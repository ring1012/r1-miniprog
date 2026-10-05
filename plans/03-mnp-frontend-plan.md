# 03 - 小程序前端实施 Plan（v2 聚合协议消费侧）

> 前置：`plans/01-ws-v2-design.md`（信封思想）、`plans/02-mnp-design.md`（绑定/路由/全局单例）。
> 本文件 = 前一次讨论的 §3（异步数据）+ §4（type 穷举 + sample）落盘，
> 外加小程序页面/菜单映射（对标 `E:\workspace\r1-admin-page`，去掉最后一个「系统配置」）。
> 实现位置：`E:\workspace\r1-miniprog\miniprogram`；`ws-client.ts` 与 `music-bar.ts` 已切 v2，本 plan 只管页面层。

## 0. 页面与菜单映射（admin-page → miniprog）

admin 导航（`admin-page/src/components/Header.tsx:18-28`）共 9 项，去掉最后 1 项：

| # | admin 路由 | 小程序页面 | 状态 | 用的 v2 数据 |
|---|---|---|---|---|
| 1 | `/` 首页 | `pages/speaker/speaker`（已有，需加菜单入口） | 改 | `player.state`（仅 music-bar 间接消费） |
| 2 | `/about` 功能指引 | `pages/guide/guide`（新建，纯静态，抄 `AboutContent.tsx` 文案） | 新建 | 无（不建 ws 订阅也行，共用全局连接） |
| 3 | `/message` 控制器 | `pages/controller/controller`（新建） | 新建 | `message.send` 下发，`chat.reply` 展示（what=100 回声） |
| 4 | `/playlist` 音乐与歌单 | `pages/playlist/playlist`（新建） | 新建 | `search.search` + `search.result` + `player.play_list` |
| 5 | `/music` 正在播放 | `pages/player/player`（新建，含 EQ 区，对标 `music/page.tsx` + `EqPanel.tsx`） | 新建 | `player.state` 全量 + 全部 `player.*` 控制 + `config.eq` |
| 6 | `/versions` 版本管理 | `pages/versions/versions`（新建） | 新建 | `system.versions` + `system.upgrade` |
| 7 | `/ai` AI配置 | `pages/ai/ai`（新建） | 新建 | `config.ai` + `config.ai.set` |
| 8 | `/services` 服务配置 | `pages/services/services`（新建，四卡：天气/音乐源/故事/HA） | 新建 | `config.weather/music_service/story_service/hass` + `.set` |
| 9 | `/config` 系统配置 | **不要**（设备绑定/解绑走小程序已有 `pages/devices/devices` + `/mnp/*` 接口） | — | — |

已有复用：`pages/gateway/gateway`（入口路由）、`pages/devices/devices`（绑定管理）、`components/music-bar`（v2 已就绪，见 §5）、`utils/ws-client.ts`（`getWs/request/send/on/off/snapshot`）。

菜单形态：小程序无顶栏导航，走 `speaker` 页抽屉/宫格入口（现有 `drawerOpen/menuOpen` 扩展），8 个入口：功能指引 / 控制器 / 音乐与歌单 / 正在播放 / 版本管理 / AI配置 / 服务配置 / 设备管理。

## 1. 全局约定（所有页面遵守）

1. 连接只有一条：`getWs()` 单例，进 `speaker` 页时 `connect({deviceId,authCode})`，之后各页只 `on/off`，**绝不自建 `wx.connectSocket`**，`onUnload` 只 `off` 本页订阅。
2. 首屏三件套：`onLoad → on(name,render) + request([...本页types])`；`snapshot(name)` 先秒出骨架；`request` 5s 超时 → toast“设备无响应”+ 回滚乐观态。
3. 事件与回包同通道：`result[].name` 分发不区分 `reqId` 有无；多终端 last-wins，后到的 `event` 直接覆盖渲染。
4. `error` 帧只 toast（含 `forType`），不断连；`4401` 走 `onAuthFail` → 退回 `devices` 页（`ws-client` 已处理）。
5. 心跳 30s `{"type":"ping"}` 与指数退避重连由单例负责；重连成功后各页**重发一次本页 `request`**（取最新快照，`music-bar` 已示范）。

