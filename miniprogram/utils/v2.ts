import { logger } from './logger';

// v2 消费侧共享类型与小工具（小程序端）。
// 注意：ES5 引擎，只用三元和 if，不用 ?. / ??。

export interface V2Position {
  musicId?: string;
  music_id?: string;
  playTimeMs?: number;
  play_time?: number;
  totalTimeMs?: number;
  total_time?: number;
  status?: number;
}

export interface V2Song {
  title?: string;
  artist?: string;
  album?: string;
  itemId?: string;
  id?: string;
  itemType?: number;
  url?: string;
  imgUrl?: string;
}

export interface V2States {
  playIndex?: number;
  playList?: V2Song[];
  playlist?: V2Song[];
  playMode?: number;
  playState?: number;
}

export interface PlayerState {
  position?: V2Position;
  states?: V2States;
  playMode?: number;
  volume?: number;
  volumeMax?: number;
  serial?: string;
}

export function num(v: unknown, dflt: number): number {
  const n = Number(v);
  if (isNaN(n)) return dflt;
  return n;
}

export function str(v: unknown, dflt: string): string {
  if (v === undefined || v === null) return dflt;
  return String(v);
}

/** 播放中判定：status 1 播放 / 3 缓冲（兼顾 states.playState）。 */
export function isPlayingState(st: PlayerState | null | undefined): boolean {
  if (!st) return false;
  const pos = st.position || {};
  if (pos.status === 1 || pos.status === 3) return true;
  const states = st.states || {};
  const ps = states.playState;
  if (ps === 1 || ps === 3) return true;
  return false;
}

export function posOf(st: PlayerState | null | undefined): V2Position {
  if (st && st.position) return st.position;
  return {};
}

export function queueOf(st: PlayerState | null | undefined): { list: V2Song[]; index: number } {
  const states = (st && st.states) || {};
  const list = states.playList || states.playlist || [];
  const index = typeof states.playIndex === 'number' ? states.playIndex : -1;
  return { list, index };
}

export function pickTitle(st: PlayerState | null | undefined): string {
  const q = queueOf(st);
  const indexed = q.index >= 0 && q.index < q.list.length ? q.list[q.index] : null;
  if (indexed && indexed.title) return indexed.title;
  const pos = posOf(st);
  const mid = pos.musicId !== undefined ? pos.musicId : pos.music_id;
  if (mid) return String(mid);
  return '未在播放';
}

export function curMs(st: PlayerState | null | undefined): number {
  const pos = posOf(st);
  const v = pos.playTimeMs !== undefined ? pos.playTimeMs : pos.play_time;
  return num(v, 0);
}

export function totalMs(st: PlayerState | null | undefined): number {
  const pos = posOf(st);
  const v = pos.totalTimeMs !== undefined ? pos.totalTimeMs : pos.total_time;
  return num(v, 0);
}

/** 事件是否携带明确的歌曲时长：只有 duration>0 才允许本地插值滚动进度条。 */
export function hasDuration(st: PlayerState | null | undefined): boolean {
  return totalMs(st) > 0;
}

/** 对标 MiniPlayer formatTime：h:mm:ss 或 m:ss（手写补零，老引擎无 padStart）。 */
export function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hrs = Math.floor(totalSeconds / 3600);
  const min = Math.floor((totalSeconds % 3600) / 60);
  const sec = totalSeconds % 60;
  const mm = min < 10 ? '0' + min : '' + min;
  const ss = sec < 10 ? '0' + sec : '' + sec;
  if (hrs > 0) return hrs + ':' + mm + ':' + ss;
  return min + ':' + ss;
}

/** 状态文案：1 正在播放 / 2 已暂停 / 3 正在缓冲。 */
export function statusText(status: number): string {
  if (status === 1) return '正在播放';
  if (status === 2) return '已暂停';
  if (status === 3) return '正在缓冲';
  return '已停止';
}

/** 模式文案：1 随机 / 2 顺序 / 3 单曲循环。 */
export function modeText(mode: number): string {
  if (mode === 1) return '随机播放';
  if (mode === 2) return '顺序播放';
  if (mode === 3) return '单曲循环';
  return '未知模式';
}

/** config.* 的 config 字符串二次解析（失败留原串，抄 admin MusicContext 做法）。 */
export function parseConfigStr(s: unknown): { ok: boolean; obj: unknown } {
  if (typeof s !== 'string' || !s) return { ok: true, obj: {} };
  try {
    return { ok: true, obj: JSON.parse(s) };
  } catch (e) {
    logger.warn('[v2] config JSON.parse failed, keep raw:', e);
    return { ok: false, obj: s };
  }
}

/** 从 config.eq 里按 band0..bandN 顺序抽频段键。 */
export function eqBands(eq: Record<string, unknown> | null | undefined): string[] {
  const out: string[] = [];
  if (!eq) return out;
  const keys = Object.keys(eq);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k.indexOf('band') === 0) out.push(k);
  }
  out.sort();
  return out;
}

/** 版本时间戳 → M月d日 HH:mm（抄 admin versions formatVersion）。 */
export function formatVersion(ts: unknown): string {
  const n = Number(ts);
  if (!n) return '---';
  try {
    const d = new Date(n);
    if (isNaN(d.getTime())) return String(ts);
    const month = d.getMonth() + 1;
    const day = d.getDate();
    const h = d.getHours();
    const m = d.getMinutes();
    const hh = h < 10 ? '0' + h : '' + h;
    const mm = m < 10 ? '0' + m : '' + m;
    return month + '月' + day + '日 ' + hh + ':' + mm;
  } catch {
    return String(ts);
  }
}
