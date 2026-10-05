import { logger } from './logger';

// 连接模式：cloud=公网（经 CF DO，需 deviceId+authCode），lan=局域网（直连音箱 ws/v2，手动输 IP）。
// 设备级抽象：两类设备并存，active 指针决定进哪个；页面层 v2 信封完全复用。
export type ConnMode = 'cloud' | 'lan';

export interface LanDevice {
  /** deviceId 即 "ip:port"（归一化后）。 */
  deviceId: string;
  name: string;
}

export interface ActiveDevice {
  kind: ConnMode;
  deviceId: string;
}

const MODE_KEY = 'connMode';
const LAN_IP_KEY = 'lanIp';
const LAN_DEVICES_KEY = 'lanDevices';
const ACTIVE_KEY = 'activeDevice';
const LAN_PORT = '18888';

/** 局域网设备仅存本地（localStorage），不上报服务器。 */
export function getLanDevices(): LanDevice[] {
  try {
    const v = wx.getStorageSync(LAN_DEVICES_KEY) as LanDevice[] | undefined;
    if (Array.isArray(v)) return v.filter((d) => d && d.deviceId);
  } catch {
    // ignore
  }
  return [];
}

export function saveLanDevice(dev: LanDevice): LanDevice[] {
  const list = getLanDevices();
  const idx = list.findIndex((d) => d.deviceId === dev.deviceId);
  if (idx >= 0) list[idx] = dev;
  else list.push(dev);
  try {
    wx.setStorageSync(LAN_DEVICES_KEY, list);
  } catch {
    // ignore
  }
  logger.debug('[mode] save lan device:', dev.deviceId);
  return list;
}

export function removeLanDevice(deviceId: string): LanDevice[] {
  const list = getLanDevices().filter((d) => d.deviceId !== deviceId);
  try {
    wx.setStorageSync(LAN_DEVICES_KEY, list);
  } catch {
    // ignore
  }
  const active = getActiveRaw();
  if (active && active.kind === 'lan' && active.deviceId === deviceId) {
    clearActive();
  }
  logger.debug('[mode] remove lan device:', deviceId);
  return list;
}

function getActiveRaw(): ActiveDevice | null {
  try {
    const v = wx.getStorageSync(ACTIVE_KEY) as ActiveDevice | undefined;
    if (v && (v.kind === 'cloud' || v.kind === 'lan') && v.deviceId) return v;
  } catch {
    // ignore
  }
  return null;
}

/** 当前选中设备（含一次性迁移：老 connMode/lanIp → lanDevices 条目）。 */
export function getActive(): ActiveDevice | null {
  const cur = getActiveRaw();
  if (cur) return cur;
  // 一次性迁移老版本状态
  try {
    const oldMode = wx.getStorageSync(MODE_KEY) as string;
    const oldIp = wx.getStorageSync(LAN_IP_KEY) as string;
    if (oldMode === 'lan' && oldIp) {
      const list = getLanDevices();
      if (!list.some((d) => d.deviceId === oldIp)) {
        list.push({ deviceId: oldIp, name: '局域网音箱' });
        wx.setStorageSync(LAN_DEVICES_KEY, list);
      }
      const active: ActiveDevice = { kind: 'lan', deviceId: oldIp };
      wx.setStorageSync(ACTIVE_KEY, active);
      wx.removeStorageSync(MODE_KEY);
      logger.debug('[mode] migrated legacy lan:', oldIp);
      return active;
    }
    wx.removeStorageSync(MODE_KEY);
  } catch {
    // ignore
  }
  return null;
}

export function setActive(kind: ConnMode, deviceId: string): void {
  try {
    wx.setStorageSync(ACTIVE_KEY, { kind, deviceId });
  } catch {
    // ignore
  }
  logger.debug('[mode] set active:', kind, kind === 'lan' ? deviceId : '');
}

export function clearActive(): void {
  try {
    wx.removeStorageSync(ACTIVE_KEY);
  } catch {
    // ignore
  }
}

export function getMode(): ConnMode {
  const a = getActive();
  return a ? a.kind : 'cloud';
}

export function setMode(mode: ConnMode): void {
  // 兼容老调用：只在切公网时清掉 lan active；切 lan 必须经 setActive（需 deviceId）
  if (mode === 'cloud') {
    const a = getActiveRaw();
    if (a && a.kind === 'lan') clearActive();
  }
  logger.debug('[mode] set mode:', mode);
}

export function getLanIp(): string {
  try {
    return (wx.getStorageSync(LAN_IP_KEY) as string) || '';
  } catch {
    return '';
  }
}

export function setLanIp(ip: string): void {
  try {
    wx.setStorageSync(LAN_IP_KEY, ip);
  } catch {
    // ignore
  }
  // authCode 永不打日志；IP 非敏感，打印方便联调
  logger.debug('[mode] set lanIp:', ip);
}

/** 归一化用户输入：去协议头/路径/空格；无端口则补 :18888；非法返回 ''。 */
export function normLanIp(input: string): string {
  let s = (input || '').trim();
  if (!s) return '';
  s = s.replace(/^wss?:\/\//i, '');
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(0, slash);
  s = s.trim();
  if (!s) return '';
  if (s.indexOf(':') < 0) s = s + ':' + LAN_PORT;
  return s;
}

/** 从 "ip:port" 里取 host 部分。 */
export function lanHost(ipPort: string): string {
  const s = (ipPort || '').trim();
  const idx = s.indexOf(':');
  if (idx >= 0) return s.slice(0, idx);
  return s;
}

/** 取手机本机 IP（拿不到时 resolve ''，不阻塞）。 */
export function getPhoneIp(): Promise<string> {
  return new Promise((resolve) => {
    try {
      const fn = (wx as unknown as { getLocalIPAddress?: (o: object) => void }).getLocalIPAddress;
      if (typeof fn !== 'function') {
        resolve('');
        return;
      }
      fn.call(wx, {
        success: (res: unknown) => {
          const ip = ((res || {}) as { localip?: string }).localip || '';
          logger.debug('[mode] phone ip:', ip);
          resolve(ip);
        },
        fail: () => resolve(''),
      });
    } catch {
      resolve('');
    }
  });
}

/**
 * /24 启发式同网段判断（前三段相同即过）。
 * 官方要求"同一网段"（掩码未知时按 /24 估算，误报只做提醒不拦截）。
 */
export function sameSubnet24(a: string, b: string): boolean {
  const pa = (a || '').trim().split('.');
  const pb = (b || '').trim().split('.');
  if (pa.length !== 4 || pb.length !== 4) return false;
  return pa[0] === pb[0] && pa[1] === pb[1] && pa[2] === pb[2];
}