## 2. v2 信封速查（消费侧视角）

```ts
// 发：查询（types 可多个，一次回一帧）
{ v: 2, to: ["speaker"], reqId: "mnp:{ts}:{seq}", type: "data.get", types: ["player.state", ...] }
// 发：控制
{ v: 2, to: ["speaker"], reqId: "...", type: "player.pause", params: {...} }
// 收：聚合回包（reqId 原样）/ 主动事件（无 reqId），都按 result[].name 渲染
{ v: 2, from: "speaker", to: ["mnp"], reqId?: "...", type?: "event", result: [{ name, data }] }
// 错：{ v: 2, type: "error", data: { message, forType } }
```

## 3. 异步数据（请求与响应分离，页面必须按事件写）

| # | 操作 | 音箱内部链路 | 页面写法 |
|---|---|---|---|
| 1 | `search.search{keyword}` | 仅 `msgcenter(65536,1024,0)` 转发，搜索联网完成后经 `search.result` **事件**推送；回包只有 `{accepted:true}` | `send()` 后转圈；**订阅 `search.result`** 到真结果才渲染；`request()` 等不到结果（5s 超时会 reject，属正常，catch 吞掉） |
| 2 | `system.upgrade{apkName,version}` | 新线程下载安装，**无进度/完成事件**（`system.upgrade_progress` 名字预留、无生产者） | 回 `{accepted:true,apkName}` 即受理成功，提示“后台升级中”；隔几分钟重 `request(['system.versions'])` 对比时间戳确认 |
| 3 | `player.play/play_list/next/prev` 切歌 | 切歌触发网络加载，回包是**切换前快照** | 先渲染回包；等随后状态事件自动校准（last-wins，不额外轮询；无进度节拍，靠播放器状态回调推事件） |
| 4 | `message.send` 非 100 的任意 `what` | 盲转发进 `msgcenter`，结果不可知 | 回 `{ok:true}` = 已投递；`what=100` 的回声走 `chat.reply{text}` 事件展示 |

## 4. type 穷举（微信端视角）

### 4.1 可发送（15 组，含 1 查询 + 14 控制）

| type | params | 回包 name | 页面 |
|---|---|---|---|
| `data.get` | `types: string[]`（见 4.2 的 9 个 name 任选组合） | 同 `types` 一一对应的条目 | 所有页首屏 |
| `player.play` | `{index?}`（无 index = 继续播） | `player.state` | player / music-bar / playlist |
| `player.play_list` | `{itemList:[{itemId,title,artist,…}], index?}`（`itemId` 必带，`index/pageIndex` 音箱侧忽略） | `player.state` | playlist（一键播放/单曲播放） |
| `player.pause` / `player.next` / `player.prev` | 无 | `player.state` | player / music-bar |
| `player.seek` | `{positionMs}`（毫秒） | `player.state` | player（进度条点击） |
| `player.volume` | `{volume}`（0~`volumeMax`，`volumeMax` 见 `player.state`，一般 15） | `player.state` | player（步进 + / −，不用 slider 连续发，松手发一次） |
| `player.mode` | `{mode}`（1 随机 / 2 顺序 / 3 单曲循环，对标 `music/page.tsx:390-397` 取模切换） | `player.state` | player |
| `search.search` | `{keyword}` | `search.result{accepted,keyword}` 立即 + 真结果事件稍后 | playlist |
| `message.send` | `{what,arg1,arg2,obj}`（表单，预设见 admin `/api/commands`，`what=100` 会回声到 `chat.reply`） | `chat.reply{ok}` 或回声事件 | controller |
| `config.ai.set` | `{config?,enabled?,endpoint?}`（`config` 为 AI 参数 JSON 字符串，`enabled` 布尔，`endpoint` 会被音箱归一化补 `http://`/去尾 `/`） | `config.ai`（合并后全量） | ai |
| `config.weather.set` / `config.music_service.set` / `config.story_service.set` / `config.hass.set` | `{config}`（JSON 字符串，原样存） | 对应 `config.*` | services（四卡各一套 query/set） |
| `config.eq.set` | 扁平 patch（`{band0..bandN(dB,-15~15),bassBoost,loudness,nxpVolume,…}`，除 `type` 外全量合并存储） | `config.eq` | player 页 EQ 区（对标 `EqPanel.tsx`，query 也走 `data.get` 取 `config.eq`） |
| `system.upgrade` | `{apkName:"new_echo.apk"\|"new_uni.apk", version:"<latest>"}`（latest 取 OTA txt，见 6.3） | `system.versions{accepted,apkName}` | versions |

