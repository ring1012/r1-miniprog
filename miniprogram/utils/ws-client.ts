import { hostFor } from './device-host';

export interface MnpCred {
  deviceId: string;
  authCode: string;
}

type Handler = (data: unknown) => void;

const HEARTBEAT_MS = 30000;
const MAX_BACKOFF_MS = 30000;

// 全局单例：各页经 getWs() 共用收发，不自建连接。
// 注：字段初始化全放 constructor（不用类字段语法），兼容 es6:false 老引擎。
export class MnpWsClient {
  private task: WechatMiniprogram.SocketTask | null;
  private subs: Map<string, Set<Handler>>;
  private cred: MnpCred | null;
  private heartbeatTimer: number | null;
  private backoffMs: number;
  private manualClose: boolean;
  private authed4401: boolean;
  private last: Map<string, unknown>;
  onAuthFail: (() => void) | null;

  constructor() {
    this.task = null;
    this.subs = new Map<string, Set<Handler>>();
    this.cred = null;
    this.heartbeatTimer = null;
    this.backoffMs = 1000;
    this.manualClose = false;
    this.authed4401 = false;
    this.last = new Map<string, unknown>();
    this.onAuthFail = null;
  }

  connect(cred: MnpCred) {
    this.cred = cred;
    this.manualClose = false;
    this.authed4401 = false;
    this.backoffMs = 1000;
    this.open();
  }

  reconnect(cred: MnpCred) {
    this.close();
    this.connect(cred);
  }

  close() {
    this.manualClose = true;
    this.stopHeartbeat();
    try {
      if (this.task) this.task.close({ code: 1000 });
    } catch {
      // ignore
    }
    this.task = null;
  }

  send(type: string, params?: Record<string, unknown>) {
    if (!this.task) return;
    try {
      this.task.send({ data: JSON.stringify({ v: 2, type, params }) });
    } catch {
      // ignore, rely on reconnect
    }
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

  /** 取某 type 最近一帧载荷（悬浮窗等后挂载者秒出状态用），无则 undefined。 */
  snapshot(type: string): unknown {
    return this.last.get(type);
  }

  private open() {
    if (!this.cred) return;
    const { deviceId, authCode } = this.cred;
    const url = `wss://${hostFor(deviceId)}/mnp/ws?clientType=mnp&deviceId=${encodeURIComponent(
      deviceId
    )}&authCode=${encodeURIComponent(authCode)}`;
    this.manualClose = false;
    const task = wx.connectSocket({ url });
    this.task = task;
    task.onOpen(() => {
      this.backoffMs = 1000;
      this.startHeartbeat();
      this.send('connection.hello', { subscribe: ['playback.position', 'playback.queue', 'playback.volume', 'playback.progress'] });
      this.send('playback.get_position');
      this.send('playback.get_queue');
      this.send('playback.get_volume');
    });
    task.onMessage((msg) => {
      try {
        const data = JSON.parse(String(msg.data)) as { type?: string; data?: unknown };
        const type = data.type || '';
        if (!type) return;
        if (type === 'error') {
          const errData = data.data as { code?: number } | undefined;
          const code = errData ? errData.code : undefined;
          if (code === 4401) {
            this.authed4401 = true;
            this.stopHeartbeat();
            if (this.onAuthFail) this.onAuthFail();
            return;
          }
        }
        const handlers = this.subs.get(type);
        this.last.set(type, data.data);
        if (handlers) handlers.forEach((fn) => {
          try {
            fn(data.data);
          } catch {
            // ignore handler errors
          }
        });
      } catch {
        // ignore parse errors
      }
    });
    const schedule = () => {
      if (this.manualClose || this.authed4401) return;
      this.stopHeartbeat();
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      setTimeout(() => {
        if (!this.manualClose && !this.authed4401) this.open();
      }, delay);
    };
    task.onClose(() => schedule());
    task.onError(() => schedule());
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setTimeout(function tick(this: MnpWsClient) {
      try {
        if (this.task) this.task.send({ data: '{"type":"ping"}' });
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
