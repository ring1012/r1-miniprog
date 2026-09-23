import { hostFor } from './device-host';

// true = verify 通过（200），false = 不存在/失败（404/网络错一律按失败处理）
export function verifyDevice(deviceId: string, authCode: string): Promise<boolean> {
  const host = hostFor(deviceId);
  return new Promise((resolve) => {
    wx.request({
      url: `https://${host}/verify`,
      method: 'POST',
      header: { 'Content-Type': 'application/json' },
      data: { deviceId, authCode, botType: 'wx' },
      success: (res) => resolve(res.statusCode === 200),
      fail: () => resolve(false),
    });
  });
}
