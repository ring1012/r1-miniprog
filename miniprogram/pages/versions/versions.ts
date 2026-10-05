import { getWs } from '../../utils/ws-client';
import { getTheme, applyNavBar, Theme } from '../../utils/theme';
import { logger } from '../../utils/logger';
import { formatVersion, num } from '../../utils/v2';

const OTA_BASE = 'https://file.air1.pp.ua/xiaoxun/';

// 版本管理：system.versions 查询 + system.upgrade 升级（对标 admin versions 页）。
// 升级是异步无进度事件的：受理即 toast，后台下载安装，隔几分钟重查确认。
Component({
  data: {
    theme: 'dark' as Theme,
    echo: 0,
    unisound: 0,
    latestEcho: 0,
    latestUni: 0,
    echoText: '读取中…',
    unisoundText: '读取中…',
    latestEchoText: '获取中…',
    latestUniText: '获取中…',
    needEcho: false,
    needUni: false,
    latestError: '',
    upgrading: '' as string,
    loading: true,
  },

  lifetimes: {},

  methods: {
    onLoad() {
      const theme = getTheme();
      this.setData({ theme });
      applyNavBar(theme);
      logger.debug('[versions] onLoad, request system.versions');
      const self = this;
      const h = function (d: unknown) { self._onVersions(d); };
      (this as unknown as { _h: unknown })._h = h;
      getWs().on('system.versions', h);
      const snap = getWs().snapshot('system.versions') as { echo?: number; unisound?: number } | undefined;
      if (snap) this._onVersions(snap);
      this.refresh();
      this.loadLatest();
    },

    onShow() {
      const theme = getTheme();
      if (theme !== this.data.theme) this.setData({ theme });
      applyNavBar(theme);
    },

    onUnload() {
      const h = (this as unknown as { _h?: (d: unknown) => void })._h;
      if (h) getWs().off('system.versions', h);
      logger.debug('[versions] onUnload, unsubscribed');
    },

    _onVersions(d: unknown) {
      const obj = ((d || {}) as { echo?: number; unisound?: number; accepted?: boolean });
      if (obj.accepted) {
        // system.upgrade 的受理回包（同名返回），不是版本数据
        logger.debug('[versions] upgrade accepted:', obj);
        return;
      }
      logger.debug('[versions] system.versions event:', obj.echo, obj.unisound);
      const echo = num(obj.echo, 0);
      const unisound = num(obj.unisound, 0);
      this.setData({
        echo: (echo as never),
        unisound: (unisound as never),
        loading: (false as never),
      });
      this.recalc();
    },

    refresh() {
      logger.debug('[versions] request system.versions');
      getWs().request(['system.versions']).then(
        () => undefined,
        (e) => {
          logger.warn('[versions] request timeout:', e);
          this.setData({ loading: false as never });
          wx.showToast({ title: '设备无响应', icon: 'none' });
        }
      );
    },

    loadLatest() {
      logger.debug('[versions] load latest from OTA');
      const self = this;
      const get = (url: string, ok: (n: number) => void) => {
        wx.request({
          url,
          responseType: 'text',
          success(res) {
            const n = parseInt(String(res.data).trim(), 10);
            logger.debug('[versions] latest', url, n);
            if (!isNaN(n)) ok(n);
          },
          fail(err) {
            logger.warn('[versions] latest fetch failed:', url, err);
            self.setData({ latestError: '最新版本获取失败，请检查网络后重试' as never });
          },
        });
      };
      get(OTA_BASE + 'controller_vers.txt', (n) => {
        self.setData({ latestEcho: (n as never) });
        self.recalc();
      });
      get(OTA_BASE + 'unisound_vers.txt', (n) => {
        self.setData({ latestUni: (n as never) });
        self.recalc();
      });
    },

    /** WXML 不支持模板调方法，展示字段全部预计算。 */
    recalc() {
      const echo = (this.data.echo as number) || 0;
      const unisound = (this.data.unisound as number) || 0;
      const latestEcho = (this.data.latestEcho as number) || 0;
      const latestUni = (this.data.latestUni as number) || 0;
      const needEcho = latestEcho > 0 && echo > 0 && latestEcho > echo;
      const needUni = latestUni > 0 && latestUni > unisound;
      logger.debug('[versions] recalc:', { echo, unisound, latestEcho, latestUni, needEcho, needUni });
      this.setData({
        echoText: ((echo ? formatVersion(echo) : '读取中…') as never),
        unisoundText: ((unisound ? formatVersion(unisound) : '读取中…') as never),
        latestEchoText: ((latestEcho ? formatVersion(latestEcho) : '获取中…') as never),
        latestUniText: ((latestUni ? formatVersion(latestUni) : '获取中…') as never),
        needEcho: (needEcho as never),
        needUni: (needUni as never),
      });
    },

    upgrade(e: WechatMiniprogram.CustomEvent) {
      const which = (e.currentTarget.dataset.which || '') as string;
      const apkName = which === 'uni' ? 'new_uni.apk' : 'new_echo.apk';
      const version = String(which === 'uni' ? this.data.latestUni : this.data.latestEcho);
      const self = this;
      wx.showModal({
        title: '确认升级？',
        content: apkName + ' → ' + version + '，后台下载安装，期间不要断电。',
        success(r) {
          if (!r.confirm) return;
          self.setData({ upgrading: (apkName as never) });
          logger.debug('[versions] send system.upgrade:', apkName, version);
          try {
            getWs().send('system.upgrade', { apkName, version });
            wx.showToast({ title: '已受理，后台升级中', icon: 'none' });
          } catch (err) {
            logger.error('[versions] upgrade send failed', err);
            wx.showToast({ title: '发送失败', icon: 'none' });
          }
          setTimeout(() => {
            // 无完成事件：提示用户稍后重查
            self.setData({ upgrading: ('' as never) });
            logger.debug('[versions] upgrade window closed for', apkName);
          }, 5000);
        },
      });
    },
  },
});
