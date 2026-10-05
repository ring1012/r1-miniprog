import { hostFor } from './device-host';
import { logger } from './logger';

export interface MnpCred {
  deviceId: string;
  authCode: string;
}

type Handler = (data: unknown) => void;

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: number;
}

interface V2Entry {
  name?: string;
  data?: unknown;
}

interface V2Frame {
  v?: number;
  type?: string;
  to?: string[];
  reqId?: string;
  types?: string[];
  params?: Record<string, unknown>;
  result?: V2Entry[];
  data?: unknown;
  /** 局域网直连标记：提醒音箱只回本机、不转 CF（LAN 传输层自动打上，公网不带）。 */
  lan?: boolean;
}

// 心跳 3s（局域网 NanoHTTPD 读空闲约 5s 即掐线，老 admin 也是 3s；公网 DO 侧 auto-pong，3s 开销可忽略，统一一份）。
const HEARTBEAT_MS = 3000;
const MAX_BACKOFF_MS = 30000;
const REQUEST_TIMEOUT_MS = 5000;

/** 日志用 URL 脱敏：去掉 query（公网 URL 里带 authCode，永不打日志）。 */
function safeUrl(url: string): string {
  const q = url.indexOf('?');
  return q >= 0 ? url.slice(0, q) : url;
}

// v2 聚合协议（与 Android V2Protocol / DO to路由对齐，v 固定为 2）。
// 上行：{v:2, to:["speaker"], reqId, type:"data.get", types:[...]} 或控制 type+params。
// 下行：{v:2, from:"speaker", to:["mnp"], reqId?, result:[{name,data}]} 按 name 分发。
// 全局单例：各页经 getWs() 共用收发，不自建连接。
// 注：字段初始化全放 constructor（不用类字段语法），兼容 es6:false 老引擎。
export class MnpWsClient {
  private task: WechatMiniprogram.SocketTask | null;
  private subs: Map<string, Set<Handler>>;
  private cred: MnpCred | null;
  private lanIp: string | null;
  private heartbeatTimer: number | null;
  private backoffMs: number;
  private manualClose: boolean;
  private authed4401: boolean;
  private last: Map<string, unknown>;
  private seq: number;
  private pending: Map<string, Pending>;
  /** socket OPEN 状态；未 open 前的帧进 openQueue 等待，避免 readyState is not OPEN。 */
  private isOpen: boolean;
  private openQueue: V2Frame[];
  onAuthFail: (() => void) | null;

  constructor() {
    this.task = null;
    this.subs = new Map<string, Set<Handler>>();
    this.cred = null;
    this.lanIp = null;
    this.heartbeatTimer = null;
    this.backoffMs = 1000;
    this.manualClose = false;
    this.authed4401 = false;
    this.last = new Map<string, unknown>();
    this.seq = 0;
    this.pending = new Map<string, Pending>();
    this.isOpen = false;
    this.openQueue = [];
    this.onAuthFail = null;
  }

  connect(cred: MnpCred) {
    this.resetForNewConnect();
    this.cred = cred;
    this.lanIp = null;
    this.open();
  }

  /** 局域网直连：ws://ip:18888/ws/v2，同 v2 信封，无鉴权。 */
  connectLan(ip: string) {
    this.resetForNewConnect();
    this.cred = null;
    this.lanIp = ip;
    this.open();
  }

  /**
   * 新一轮建连前的清理：关掉旧 task、置 isOpen=false、清 openQueue、
   * fail 掉上一轮 pending。旧 task 随后触发的 onClose/onError 靠
   * open() 里的 task 身份比对丢弃，不会误杀新连接。
   */
  private resetForNewConnect() {
    this.manualClose = true;
    try {
      if (this.task) this.task.close({ code: 1000 });
    } catch {
      // ignore
    }
    this.task = null;
    this.isOpen = false;
    this.openQueue = [];
    this.stopHeartbeat();
    this.failAllPending(new Error('reconnect'));
    this.manualClose = false;
    this.authed4401 = false;
    this.backoffMs = 1000;
  }

  isLan(): boolean {
    return this.lanIp !== null && this.lanIp !== '';
  }

  reconnect(cred: MnpCred) {
    this.close();
    this.connect(cred);
  }

  close() {
    this.manualClose = true;
    this.isOpen = false;
    this.openQueue = [];
    this.stopHeartbeat();
    this.failAllPending(new Error('closed'));
    try {
      if (this.task) this.task.close({ code: 1000 });
    } catch {
      // ignore
    }
    this.task = null;
  }

