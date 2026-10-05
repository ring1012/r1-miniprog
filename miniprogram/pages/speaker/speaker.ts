import { getWs } from '../../utils/ws-client';
import { ensureMnpUserId, queryDevices } from '../../utils/api';
import { getTheme, setTheme, applyNavBar, THEMES, Theme } from '../../utils/theme';
import { logger } from '../../utils/logger';
import { getActive, getLanDevices, setActive } from '../../utils/mode';

interface Donation {
  name: string;
  platform: string;
  date: string;
  amount: number;
}

interface CurrentDevice {
  deviceId: string;
  authCode: string;
  name: string;
}

Component({
  data: {
    device: null as CurrentDevice | null,
    connState: '连接中…',
    donations: [] as Donation[],
    totalAmount: '0.00',
    totalCount: 0,
    donationError: '',
    theme: 'dark' as Theme,
    themeList: THEMES,
    menuOpen: false,
    drawerOpen: false,
    activeKey: '',
    isLan: false,
  },

  lifetimes: {},

  methods: {
    onLoad() {
      const theme = getTheme();
      this.setData({ theme });
      applyNavBar(theme);
      void this.init();
      this.loadDonations();
    },

    onShow() {
      // 从设备管理页返回时同步主题；选中设备变化后重建连
      const theme = getTheme();
      if (theme !== this.data.theme) this.setData({ theme });
      applyNavBar(theme);
      const active = getActive();
      const key = active ? active.kind + ':' + active.deviceId : '';
      const cur = ((this.data.activeKey as unknown as string) || '');
      if (key !== cur) {
        logger.debug('[speaker] active changed to', key, ', re-init');
        void this.init();
      }
    },

    onUnload() {
      // 连接不断：悬浮窗与其他页还要用，只清本页无订阅
    },

    async init() {
      let active = getActive();
      if (!active) {
        // 兼容老版本：有公网 currentDevice 即转为选中态
        const legacy = wx.getStorageSync('currentDevice') as CurrentDevice | null;
        if (legacy && legacy.deviceId) {
          setActive('cloud', legacy.deviceId);
          active = { kind: 'cloud', deviceId: legacy.deviceId };
        } else {
          wx.redirectTo({ url: '/pages/devices/devices' });
          return;
        }
      }
      this.setData({
        activeKey: ((active.kind + ':' + active.deviceId) as never),
        isLan: ((active.kind === 'lan') as never),
      });
      if (active.kind === 'lan') {
        // 局域网设备：只读本地记录，直连，不走绑定/鉴权
        const found = getLanDevices().find((d) => d.deviceId === active.deviceId);
        if (!found) {
          logger.warn('[speaker] lan device gone:', active.deviceId);
          wx.showToast({ title: '局域网设备已删除', icon: 'none' });
          wx.redirectTo({ url: '/pages/devices/devices' });
          return;
        }
        const ip = found.deviceId;
        logger.debug('[speaker] lan mode, connect:', ip);
        this.setData({
          device: ({ deviceId: ip, authCode: '', name: found.name } as never),
          connState: ('局域网连接中…' as never),
        });
        const ws = getWs();
        ws.connectLan(ip);
        this._fetchFirstState();
        // 用 device.info 回包确认在线（失败即连接失败，不靠定时器假装在线）
        const self = this;
        ws.request(['device.info']).then(
          () => {
            logger.debug('[speaker] lan online:', ip);
            self.setData({ connState: '局域网在线' as never });
          },
          (e) => {
            logger.warn('[speaker] lan connect failed:', e);
            self.setData({ connState: '局域网连接失败' as never });
            wx.showToast({ title: '局域网连接失败', icon: 'none' });
          }
        );
        return;
      }
      const stored = wx.getStorageSync('currentDevice') as CurrentDevice | null;
      let device = stored;
      if (!device || !device.deviceId) {
        try {
          const mnpUserId = await ensureMnpUserId();
          const list = await queryDevices(mnpUserId);
          const active = wx.getStorageSync('activeDeviceId') as string;
          device = list.find((d) => d.deviceId === active) || list[0] || null;
          if (device) {
            wx.setStorageSync('currentDevice', device);
            wx.setStorageSync('activeDeviceId', device.deviceId);
          }
        } catch {
          device = null;
        }
      }
      if (!device) {
        wx.redirectTo({ url: '/pages/devices/devices' });
        return;
      }
      this.setData({ device: device as never, connState: '连接中…' as never });
      const ws = getWs();
      ws.onAuthFail = () => {
        this.setData({ connState: '鉴权失败' as never });
        wx.showToast({ title: '添加音箱失败', icon: 'none' });
        wx.redirectTo({ url: '/pages/devices/devices' });
      };
      // 播放状态只由悬浮窗订阅展示，本页只建连不断连
      ws.connect({ deviceId: device.deviceId, authCode: device.authCode });
      this._fetchFirstState();
      setTimeout(() => {
        if ((this.data.connState as unknown as string) === '连接中…') {
          this.setData({ connState: '在线' as never });
        }
      }, 2000);
    },

    loadDonations() {
      wx.request({
        url: 'https://air1.pp.ua/api/donation',
        success: (res) => {
          const arr = Array.isArray(res.data) ? (res.data as Donation[]) : [];
          const sorted = [...arr].sort((a, b) => +new Date(b.date) - +new Date(a.date));
          const total = sorted
            .filter((d) => d.platform !== '闲鱼')
            .reduce((s, d) => s + (Number(d.amount) || 0), 0);
          this.setData({
            donations: sorted.slice(0, 20) as never,
            totalAmount: total.toFixed(2) as never,
            totalCount: sorted.length as never,
          });
        },
        fail: () => this.setData({ donationError: '无法加载捐赠记录' as never }),
      });
    },

    goManage() {
      this.setData({ menuOpen: false });
      wx.navigateTo({ url: '/pages/devices/devices' });
    },

    // 首页首次进入主动拉一次正在播放：music-bar 的 attached 可能早于建连，
    // 此时 request 因无 task 直接失败且不重试，悬浮窗首屏就是空的。
    // 建连后调用：帧进 openQueue 等 open 后发出；已有快照（非首次）直接跳过。
    _fetchFirstState() {
      const ws = getWs();
      if (ws.snapshot('player.state')) return;
      logger.debug('[speaker] 首屏主动拉 player.state');
      ws.request(['player.state']).then(
        () => logger.debug('[speaker] player.state 首屏回包'),
        (e) => logger.warn('[speaker] player.state 首屏拉取失败:', e)
      );
    },
    // 打赏链接：小程序没有跨 App 直跳 API，点击复制链接，用户去浏览器粘贴打开。
    // 支付宝复制收款 https 链接；微信复制 air1.pp.ua 上的收款码图片链接，浏览器打开后长按识别。
    // 链接文本另设 selectable 兜底长按复制。
    copyPayLink(e: WechatMiniprogram.CustomEvent) {
      const ds = (e.currentTarget.dataset || {}) as { link?: string; name?: string; tip?: string };
      const link = ds.link || '';
      const name = ds.name || '打赏';
      if (!link) return;
      wx.setClipboardData({
        data: link,
        success: () => {
          wx.showToast({ title: ds.tip || ('已复制，去' + name + '粘贴打开'), icon: 'none' });
        },
        fail: () => {
          wx.showToast({ title: '复制失败，请长按链接复制', icon: 'none' });
        },
      });
    },
    goPage(e: WechatMiniprogram.CustomEvent) {
      const url = (e.currentTarget.dataset.url || '') as string;
      this.setData({ menuOpen: false, drawerOpen: false });
      if (!url) return;
      wx.navigateTo({ url });
    },
    toggleMenu() {
      this.setData({ menuOpen: !this.data.menuOpen });
    },
    closeMenu() {
      if (this.data.menuOpen) this.setData({ menuOpen: false });
    },
    toggleDrawer() {
      this.setData({ drawerOpen: !this.data.drawerOpen });
    },
    closeDrawer() {
      if (this.data.drawerOpen) this.setData({ drawerOpen: false });
    },
    onMenuManage() {
      this.setData({ drawerOpen: false });
      this.goManage();
    },
    onMenuTheme() {
      const list = this.data.themeList as Array<{ key: Theme }>;
      const cur = this.data.theme as Theme;
      let idx = 0;
      for (let i = 0; i < list.length; i++) {
        if (list[i].key === cur) idx = i;
      }
      const next = list[(idx + 1) % list.length].key;
      setTheme(next);
      this.setData({ theme: next, menuOpen: false, drawerOpen: false });
    },
  },
});
