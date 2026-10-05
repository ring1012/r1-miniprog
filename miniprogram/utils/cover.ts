// 封面图：对标 admin 的 /api/img-proxy 中转。
// 设备下发的 song.imgUrl（酷我等源）有防盗链/Referer 限制，小程序 <image> 直链经常 403，
// 所以统一走 admin 已部署的代理：https://air1.pp.ua/api/img-proxy?url=<encodeURIComponent(imgUrl)>，
// 服务端以浏览器 UA 抓图后回流（带长缓存 + CORS），用法见 r1-admin-page：
//   MiniPlayer.tsx:57 / music/page.tsx:220 / node-functions/api/img-proxy.js
// 注意：ES5 引擎，只用三元和 if。
import { queueOf, PlayerState } from './v2';

const IMG_PROXY_BASE = 'https://air1.pp.ua/api/img-proxy?url=';

/** 原始 imgUrl → 代理地址；空串直接返回空串（调用方 wx:if 兜底 emoji）。 */
export function coverUrl(imgUrl: unknown): string {
  if (imgUrl === undefined || imgUrl === null) return '';
  const raw = String(imgUrl);
  if (!raw) return '';
  // http(s) 才走代理；相对路径/本地包文件直接返回（理论上设备只会给 http，但防御一下）。
  if (raw.indexOf('http://') === 0 || raw.indexOf('https://') === 0) {
    try {
      return IMG_PROXY_BASE + encodeURIComponent(raw);
    } catch {
      return '';
    }
  }
  return raw;
}

/** 当前播放歌曲的代理封面（无封面返回空串）。 */
export function pickCover(st: PlayerState | null | undefined): string {
  const q = queueOf(st);
  const indexed = q.index >= 0 && q.index < q.list.length ? q.list[q.index] : null;
  if (!indexed) return '';
  return coverUrl(indexed.imgUrl);
}
