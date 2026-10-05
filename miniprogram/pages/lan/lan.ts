import { getWs } from '../../utils/ws-client';
import { getTheme, applyNavBar, Theme } from '../../utils/theme';
import { logger } from '../../utils/logger';
import { saveLanDevice, setActive, normLanIp, lanHost, getPhoneIp, sameSubnet24 } from '../../utils/mode';

// 添加局域网设备：手动输音箱 IP，直连 ws://ip:18888/ws/v2（同 v2 信封，无鉴权）。
// 设备只存本地（saveLanDevice），不上报服务器；选定后经 active 指针进入。
// 调开发者工具需勾选“不校验合法域名”；真机须与音箱同一 Wi-Fi。
Component({
  data: {
    theme: 'dark' as Theme,
    name: '局域网音箱',
    ipInput: '',
    testing: false,
    testResult: '',
    serial: '',
  },

  lifetimes: {},

  methods: {
    onLoad() {
      const theme = getTheme();
      this.setData({ theme });
      applyNavBar(theme);
      logger.debug('[lan] onLoad');
    },

    onShow() {
      const theme = getTheme();
      if (theme !== this.data.theme) this.setData({ theme });
      applyNavBar(theme);
    },

    onInput(e: WechatMiniprogram.CustomEvent) {
      this.setData({ ipInput: (((e.detail as { value: string }).value) as never) });
    },

    onNameInput(e: WechatMiniprogram.CustomEvent) {
      this.setData({ name: (((e.detail as { value: string }).value) as never) });
    },

    test() {
      const ip = normLanIp(this.data.ipInput as string);
      if (!ip) {
        wx.showToast({ title: 'IP 格式不对', icon: 'none' });
        return;
      }
      // 重试序号：连续点“测试”时，只有最新一轮能写 UI / 发起连接，
      // 老一轮的 getPhoneIp / device.info 回调直接丢弃，避免互相覆盖。
      const seq = (((this as unknown as { _testSeq?: number })._testSeq || 0) + 1);
      (this as unknown as { _testSeq?: number })._testSeq = seq;
      this.setData({ testing: true as never, testResult: '' as never, serial: '' as never });
      logger.debug('[lan] test connect:', ip);
      const self = this;
      // 同网段预检（官方免白名单条件之一）：只提醒不拦截
      void getPhoneIp().then((phoneIp) => {
        if (((self as unknown as { _testSeq?: number })._testSeq) !== seq) return;
        if (phoneIp && !sameSubnet24(phoneIp, lanHost(ip))) {
          logger.warn('[lan] subnet mismatch, phone:', phoneIp, 'target:', ip);
          self.setData({ testResult: ('手机和音箱好像不在同一个Wi-Fi下，先尝试连接，不行就切到同一个Wi-Fi再试' as never) });
        }
        self.doTestConnect(ip, seq);
      });
    },

    doTestConnect(ip: string, seq?: number) {
      const self = this;
      const cur = seq !== undefined ? seq : ((this as unknown as { _testSeq?: number })._testSeq || 0);
      const isStale = () => ((self as unknown as { _testSeq?: number })._testSeq) !== cur;
      try {
        getWs().connectLan(ip);
      } catch (e) {
        logger.error('[lan] connectLan threw', e);
        if (!isStale()) this.setData({ testing: false as never, testResult: '连接异常' as never });
        return;
      }
      getWs().request(['device.info']).then(
        (m) => {
          if (isStale()) return;
          const info = (m['device.info'] || {}) as { serial?: string };
          const serial = info.serial !== undefined ? String(info.serial) : '';
          logger.debug('[lan] device.info ok, serial:', serial);
          self.setData({ testing: false as never, serial: (serial as never), testResult: ('连通，serial=' + serial) as never });
        },
        (e) => {
          if (isStale()) return;
          logger.warn('[lan] device.info timeout:', e);
          self.setData({
            testing: false as never,
            testResult: ('连不上：请确认手机和音箱连着同一个Wi-Fi；iPhone用户还需在系统设置里允许微信访问本地网络，然后重试' as never),
          });
        }
      );
    },

    save() {
      const ip = normLanIp(this.data.ipInput as string);
      if (!ip) {
        wx.showToast({ title: 'IP 格式不对', icon: 'none' });
        return;
      }
      const name = ((this.data.name as unknown as string) || '局域网音箱').trim() || '局域网音箱';
      saveLanDevice({ deviceId: ip, name });
      setActive('lan', ip);
      logger.debug('[lan] save + enter:', ip);
      getWs().connectLan(ip);
      wx.redirectTo({ url: '/pages/speaker/speaker' });
    },
  },
});
