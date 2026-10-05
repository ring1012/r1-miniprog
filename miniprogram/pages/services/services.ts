import { getWs } from '../../utils/ws-client';
import { getTheme, applyNavBar, Theme } from '../../utils/theme';
import { logger } from '../../utils/logger';
import { parseConfigStr } from '../../utils/v2';

// 服务配置：天气/音乐源/故事/HA 四卡（对标 admin services 页表单版）。
// 小程序没有 select 组件，用 picker + input 还原 admin 的结构化表单，
// 不再让用户手写 JSON：拉取→解析进表单→改→组装对象 JSON.stringify 再 set 回去。
const WEATHER_PROVIDERS = ['qweather'];
const WEATHER_LABELS = ['和风天气 (QWeather)'];

const MUSIC_PROVIDERS = ['default', 'youtube', 'bilibili', 'kw', 'tx', 'wy'];
const MUSIC_LABELS = ['🎵 默认', '▶️ YouTube Music', '📺 哔哩哔哩', '🎤 酷我', '🎧 腾讯', '📻 网易云'];

const STORY_PROVIDERS = ['youtube', 'bilibili'];
const STORY_LABELS = ['▶️ YouTube', '📺 哔哩哔哩'];

const MUSIC_PRESETS = [
  { label: '默认', url: 'https://media.thd.dpdns.org/music/v2' },
  { label: 'youtube', url: 'https://yt.huan.dedyn.io/youtube/music/v2' },
  { label: 'bilibili', url: 'https://bilibili.gptclub.top/music' },
  { label: '酷我', url: 'https://media.air1.bot.cd/music/v3/kw' },
  { label: 'QQ', url: 'https://media.air1.bot.cd/music/v3/tx' },
  { label: '网易', url: 'https://media.air1.bot.cd/music/v3/wy' },
];

const STORY_PRESETS = [
  { label: 'youtube', url: 'https://yt.huan.dedyn.io/youtube/audio/v2' },
  { label: 'bilibili', url: 'https://bilibili.gptclub.top/music' },
];

const TYPES = ['config.weather', 'config.music_service', 'config.story_service', 'config.hass'];

function idxOf(list: string[], v: unknown): number {
  const s = v === undefined || v === null ? '' : String(v);
  for (let i = 0; i < list.length; i++) {
    if (list[i] === s) return i;
  }
  return 0;
}

function pickStr(obj: Record<string, unknown>, k: string): string {
  const v = obj[k];
  return v === undefined || v === null ? '' : String(v);
}

