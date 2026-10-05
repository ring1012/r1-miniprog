import { getWs } from '../../utils/ws-client';
import { getTheme, applyNavBar, Theme } from '../../utils/theme';
import { logger } from '../../utils/logger';
import { parseConfigStr } from '../../utils/v2';

interface AiForm {
  key: string;
  systemPrompt: string;
  model: string;
  endpoint: string;
  extraBody: string;
  cdn: string;
}

// AI配置：config.ai 查询 + config.ai.set 保存（对标 admin ai 页）。
// 老 admin 发两条 save1+save2，v2 合并为一条 {config,enabled,endpoint}。
// 验证走 admin 已部署的 edge 中转（https://air1.pp.ua/api/ai-test，
// request 白名单已有；小程序直调用户 endpoint 会被域名白名单卡死）。
const AI_TEST_URL = 'https://air1.pp.ua/api/ai-test';

/** 局域网端点：云端中转够不着，豁免验证直存（对标 admin 的 isLan 逻辑）。 */
function isLanEndpoint(url: string): boolean {
  const m = /^https?:\/\/([^/:?#]+)/i.exec((url || '').trim());
  if (!m) return false;
  const host = m[1].toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1') return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const m172 = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (m172) {
    const n = Number(m172[1]);
    if (n >= 16 && n <= 31) return true;
  }
  return false;
}
Component({
  data: {
    theme: 'dark' as Theme,
    enabled: false,
    form: {
      key: '',
      systemPrompt: '你是一个智能音箱',
      model: '',
      endpoint: '',
      extraBody: '',
      cdn: '',
    } as AiForm,
    loading: true,
    saved: false,
    verifying: false,
    verified: false,
    verifyMsg: '',
    isLan: false,
  },

  lifetimes: {},

  methods: {
    onLoad() {
      const theme = getTheme();
      this.setData({ theme });
      applyNavBar(theme);
      logger.debug('[ai] onLoad, request config.ai');
      const self = this;
      const h = function (d: unknown) { self._onAi(d); };
      (this as unknown as { _h: unknown })._h = h;
      getWs().on('config.ai', h);
      const snap = getWs().snapshot('config.ai') as { enabled?: boolean; config?: string; endpoint?: string } | undefined;
      if (snap) this._onAi(snap);
      getWs().request(['config.ai']).then(
        () => undefined,
        (e) => {
          logger.warn('[ai] request timeout:', e);
          this.setData({ loading: false as never });
          wx.showToast({ title: '设备无响应', icon: 'none' });
        }
      );
    },

    onShow() {
      const theme = getTheme();
      if (theme !== this.data.theme) this.setData({ theme });
      applyNavBar(theme);
    },

    onUnload() {
      const h = (this as unknown as { _h?: (d: unknown) => void })._h;
      if (h) getWs().off('config.ai', h);
      logger.debug('[ai] onUnload, unsubscribed');
    },

    _onAi(d: unknown) {
      const obj = ((d || {}) as { enabled?: boolean; config?: string; endpoint?: string });
      logger.debug('[ai] config.ai event, enabled:', obj.enabled);
      const parsed = parseConfigStr(obj.config);
      const cfg = (parsed.obj || {}) as Record<string, unknown>;
      const pick = (k: string): string => {
        const v = cfg[k];
        return v === undefined || v === null ? '' : String(v);
      };
      const endpoint = pick('endpoint') || (obj.endpoint !== undefined ? String(obj.endpoint) : '');
      this.setData({
        enabled: (!!obj.enabled as never),
        loading: (false as never),
        form: ({
          key: pick('key'),
          systemPrompt: pick('systemPrompt') || '你是一个智能音箱',
          model: pick('model'),
          endpoint,
          extraBody: pick('extraBody'),
          cdn: pick('cdn'),
        } as never),
        isLan: (isLanEndpoint(endpoint) as never),
        verified: (false as never),
        verifyMsg: ('' as never),
      });
    },

    onToggleEnabled() {
      this.setData({ enabled: !(this.data.enabled as boolean) as never, saved: (false as never) });
    },

    onInput(e: WechatMiniprogram.CustomEvent) {
      const field = (e.currentTarget.dataset.field || '') as string;
      const value = (e.detail as { value: string }).value;
      const form = { ...(this.data.form as AiForm) } as Record<string, string>;
      form[field] = value;
      // 表单一改验证即失效，必须重验（对标 admin 改表单清 testResult）
      this.setData({ form: (form as never), saved: (false as never), verified: (false as never), verifyMsg: ('' as never) });
      if (field === 'endpoint') this.setData({ isLan: (isLanEndpoint(value) as never) });
    },

    verify() {
      const f = this.data.form as AiForm;
      if (f.extraBody.trim()) {
        try {
          JSON.parse(f.extraBody);
        } catch {
          wx.showToast({ title: 'extraBody 不是合法 JSON', icon: 'none' });
          return;
        }
      }
      const endpoint = (f.endpoint || '').trim();
      const key = (f.key || '').trim();
      const model = (f.model || '').trim();
      if (!endpoint || !key || !model) {
        wx.showToast({ title: '请先填 endpoint/key/model', icon: 'none' });
        return;
      }
      if (isLanEndpoint(endpoint)) {
        this.setData({ verifyMsg: ('局域网端点无法在线验证，确认可用后可直接保存' as never) });
        return;
      }
      this.setData({ verifying: (true as never), verifyMsg: ('' as never) });
      logger.debug('[ai] verify via relay:', AI_TEST_URL);
      wx.request({
        url: AI_TEST_URL,
        method: 'POST',
        header: { 'Content-Type': 'application/json' },
        data: { endpoint, key, model, extraBody: f.extraBody },
        success: (res) => {
          const d = ((res.data || {}) as { success?: boolean; message?: string });
          if (res.statusCode >= 200 && res.statusCode < 300 && d.success) {
            // 验证通过即自动启用：点验证就是为了用，省一次手动拨开关
            this.setData({
              verifying: (false as never),
              verified: (true as never),
              enabled: (true as never),
              verifyMsg: ('验证成功，AI 已自动启用，可保存' as never),
            });
            wx.showToast({ title: '验证成功', icon: 'success' });
          } else {
            this.setData({
              verifying: (false as never),
              verified: (false as never),
              verifyMsg: ((d.message || ('验证失败：HTTP ' + res.statusCode)) as never),
            });
            wx.showToast({ title: '验证失败', icon: 'none' });
          }
        },
        fail: (err) => {
          logger.warn('[ai] verify request fail', err);
          this.setData({
            verifying: (false as never),
            verified: (false as never),
            verifyMsg: ('验证请求失败，请检查网络' as never),
          });
          wx.showToast({ title: '验证失败', icon: 'none' });
        },
      });
    },

    save() {
      const f = this.data.form as AiForm;
      const enabled = this.data.enabled as boolean;
      // 未验证不给存：配错 endpoint/key 存进音箱等于白配（局域网端点豁免直存）
      if (!(this.data.verified as boolean) && !(this.data.isLan as boolean)) {
        wx.showToast({ title: '请先验证连接', icon: 'none' });
        return;
      }
      // extraBody 必须是合法 JSON（音箱侧会二次解析）
      if (f.extraBody.trim()) {
        try {
          JSON.parse(f.extraBody);
        } catch {
          wx.showToast({ title: 'extraBody 不是合法 JSON', icon: 'none' });
          return;
        }
      }
      const config = JSON.stringify({
        key: f.key,
        systemPrompt: f.systemPrompt,
        model: f.model,
        endpoint: f.endpoint,
        extraBody: f.extraBody,
        cdn: f.cdn,
      });
      logger.debug('[ai] send config.ai.set, enabled:', enabled, 'config:', config);
      try {
        getWs().send('config.ai.set', { config, enabled, endpoint: f.endpoint });
        this.setData({ saved: true as never });
        wx.showToast({ title: '已保存', icon: 'success' });
      } catch (e) {
        logger.error('[ai] save failed', e);
        wx.showToast({ title: '发送失败', icon: 'none' });
      }
    },
  },
});
