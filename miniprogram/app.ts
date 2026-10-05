// app.ts
import { loginOnce } from './utils/api';
import { logger } from './utils/logger';

function checkUpdate() {
  try {
    const um = wx.getUpdateManager();
    um.onCheckForUpdate((res) => {
      logger.debug('[app] checkUpdate hasUpdate:', res.hasUpdate);
    });
    um.onUpdateReady(() => {
      logger.info('[app] update ready, ask restart');
      wx.showModal({
        title: '新版本已就绪',
        content: '重启应用以使用最新版本？',
        success: (r) => {
          if (r.confirm) um.applyUpdate();
        },
      });
    });
    um.onUpdateFailed(() => {
      logger.error('[app] update failed');
      wx.showToast({ title: '新版本下载失败，请稍后重试', icon: 'none' });
    });
  } catch (e) {
    logger.error('[app] updateManager unsupported', e);
  }
}

App<IAppOption>({
  globalData: {},
  onLaunch() {
    checkUpdate();
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