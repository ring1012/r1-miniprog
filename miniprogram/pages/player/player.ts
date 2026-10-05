import { getWs } from '../../utils/ws-client';
import { getTheme, applyNavBar, Theme } from '../../utils/theme';
import { logger } from '../../utils/logger';
import {
  PlayerState, V2Song, queueOf, pickTitle, curMs, totalMs, hasDuration,
  formatTime, statusText, modeText, isPlayingState, num, eqBands,
} from '../../utils/v2';
import { pickCover } from '../../utils/cover';

interface BandItem {
  key: string;
  value: number;
}

interface LyricLine {
  t: number;
  text: string;
}

interface EqPreset {
  name: string;
  values: number[];
}

// 均衡器预设：照搬 admin EqPanel（band0..band4 五段，选中即整组下发）。
const EQ_PRESETS: EqPreset[] = [
  { name: 'R1 默认 (Harman)', values: [0, 0, 0, 0, 0] },
  { name: 'R1 签名 (Signature)', values: [2, 1, 0, 1, 2] },
  { name: '极深低音 (Deep Impact)', values: [8, 5, 0, -2, -3] },
  { name: '丝滑人声 (Pure Silk)', values: [0, 2, 6, 2, 0] },
  { name: '通透水晶 (Crystal Air)', values: [-2, -1, 1, 5, 8] },
  { name: '深夜模式 (Midnight)', values: [5, 2, -2, 2, 4] },
  { name: '现场舞台 (Live Stage)', values: [4, 1, -1, 3, 6] },
  { name: '温暖爵士 (Warm Jazz)', values: [4, 5, 2, 0, -2] },
  { name: '电子能量 (Electronic)', values: [7, 3, -1, 3, 7] },
  { name: '清脆播客 (Podcast)', values: [-6, 0, 7, 4, -2] },
  { name: '流行 (Pop)', values: [3, 2, 0, 1, 2] },
  { name: '摇滚 (Rock)', values: [5, 3, -1, 2, 5] },
  { name: '爵士 (Jazz)', values: [4, 2, -2, 2, 0] },
  { name: '古典 (Classical)', values: [5, 3, 0, 2, 4] },
  { name: '人声 (Vocal)', values: [0, 2, 5, 3, 0] },
  { name: '电子 (Basic)', values: [6, 4, 0, 2, 5] },
  { name: '民谣 (Folk)', values: [2, 1, 0, 2, 3] },
  { name: '蓝调 (Blues)', values: [3, 4, 2, -2, 2] },
  { name: '舞曲 (Dance)', values: [4, 2, 0, 2, 4] },
];

// 频段中文标签：照搬 admin EqPanel。
const BAND_LABELS: Record<string, string> = {
  band0: '60 Hz',
  band1: '230 Hz',
  band2: '910 Hz',
  band3: '3.6 kHz',
  band4: '14 kHz',
};

