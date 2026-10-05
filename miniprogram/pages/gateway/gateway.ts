import { ensureMnpUserId, queryDevices, bindDevice, MnpDevice } from '../../utils/api';
import { verifyDevice } from '../../utils/verify';
import { getTheme, applyNavBar, Theme } from '../../utils/theme';
import { getActive } from '../../utils/mode';

Page({
  data: {
    loading: true,
    error: '',
    theme: 'dark' as Theme,
  },
  onLoad(options: Record<string, string>) {
    const theme = getTheme();
    this.setData({ theme });
    applyNavBar(theme);
    void this.route(options || {});
  },
  onShow() {
    const theme = getTheme();
    if (theme !== this.data.theme) this.setData({ theme });
    applyNavBar(theme);
  },
  async route(options: Record<string, string>) {
    // 局域网设备选中态：不走绑定/登录，直接进 speaker（speaker 内直连）
    const active = getActive();
    if (active && active.kind === 'lan') {
      wx.redirectTo({ url: '/pages/speaker/speaker' });
      return;
    }
    const deviceId = (options.deviceId || '').trim();
    const authCode = (options.authCode || '').trim();
    const name = ((options.name || '我的音箱') as string).slice(0, 32);
    try {
      const mnpUserId = await ensureMnpUserId();
      const list = await queryDevices(mnpUserId);
      if (deviceId && authCode) {
        await this.routeWithParams(mnpUserId, list, deviceId, authCode, name);
        return;
      }
      await this.routeBare(list);
    } catch (e) {
      this.setData({ loading: false, error: (e as Error).message || '加载失败' });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  async routeWithParams(
    mnpUserId: string,
    list: MnpDevice[],
    deviceId: string,
    authCode: string,
    name: string
  ) {
    const hit = list.find((d) => d.deviceId === deviceId && d.authCode === authCode);
    if (hit) {
      this.enter(hit);
      return;
    }
    const ok = await verifyDevice(deviceId, authCode);
    if (!ok) {
      wx.showToast({ title: '添加音箱失败', icon: 'none' });
      wx.setStorageSync('prefillDevice', { deviceId, authCode, name });
      wx.redirectTo({ url: '/pages/devices/devices' });
      return;
    }
    const res = await bindDevice(mnpUserId, deviceId, authCode, name);
    const saved = res.list.find((d) => d.deviceId === deviceId) || { deviceId, authCode, name };
    this.enter(saved);
  },

  async routeBare(list: MnpDevice[]) {
    if (list.length === 0) {
      wx.redirectTo({ url: '/pages/devices/devices' });
      return;
    }
    if (list.length === 1) {
      this.enter(list[0]);
      return;
    }
    const active = wx.getStorageSync('activeDeviceId') as string;
    const found = active && list.find((d) => d.deviceId === active);
    if (found) {
      this.enter(found);
      return;
    }
    wx.redirectTo({ url: '/pages/devices/devices?pick=1' });
  },

  enter(d: MnpDevice) {
    wx.setStorageSync('activeDeviceId', d.deviceId);
    wx.setStorageSync('currentDevice', d);
    wx.redirectTo({
      url: `/pages/speaker/speaker?deviceId=${encodeURIComponent(d.deviceId)}`,
    });
  },
});
