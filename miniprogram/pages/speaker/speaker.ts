import { getWs } from '../../utils/ws-client';
import { ensureMnpUserId, queryDevices } from '../../utils/api';
import { getTheme, setTheme, applyNavBar, THEMES, Theme } from '../../utils/theme';

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
      // 从设备管理页返回时同步主题
      const theme = getTheme();
      if (theme !== this.data.theme) this.setData({ theme });
      applyNavBar(theme);
    },

    onUnload() {
      // 连接不断：悬浮窗与其他页还要用，只清本页无订阅
    },

    async init() {
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