Component({
  data: {
    theme: 'dark' as Theme,
    loading: true,
    weatherLabels: WEATHER_LABELS,
    musicLabels: MUSIC_LABELS,
    storyLabels: STORY_LABELS,
    musicPresets: MUSIC_PRESETS,
    storyPresets: STORY_PRESETS,
    weather: { providerIdx: 0, endpoint: '', apiKey: '', saved: false },
    music: { providerIdx: 0, endpoint: '', saved: false },
    story: { providerIdx: 0, endpoint: '', saved: false },
    hass: { ip: '', token: '', saved: false },
  },

  methods: {
    onLoad() {
      const theme = getTheme();
      this.setData({ theme });
      applyNavBar(theme);
      logger.debug('[services] onLoad, request 4 configs + forms');
      const ws = getWs();
      const self = this;
      const handlers: Array<(d: unknown) => void> = [];
      for (let i = 0; i < TYPES.length; i++) {
        const name = TYPES[i];
        const fn = function (d: unknown) {
          logger.debug('[services] event:', name);
          self.applyOne(name, ((d || {}) as { config?: string }));
        };
        handlers.push(fn);
        ws.on(name, fn);
        const snap = ws.snapshot(name) as { config?: string } | undefined;
        if (snap) this.applyOne(name, snap);
      }
      (this as unknown as { _handlers: unknown })._handlers = handlers;
      ws.request(TYPES).then(
        (m) => logger.debug('[services] 首屏聚合回包:', Object.keys(m)),
        (e) => {
          logger.warn('[services] request timeout:', e);
          wx.showToast({ title: '设备无响应', icon: 'none' });
        }
      );
      // 聚合回包/事件都会调 applyOne 关 loading；5s 兜底防一直转圈
      setTimeout(() => {
        this.setData({ loading: false as never });
      }, 5000);
    },

    onShow() {
      const theme = getTheme();
      if (theme !== this.data.theme) this.setData({ theme });
      applyNavBar(theme);
    },

    onUnload() {
      const handlers = ((this as unknown as { _handlers?: Array<(d: unknown) => void> })._handlers) || [];
      for (let i = 0; i < TYPES.length; i++) getWs().off(TYPES[i], handlers[i]);
      logger.debug('[services] onUnload, unsubscribed');
    },

    applyOne(name: string, data: { config?: string }) {
      const parsed = parseConfigStr(data.config);
      const cfg = ((parsed.obj || {}) as Record<string, unknown>);
      if (name === 'config.weather') {
        this.setData({
          weather: {
            providerIdx: idxOf(WEATHER_PROVIDERS, cfg['provider'] || 'qweather'),
            endpoint: pickStr(cfg, 'endpoint'),
            apiKey: pickStr(cfg, 'apiKey'),
            saved: false,
          } as never,
          loading: false as never,
        });
      } else if (name === 'config.music_service') {
        this.setData({
          music: {
            providerIdx: idxOf(MUSIC_PROVIDERS, cfg['provider']),
            endpoint: pickStr(cfg, 'endpoint'),
            saved: false,
          } as never,
          loading: false as never,
        });
      } else if (name === 'config.story_service') {
        this.setData({
          story: {
            providerIdx: idxOf(STORY_PROVIDERS, cfg['provider']),
            endpoint: pickStr(cfg, 'endpoint'),
            saved: false,
          } as never,
          loading: false as never,
        });
      } else if (name === 'config.hass') {
        this.setData({
          hass: {
            ip: pickStr(cfg, 'ip'),
            token: pickStr(cfg, 'token'),
            saved: false,
          } as never,
          loading: false as never,
        });
      }
      logger.debug('[services] apply', name, 'ok:', parsed.ok);
    },

    // —— 通用输入：data-section="weather|music|story|hass" data-field="endpoint|..." ——
    onInput(e: WechatMiniprogram.CustomEvent) {
      const ds = (e.currentTarget.dataset || {}) as { section?: string; field?: string };
      const value = (e.detail as { value: string }).value;
      const section = ds.section || '';
      const field = ds.field || '';
      if (section === 'weather') {
        const w = { ...(this.data.weather as Record<string, unknown>) } as Record<string, unknown>;
        w[field] = value;
        w['saved'] = false;
        this.setData({ weather: w as never });
      } else if (section === 'music') {
        const m = { ...(this.data.music as Record<string, unknown>) } as Record<string, unknown>;
        m[field] = value;
        m['saved'] = false;
        this.setData({ music: m as never });
      } else if (section === 'story') {
        const s = { ...(this.data.story as Record<string, unknown>) } as Record<string, unknown>;
        s[field] = value;
        s['saved'] = false;
        this.setData({ story: s as never });
      } else if (section === 'hass') {
        const h = { ...(this.data.hass as Record<string, unknown>) } as Record<string, unknown>;
        h[field] = value;
        h['saved'] = false;
        this.setData({ hass: h as never });
      }
    },

    onProviderChange(e: WechatMiniprogram.CustomEvent) {
      const ds = (e.currentTarget.dataset || {}) as { section?: string };
      const idx = Number((e.detail as { value: number }).value) || 0;
      const section = ds.section || '';
      if (section === 'weather') {
        const w = { ...(this.data.weather as Record<string, unknown>) } as Record<string, unknown>;
        w['providerIdx'] = idx;
        w['saved'] = false;
        this.setData({ weather: w as never });
      } else if (section === 'music') {
        const m = { ...(this.data.music as Record<string, unknown>) } as Record<string, unknown>;
        m['providerIdx'] = idx;
        m['saved'] = false;
        this.setData({ music: m as never });
      } else if (section === 'story') {
        const s = { ...(this.data.story as Record<string, unknown>) } as Record<string, unknown>;
        s['providerIdx'] = idx;
        s['saved'] = false;
        this.setData({ story: s as never });
      }
    },

    // 预设端点一键填入：data-section="music|story" data-url="..."
    usePreset(e: WechatMiniprogram.CustomEvent) {
      const ds = (e.currentTarget.dataset || {}) as { section?: string; url?: string };
      const url = ds.url || '';
      if (!url) return;
      if (ds.section === 'music') {
        const m = { ...(this.data.music as Record<string, unknown>) } as Record<string, unknown>;
        m['endpoint'] = url;
        m['saved'] = false;
        this.setData({ music: m as never });
      } else if (ds.section === 'story') {
        const s = { ...(this.data.story as Record<string, unknown>) } as Record<string, unknown>;
        s['endpoint'] = url;
        s['saved'] = false;
        this.setData({ story: s as never });
      }
    },

    saveWeather() {
      const w = this.data.weather as { providerIdx: number; endpoint: string; apiKey: string };
      const provider = WEATHER_PROVIDERS[w.providerIdx] || 'qweather';
      const endpoint = (w.endpoint || '').trim();
      const apiKey = (w.apiKey || '').trim();
      if (!endpoint.startsWith('https')) {
        wx.showToast({ title: 'Endpoint 须 https 开头', icon: 'none' });
        return;
      }
      if (!apiKey) {
        wx.showToast({ title: '请填写 API Key', icon: 'none' });
        return;
      }
      const config = JSON.stringify({ provider, endpoint, apiKey });
      logger.debug('[services] send config.weather.set:', config);
      try {
        getWs().send('config.weather.set', { config });
        this.setData({ 'weather.saved': true as never });
        wx.showToast({ title: '已保存', icon: 'success' });
      } catch (err) {
        logger.error('[services] save weather failed', err);
        wx.showToast({ title: '发送失败', icon: 'none' });
      }
    },

    saveMusic() {
      const m = this.data.music as { providerIdx: number; endpoint: string };
      const provider = MUSIC_PROVIDERS[m.providerIdx] || 'default';
      const endpoint = (m.endpoint || '').trim();
      const config = JSON.stringify({ provider, endpoint });
      logger.debug('[services] send config.music_service.set:', config);
      try {
        getWs().send('config.music_service.set', { config });
        this.setData({ 'music.saved': true as never });
        wx.showToast({ title: '已保存', icon: 'success' });
      } catch (err) {
        logger.error('[services] save music failed', err);
        wx.showToast({ title: '发送失败', icon: 'none' });
      }
    },

    saveStory() {
      const s = this.data.story as { providerIdx: number; endpoint: string };
      const provider = STORY_PROVIDERS[s.providerIdx] || 'youtube';
      const endpoint = (s.endpoint || '').trim();
      const config = JSON.stringify({ provider, endpoint });
      logger.debug('[services] send config.story_service.set:', config);
      try {
        getWs().send('config.story_service.set', { config });
        this.setData({ 'story.saved': true as never });
        wx.showToast({ title: '已保存', icon: 'success' });
      } catch (err) {
        logger.error('[services] save story failed', err);
        wx.showToast({ title: '发送失败', icon: 'none' });
      }
    },

    saveHass() {
      const h = this.data.hass as { ip: string; token: string };
      let ip = (h.ip || '').trim();
      if (ip.charAt(ip.length - 1) === '/') ip = ip.slice(0, ip.length - 1);
      const token = (h.token || '').trim();
      if (!ip) {
        wx.showToast({ title: '请填写 HA 地址', icon: 'none' });
        return;
      }
      if (ip.indexOf('http') !== 0) {
        wx.showToast({ title: '地址须 http(s) 开头', icon: 'none' });
        return;
      }
      if (!token) {
        wx.showToast({ title: '请填写访问令牌', icon: 'none' });
        return;
      }
      const config = JSON.stringify({ ip, token });
      logger.debug('[services] send config.hass.set, ip:', ip);
      try {
        getWs().send('config.hass.set', { config });
        this.setData({ hass: { ip, token, saved: true } as never });
        wx.showToast({ title: '已保存', icon: 'success' });
      } catch (err) {
        logger.error('[services] save hass failed', err);
        wx.showToast({ title: '发送失败', icon: 'none' });
      }
    },
  },
});
