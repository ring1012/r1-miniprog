import { logger } from './logger';

export interface MnpDevice {
  deviceId: string;
  authCode: string;
  name: string;
}

/** 后台 /mnp/session 返回：mnpUserId 即 openid；sessionKey/unionId 按后端实际返回透出（debug 打印用，不落盘）。 */
export interface MnpSessionResp {
  success: boolean;
  mnpUserId?: string;
  openId?: string;
  sessionKey?: string;
  unionId?: string;
}

const ENTRY_BASE = 'https://entry.air1.pp.ua';

function post<T>(path: string, data: Record<string, unknown>): Promise<T> {
  // authCode 永不打日志：bind 入参含敏感字段，这里只打 path。
  logger.debug('[api] POST', path);
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${ENTRY_BASE}${path}`,
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data as T);
        } else {
          logger.warn('[api] fail', path, res.statusCode);
          reject(new Error(`http ${res.statusCode}`));
        }
      },
      fail: (err) => {
        logger.warn('[api] request fail', path, err);
        reject(err);
      },
    });
  });
}

/** 拿 wx.login 的 code 换 openId/sessionKey/unionId（经后台 /mnp/session 中转，前端不直调微信接口）。 */
export function exchangeCodeForSession(code: string): Promise<MnpSessionResp> {
  logger.debug('[auth] wx.login code:', code);
  return post<MnpSessionResp>('/mnp/session', { code }).then((d) => {
    // debug 才打印（含 sessionKey 明文）；上线切 info 后自动屏蔽。成功字段不落盘，只缓存 mnpUserId。
    logger.debug('[auth] session resp:', {
      success: d.success,
      mnpUserId: d.mnpUserId,
      openId: d.openId,
      unionId: d.unionId,
      sessionKey: d.sessionKey,
      hasSessionKey: !!d.sessionKey,
    });
    return d;
  });
}

export function ensureMnpUserId(): Promise<string> {
  // 缓存命中直接用，不再 login（openid 稳定；微信 storage 按用户隔离，切号即换隔离区）
  const cached = wx.getStorageSync('mnpUserId') as string;
  if (cached) return Promise.resolve(cached);
  return loginOnce();
}

let sessionInflight: Promise<string> | null = null;

/** 首次进入才走：wx.login + /session，单发（并发调用共用同一个 inflight）。 */
export function loginOnce(): Promise<string> {
  if (sessionInflight) return sessionInflight;
  sessionInflight = new Promise((resolve, reject) => {
    wx.login({
      success: (r) => {
        if (!r.code) {
          sessionInflight = null;
          reject(new Error('login failed'));
          return;
        }
        exchangeCodeForSession(r.code)
          .then((d) => {
            if (d.success && d.mnpUserId) {
              try {
                wx.setStorageSync('mnpUserId', d.mnpUserId);
              } catch {
                // ignore
              }
              resolve(d.mnpUserId);
            } else {
              sessionInflight = null;
              reject(new Error('session failed'));
            }
          })
          .catch((err) => {
            sessionInflight = null;
            reject(err);
          });
      },
      fail: (err) => {
        sessionInflight = null;
        reject(err);
      },
    });
  });
  return sessionInflight;
}

export function queryDevices(mnpUserId: string): Promise<MnpDevice[]> {
  return post<{ success: boolean; list: MnpDevice[] }>('/mnp/query', { mnpUserId }).then((d) => d.list || []);
}

export function bindDevice(mnpUserId: string, deviceId: string, authCode: string, name?: string) {
  return post<{ success: boolean; list: MnpDevice[]; updated: boolean }>('/mnp/bind', {
    mnpUserId,
    deviceId,
    authCode,
    name,
  });
}

export function unbindDevice(mnpUserId: string, deviceId: string) {
  return post<{ success: boolean; list: MnpDevice[] }>('/mnp/unbind', { mnpUserId, deviceId });
}