### 4.2 可接收（`result[].name`，共 10 个 + error）

| name | data 形状 | 生产者 | 订阅页 |
|---|---|---|---|
| `player.state` | `{position{musicId,playTimeMs,totalTimeMs,status}, states{playIndex,playList[{album,artist,itemId,itemType,title,url,imgUrl}],playMode,playState}, playMode, volume, volumeMax, serial}` | 查询回包；控制回包；切歌/暂停/seek/音量/模式后事件；上线推送；播放器状态变化事件（进度无推送） | player / music-bar（全页常驻）/ playlist（播哪首高亮，可选订） |
| `device.info` | `{serial,volumeMax}` | 查询回包 | 预留（设备页展示用，不急） |
| `config.ai` | `{enabled,config,endpoint}`（`config` 是 JSON 字符串，二次 `JSON.parse`，失败留原串——抄 `MusicContext` 做法） | 查询/设置回包 | ai |
| `config.weather` / `config.music_service` / `config.story_service` / `config.hass` | `{config}`（同上二次解析） | 查询/设置回包 | services |
| `config.eq` | `{band0..N,eqEnabled,currentPreset,bassBoost,bassBoostEnabled,loudness,loudnessEnabled,nxpVolume,nxpVolumeEnabled,availableEffects[]}`（唯一无 `status` 概念的回执，整包即数据） | 查询/设置回包 | player EQ 区 |
| `system.versions` | `{echo,unisound}`（毫秒时间戳，前端 `formatVersion` 转 `M月d日 HH:mm`，抄 `versions/page.tsx:15-30`） | 查询回包 | versions |
| `search.result` | 查询态 `{accepted,keyword}`；真结果 `{count,musicinfo[]}`（**对象直传**，老 LAN 是二次序列化 string，小程序按新格式取 `itemList/musicList/musicinfo` 三字段兼容，抄 `playlist/page.tsx:249-257` 归一化 `itemId=id||itemId`） | 回包 + 事件 | playlist |
| `chat.reply` | `{text}`（`what=100` 回声）/ `{ok}`（纯受理） | 回包 + 事件 | controller |
| `error` | `{message,forType}` | 未知 type/name、缺参 | 全局 toast |

### 4.3 Samples（可直接当联调用例）

```json
// S1 首屏多 type 一次拉（player 页 onLoad）
→ {"v":2,"to":["speaker"],"reqId":"mnp:1728000000000:7","type":"data.get","types":["player.state","config.eq"]}
← {"v":2,"from":"speaker","to":["mnp"],"reqId":"mnp:1728000000000:7","result":[
  {"name":"player.state","data":{"position":{"musicId":"夜曲","playTimeMs":42000,"totalTimeMs":240000,"status":1},"states":{"playIndex":2,"playList":[{"title":"夜曲","artist":"周杰伦"}],"playMode":0},"volume":8,"volumeMax":15,"serial":"R1XX"}},
  {"name":"config.eq","data":{"band0":5,"eqEnabled":true,"currentPreset":0}}]}

// S2 控制暂停（回包 + 同设备其他端同步事件，两帧同内容）
→ {"v":2,"to":["speaker"],"reqId":"mnp:...:8","type":"player.pause"}
← {"v":2,"from":"speaker","to":["mnp"],"reqId":"mnp:...:8","result":[{"name":"player.state","data":{/* status=2 快照 */}}]}
← {"v":2,"from":"speaker","to":["mnp"],"type":"event","result":[{"name":"player.state","data":{/* 同上 */}}]}

// S3 搜索两段（playlist 页）
→ {"v":2,"to":["speaker"],"reqId":"mnp:...:9","type":"search.search","params":{"keyword":"周杰伦"}}
← {"v":2,"from":"speaker","to":["mnp"],"reqId":"mnp:...:9","result":[{"name":"search.result","data":{"accepted":true,"keyword":"周杰伦"}}]}
← 事件 {"v":2,"from":"speaker","to":["mnp"],"type":"event","result":[{"name":"search.result","data":{"count":20,"musicinfo":[...]}}]}

// S4 未知 name 不断连（types 里混一个错的， 对的照常回）
→ types:["player.state","xxx.yyy"]
← player.state 条目正常回，另补 {"v":2,"type":"error","data":{"message":"unknown name: xxx.yyy","forType":"xxx.yyy"}}
```