  /** 控制类发送（fire-and-forget，成功以随后同名 event 为准）。 */
  send(type: string, params?: Record<string, unknown>) {
    this.sendRaw({ v: 2, to: ['speaker'], reqId: this.nextReqId(), type, params });
  }

  /** 批量拉取：一次性聚合，reqId 配对，5s 超时。 */
  request(types: string[]): Promise<Record<string, unknown>> {
    const self = this;
    return new Promise<Record<string, unknown>>(function (resolve, reject) {
      if (!self.task) {
        reject(new Error('no connection'));
        return;
      }
      const reqId = self.nextReqId();
      const timer = setTimeout(function () {
        self.pending.delete(reqId);
        // 超时后把排队中还没发出的同 reqId 帧摘掉，避免 socket 后来
        // open 时发出已没人等的过期请求（NanoHTTPD 单线程，少一次是一次）。
        self.dropQueuedReq(reqId);
        reject(new Error('timeout'));
      }, REQUEST_TIMEOUT_MS) as unknown as number;
      self.pending.set(reqId, { resolve, reject, timer });
      try {
        self.sendRaw({ v: 2, to: ['speaker'], reqId, type: 'data.get', types });
      } catch (e) {
        clearTimeout(timer);
        self.pending.delete(reqId);
        self.dropQueuedReq(reqId);
        reject(e instanceof Error ? e : new Error('send failed'));
      }
    });
  }

  on(type: string, fn: Handler) {
    let set = this.subs.get(type);
    if (!set) {
      set = new Set();
      this.subs.set(type, set);
    }
    set.add(fn);
  }

  off(type: string, fn: Handler) {
    const set = this.subs.get(type);
    if (set) set.delete(fn);
  }

  /** 取某 name 最近一帧载荷（悬浮窗等后挂载者秒出状态用），无则 undefined。 */
  snapshot(type: string): unknown {
    return this.last.get(type);
  }

  private nextReqId(): string {
    this.seq += 1;
    return 'mnp:' + Date.now() + ':' + this.seq;
  }

  private sendRaw(frame: V2Frame) {
    if (!this.task) return;
    // 局域网传输统一打标记（调用方无需关心）：音箱见 lan 即只回本机、不转 CF
    if (this.isLan() && frame.lan === undefined) frame.lan = true;
    // 未 OPEN 先排队（connect 后立刻 request 的竞态），onOpen 时 flush；队列封顶防爆
    if (!this.isOpen) {
      if (this.openQueue.length < 20) this.openQueue.push(frame);
      try {
        logger.debug('[ws] TX queued:', JSON.stringify(frame));
      } catch {
        logger.debug('[ws] TX queued: <unstringifiable>');
      }
      return;
    }
    try {
      const s = JSON.stringify(frame);
      this.task.send({ data: s });
      logger.debug('[ws] TX:', s);
    } catch {
      // 发送瞬间断开：回队等下一次 open
      if (this.openQueue.length < 20) this.openQueue.push(frame);
    }
  }

  private flushOpenQueue() {
    if (!this.task || !this.isOpen) return;
    const q = this.openQueue;
    this.openQueue = [];
    for (let i = 0; i < q.length; i++) {
      const f = q[i];
      // data.get 若 pending 已超时/被新一轮建连清掉，就不再发过期帧
      if (f.type === 'data.get' && f.reqId && !this.pending.has(f.reqId)) continue;
      try {
        if (this.task) {
          const s = JSON.stringify(f);
          this.task.send({ data: s });
          logger.debug('[ws] TX flush:', s);
        }
      } catch {
        // 发送瞬间断开：回队等下一次 open
        if (this.openQueue.length < 20) this.openQueue.push(f);
      }
    }
  }

  private dropQueuedReq(reqId: string) {
    if (this.openQueue.length === 0 || !reqId) return;
    this.openQueue = this.openQueue.filter((f) => f.reqId !== reqId);
  }

  private failAllPending(err: Error) {
    if (this.pending.size === 0) return;
    const list = Array.from(this.pending.values());
    this.pending.clear();
    for (let i = 0; i < list.length; i++) {
      try {
        clearTimeout(list[i].timer);
      } catch {
        // ignore
      }
      try {
        list[i].reject(err);
      } catch {
        // ignore
      }
    }
  }

  private emit(name: string, data: unknown) {
    this.last.set(name, data);
    const handlers = this.subs.get(name);
    if (handlers) handlers.forEach((fn) => {
      try {
        fn(data);
      } catch (e) {
        logger.warn('[ws] handler error:', name, e);
      }
    });
  }

