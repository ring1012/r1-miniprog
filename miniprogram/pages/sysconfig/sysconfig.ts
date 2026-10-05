import { getWs } from '../../utils/ws-client';
import { getTheme, applyNavBar, Theme } from '../../utils/theme';
import { logger } from '../../utils/logger';
import { getActive } from '../../utils/mode';
import { ensureMnpUserId, queryDevices, bindDevice, unbindDevice, MnpDevice } from '../../utils/api';
import { verifyDevice } from '../../utils/verify';

// 系统配置（仅局域网模式可见，对标 admin /config 页，不含 tg/bot 选择）。
// serial 取自 LAN device.info；校验走 connector /verify；绑定走 entry /mnp/*。
Component({
  data: {
    theme: 'dark' as Theme,
    isLan: false,
    serial: '',
    form: { deviceId: '', authCode: '', name: '我的音箱' },
    showAuth: false,
    verifyState: '',
    bound: [] as MnpDevice[],
  },

  lifetimes: {},

  methods: {
    onLoad() {
      const theme = getTheme();
      const active = getActive();
      const isLan = !!active && active.kind === 'lan';
      this.setData({ theme, isLan: (isLan as never) });
      applyNavBar(theme);
      logger.debug('[sysconfig] onLoad, isLan:', isLan);
      if (!isLan) return;
      const self = this;
      const h = function (d: unknown) { self._onInfo(d); };
      (this as unknown as { _h: unknown })._h = h;
      getWs().on('device.info', h);
      const snap = getWs().snapshot('device.info') as { serial?: string } | undefined;
      if (snap) this._onInfo(snap);
      else {
        getWs().request(['device.info']).then(
          () => undefined,
          (e) => logger.warn('[sysconfig] device.info timeout:', e)
        );
      }
      void this.loadBound();
    },

    onShow() {
      const theme = getTheme();
      if (theme !== this.data.theme) this.setData({ theme });
      applyNavBar(theme);
    },

    onUnload() {
      const h = (this as unknown as { _h?: (d: unknown) => void })._h;
      if (h) getWs().off('device.info', h);
      logger.debug('[sysconfig] onUnload, unsubscribed');
    },

    _onInfo(d: unknown) {
      const obj = ((d || {}) as { serial?: string });
      const serial = obj.serial !== undefined ? String(obj.serial) : '';
      logger.debug('[sysconfig] device.info serial:', serial);
      const form = { ...(this.data.form as Record<string, string>) };
      if (!form.deviceId && serial) form.deviceId = serial;
      this.setData({ serial: (serial as never), form: (form as never) });
    },

    async loadBound() {
      try {
        const mnpUserId = await ensureMnpUserId();
        const list = await queryDevices(mnpUserId);
        logger.debug('[sysconfig] bound count:', list.length);
        this.setData({ bound: (list as never) });
      } catch (e) {
        logger.warn('[sysconfig] loadBound failed', e);
      }
    },

    onInput(e: WechatMiniprogram.CustomEvent) {
      const field = (e.currentTarget.dataset.field || '') as string;
      const value = (e.detail as { value: string }).value;
      const form = { ...(this.data.form as Record<string, string>) };
      form[field] = value;
      this.setData({ form: (form as never), verifyState: ('' as never) });
    },

    toggleEye() {
      this.setData({ showAuth: !(this.data.showAuth as boolean) as never });
    },

    async doVerify() {
      const f = this.data.form as Record<string, string>;
      const did = (f.deviceId || '').trim();
      const ac = (f.authCode || '').trim();
      if (!did || !ac) {
        wx.showToast({ title: '请填写完整', icon: 'none' });
        return;
      }
      logger.debug('[sysconfig] verify:', did);
      const ok = await verifyDevice(did, ac);
      logger.debug('[sysconfig] verify result:', ok);
      this.setData({ verifyState: ((ok ? '校验通过' : '校验失败') as never) });
      if (!ok) wx.showToast({ title: '添加音箱失败', icon: 'none' });
    },

    async doBind() {
      const f = this.data.form as Record<string, string>;
      const did = (f.deviceId || '').trim();
      const ac = (f.authCode || '').trim();
      if (!did || !ac) {
        wx.showToast({ title: '请填写完整', icon: 'none' });
        return;
      }
      wx.showLoading({ title: '校验中' });
      try {
        const ok = await verifyDevice(did, ac);
        if (!ok) {
          wx.hideLoading();
          wx.showToast({ title: '添加音箱失败，请检查', icon: 'none' });
          return;
        }
        const mnpUserId = await ensureMnpUserId();
        const res = await bindDevice(mnpUserId, did, ac, (f.name || '我的音箱').trim() || '我的音箱');
        wx.hideLoading();
        logger.debug('[sysconfig] bind ok, list:', res.list.length);
        this.setData({ bound: (res.list as never) });
        wx.showToast({ title: '绑定成功', icon: 'success' });
      } catch (e) {
        wx.hideLoading();
        logger.error('[sysconfig] bind failed', e);
        wx.showToast({ title: '绑定失败', icon: 'none' });
      }
    },

    async doUnbind(e: WechatMiniprogram.CustomEvent) {
      const id = (e.currentTarget.dataset.id || '') as string;
      const confirm = await new Promise<boolean>((resolve) => {
        wx.showModal({
          title: '确认解绑？',
          content: id,
          success: (r) => resolve(r.confirm),
          fail: () => resolve(false),
        });
      });
      if (!confirm) return;
      try {
        const mnpUserId = await ensureMnpUserId();
        const res = await unbindDevice(mnpUserId, id);
        logger.debug('[sysconfig] unbind ok:', id);
        this.setData({ bound: (res.list as never) });
        wx.showToast({ title: '已解绑', icon: 'success' });
      } catch (e) {
        logger.error('[sysconfig] unbind failed', e);
        wx.showToast({ title: '解绑失败', icon: 'none' });
      }
    },

    goLan() {
      wx.navigateTo({ url: '/pages/lan/lan' });
    },
  },
});
