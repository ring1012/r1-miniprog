// app.ts
import { loginOnce } from './utils/api';
import { logger } from './utils/logger';

App<IAppOption>({
  globalData: {},
  onLaunch() {
    // 展示本地存储能力
    const logs = wx.getStorageSync('logs') || []
    logs.unshift(Date.now())
    wx.setStorageSync('logs', logs)

    // 登录只在首次进入做一次：有缓存直接用，不再 wx.login / 调 /session
    // openId/sessionKey/unionId 明细由 exchange 内部打 debug（develop/trial 可见）
    const cached = wx.getStorageSync('mnpUserId') as string;
    if (cached) {
      logger.debug('[app] cached mnpUserId, skip login:', cached);
      return;
    }
    logger.debug('[app] first launch, login...');
    loginOnce().then(
      (id) => logger.info('[app] session ok, mnpUserId cached:', id),
      (err) => logger.error('[app] session error', err),
    );
  },
})