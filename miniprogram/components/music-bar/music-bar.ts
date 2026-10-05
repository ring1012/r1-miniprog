import { getWs } from '../../utils/ws-client';
import { coverUrl } from '../../utils/cover';

interface V2Position {
  musicId?: string;
  music_id?: string;
  playTimeMs?: number;
  play_time?: number;
  totalTimeMs?: number;
  total_time?: number;
  status?: number;
}

interface V2Song {
  title?: string;
  artist?: string;
  itemId?: string;
  imgUrl?: string;
}

interface V2States {
  playIndex?: number;
  playList?: V2Song[];
  playlist?: V2Song[];
  playMode?: number;
  playState?: number;
}

interface PlayerState {
  position?: V2Position;
  states?: V2States;
  volume?: number;
  serial?: string;
}

// 全局悬浮播放条：v2 单 type（player.state）驱动。
// 首屏 snapshot 秒出，无快照才 request 一次；之后不轮询，本地 1s 插值估算进度；
// 仅在收到 event[player.state] 或操作后以真实帧校准（进度无推送，靠播放器状态回调事件）。
// 注意：ES5 引擎，只用三元和 if。
Component({
  properties: {
    theme: { type: String, value: 'dark' },
  },
  data: {
    title: '未在播放',
    sub: '小讯播放器',
    timeText: '',
    playing: false,
    progress: 0,
    hasConn: false,
    cover: '',
    coverError: false,
    state: null as PlayerState | null,
    tickTimer: null as number | null,
  },
  lifetimes: {
    attached() {
      const ws = getWs();
      const snap = ws.snapshot('player.state') as PlayerState | undefined;
      if (snap) {
        this.applyState(snap);
      } else {
        ws.request(['player.state']).then(
          (m) => {
            const st = (m['player.state'] || null) as PlayerState | null;
            if (st) this.applyState(st);
          },
          () => undefined
        );
      }
      const self = this;
      const handler = function (d: unknown) { self._onState(d); };
      (this as unknown as { _wsHandler: unknown })._wsHandler = handler;
      ws.on('player.state', handler);
    },
    detached() {
      const ws = getWs();
      const h = (this as unknown as { _wsHandler?: (d: unknown) => void })._wsHandler;
      if (h) ws.off('player.state', h);
      this.stopTick();
    },
  },
  methods: {
    _onState(d: unknown) {
      const st = ((d || null) as PlayerState | null);
      if (!st) return;
      this.applyState(st);
    },

    applyState(st: PlayerState) {
      this.setData({ state: (st as never), hasConn: (true as never) });
      this.render();
      this.restartTick();
    },

    isPlaying(): boolean {
      const st = ((this.data.state || {}) as PlayerState);
      const pos = (st.position || {}) as V2Position;
      const status = typeof pos.status === 'number' ? pos.status : -1;
      if (status === 1 || status === 3) return true;
      const states = (st.states || {}) as V2States;
      if (typeof states.playState === 'number') {
        return states.playState === 1 || states.playState === 3;
      }
      return false;
    },

    restartTick() {
      this.stopTick();
      if (!this.isPlaying()) return;
      // 无明确歌曲时长不滚动进度条：等带 totalTimeMs 的事件来校准
      const st0 = ((this.data.state || null) as PlayerState | null);
      const p0 = (st0 && st0.position ? st0.position : {}) as V2Position;
      const t0 = this.num(p0.totalTimeMs !== undefined ? p0.totalTimeMs : p0.total_time, 0);
      if (t0 <= 0) return;
      const self = this;
      const timer = setInterval(function () {
        const st = ((self.data.state || {}) as PlayerState);
        const pos = (st.position || {}) as V2Position;
        const cur = self.num(pos.playTimeMs !== undefined ? pos.playTimeMs : pos.play_time, 0);
        const total = self.num(pos.totalTimeMs !== undefined ? pos.totalTimeMs : pos.total_time, 0);
        if (!self.isPlaying()) {
          self.stopTick();
          return;
        }
        if (total <= 0) {
          // 事件里时长没了，停止本地插值
          self.stopTick();
          self.render();
          return;
        }
        const next = Math.min(cur + 1000, total);
        const npos: V2Position = {
          musicId: pos.musicId !== undefined ? pos.musicId : pos.music_id,
          playTimeMs: next,
          totalTimeMs: total,
          status: pos.status,
        };
        const nst: PlayerState = {
          position: npos,
          states: st.states,
          volume: st.volume,
          serial: st.serial,
        };
        self.setData({ state: (nst as never) });
        self.render();
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

    num(v: unknown, dflt: number): number {
      const n = Number(v);
      if (isNaN(n)) return dflt;
      return n;
    },

    pickTitle(): string {
      const st = ((this.data.state || {}) as PlayerState);
      const states = (st.states || {}) as V2States;
      const list = states.playList || states.playlist || [];
      const idx = typeof states.playIndex === 'number' ? states.playIndex : -1;
      const indexed = idx >= 0 && idx < list.length ? list[idx] : null;
      const pos = (st.position || {}) as V2Position;
      if (indexed && indexed.title) return indexed.title;
      const mid = pos.musicId !== undefined ? pos.musicId : pos.music_id;
      if (mid) return mid;
      return '未在播放';
    },

    pickCover(): string {
      const st = ((this.data.state || {}) as PlayerState);
      const states = (st.states || {}) as V2States;
      const list = states.playList || states.playlist || [];
      const idx = typeof states.playIndex === 'number' ? states.playIndex : -1;
      const indexed = idx >= 0 && idx < list.length ? list[idx] : null;
      if (!indexed) return '';
      return coverUrl(indexed.imgUrl);
    },

    onCoverError() {
      if (!this.data.coverError) this.setData({ coverError: (true as never) });
    },

    render() {
      const st = ((this.data.state || {}) as PlayerState);
      const pos = (st.position || {}) as V2Position;
      const cur = this.num(pos.playTimeMs !== undefined ? pos.playTimeMs : pos.play_time, 0);
      const total = this.num(pos.totalTimeMs !== undefined ? pos.totalTimeMs : pos.total_time, 0);
      const playing = this.isPlaying();
      const raw = total > 0 ? Math.round((cur / total) * 100) : 0;
      const progress = raw > 100 ? 100 : raw;
      const right = total > 0 ? this.formatTime(total) : '--:--';
      const cover = this.pickCover();
      const oldCover = (this.data.cover as unknown as string) || '';
      const patch: Record<string, unknown> = {
        title: this.pickTitle(),
        sub: playing ? '播放中' : '已暂停',
        timeText: this.formatTime(cur) + ' / ' + right,
        playing,
        progress,
        cover,
      };
      // 切歌时清除旧失败标记，否则 error 态一直兜底 emoji
      if (cover !== oldCover) patch.coverError = false;
      this.setData(patch as never);
    },

    // 对标 MiniPlayer formatTime：h:mm:ss 或 m:ss（手写补零，老引擎无 padStart）
    formatTime(ms: number): string {
      const totalSeconds = Math.floor(ms / 1000);
      const hrs = Math.floor(totalSeconds / 3600);
      const min = Math.floor((totalSeconds % 3600) / 60);
      const sec = totalSeconds % 60;
      const mm = min < 10 ? '0' + min : '' + min;
      const ss = sec < 10 ? '0' + sec : '' + sec;
      if (hrs > 0) return hrs + ':' + mm + ':' + ss;
      return min + ':' + ss;
    },

    tap() {
      try {
        wx.vibrateShort({ type: 'light' });
      } catch {
        // ignore
      }
    },

    onToggle() {
      this.tap();
      const playing = this.data.playing as boolean;
      getWs().send(playing ? 'player.pause' : 'player.play');
    },

    onPrev() {
      this.tap();
      getWs().send('player.prev');
    },

    onNext() {
      this.tap();
      getWs().send('player.next');
    },

    goPlayer() {
      this.tap();
      const pages = getCurrentPages();
      const cur = pages.length ? pages[pages.length - 1] : null;
      const route = cur ? (cur.route || '') : '';
      if (route.indexOf('speaker') >= 0) return;
      if (route.indexOf('player') >= 0) return;
      wx.navigateTo({ url: '/pages/speaker/speaker' });
    },

    // 封面专属：直达「正在播放」页（catchtap 阻断冒泡，不会同时触发整条的 goPlayer）
    goCover() {
      this.tap();
      const pages = getCurrentPages();
      const cur = pages.length ? pages[pages.length - 1] : null;
      const route = cur ? (cur.route || '') : '';
      if (route.indexOf('player') >= 0) return;
      wx.navigateTo({ url: '/pages/player/player' });
    },
  },
});
