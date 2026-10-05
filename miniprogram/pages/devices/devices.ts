import { ensureMnpUserId, queryDevices, bindDevice, unbindDevice, MnpDevice } from '../../utils/api';
import { verifyDevice } from '../../utils/verify';
import { getWs } from '../../utils/ws-client';
import { getTheme, setTheme, applyNavBar, THEMES, Theme } from '../../utils/theme';
import { logger } from '../../utils/logger';
import { getLanDevices, removeLanDevice, getActive, setActive, clearActive, LanDevice } from '../../utils/mode';

Component({
  data: {
    list: [] as MnpDevice[],
    lanList: [] as LanDevice[],
    activeKind: 'cloud' as string,
    activeId: '' as string,
    showAuth: {} as Record<string, boolean>,
    pickMode: false,
    loading: true,
    menuOpen: false,
    theme: 'dark' as Theme,
    themeList: THEMES,
    form: { deviceId: '', authCode: '', name: '', isNew: true },
    formVisible: false,
  },
  lifetimes: {},
  methods: {
    onLoad(options: Record<string, string>) {
      const theme = getTheme();
      const pick = ((options && options.pick) || '') === '1';
      this.setData({ pickMode: pick, theme });
      applyNavBar(theme);
      logger.debug('[devices] onLoad');
      void this.load();
    },
    onShow() {
      const theme = getTheme();
      if (theme !== this.data.theme) this.setData({ theme });
      applyNavBar(theme);
      // 返回时刷新本地局域网列表与选中态（lan 页保存后回来即见）
      this.setData({
        lanList: (getLanDevices() as never),
      });
      // 删的是公网当前设备时 active 可能已顺延，这里只做展示同步
      const shown = getActive();
      this.setData({
        activeKind: ((shown ? shown.kind : 'cloud') as never),
        activeId: ((shown ? shown.deviceId : '') as never),
      });
    },
    async load() {
      // 缓存先行秒开，后台刷新补新（stale-while-revalidate），避免两次网络串行堵首屏
      const cachedUser = wx.getStorageSync('mnpUserId') as string;
      let hasCache = false;
      try {
        const cache = wx.getStorageSync('deviceListCache') as {
          user: string;
          list: MnpDevice[];
        } | null;
        if (cache && cache.user && cache.user === cachedUser && cache.list && cache.list.length) {
          this.setData({ list: cache.list, loading: false });
          hasCache = true;
        } else {
          this.setData({ loading: true });
        }
      } catch {
        this.setData({ loading: true });
      }
      try {
        const mnpUserId = await ensureMnpUserId();
        const list = await queryDevices(mnpUserId);
        try {
          wx.setStorageSync('deviceListCache', { user: mnpUserId, list });
        } catch {
          // ignore
        }
        const prefill = wx.getStorageSync('prefillDevice') as Partial<MnpDevice> | null;
        if (prefill && prefill.deviceId) {
          wx.removeStorageSync('prefillDevice');
          this.setData({
            list,
            loading: false,
            formVisible: true,
            form: {
              deviceId: prefill.deviceId || '',
              authCode: prefill.authCode || '',
              name: prefill.name || '我的音箱',
              isNew: true,
            },
          });
          return;
        }
        this.setData({ list, loading: false });
      } catch {
        // 有缓存就留着看，只提示刷新失败；无缓存才结束 loading
        if (!hasCache) this.setData({ loading: false });
        wx.showToast({ title: hasCache ? '刷新失败' : '加载失败', icon: 'none' });
      }
    },

    toggleAvatarMenu() {
      this.setData({ menuOpen: !this.data.menuOpen });
    },

    closeAvatarMenu() {
      if (this.data.menuOpen) this.setData({ menuOpen: false });
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
      this.setData({ theme: next, menuOpen: false });
    },

    onMenuManage() {
      // 已在设备页：刷新列表
      this.setData({ menuOpen: false });
      void this.load();
    },

    toggleEye(e: WechatMiniprogram.CustomEvent) {
      const id = (e.currentTarget.dataset.id || '') as string;
      const showAuth = { ...(this.data.showAuth as Record<string, boolean>) };
      showAuth[id] = !showAuth[id];
      this.setData({ showAuth });
    },

    openAdd() {
      this.setData({ formVisible: true, form: { deviceId: '', authCode: '', name: '我的音箱', isNew: true } });
    },

    openEdit(e: WechatMiniprogram.CustomEvent) {
      const id = (e.currentTarget.dataset.id || '') as string;
      const found = (this.data.list as MnpDevice[]).find((d) => d.deviceId === id);
      if (!found) return;
      this.setData({
        formVisible: true,
        form: { deviceId: found.deviceId, authCode: found.authCode, name: found.name, isNew: false },
      });
    },

    closeForm() {
      this.setData({ formVisible: false });
    },

    noop() {},

    onFormInput(e: WechatMiniprogram.CustomEvent) {
      const field = (e.currentTarget.dataset.field || '') as 'deviceId' | 'authCode' | 'name';
      const value = (e.detail as { value: string }).value;
      this.setData({ [`form.${field}`]: value });
    },

    async submitForm() {
      const { deviceId, authCode, name } = this.data.form as { deviceId: string; authCode: string; name: string };
      const did = deviceId.trim();
      const ac = authCode.trim();
      if (!did || !ac) {
        wx.showToast({ title: '请填写完整', icon: 'none' });
        return;
      }
      wx.showLoading({ title: '校验中' });
      try {
        const ok = await verifyDevice(did, ac);
        if (!ok) {
          wx.hideLoading();
          wx.showToast({ title: '添加音箱失败，请检查 deviceId 和 authCode', icon: 'none' });
          return;
        }
        const mnpUserId = await ensureMnpUserId();
        const res = await bindDevice(mnpUserId, did, ac, name.trim() || '我的音箱');
        wx.hideLoading();
        this.setData({ formVisible: false, list: res.list });
        try {
          wx.setStorageSync('deviceListCache', { user: mnpUserId, list: res.list });
        } catch {
          // ignore
        }
        wx.showToast({ title: '保存成功', icon: 'success' });
      } catch {
        wx.hideLoading();
        wx.showToast({ title: '保存失败', icon: 'none' });
      }
    },

    async remove(e: WechatMiniprogram.CustomEvent) {
      const id = (e.currentTarget.dataset.id || '') as string;
      const confirm = await new Promise<boolean>((resolve) => {
        wx.showModal({
          title: '确认删除？',
          content: id,
          success: (r) => resolve(r.confirm),
          fail: () => resolve(false),
        });
      });
      if (!confirm) return;
      try {
        const mnpUserId = await ensureMnpUserId();
        const res = await unbindDevice(mnpUserId, id);
        const cur = wx.getStorageSync('currentDevice') as MnpDevice | null;
        if (cur && cur.deviceId === id) {
          getWs().close();
          wx.removeStorageSync('currentDevice');
        }
        const active = wx.getStorageSync('activeDeviceId') as string;
        if (active === id) {
          const next = (res.list[0] && res.list[0].deviceId) || '';
          if (next) wx.setStorageSync('activeDeviceId', next);
          else wx.removeStorageSync('activeDeviceId');
        }
        // 同步选中指针：删的是当前设备则顺延/清空
        const sel = getActive();
        if (sel && sel.kind === 'cloud' && sel.deviceId === id) {
          const next = (res.list[0] && res.list[0].deviceId) || '';
          if (next) setActive('cloud', next);
          else clearActive();
        }
        this.setData({ list: res.list });
        try {
          wx.setStorageSync('deviceListCache', { user: mnpUserId, list: res.list });
        } catch {
          // ignore
        }
        wx.showToast({ title: '已删除', icon: 'success' });
      } catch {
        wx.showToast({ title: '删除失败', icon: 'none' });
      }
    },

    choose(e: WechatMiniprogram.CustomEvent) {
      // 公网卡片点击即进入设备（选择模式/管理模式一致）
      const id = (e.currentTarget.dataset.id || '') as string;
      const found = (this.data.list as MnpDevice[]).find((d) => d.deviceId === id);
      if (!found) return;
      logger.debug('[devices] choose cloud:', id);
      setActive('cloud', found.deviceId);
      wx.setStorageSync('activeDeviceId', found.deviceId);
      wx.setStorageSync('currentDevice', found);
      wx.redirectTo({ url: `/pages/speaker/speaker?deviceId=${encodeURIComponent(found.deviceId)}` });
    },

    chooseLan(e: WechatMiniprogram.CustomEvent) {
      // 局域网卡片：只写本地选中指针，不碰服务器
      const id = (e.currentTarget.dataset.id || '') as string;
      const found = (this.data.lanList as LanDevice[]).find((d) => d.deviceId === id);
      if (!found) return;
      logger.debug('[devices] choose lan:', id);
      setActive('lan', found.deviceId);
      wx.redirectTo({ url: '/pages/speaker/speaker' });
    },

    async removeLan(e: WechatMiniprogram.CustomEvent) {
      const id = (e.currentTarget.dataset.id || '') as string;
      const confirm = await new Promise<boolean>((resolve) => {
        wx.showModal({
          title: '删除局域网设备？',
          content: id + '（仅删本地记录）',
          success: (r) => resolve(r.confirm),
          fail: () => resolve(false),
        });
      });
      if (!confirm) return;
      const list = removeLanDevice(id);
      logger.debug('[devices] remove lan:', id);
      const active = getActive();
      this.setData({
        lanList: (list as never),
        activeKind: ((active ? active.kind : 'cloud') as never),
        activeId: ((active ? active.deviceId : '') as never),
      });
      wx.showToast({ title: '已删除', icon: 'success' });
    },

    goLanAdd() {
      wx.navigateTo({ url: '/pages/lan/lan' });
    },
  },
});
