# WS v2 接口方案（替代 `/ws/status`，Web 与微信共用）

> 设计目标：无每秒推送；页面按 `type` 收发；音箱异步处理完按类型推；前端只收自己页面需要的 types 渲染。
> 核心更正（多终端）：**不按 `reqId` 过滤**。`reqId` 只做追踪/排错，`result` 只回发送者，`event` 广播给所有订阅了该 `type` 的终端。
> 兼容：音箱端新增 `/ws/v2`，老 `/ws/status` 保留兼容，不再新增前端调用。

## 1. 拓扑与鉴权（已确认）

- 音箱（不在本项目，是 Web 的服务端）既是 **局域网 WS 服务端**，又是 **CF worker wss 的客户端**：
  - Web 直连：浏览器 → `ws://<ip>:18888/ws/v2?clientType=web`（音箱 serving）。
  - 微信：小程序 → `wss://<host>/ws?deviceId=..&authCode=..&clientType=wx`（CF worker serving）← 音箱作为客户端长连 CF 上行推送。
- 状态扇出：音箱每次状态变化推两路——① 局域网 ws 客户端（Web），② CF 云端（CF 再按订阅 `type` 扇出给微信，如有连接）。
- 云 URL 固定三个 query：`deviceId`、`authCode`、`clientType`（`wx`/`web`，无 `deviceType`）。
- 鉴权失败回 `error{code:4401}` 后关闭；直连局域网模式信任内网（保持现状）。
- `reqId` 全局唯一（建议 `${clientId}:${seq}`），CF 靠它把云端命令的 `result` 路由回正确的微信连接；`event` 不靠它路由，靠 `type` 订阅表。

### host 算法（Java `String.hashCode` 对齐）

```
h = 0
for c in serial: h = (31*h + ord(c)) & 0xFFFFFFFF  # 32bit 溢出，JS 用 Math.imul
  转有符号 int32 后：mod = ((h % 6) + 6) % 6
host = f"xn--3ug.t{mod}.typo.de5.net"
```

- 与 `CustomMsgController.java:86-87`、`wx-command.ts:hashMod6` 同源，收编进 `packages/shared/src/device-host.ts`，附单测（含 `"0" → t0` 向量）。

## 2. 帧格式（单个 `type`，两端统一）

```ts
// C → S：发一个 type 的 message，音箱收到即处理（fire-and-forget，无 reqId）
type Command = { v: 2; type: string; params?: Record<string, unknown> };
// S → C：只有“按 type 广播的事实”，发送者作为订阅者自然收到
type Push = { v: 2; type: string; data: unknown };
// S → C：定向错误，只发给出问题的那条连接
type ConnError = { v: 2; type: "error"; data: { message: string; forType?: string } };
```

规则：

1. 所有 S→C 事实帧按 `type` 广播给订阅者，不做发送者定向——成功判定 = 等到对应 `type` 的事实帧。
2. 查询 = 触发一次事实广播：`playback.get_state` → 发布 `playback.state`；`system.get_versions` → 发布 `system.versions`。顺带让同页其他终端一起同步，无害。
3. 命令被拒（未知 `type`/参数错/未鉴权）→ 仅向该连接发 `error` 帧（带 `forType`），不断连；前端 toast + 回滚乐观态。
4. 无配对、无 `cid`：多人同时操作以最后到达的事实为准（last-wins），客户端不区分谁触发的，只渲染最终态。
5. 超时未等到事实帧（建议 web 2s / wx 5s）视为失败，回滚乐观并提示“设备无响应”。

## 3. Type 矩阵（按页面需要订阅）

> `R` = request params，`D` = result.data（仅发送者），`E` = event data（订阅者全收）。v1 action 映射在括号内。

### connection（全局）
- `connection.hello{R:{client:{platform,version}}, subscribe?: string[]}` → `D:{serverTime, serial}`。
- `connection.subscribe{R:{types:string[]}}` / `connection.unsubscribe{R:{types:string[]}}` → ok（进页订阅、离页退订）。
- `connection.ping` → `D:{now}`；保活客户端每 25–30s 发，服务端 90s 无帧断连。另配 CF 在离线/踢人时推 `connection.kicked{reason}` event。

### playback（音乐页，订阅 `playback.state` + `playback.progress`）
- 命令（各发一个 type 即可）：`playback.get_state`（首屏拉全量，替代 1s 包）/ `playback.play{R:{index?}}` / `playback.pause` / `playback.next` / `playback.prev` / `playback.seek{R:{positionMs}}` / `playback.volume{R:{volume}}` / `playback.mode{R:{mode}}`（v1 同名迁移；`play_list` 客户端不发，队列只读）。
- E `playback.state{position:{musicId,playTimeMs,status,totalTimeMs}, queue:{index,list,mode}, volume, serial}`：**全量当前态**（变化字段才推；切歌/seek/暂停立即推一次）。
- E `playback.progress{playTimeMs}`：播放中节流 5s 推一次；前端期间本地 1s 插值显示（同时是乱序/丢包后的自愈节拍）。