/** 当前五段值命中哪个预设，无命中返回 -1（picker 回到占位）。 */
function matchPreset(eq: Record<string, unknown>): number {
  for (let p = 0; p < EQ_PRESETS.length; p++) {
    const v = EQ_PRESETS[p].values;
    let ok = true;
    for (let i = 0; i < 5; i++) {
      if (num(eq['band' + i], 0) !== v[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return p;
  }
  return -1;
}

// 歌词：对标 admin music 页（歌曲 url 取 id/lyricsType → /get-lyric → lrclist 高亮跟随，400ms 补偿）。
const LYRIC_URL = 'https://air1.pp.ua/get-lyric';
const LYRIC_OFFSET_MS = 400;

function lyricParam(url: string, key: string): string {
  const m = new RegExp('[?&]' + key + '=([^&]*)').exec(url || '');
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function lyricTypeOk(t: string): boolean {
  return t === 'kuwo' || t === 'youtube' || t.indexOf('lx-') === 0;
}

// 正在播放：player.state 全量渲染 + 全部 player.* 控制 + EQ 区（对标 admin music 页 + EqPanel）。
// 进度本地 1s 插值（与 music-bar 同逻辑），事件/操作后以真实帧校准，不轮询。
Component({
  data: {
    theme: 'dark' as Theme,
    state: null as PlayerState | null,
    title: '未在播放',
    artist: '小讯播放器',
    album: '',
    statusStr: '已停止',
    modeStr: '未知模式',
    mode: 0,
    cur: 0,
    total: 0,
    curText: '0:00',
    totalText: '--:--',
    progress: 0,
    playing: false,
    volume: 0,
    volumeMax: 15,
    cover: '',
    coverError: false,
    queue: [] as V2Song[],
    queueIndex: -1,
    showQueue: false,
    eq: null as Record<string, unknown> | null,
    bands: [] as BandItem[],
    bandLabels: BAND_LABELS,
    presetNames: ['选择预设音效…'].concat(EQ_PRESETS.map((p) => p.name)),
    presetIdx: 0,
    tickTimer: null as number | null,
    loading: true,
    showLyrics: false,
    lyrics: [] as LyricLine[],
    lyricIdx: -1,
    lrcScrollTop: 0,
    lyricLoading: false,
    lyricKey: '',
  },

  lifetimes: {},

  methods: {
    onLoad() {
      const theme = getTheme();
      this.setData({ theme });
      applyNavBar(theme);
      logger.debug('[player] onLoad, request player.state + config.eq');
      const self = this;
      const stateHandler = function (d: unknown) { self._onState(d); };
      const eqHandler = function (d: unknown) { self._onEq(d); };
      (this as unknown as { _stateHandler: unknown })._stateHandler = stateHandler;
      (this as unknown as { _eqHandler: unknown })._eqHandler = eqHandler;
      getWs().on('player.state', stateHandler);
      getWs().on('config.eq', eqHandler);
      const snapS = getWs().snapshot('player.state') as PlayerState | undefined;
      if (snapS) this.applyState(snapS);
      const snapE = getWs().snapshot('config.eq') as Record<string, unknown> | undefined;
      if (snapE) this.applyEq(snapE);
      // 快照缺啥补啥：有快照的不再重复拉；进度靠本地 1s 插值，后端推 event 校准。
      const need: string[] = [];
      if (!snapS) need.push('player.state');
      if (!snapE) need.push('config.eq');
      if (need.length === 0) {
        this.setData({ loading: (false as never) });
        logger.debug('[player] snapshot hit, skip request');
      } else {
        getWs().request(need).then(
          (m) => logger.debug('[player]首屏聚合回包:', Object.keys(m)),
          (e) => {
            logger.warn('[player] request timeout:', e);
            this.setData({ loading: false as never });
            wx.showToast({ title: '设备无响应', icon: 'none' });
          }
        );
      }
    },

    onShow() {
      const theme = getTheme();
      if (theme !== this.data.theme) this.setData({ theme });
      applyNavBar(theme);
      // 不轮询：切回本页不发 request，看本地插值 + 后端事件；
      // 若切后台期间有事件，已在 _onState 里校准并重起 tick，这里只保活 tick。
      this.restartTick();
    },

    onUnload() {
      const self = this as unknown as { _stateHandler?: (d: unknown) => void; _eqHandler?: (d: unknown) => void };
      if (self._stateHandler) getWs().off('player.state', self._stateHandler);
      if (self._eqHandler) getWs().off('config.eq', self._eqHandler);
      this.stopTick();
      logger.debug('[player] onUnload, unsubscribed');
    },

    _onState(d: unknown) {
      const st = ((d || null) as PlayerState | null);
      if (!st) return;
      logger.debug('[player] player.state event');
      this.applyState(st);
    },

    _onEq(d: unknown) {
      const eq = ((d || {}) as Record<string, unknown>);
      logger.debug('[player] config.eq event');
      this.applyEq(eq);
    },

    applyState(st: PlayerState) {
      const q = queueOf(st);
      const indexed = q.index >= 0 && q.index < q.list.length ? q.list[q.index] : null;
      const pos = st.position || {};
      const status = typeof pos.status === 'number' ? pos.status : 0;
      const pm = (st.states && typeof st.states.playMode === 'number')
        ? (st.states as { playMode: number }).playMode
        : num(st.playMode, 0);
      const cur = curMs(st);
      const total = totalMs(st);
      const raw = total > 0 ? Math.round((cur / total) * 100) : 0;
      const cover = pickCover(st);
      const oldCover = (this.data.cover as unknown as string) || '';
      const patch: Record<string, unknown> = {
        state: st,
        title: pickTitle(st),
        artist: (indexed && indexed.artist) || '小讯播放器',
        album: (indexed && indexed.album) || '',
        statusStr: statusText(status),
        modeStr: modeText(pm),
        mode: pm,
        cur,
        total,
        progress: raw > 100 ? 100 : raw,
        playing: isPlayingState(st),
        volume: num(st.volume, this.data.volume as number),
        volumeMax: num(st.volumeMax, 15),
        cover,
        queue: q.list,
        queueIndex: q.index,
        loading: false,
      };
      // 切歌（封面地址变化）时清除旧的加载失败标记，否则 error 态会一直兜底 emoji
      if (cover !== oldCover) patch.coverError = false;
      this.setData(patch as never);
      this.syncLyrics(indexed);
      this.updateLyricIdx(cur);
      this.renderTime();
      this.restartTick();
    },

    renderTime() {
      // 时间文本单独刷，避免整页 setData 开销感知；无明确时长显示 --:--
      const cur = this.data.cur as number;
      const total = this.data.total as number;
      const right = total > 0 ? formatTime(total) : '--:--';
      this.setData({ curText: (formatTime(cur) as never), totalText: (right as never) });
    },

    restartTick() {
      this.stopTick();
      const st = (this.data.state || null) as PlayerState | null;
      if (!isPlayingState(st)) return;
      // 无明确歌曲时长不滚动：等带 totalTimeMs 的事件来校准
      if (!hasDuration(st)) {
        logger.debug('[player] no duration in state, tick off');
        return;
      }
      const self = this;
      const timer = setInterval(function () {
        const st2 = (self.data.state || {}) as PlayerState;
        if (!isPlayingState(st2)) {
          self.stopTick();
          return;
        }
        const total = totalMs(st2);
        if (total <= 0) {
          // 事件里时长没了（换歌/未知），停止本地插值，进度留到下一帧校准
          self.stopTick();
          self.renderTime();
          return;
        }
        const next = Math.min(curMs(st2) + 1000, total);
        const pos = st2.position || {};
        const nst: PlayerState = {
          position: {
            musicId: pos.musicId !== undefined ? pos.musicId : pos.music_id,
            playTimeMs: next,
            totalTimeMs: total,
            status: pos.status,
          },
          states: st2.states,
          playMode: st2.playMode,
          volume: st2.volume,
          volumeMax: st2.volumeMax,
          serial: st2.serial,
        };
        self.setData({ state: (nst as never), cur: (next as never) });
        const raw = Math.round((next / total) * 100);
        self.setData({ progress: ((raw > 100 ? 100 : raw) as never) });
        self.updateLyricIdx(next);
        self.renderTime();
      }, 1000) as unknown as number;
      this.setData({ tickTimer: (timer as never) });
    },

    stopTick() {
      const t = (this.data.tickTimer as unknown as number | null);
      if (t !== null && t !== undefined) {
        try {
          clearInterval(t);
        } catch {
          // ignore
        }
        this.setData({ tickTimer: (null as never) });
      }
    },

    tap() {
      try {
        wx.vibrateShort({ type: 'light' });
      } catch {
        // ignore
      }
    },

    onCoverError() {
      // 主封面代理加载失败（源站挂/无图）：降级 emoji，不反复重试
      if (!this.data.coverError) this.setData({ coverError: (true as never) });
    },

    onToggle() {
      this.tap();
      const playing = this.data.playing as boolean;
      const type = playing ? 'player.pause' : 'player.play';
      logger.debug('[player] send', type);
      getWs().send(type);
    },

    onPrev() {
      this.tap();
      logger.debug('[player] send player.prev');
      getWs().send('player.prev');
    },

    onNext() {
      this.tap();
      logger.debug('[player] send player.next');
      getWs().send('player.next');
    },

    playIndex(e: WechatMiniprogram.CustomEvent) {
      this.tap();
      const idx = Number(e.currentTarget.dataset.index);
      logger.debug('[player] send player.play index:', idx);
      getWs().send('player.play', { index: idx });
    },

    toggleMode() {
      this.tap();
      const cur = (this.data.mode as number) || 0;
      const next = (cur % 3) + 1;
      logger.debug('[player] send player.mode:', next);
      getWs().send('player.mode', { mode: next });
    },

    // 进度条点播：按点击位置比例换算 seek（替代原生 slider，样式与主题统一）
    onBarSeek(e: WechatMiniprogram.CustomEvent) {
      this.tap();
      const total = (this.data.total as number) || 0;
      if (total <= 0) return;
      const self = this;
      const touch = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
      const clientX = touch ? touch.clientX : 0;
      const q = this.createSelectorQuery();
      q.select('.barzone').boundingClientRect(function (rect) {
        if (!rect || !rect.width) return;
        let ratio = (clientX - rect.left) / rect.width;
        if (ratio < 0) ratio = 0;
        if (ratio > 1) ratio = 1;
        const v = Math.round(ratio * total);
        logger.debug('[player] send player.seek:', v);
        getWs().send('player.seek', { positionMs: v });
      }).exec();
    },

    volStep(e: WechatMiniprogram.CustomEvent) {
      this.tap();
      const d = Number(e.currentTarget.dataset.d);
      const max = (this.data.volumeMax as number) || 15;
      const cur = (this.data.volume as number) || 0;
      const next = Math.max(0, Math.min(max, cur + d));
      logger.debug('[player] send player.volume:', next);
      getWs().send('player.volume', { volume: next });
    },

    onVolume(e: WechatMiniprogram.CustomEvent) {
      const v = Number((e.detail as { value: number }).value);
      logger.debug('[player] send player.volume:', v);
      getWs().send('player.volume', { volume: v });
    },

    toggleQueue() {
      this.tap();
      this.setData({ showQueue: !(this.data.showQueue as boolean) as never });
    },

    toggleLyrics() {
      this.tap();
      const show = !(this.data.showLyrics as boolean);
      this.setData({ showLyrics: (show as never) }, () => {
        if (show) this.centerLyric(this.data.lyricIdx as number);
      });
    },

    // ── 歌词区 ──
    syncLyrics(song: V2Song | null) {
      const url = (song && song.url) || '';
      const mid = (song && ((song as Record<string, unknown>).musicId !== undefined
        ? String((song as Record<string, unknown>).musicId)
        : String((song as Record<string, unknown>).music_id || ''))) || '';
      const key = url + '|' + mid + '|' + ((song && song.title) || '');
      if (key === (this.data.lyricKey as string)) return;
      this.setData({
        lyricKey: (key as never),
        lyrics: ([] as never),
        lyricIdx: (-1 as never),
        lyricLoading: (false as never),
      });
      if (!url) return;
      const id = lyricParam(url, 'id');
      const type = lyricParam(url, 'lyricsType');
      if (!id || !lyricTypeOk(type)) {
        logger.debug('[player] lyric skipped, id:', id, 'type:', type);
        return;
      }
      this.setData({ lyricLoading: (true as never) });
      logger.debug('[player] lyric fetch:', type, id);
      wx.request({
        url: LYRIC_URL + '?id=' + encodeURIComponent(id) + '&type=' + encodeURIComponent(type),
        success: (res) => {
          if (key !== (this.data.lyricKey as string)) return;
          const body = ((res.data || {}) as { code?: number; data?: { lrclist?: Array<{ lineLyric?: string; time?: string }> } });
          const raw = (body.data && body.data.lrclist) || [];
          const list: LyricLine[] = [];
          for (let i = 0; i < raw.length; i++) {
            const text = (raw[i].lineLyric || '').trim();
            if (!text) continue;
            const t = Math.round(Number(raw[i].time || 0) * 1000);
            if (isNaN(t)) continue;
            list.push({ t, text });
          }
          list.sort((a, b) => a.t - b.t);
          logger.debug('[player] lyric loaded, n:', list.length);
          this.setData({ lyrics: (list as never), lyricIdx: (-1 as never), lyricLoading: (false as never) });
          this.updateLyricIdx(this.data.cur as number);
        },
        fail: (err) => {
          if (key !== (this.data.lyricKey as string)) return;
          logger.warn('[player] lyric fetch fail', err);
          this.setData({ lyricLoading: (false as never) });
        },
      });
    },

    updateLyricIdx(cur: number) {
      const list = this.data.lyrics as LyricLine[];
      let idx = -1;
      if (list.length > 0) {
        const target = (cur || 0) + LYRIC_OFFSET_MS;
        for (let i = 0; i < list.length; i++) {
          if (list[i].t <= target) idx = i;
          else break;
        }
      }
      if (idx !== (this.data.lyricIdx as number)) {
        // 行号变化才 setData，渲染完成后手动居中（scroll-into-view 只保可见不居中）
        this.setData({ lyricIdx: (idx as never) }, () => {
          this.centerLyric(idx);
        });
      }
    },

    centerLyric(idx: number) {
      if (idx < 0 || !(this.data.showLyrics as boolean)) return;
      const q = this.createSelectorQuery();
      q.select('.lrcbox').boundingClientRect();
      q.select('#lrc' + idx).boundingClientRect();
      q.exec((res) => {
        const arr = (res || []) as Array<{ top?: number; height?: number } | null>;
        const box = arr[0];
        const item = arr[1];
        if (!box || !item || !box.height) return;
        const base = (this.data.lrcScrollTop as number) || 0;
        const target = base + (item.top || 0) - (box.top || 0) - box.height / 2 + (item.height || 0) / 2;
        this.setData({ lrcScrollTop: ((target < 0 ? 0 : Math.round(target)) as never) });
      });
    },

    // ── EQ 区 ──
    applyEq(eq: Record<string, unknown>) {
      const keys = eqBands(eq);
      const bands: BandItem[] = [];
      for (let i = 0; i < keys.length; i++) {
        bands.push({ key: keys[i], value: num(eq[keys[i]], 0) });
      }
      const m = matchPreset(eq);
      logger.debug('[player] eq bands:', keys.join(','), 'preset:', m);
      this.setData({ eq: (eq as never), bands: (bands as never), presetIdx: ((m + 1) as never) });
    },

    onBand(e: WechatMiniprogram.CustomEvent) {
      const key = (e.currentTarget.dataset.key || '') as string;
      const v = Number((e.detail as { value: number }).value);
      logger.debug('[player] send config.eq.set:', key, v);
      const patch: Record<string, unknown> = {};
      patch[key] = v;
      getWs().send('config.eq.set', patch);
      // 乐观更新本地条 + 回算预设命中（手动拧动后多半回到占位）
      const eq = { ...((this.data.eq || {}) as Record<string, unknown>) };
      eq[key] = v;
      const bands = (this.data.bands as BandItem[]).map((b) => (b.key === key ? { key, value: v } : b));
      this.setData({ eq: (eq as never), bands: (bands as never), presetIdx: ((matchPreset(eq) + 1) as never) });
    },

    onPresetChange(e: WechatMiniprogram.CustomEvent) {
      const idx = Number((e.detail as { value: number }).value) || 0;
      if (idx <= 0) return;
      const p = EQ_PRESETS[idx - 1];
      if (!p) return;
      const data: Record<string, number> = {};
      for (let i = 0; i < 5; i++) data['band' + i] = p.values[i];
      logger.debug('[player] apply eq preset:', p.name);
      getWs().send('config.eq.set', data);
      // 乐观更新：五段按预设值刷，其余键保留
      const eq = { ...((this.data.eq || {}) as Record<string, unknown>) };
      for (let i = 0; i < 5; i++) eq['band' + i] = p.values[i];
      const bands = (this.data.bands as BandItem[]).map((b) => (
        data[b.key] !== undefined ? { key: b.key, value: data[b.key] } : b
      ));
      this.setData({ eq: (eq as never), bands: (bands as never), presetIdx: (idx as never) });
    },
  },
});
