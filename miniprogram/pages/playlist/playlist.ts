import { getWs } from '../../utils/ws-client';
import { getTheme, applyNavBar, Theme } from '../../utils/theme';
import { logger } from '../../utils/logger';
import { V2Song, PlayerState, queueOf, pickTitle } from '../../utils/v2';
import { getActive } from '../../utils/mode';

interface Song extends V2Song {
  key: string;
}

interface Pl {
  uuid: string;
  name: string;
  desc: string;
}

// 音乐与歌单：search.search 搜歌 + player.play_list 点播 + 服务端歌单 CRUD（对标 admin playlist 页）。
// 搜索是异步两段式：先回 accepted，再等 search.result 事件出真结果。
// 歌单走线上 `/api/playlist`（x-r1-serial 头鉴权，serial 取自 player.state，取不到用当前公网 deviceId）。
const PL_BASE = 'https://air1.pp.ua/api/playlist';

// 发给歌单接口的歌曲只留有效字段（去 key，防脏数据进 KV）。
function cleanSong(s: Song): Record<string, unknown> {
  return {
    itemId: (s.itemId || (s as Record<string, unknown>).id || '') as string,
    title: s.title || '',
    artist: s.artist || '',
    album: s.album || '',
    url: s.url || '',
    imgUrl: s.imgUrl || '',
    itemType: typeof s.itemType === 'number' ? s.itemType : 0,
  };
}