### search（音乐页内搜索，订阅 `playback.state` 即可）
- 客户端只做一件事：`search.search{R:{keyword}}` → 音箱搜到即播一首（搜播一体），成功后发布 `playback.state` 最终态。客户端不等中间结果，只渲染最后的 `playback.state`。
- 无 `search.result` 事件，无列表挑选流程（v1 的异步广播+二次序列化一并废除）。`play_list` 多条队列命令客户端不发——队列只读，存在 `playback.state.queue` 里展示。

### config.*（AI/天气/音乐源/故事/HA/EQ 页，订阅 `config.updated`）
- 统一 `config.ai.get` → `D{enabled,config,endpoint}`；`config.ai.set{R:{enabled?,config?,endpoint?}}`（拆掉 v1 `save1/save2` 黑话）。
- `config.weather/music_service/story_service/hass`：`.get → D{config}`；`.set{R:{config}}`（对象直传，去 stringify 套娃）。
- `config.eq`：`.get → D{...flat}`；`.set{R:{...flatPatch}}`（去 `type:"set"` 包裹层）。
- E `config.updated{domain, patch}`（同设备多前端同步）。

### system（版本页，订阅 `system.upgrade_progress`）
- `system.get_versions` → `D:{echo,unisound}`；`system.get_serial` → `D:{serial}`。
- `system.upgrade{R:{apkName,version}}` → result 受理 + E `system.upgrade_progress{apkName, state, progress?}`。

### message（调试页，无订阅）
- `message.send{R:{what,arg1,arg2,obj}}` → result ok。

### chat（小程序“我的音箱”，订阅 `chat.reply`）
- `chat.ask{R:{text}}` → 音箱处理后发布 `chat.reply{data:{text}}`（替代现 `POST /v1/devices/messages` + ws 旁路的双通道；HTTP POST 保留降级）。多问并发只以后到的回复为准追加展示，不配对。

## 4. 时序示例（音乐页 + 问答）

```
# 进音乐页：订阅需要的 types，拉一次全量（全量以事实帧回来）
C: {v:2,type:"connection.hello",params:{subscribe:["playback.state","playback.progress"]}}
S: {v:2,type:"playback.state",data:{position:{...},queue:{...},volume:8,serial:"..."}}
# 点播放：只发一个 type；state 事实广播所有订阅者（含别的终端）
C: {v:2,type:"playback.play",params:{index:2}}
S: {v:2,type:"playback.state",data:{position:{status:1},queue:{index:2},volume:8}}
# 微信问 AI
C: {v:2,type:"chat.ask",params:{text:"今天天气"}}
S: {v:2,type:"chat.reply",data:{text:"..."}}
```

## 5. 乐观渲染 + 延迟变量（已确认：web 100ms / 微信 1000ms）

`packages/shared/src/optimistic.ts`：

```ts
export const OPTIMISTIC_DELAY_MS = { web: 100, wx: 1000 } as const; // 用户自填
```

- 点击播放/暂停/快进/音量等：**不等真实消息**，起一个 `setTimeout(OPTIMISTIC_DELAY_MS[platform])` 后应用本地乐观态（如 `status:播放中`、进度跳到目标）。
- 真实 `event` 到达：直接覆盖为真实数据（修正）。
- 防踩踏（无 rev 的补偿）：记录 `clickAt`；若同一字段在点击后已收到过真实 event（`lastRealAt > clickAt`，说明别人/自己上一条已生效），则丢弃到期的乐观定时器，不覆盖。最后到达者胜，`playback.progress` 5s 节拍兜底自愈。
- 已知接受的风险（用户确认不加 rev）：极端乱序下会闪一下，以到达顺序为准，不做版本丢弃。

## 6. 音箱端落地要点（给 r1-control，音箱不在本项目）

1. 新增 `/ws/v2` 按 `type` 分发，老 `handleAction` 逐个迁移并 `@Deprecated`。
2. 推送中心只有一个动作：`publish(type, data)`；走两路：局域网订阅连接 + CF 上行（CF 按微信连接的订阅表再扇出）。
3. CF 只维护两样：微信连接订阅表 + 连接鉴权（`deviceId`→转发到正确的音箱上行）。**无待回表、无配对**；命令按连接鉴权透传。
4. 进度节流 5s；`seek/切歌/暂停` 立即推一次全量 `playback.state`。
5. 每条 `error` 帧带 `message + forType`，前端直接展示。
6. 日志靠时间戳 + `type` 排序，不做命令-事实配对。

## 7. 前端落地要点（两端共用 `packages/shared/src/ws/*`）

- `createWsClient(url, {platform:"web"|"wx", pingMs})`：建连自动 `hello`、按页 `subscribe/unsubscribe`、`onMessage` 按 `type` 分发到各 store、指数退避重连。不做请求-回执匹配：发完即记 `sentAt`，等事实帧；超时（web 2s / wx 5s）回滚乐观。
- 页面三件套：`onMount → subscribe + get_*`，`onMessage(type) → render`，`onUnmount → unsubscribe`。
- `packages/shared` 必须有：`envelope.zod.ts`、`types/*.zod.ts`、`client.ts`（注入 `WebSocket`/`wx.SocketTask` 适配器）、`device-host.ts`、`optimistic.ts`。