## 5. music-bar（已实现，页面只管引入）

* 每个 speaker 系页面 `wxml` 引入 `<music-bar>`（`speaker` 页已有，他页照抄）；详情 `player` 页可隐藏（对标 `MiniPlayer` 行为，`goPlayer` 已处理路由判断）。
* 数据源：`snapshot('player.state')` 秒出 → 否则 `request(['player.state'])`；订阅唯一 `player.state`。
* 进度本地 1s 插值（`playTimeMs+=1000` 封顶 `totalTimeMs`），暂停即停；仅事件/操作后以真实帧校准，**不轮询**（无进度节拍）。

## 6. 分页实施要点

### 6.1 `pages/player/player`（正在播放，对标 `music/page.tsx`）

* `request(['player.state','config.eq'])` 双 type 一次拉；订阅两个 name。
* 曲名取 `states.playList[playIndex].title ?? position.musicId`；状态文案 `status:1 播放中/2 已暂停/3 正在缓冲`；模式文案 `1 随机/2 顺序/3 单曲循环`，切换算法 `(playMode)%3+1`。
* 进度条：本地 tick 值渲染，点击按比例 `seek({positionMs})`（毫秒，注意 admin 用 `position` 系毫秒值，v2 统一 `positionMs`）。
* 音量：`volume/volumeMax` 展示，用 `+/−` 步进（松手发 `player.volume`，不用 slider 高频发）。
* EQ 区（对标 `EqPanel`）：`config.eq` 渲染 `band0..N` slider + 开关；改动合并为 patch 一次 `config.eq.set`；乐观更新 + 回包覆盖。
* 歌词：admin 走同域 `/get-lyric`，小程序无此通道——**v1 不做**（只展示封面 `imgUrl`/曲名/歌手/专辑）。

### 6.2 `pages/playlist/playlist`（音乐与歌单，对标 `playlist/page.tsx`）

* 搜索框 → `send('search.search',{keyword})` + 转圈；`on('search.result')` 收到真结果（`count/musicinfo`）才停转渲染；`isSearching` 35s 超时兜底（抄 admin）。
* 结果归一化：`itemList/musicList/musicinfo` 三字段兼容，`itemId=id||itemId`，上限取 100 条渲染。
* 点播单曲 / 全部播放 / 歌单播放 → `send('player.play_list',{itemList,index:0})`（`index` 音箱侧忽略，照填 0）。
* 歌单 CRUD（列表/歌单歌曲/增删）走 `https://air1.pp.ua/api/playlist` + `x-r1-serial` 头（`wx.request`，复用 admin 后端，见 §7 待确认项）。

### 6.3 `pages/versions/versions`（版本管理，对标 `versions/page.tsx`）

* 当前版本：`request(['system.versions'])` + `formatVersion` 展示。
* 最新版本：`wx.request` 取 OTA 文本（`https://file.air1.pp.ua/xiaoxun/controller_vers.txt` / `unisound_vers.txt`，纯文本 `parseInt`，对标 admin 的 `/api/bridge` 中转——小程序直连需加白名单，见 §7）。
* `remote > current` 才显示升级按钮 → `send('system.upgrade',{apkName,version:String(latest)})` → toast“后台升级中”；**无进度条**（异步见 §3-2），返回后重查确认。
* 发版说明：admin 读 `/api/release-notes`，小程序同源复用（待确认，降级为不展示）。