Component({
  data: {
    theme: 'dark' as Theme,
    keyword: '',
    searching: false,
    results: [] as Song[],
    queueCount: 0,
    queueTitle: '未在播放',
    serial: '',
    playlists: [] as Pl[],
    plNames: [] as string[],
    plIdx: 0,
    currentUuid: '',
    plSongs: [] as Song[],
    plLoading: false,
    songsLoading: false,
    showCreate: false,
    newPlName: '',
    addIdx: -1,
  },

  lifetimes: {},

  methods: {
    onLoad() {
      const theme = getTheme();
      this.setData({ theme });
      applyNavBar(theme);
      logger.debug('[playlist] onLoad');
      // 注意：小程序 methods 不会自动绑定 this，直接传 this._onX 会丢 this，
      // ws 回调里 this.setData 即抛错（之前被 emit 静默吞掉，表现为收到数据但不渲染）。
      // 这里包一层闭包并留引用，onUnload 用同一引用 off。
      const self = this;
      const searchHandler = function (d: unknown) { self._onSearchResult(d); };
      const stateHandler = function (d: unknown) { self._onPlayerState(d); };
      (this as unknown as { _searchHandler: unknown })._searchHandler = searchHandler;
      (this as unknown as { _stateHandler: unknown })._stateHandler = stateHandler;
      getWs().on('search.result', searchHandler);
      getWs().on('player.state', stateHandler);
      const snapQ = getWs().snapshot('player.state') as PlayerState | undefined;
      if (snapQ) this._onPlayerState(snapQ);
      this.ensureSerialAndLoad();
    },

    onShow() {
      const theme = getTheme();
      if (theme !== this.data.theme) this.setData({ theme });
      applyNavBar(theme);
      // 从别页连上设备回来时补拉歌单；已有则不重复拉
      if (!(this.data.serial as string) || (this.data.playlists as Pl[]).length === 0) {
        this.ensureSerialAndLoad();
      }
    },

    onUnload() {
      const self = this as unknown as { _searchHandler?: (d: unknown) => void; _stateHandler?: (d: unknown) => void };
      if (self._searchHandler) getWs().off('search.result', self._searchHandler);
      if (self._stateHandler) getWs().off('player.state', self._stateHandler);
      logger.debug('[playlist] onUnload, unsubscribed');
    },

    // ── 歌单：serial 解析 + 拉取 ──
    resolveSerial(): string {
      const snap = getWs().snapshot('player.state') as PlayerState | undefined;
      if (snap && snap.serial) return String(snap.serial);
      const a = getActive();
      if (a && a.kind === 'cloud' && a.deviceId) return a.deviceId;
      return '';
    },

    ensureSerialAndLoad() {
      const s = this.resolveSerial();
      if (!s) {
        logger.debug('[playlist] no serial yet, wait player.state');
        return;
      }
      if (s !== (this.data.serial as string)) this.setData({ serial: (s as never) });
      if ((this.data.playlists as Pl[]).length === 0) this.fetchPlaylists();
    },

    fetchPlaylists() {
      const serial = (this.data.serial as string) || this.resolveSerial();
      if (!serial) return;
      this.setData({ serial: (serial as never), plLoading: (true as never) });
      wx.request({
        url: PL_BASE + '?action=list',
        header: { 'x-r1-serial': serial },
        success: (res) => {
          let data = (res.data || []) as Pl[];
          if (!Array.isArray(data)) data = [];
          // 默认收藏置顶（对标 admin）
          if (!data.some((p) => p.uuid === 'default')) {
            data = [{ uuid: 'default', name: '我的收藏', desc: '默认收藏歌单' }].concat(data);
          } else {
            data = data.map((p) => (p.uuid === 'default' ? { ...p, name: '我的收藏' } : p));
          }
          const names = data.map((p) => p.name || p.uuid);
          let idx = 0;
          const cur = this.data.currentUuid as string;
          if (cur) {
            for (let i = 0; i < data.length; i++) {
              if (data[i].uuid === cur) {
                idx = i;
                break;
              }
            }
          }
          this.setData({
            playlists: (data as never),
            plNames: (names as never),
            plIdx: (idx as never),
            currentUuid: (data.length > 0 ? data[idx].uuid : '' as never),
            plLoading: (false as never),
          });
          if (data.length > 0) this.fetchSongs(data[idx].uuid);
          else this.setData({ plSongs: ([] as never) });
        },
        fail: (err) => {
          logger.warn('[playlist] fetch playlists fail', err);
          this.setData({ plLoading: (false as never) });
          wx.showToast({ title: '歌单加载失败', icon: 'none' });
        },
      });
    },

    fetchSongs(uuid: string) {
      const serial = this.data.serial as string;
      if (!serial || !uuid) return;
      this.setData({ songsLoading: (true as never) });
      wx.request({
        url: PL_BASE + '?action=get_songs&uuid=' + encodeURIComponent(uuid),
        header: { 'x-r1-serial': serial },
        success: (res) => {
          const raw = (res.data || []) as Song[];
          const list = Array.isArray(raw) ? raw : [];
          for (let i = 0; i < list.length; i++) list[i].key = 'p' + i;
          this.setData({ plSongs: (list as never), songsLoading: (false as never) });
        },
        fail: (err) => {
          logger.warn('[playlist] fetch songs fail', err);
          this.setData({ songsLoading: (false as never) });
        },
      });
    },

    onPlChange(e: WechatMiniprogram.CustomEvent) {
      const idx = Number((e.detail as { value: number }).value) || 0;
      const list = this.data.playlists as Pl[];
      const p = list[idx];
      if (!p) return;
      this.setData({ plIdx: (idx as never), currentUuid: (p.uuid as never) });
      this.fetchSongs(p.uuid);
    },

    playPlSong(e: WechatMiniprogram.CustomEvent) {
      const idx = Number(e.currentTarget.dataset.index);
      const list = this.data.plSongs as Song[];
      const s = list[idx];
      if (!s) return;
      this.playList([s]);
    },

    playAllPl() {
      const list = this.data.plSongs as Song[];
      if (list.length === 0) {
        wx.showToast({ title: '本单暂无歌曲', icon: 'none' });
        return;
      }
      this.playList(list);
    },

    removePlSong(e: WechatMiniprogram.CustomEvent) {
      const idx = Number(e.currentTarget.dataset.index);
      const list = this.data.plSongs as Song[];
      const s = list[idx];
      const uuid = this.data.currentUuid as string;
      const serial = this.data.serial as string;
      const songId = (s && (s.itemId || '')) || '';
      if (!s || !uuid || !songId) return;
      wx.request({
        url: PL_BASE + '?action=remove_song&uuid=' + encodeURIComponent(uuid) + '&songId=' + encodeURIComponent(songId),
        method: 'DELETE',
        header: { 'x-r1-serial': serial },
        success: (res) => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            const next = list.filter((_, i) => i !== idx);
            this.setData({ plSongs: (next as never) });
            wx.showToast({ title: '已删除', icon: 'success' });
          } else {
            wx.showToast({ title: '删除失败', icon: 'none' });
          }
        },
        fail: () => wx.showToast({ title: '删除失败', icon: 'none' }),
      });
    },

    // ── 搜索结果 → 加歌单 ──
    openAdd(e: WechatMiniprogram.CustomEvent) {
      const idx = Number(e.currentTarget.dataset.index);
      if ((this.data.playlists as Pl[]).length === 0) {
        wx.showToast({ title: '歌单未加载', icon: 'none' });
        return;
      }
      this.setData({ addIdx: (idx as never) });
    },

    closeAdd() {
      this.setData({ addIdx: (-1 as never) });
    },

    noop() {
      // 拦截 sheet 内冒泡，空实现
    },

    addToPl(e: WechatMiniprogram.CustomEvent) {
      const uuid = (e.currentTarget.dataset.uuid || '') as string;
      const idx = this.data.addIdx as number;
      const song = (this.data.results as Song[])[idx];
      const serial = this.data.serial as string;
      if (!uuid || !song || !serial) return;
      wx.request({
        url: PL_BASE + '?action=add_song',
        method: 'POST',
        header: { 'x-r1-serial': serial, 'Content-Type': 'application/json' },
        data: { uuid, song: cleanSong(song) },
        success: (res) => {
          const body = ((res.data || {}) as { success?: boolean; error?: string; uuid?: string });
          if (res.statusCode >= 200 && res.statusCode < 300 && (body.success || res.statusCode === 200)) {
            // 正选歌单本地追加（对标 admin 去重追加）
            if (uuid === (this.data.currentUuid as string)) {
              const list = [...(this.data.plSongs as Song[])];
              const sid = (song.itemId || '') as string;
              if (!list.some((s) => (s.itemId || '') === sid)) {
                list.push({ ...(cleanSong(song) as unknown as Song), key: 'p' + list.length });
                this.setData({ plSongs: (list as never) });
              }
            }
            this.setData({ addIdx: (-1 as never) });
            wx.showToast({ title: '已加入歌单', icon: 'success' });
          } else {
            wx.showToast({ title: body.error || '加入失败', icon: 'none' });
          }
        },
        fail: () => wx.showToast({ title: '加入失败', icon: 'none' }),
      });
    },

    // ── 新建 / 删除歌单 ──
    toggleCreate() {
      this.setData({ showCreate: !(this.data.showCreate as boolean) as never });
    },

    onCreateInput(e: WechatMiniprogram.CustomEvent) {
      this.setData({ newPlName: (((e.detail as { value: string }).value || '') as never) });
    },

    createPl() {
      const name = ((this.data.newPlName as string) || '').trim();
      const serial = this.data.serial as string;
      if (!name) {
        wx.showToast({ title: '先输入歌单名称', icon: 'none' });
        return;
      }
      if (!serial) {
        wx.showToast({ title: '未获取到设备 serial', icon: 'none' });
        return;
      }
      wx.request({
        url: PL_BASE + '?action=create',
        method: 'POST',
        header: { 'x-r1-serial': serial, 'Content-Type': 'application/json' },
        data: { name },
        success: (res) => {
          const body = ((res.data || {}) as { success?: boolean; error?: string });
          if (res.statusCode >= 200 && res.statusCode < 300 && (body.success || res.statusCode === 200)) {
            this.setData({ showCreate: (false as never), newPlName: ('' as never) });
            this.fetchPlaylists();
            wx.showToast({ title: '已创建', icon: 'success' });
          } else {
            wx.showToast({ title: body.error || '创建失败', icon: 'none' });
          }
        },
        fail: () => wx.showToast({ title: '创建失败', icon: 'none' }),
      });
    },

    deletePl() {
      const uuid = this.data.currentUuid as string;
      const serial = this.data.serial as string;
      const list = this.data.playlists as Pl[];
      let name = uuid;
      for (let i = 0; i < list.length; i++) {
        if (list[i].uuid === uuid) name = list[i].name;
      }
      if (!uuid || uuid === 'default') {
        wx.showToast({ title: '默认收藏不可删除', icon: 'none' });
        return;
      }
      const self = this;
      wx.showModal({
        title: '删除歌单？',
        content: '「' + name + '」及其中歌曲将一并删除。',
        success(r) {
          if (!r.confirm) return;
          wx.request({
            url: PL_BASE + '?action=delete&uuid=' + encodeURIComponent(uuid),
            method: 'DELETE',
            header: { 'x-r1-serial': serial },
            success: (res) => {
              if (res.statusCode >= 200 && res.statusCode < 300) {
                self.setData({ currentUuid: ('' as never) });
                self.fetchPlaylists();
                wx.showToast({ title: '已删除', icon: 'success' });
              } else {
                wx.showToast({ title: '删除失败', icon: 'none' });
              }
            },
            fail: () => wx.showToast({ title: '删除失败', icon: 'none' }),
          });
        },
      });
    },

    // ── 搜索 + 点播（原有） ──
    _onPlayerState(d: unknown) {
      const st = ((d || null) as PlayerState | null);
      if (!st) return;
      // player.state 捎带 serial：之前拿不到 serial 的话现在补上并拉歌单
      if (st.serial && !(this.data.serial as string)) {
        this.setData({ serial: (String(st.serial) as never) });
        if ((this.data.playlists as Pl[]).length === 0) this.fetchPlaylists();
      }
      const q = queueOf(st);
      this.setData({
        queueCount: q.list.length as never,
        queueTitle: (pickTitle(st) as never),
      });
    },

    _onSearchResult(d: unknown) {
      const obj = ((d || {}) as { accepted?: boolean; keyword?: string; count?: number; pageIndex?: number; musicinfo?: unknown[]; itemList?: unknown[]; musicList?: unknown[] });
      if (obj.accepted) {
        logger.debug('[playlist] search accepted:', obj.keyword);
        return;
      }
      const raw = obj.itemList || obj.musicList || obj.musicinfo || [];
      logger.debug('[playlist] search.result event, n:', raw.length, 'pageIndex:', obj.pageIndex);
      const list: Song[] = [];
      for (let i = 0; i < raw.length && i < 100; i++) {
        const s = (raw[i] || {}) as Record<string, unknown>;
        const id = s.itemId !== undefined ? s.itemId : s.id;
        list.push({
          title: s.title !== undefined ? String(s.title) : '未知曲名',
          artist: s.artist !== undefined ? String(s.artist) : '',
          album: s.album !== undefined ? String(s.album) : '',
          itemId: id !== undefined ? String(id) : '',
          itemType: typeof s.itemType === 'number' ? s.itemType : 0,
          url: s.url !== undefined ? String(s.url) : '',
          imgUrl: s.imgUrl !== undefined ? String(s.imgUrl) : '',
          key: 'r' + i,
        });
      }
      this.setData({ results: list as never, searching: false as never });
      if (list.length === 0) wx.showToast({ title: '无搜索结果', icon: 'none' });
    },

    onKeywordInput(e: WechatMiniprogram.CustomEvent) {
      this.setData({ keyword: ((e.detail as { value: string }).value as never) });
    },

    doSearch() {
      const kw = ((this.data.keyword as unknown as string) || '').trim();
      if (!kw) {
        wx.showToast({ title: '先输入关键词', icon: 'none' });
        return;
      }
      if (this.data.searching) return;
      this.setData({ searching: true as never, results: [] as never });
      logger.debug('[playlist] send search.search:', kw);
      try {
        getWs().send('search.search', { keyword: kw });
      } catch (e) {
        logger.error('[playlist] send failed', e);
        this.setData({ searching: false as never });
        wx.showToast({ title: '发送失败', icon: 'none' });
        return;
      }
      const self = this;
      setTimeout(() => {
        // 35s 还没等到真结果：按超时处理（抄 admin）
        if (self.data.searching) {
          self.setData({ searching: false as never });
          logger.warn('[playlist] search timeout for:', kw);
          wx.showToast({ title: '搜索超时，请重试', icon: 'none' });
        }
      }, 35000);
    },

    playOne(e: WechatMiniprogram.CustomEvent) {
      const idx = Number(e.currentTarget.dataset.index);
      const list = this.data.results as Song[];
      const song = list[idx];
      if (!song) return;
      this.playList([song]);
    },

    playAll() {
      const list = this.data.results as Song[];
      if (list.length === 0) return;
      this.playList(list);
    },

    playList(songs: Song[]) {
      const itemList = songs.map((s) => ({
        itemId: s.itemId,
        title: s.title,
        artist: s.artist,
        album: s.album,
        url: s.url,
        imgUrl: s.imgUrl,
        itemType: s.itemType || 0,
      }));
      logger.debug('[playlist] send player.play_list, n:', itemList.length);
      try {
        getWs().send('player.play_list', { itemList, index: 0 });
        wx.showToast({ title: '已下发播放', icon: 'success' });
      } catch (e) {
        logger.error('[playlist] play_list send failed', e);
        wx.showToast({ title: '发送失败', icon: 'none' });
      }
    },
  },
});