  private open() {
    let url = '';
    if (this.lanIp) {
      url = `ws://${this.lanIp}/ws/v2`;
    } else {
      if (!this.cred) return;
      const cred = this.cred;
      const deviceId = cred.deviceId;
      const authCode = cred.authCode;
      url = `wss://${hostFor(deviceId)}/mnp/ws?clientType=mnp&deviceId=${encodeURIComponent(
        deviceId
      )}&authCode=${encodeURIComponent(authCode)}`;
    }
    this.manualClose = false;
    const task = wx.connectSocket({ url });
    this.task = task;
    const self = this;
    task.onOpen(() => {
      // 旧连接的延迟回调：本轮已被新 connectLan/connect 覆盖，直接丢弃
      if (self.task !== task) return;
      logger.debug('[ws] open:', safeUrl(url));
      self.backoffMs = 1000;
      self.isOpen = true;
      self.startHeartbeat();
      // 先把 connect 后排队的帧发出；本层不再顺手拉 player.state：
      // 进度由各端本地 1s 插值推进，暂停/播放等变更由后端主动推 event 校准，
      // 首屏所需一次性拉取由页面层按 snapshot 缺啥补啥（只发一次），避免建连+页面双重请求。
      self.flushOpenQueue();
      if (self.isLan()) {
        return;
      }
      // 建连问候（DO 回 connected，维持 mnp 订阅关系；不带数据拉取）
      self.sendRaw({ v: 2, to: ['speaker'], reqId: self.nextReqId(), type: 'connection.hello', params: { subscribe: ['player.state'] } });
    });
    task.onMessage((msg) => {
      if (self.task !== task) return;
      try {
        logger.debug('[ws] RX:', String(msg.data));
      } catch {
        // ignore log errors
      }
      try {
        const data = JSON.parse(String(msg.data)) as V2Frame;
        if (!data) return;
        const type = data.type || '';
        // 定向错误帧
        if (type === 'error') {
          const errData = data.data as { code?: number } | undefined;
          const code = errData ? errData.code : undefined;
          if (code === 4401) {
            self.authed4401 = true;
            self.stopHeartbeat();
            self.failAllPending(new Error('auth failed'));
            if (self.onAuthFail) self.onAuthFail();
            return;
          }
          return;
        }
        // v2 聚合帧：按 result[].name 分发
        const result = data.result;
        if (result && result.length !== undefined) {
          const byName: Record<string, unknown> = {};
          for (let i = 0; i < result.length; i++) {
            const entry = result[i] || {};
            const name = entry.name || '';
            if (!name) continue;
            byName[name] = entry.data;
            self.emit(name, entry.data);
          }
          const reqId = data.reqId || '';
          if (reqId) {
            const p = self.pending.get(reqId);
            if (p) {
              self.pending.delete(reqId);
              try {
                clearTimeout(p.timer);
              } catch {
                // ignore
              }
              try {
                p.resolve(byName);
              } catch {
                // ignore
              }
            }
          }
          return;
        }
        // 兼容老帧 {type, data}（迁移期）
        if (type) {
          self.emit(type, data.data);
        }
      } catch {
        // ignore parse errors
      }
    });
    const schedule = () => {
      // 旧 task 在新一轮建连后才 close/error：不再碰新连接的状态
      if (self.task !== task) return;
      if (self.manualClose || self.authed4401) return;
      self.isOpen = false;
      self.stopHeartbeat();
      self.failAllPending(new Error('reconnect'));
      const delay = self.backoffMs;
      self.backoffMs = Math.min(self.backoffMs * 2, MAX_BACKOFF_MS);
      setTimeout(() => {
        // 延迟期间用户又点了测试/切换了设备：旧的重连不再覆盖新连接
        if (self.task !== task) return;
        if (!self.manualClose && !self.authed4401) self.open();
      }, delay);
    };
    task.onClose((res) => {
      if (self.task !== task) return;
      logger.warn('[ws] close:', safeUrl(url), res && (res as { code?: number }).code, res && (res as { reason?: string }).reason);
      schedule();
    });
    task.onError((err) => {
      if (self.task !== task) return;
      logger.error('[ws] error:', safeUrl(url), err);
      schedule();
    });
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setTimeout(function tick(this: MnpWsClient) {
      try {
        if (this.task) {
          this.task.send({ data: '{"type":"ping"}' });
          logger.debug('[ws] TX ping');
        }
      } catch {
        // ignore
      }
      this.heartbeatTimer = setTimeout(tick.bind(this), HEARTBEAT_MS);
    }.bind(this), HEARTBEAT_MS) as unknown as number;
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

let singleton: MnpWsClient | null = null;

export function getWs(): MnpWsClient {
  if (!singleton) singleton = new MnpWsClient();
  return singleton;
}
