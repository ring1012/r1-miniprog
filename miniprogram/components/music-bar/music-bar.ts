import { getWs } from '../../utils/ws-client';

interface BarPos {
  playTimeMs?: number;
  status?: number;
  totalTimeMs?: number;
  musicId?: string;
}

interface BarQueue {
  index?: number;
  list?: Array<{ title?: string }>;
}

// 全局悬浮播放条：对标 admin-page MiniPlayer（顶部进度线 + 封面/曲名/状态 + 上一首/播停/下一首）。
// 数据源走全局 ws 单例 + snapshot，挂载晚也能秒出状态；无连接时自动隐藏。
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
    pos: null as BarPos | null,
    queue: null as BarQueue | null,
  },
  lifetimes: {
    attached() {
      const ws = getWs();
      const snapPos = ws.snapshot('playback.position') as BarPos | undefined;
      const snapQueue = ws.snapshot('playback.queue') as BarQueue | undefined;
      const snapState = ws.snapshot('playback.state') as {
        position?: BarPos;
        queue?: BarQueue;
      } | undefined;
      if (snapPos || snapQueue || snapState) {
        const pos = (snapState && snapState.position ? snapState.position : snapPos) || null;
        const queue = (snapState && snapState.queue ? snapState.queue : snapQueue) || null;
        this.setData({ pos: pos as never, queue: queue as never, hasConn: true as never });
        this.render();
      }
      ws.on('playback.position', this._onPosition);
      ws.on('playback.queue', this._onQueue);
      ws.on('playback.state', this._onState);
      ws.on('playback.progress', this._onProgress);
    },
    detached() {
      const ws = getWs();
      ws.off('playback.position', this._onPosition);
      ws.off('playback.queue', this._onQueue);
      ws.off('playback.state', this._onState);
      ws.off('playback.progress', this._onProgress);
    },
  },
  methods: {
    _onPosition(d: unknown) {
      this.setData({ pos: ((d || null) as BarPos | null) as never, hasConn: true as never });
      this.render();
    },

    _onQueue(d: unknown) {
      this.setData({ queue: ((d || null) as BarQueue | null) as never, hasConn: true as never });
      this.render();
    },

    _onState(d: unknown) {
      const s = (d || {}) as { position?: BarPos; queue?: BarQueue };
      const patch: Record<string, unknown> = {};
      if (s.position) patch.pos = s.position;
      if (s.queue) patch.queue = s.queue;
      patch.hasConn = true;
      this.setData(patch as never);
      this.render();
    },

    _onProgress(d: unknown) {
      const p = (d || {}) as { playTimeMs?: number };
      const cur = ((this.data.pos || {}) as BarPos);
      const next: BarPos = {
        playTimeMs: p.playTimeMs !== undefined ? p.playTimeMs : cur.playTimeMs,
        status: cur.status,
        totalTimeMs: cur.totalTimeMs,
        musicId: cur.musicId,
      };
      this.setData({ pos: next as never, hasConn: true as never });
      this.render();
    },

    render() {
      const pos = ((this.data.pos || {}) as BarPos);
      const queue = ((this.data.queue || {}) as BarQueue);
      const list = queue.list || [];
      const idx = typeof queue.index === 'number' ? queue.index : -1;
      const indexed = idx >= 0 && idx < list.length ? list[idx] : null;
      const title = (indexed && indexed.title) || pos.musicId || '未在播放';
      const playing = pos.status === 1 || pos.status === 3;
      const total = pos.totalTimeMs || 0;
      const cur = pos.playTimeMs || 0;
      const raw = total > 0 ? Math.round((cur / total) * 100) : 0;
      const progress = raw > 100 ? 100 : raw;
      this.setData({
        title: title as never,
        sub: (playing ? '播放中' : '已暂停') as never,
        timeText: (this.formatTime(cur) + ' / ' + this.formatTime(total)) as never,
        playing: playing as never,
        progress: progress as never,
      });
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

    onToggle() {
      const playing = this.data.playing as boolean;
      getWs().send(playing ? 'playback.pause' : 'playback.play');
    },

    onPrev() {
      getWs().send('playback.prev');
    },

    onNext() {
      getWs().send('playback.next');
    },

    goPlayer() {
      const pages = getCurrentPages();
      const cur = pages.length ? pages[pages.length - 1] : null;
      const route = cur ? (cur.route || '') : '';
      if (route.indexOf('speaker') >= 0) return;
      wx.navigateTo({ url: '/pages/speaker/speaker' });
    },
  },
});