### 6.4 `pages/ai/ai`（对标 `ai/page.tsx:19-134`）

* 表单字段：`choice/key/systemPrompt/model/endpoint/extraBody/cdn` + `aiType` + 启用开关；`request(['config.ai'])` 回填（白名单 key 过滤）。
* 保存：一次 `config.ai.set{config:JSON.stringify(过滤后),enabled,endpoint}`（老 admin 发两条 `save1+save2`，v2 已合并为一条）。
* 连通性测试：走 admin 已部署的 edge 中转 `POST https://air1.pp.ua/api/ai-test`（request 白名单已有；小程序直调用户 endpoint 会被域名白名单卡死）。验证通过才给保存（`verified` 门禁，表单一改即失效），验证通过自动 `enabled=true`；局域网端点云端够不着，豁免直存（对标 admin isLan）。admin 侧同规则：测试通过自动启用 + 未验证锁定保存。

### 6.5 `pages/services/services`（对标 `services/page.tsx` 四卡）

* 四卡各 `request(['config.<域>'])` 回填 → 改 → `config.<域>.set{config:JSON.stringify(...)}`；天气卡保留 `endpoint https` 校验。
* HASS/音乐源/故事源字段结构与 admin 一致（`{...config}` 对象直传后 `JSON.stringify`）。

### 6.6 `pages/controller/controller`（对标 `message/page.tsx:90-140`）

* 命令预设下拉：静态抄 admin `/api/commands` 列表（构建时拷一份 `utils/commands.ts`，不运行时拉）。
* 表单 `{what,arg1,arg2,obj}` → `send('message.send',…)` → 等同名回包/`chat.reply` 事件判成功（5s 超时按失败）；`what=100` 的回声在下方日志区展示。
* 老 admin 自建短连接直发，本页改走全局单例。

### 6.7 `pages/guide/guide` + `pages/speaker/speaker`

* guide 纯静态（AboutContent 文案 + 双卡说明），无 ws 逻辑。
* speaker 首页：现有 Hero/双卡/捐赠不动；抽屉菜单扩展 8 入口；`music-bar` 常驻；`connState` 显示沿用现有逻辑。

## 7. 白名单与待确认（联调前定）

1. `wx.request` 域名：`https://air1.pp.ua`（捐赠/歌单/release-notes）、`https://entry.air1.pp.ua`（session/query/bind/unbind）、`https://file.air1.pp.ua`（OTA txt 直读；若小程序直连有防盗链则改走自有中转）。
2. `wx.connectSocket`：`wss://*.typo.de5.net`（已有）。
3. 歌单 HTTP API（`action=list/get_songs/add_song/remove_song/create/delete` + `x-r1-serial` 头）：已确认可复用，serial 取自 `player.state.serial`（取不到用当前公网 deviceId），见 playlist 页。
4. AI 连通性测试：已做（走 `https://air1.pp.ua/api/ai-test` 中转，见 §6.4）；歌词 lyric：已做（歌曲 url 取 id/lyricsType → `https://air1.pp.ua/get-lyric`，player 页 scroll-view 跟随，见 §6.2）。

## 8. 验收清单

* [ ] 8 个页面首屏：`request` 一次拉齐本页 types，无串行等待；杀进程重进秒出 snapshot。
* [ ] 搜索：发词→转圈→事件到→列表渲染；`play_list` 点播后 5s 内进度自动对齐真值。
* [ ] 播放控制：播/停/上下曲/seek/音量/模式，操作后事件覆盖无闪烁；music-bar 与 player 页同显一致。
* [ ] 配置页：改→存→重进回显一致；未知 name 只 toast 不断连；4401 退回 devices。
* [ ] 心跳抓包：30s `ping/pong`；飞行模式开关后自动重连并重拉本页数据。
