# 02 - 微信小程序音箱绑定 + WSS 控制设计稿（r1-miniprog）

> 状态：已定稿，不实现。wss 帧信封复用 `plans/01-ws-v2-design.md`（抄自 `E:\workspace\r1-unified\plans\01-ws-v2-design.md`）。
> 三端：`r1-miniprog` 小程序 / `r1-entry`（`E:\workspace\r1-entry\functions`，KV 绑定关系） / `r1-connector`（`E:\workspace\r1\r1-connector\functions`，verify + `DeviceDO` + WSS）。
> 首页参照：`E:\workspace\r1-admin-page\src\app\page.tsx`，后端数据与图片 host `https://air1.pp.ua`。

## 1. 范围

v1 做：

- 带参扫码绑定（`deviceId + authCode + 可选 name`）→ 自动 query → verify → bind → 进首页。
- 无参打开智能路由（0/1/N 条）。
- 设备管理：查/增/改/删，`authCode` 👁️ 切换。
- 小程序 `wss /mnp/ws` 长连：30s ping 心跳 + 指数退避重连，全局单例。
- 音箱首页：全抄 admin-page 静态（Hero + 双卡纯展示 + 捐赠）+ 全局常驻音乐插件（wss 数据驱动）。

v1 不做：改音箱固件协议；支付；二维码生成后台（只收 query）；`search / chat / config` 页面（types 预留，未知 type 回 `error` 不断连）。

## 2. 名词、存储与常量

- `mnpUserId`：微信 `openid`。流程见 §3.1。微信本地存储按用户隔离，key 不加前缀。
- KV（entry `my_kv`）：`key = wx:v1:mnp:{mnpUserId}`，`value = JSON [{deviceId, authCode, name}]`，`name` 缺省 `"我的音箱"`。
- 微信本地存储（非 KV）：`mnpUserId: string`（缓存 openid）、`activeDeviceId: string`（当前设备）。字面量即 key 名。
- 校验上限：`deviceId ≤ 64 / authCode ≤ 32 / name ≤ 32`，缺参或超限 `400`，`""` 直接 400。
- host 算法（Java `int32` 对齐，三端同一份实现）：
  ```
  h = 0
  for c in deviceId: h = (31*h + ord(c)) | 0   # JS: Math.imul(31,h)+c |0
  mod = abs(h) % 6
  host = xn--3ug.t{mod}.typo.de5.net
  ```
  现有实现 `r1-connector/functions/routers/devices.ts:25-32`、`wx-command.ts:29-37`、`r1-entry/functions/routers/wx-command.ts:54-61`。小程序新增 `utils/device-host.ts` + 单测 `"0" → t0`。

## 3. 端到端流程

### 3.1 登录（先拿身份，再调业务）

```
gateway onLoad
  mnpUserId = wx.getStorageSync('mnpUserId')
  if (mnpUserId): 用它先调 query 快显；后台静默 wx.login → POST /mnp/session → 覆盖缓存
    （若 openid 变化则以新值为准，清 activeDeviceId 重路由）
  else: 阻塞 wx.login → POST /mnp/session → 写缓存 → 再调 query
  loading 覆盖整个等待期；session_key 如需仅放内存。
```

### 3.2 带参扫码（options 有 deviceId + authCode）

```
解析 {deviceId, authCode, name = '我的音箱'.slice(0,32)}（仅 query；scene 存在则尝试兼容解析，不强依赖）
  → POST /mnp/query {mnpUserId}
  → 双字段全等命中？是 → 写 activeDeviceId → 进 speaker（建 wss §8）
  → 否 → hashMod6(deviceId) 选 host → POST /verify {deviceId, authCode, botType:'wx'}
      → 404 → toast“添加音箱失败” + 停留管理/引导页（不调 bind）
      → 200 → POST /mnp/bind {mnpUserId, deviceId, authCode, name}
          → 成功 → 写 activeDeviceId → 进 speaker
```

### 3.3 无参打开（options 无 deviceId）

```
POST /mnp/query
  → 0 条 → popup 设备管理页（空 list + 添加按钮，不做单独空态页）
  → 1 条 → 写 activeDeviceId → 直进 speaker
  → N 条 → activeDeviceId 在 list 中？是 → 直进；否 → popup 选音箱（name + deviceId）
      → 用户选择 → 写 activeDeviceId → 进 speaker
```

### 3.4 设备管理 CRUD

- 入口：speaker 右上 `👤` → ActionSheet「管理设备 / 切换音箱」。
- 列表：`POST /mnp/query` 渲染 `name / deviceId（全显） / authCode（默认 ••••，点 👁️/🙈 切明文）` + `✏️ 🗑️`。
- 添加/编辑：`deviceId` 为主键不可改，只能改 `authCode/name`。表单提交 → `POST /verify` → 200 才 `POST /mnp/bind` → 刷新 query。verify 失败 toast“添加音箱失败，请检查 deviceId 和 authCode”，不调 bind。
- 删除：`wx.showModal` 二次确认 → `POST /mnp/unbind` → 刷新；删当前 wss 连接设备立即断 wss；删 active 设备则更新 `activeDeviceId`（清掉或切剩余第一条）并回 gateway 重路由。

## 4. 小程序实现（r1-miniprog）

现有 `miniprogram/app.json` 为模板页，需新增：

- `pages/gateway/gateway`：统一入口（§3.1–3.3，loading + toast）。可替换 `pages/index`。
- `pages/speaker/speaker`：音箱首页（§9）。
- `pages/devices/devices`：设备管理（§3.4）+ 多设备 popup 复用 `components/device-picker`。
- `components/music-bar` + `store/music`：全局常驻音乐插件（对标 `admin-page/src/components/MiniPlayer.tsx + MusicContext.tsx`）。
- `components/support-section`、`components/donation-wall`：捐赠区移植（§9）。
- `utils/device-host.ts`（hash）、`utils/api.ts`（session/query/bind/unbind）、`utils/verify.ts`（hash 选 host 调 verify）、`utils/ws-client.ts`（全局单例 §8）。

## 5. r1-entry API（`https://entry.air1.pp.ua`，新增 `routers/mnp.ts`，`app.route('/mnp', mnp)`）

env 绑定（全小写，部署已有、`functions/env.ts` 落地补声明）：`mnp_app_id`、`mnp_app_secret`。

### 5.1 POST /mnp/session

- Req `{code}`（`wx.login()`）。代调 `GET https://api.weixin.qq.com/sns/jscode2session?appid={mnp_app_id}&secret={mnp_app_secret}&js_code={code}&grant_type=authorization_code` 取 `openid`。
- Res `{success:true, mnpUserId: openid}`；微信失败 `502`；env 缺失 `500`。

### 5.2 POST /mnp/query

- Req `{mnpUserId}`。`GET wx:v1:mnp:{mnpUserId}`，不存在返回 `[]`。
- Res `{success:true, list:[{deviceId, authCode, name}]}`；`name` 缺失回填 `"我的音箱"`（仅返回体，不写回）。
- Err `400 {success:false, error}`。

### 5.3 POST /mnp/bind（增改共用）

- Req `{mnpUserId, deviceId, authCode, name?}`，`name` 缺省 `"我的音箱"`。调用前小程序必须已调通 `/verify`，后端不代调。
- 逻辑：读 list（无则 `[]`）→ 按 `deviceId` 找下标 → 无则 `push`，有则 `authCode/name` 不同即更新（请求未带 `name` 则保留旧值）→ 整 list `PUT`（last-wins，无锁）。
- Res `{success:true, list, updated:boolean}`。

### 5.4 POST /mnp/unbind

- Req `{mnpUserId, deviceId}`，不调 verify。
- 逻辑：过滤该 `deviceId` 后写回（空则存 `[]`）。
- Res `{success:true, list}`；原本无该设备 `404`。

## 6. r1-connector POST /verify（新增 `routers/verify.ts`，全 host 共用）

- Req `{deviceId, authCode, botType:'wx'}`，三字段必传。
- 逻辑：`CREATE TABLE IF NOT EXISTS devices(...)` → `SELECT 1 FROM devices WHERE deviceId=? AND authCode=? AND botType=? LIMIT 1`（全 `bind` 防注入）。建议同样 `validateDeviceHost(deviceId, host)`（`devices.ts:34-43`），`workers.dev` 不放行。
- Res：有记录 `200` 无 body；无记录 `404` 无 body。
- 只读：不写 DB，不消费 KV `auth:{deviceId}`（区别于 `/v1/devices/bind`）。

## 7. r1-connector WSS（`/mnp/ws` + `DeviceDO`）

### 7.1 接入

- `wss://xn--3ug.t{N}.typo.de5.net/mnp/ws?clientType=mnp&deviceId=$deviceId&authCode=$authCode`。`authCode` 放 query，供握手前 `idFromName(deviceId)` 取 DO。
- `index.tsx fetch` 扩展现有 `/ws` 分支（`index.tsx:194-210` 同模式）：三参齐全才转发 DO，否则 `400/4401`。
- `DeviceDO` 保留 `new WebSocketRequestResponsePair('{"type":"ping"}','{"type":"pong"}')`（`do/device.ts:26-28`）。
- tag：`acceptWebSocket(server, ['mnp'])`；广播 `send(msg, tag?)`（`do/device.ts:47-58`）：音箱 `speeker`（既有拼写保持）、小程序 `mnp`。
- 强绑：`validateDeviceHost` 必做，失败 `403/4401`，不放行 `workers.dev`。

### 7.2 首连鉴权

`DeviceDO.fetch` 从 query 取参 → 先 `validateDeviceHost` → 查 D1 `WHERE deviceId=? AND authCode=? AND botType='wx' LIMIT 1` → 命中 `acceptWebSocket(tag='mnp')` + 回 `{type:'connected', deviceId}`；未命中回 `error{code:4401}` 后 `close(4401)`，小程序弹“添加音箱失败”退回列表。

### 7.3 帧（信封同 `01 §2`，v1 只实现 music + connection）

| 方向 | type | 说明 |
|---|---|---|
| C→S | `connection.hello{subscribe}` | 建连第一帧 |
| S→C | `connected{deviceId, serverTime}` | 鉴权通过 |
| C→S | `playback.get_position / get_queue / get_volume` | 细分拉取，并行发送、分别渲染，互不阻塞 |
| S→C | `playback.position{playTimeMs,status,totalTimeMs,musicId} / playback.queue{index,list,mode} / playback.volume{volume}` | 音箱按 type 按需拼装 |
| C→S | `playback.get_state` | 可选聚合加速首屏 |
| S→C | `playback.state{position,queue,volume,serial}` | 全量；seek/切歌/暂停立即推一次 |
| S→C | `playback.progress{playTimeMs}` | 5s 节拍，端侧 1s 插值 |
| C→S | `playback.play{index?} / pause / next / prev / seek{positionMs} / volume{volume} / mode{mode}` | 控制，wx 乐观延迟 1000ms，超时 5s 回滚（`01 §5`） |
| S→C | `error{message, forType?, code?}` | 未知 type / 参数错仅回该连接，不断连 |

## 8. 小程序 WSS 客户端（全局单例）

- `App.globalData.ws` 单 `wx.SocketTask` + `Map<type, Set<cb>>` 分发；各页经 `getWs().send(type,params) / on(type,cb) / off` 收发，不自建连接；换设备调 `reconnect(newDevice)` 全局重建。
- `onOpen → hello + subscribe → 并行 get_position/queue/volume（+可选 get_state）`；`onMessage` 按 type 分发；`onClose/onError` 指数退避 `1s/2s/4s…上限30s`；`4401` 停连并退回列表。
- 心跳：单例 `30s send('{"type":"ping"}')`（DO 层 auto pong 另保留）；服务端 90s 无帧可断；切后台不断连（音乐常驻），仅页面级 `unsubscribe`。

## 9. speaker 首页（全抄 + 音乐 + 捐赠）

纵向平铺 `admin-page/src/app/page.tsx:20-97`（Next `Link` 去掉，无子路由）：Hero 文案照抄 + 双卡（功能指引/小讯控制器，纯展示不可点击）+ 顶栏（`name + deviceId` + `👤`）+ 音乐插件 + 捐赠 + footer。

- 音乐插件：底部悬浮（封面/歌名/进度/播放暂停/上下曲），详情页隐藏（同 `MiniPlayer.tsx:13`）。首连时序见 §7.3/§8；离线态显示“连接中…/重连中…”，`error` toast + 回滚。
- 捐赠（已挖实）：
  - 数据 `GET https://air1.pp.ua/api/donation`（`r1-admin-page/edge-functions/api/donation.js:8-20`，KV `r1-donation`，`[{name,platform,date,amount}]`），`wx.request` 移植，按 `date` 倒序（`DonationWall.tsx:51`），`total = sum(amount where platform != '闲鱼')`（`:94`）。
  - 图片外链直用不打包：`https://air1.pp.ua/alipay.jpg`、`https://air1.pp.ua/weixin.jpg`（`SupportSection.tsx:37,43`）；进度外链 `https://github.com/users/ring1012/projects/1`（`:25`）。
  - 弹幕 + 展开全部照搬，小程序用 CSS 简化。
- 白名单（微信后台）：`https://air1.pp.ua`、`https://entry.air1.pp.ua`、`wss://*.typo.de5.net`（request + socket）。

## 10. 安全、边界与错误码

- `authCode` 默认掩码，内存明文仅提交瞬间；不打日志；storage 只存 `mnpUserId/activeDeviceId`，不存明文 `authCode`。
- Entry/verify 同校验 + 全 `prepare().bind()`。
- 错误：业务参数错 `400`；verify 无记录 `404` 无 body；wss 鉴权失败 `error 4401 + close(4401)` + toast“添加音箱失败”；wss 超时 5s 回滚乐观。

## 11. 验收清单

- [ ] 扫码带参：命中直进；未命中 verify 404 停留 + toast；verify 200 → bind → 自动进首页。
- [ ] 无参：0 条弹管理空页+添加；1 条直进；N 条按 active/弹窗。
- [ ] 管理：👁️ 切换；`deviceId` 不可改；增改先 verify；删当前断 wss、删 active 更新 storage。
- [ ] 登录：无缓存阻塞换取；有缓存快显 + 后台刷新；openid 变化重路由。
- [ ] wss：三参缺一拒连；host 错拒连；4401 停连；30s 心跳；杀进程重连；未知 type 只回 error。
- [ ] 首页：静态全抄；音乐首帧渲染；捐赠数/图正常；白名单配齐。

## 附录 A. 落地任务（不实现，仅拆分）

- entry：`routers/mnp.ts`（session/query/bind/unbind）+ `env.ts` 补 `mnp_app_id/secret` + 单测（空/单/多/更新/删除/openid 变化）。
- connector：`routers/verify.ts` + `/mnp/ws` + DO 三字段鉴权 + tag=mnp + ping/pong 保留 + 未知 type error + 回归 `/ws`。
- miniprog：gateway/speaker/devices + music-bar + support/donation + utils 四件套 + popup + 👁️ + 心跳退避 + 白名单。
- 联调：扫码/多设备/verify 失败/4401/重连/心跳抓包。

## 附录 B. 确认历史（Q1–Q25，压缩存档）

Q1 同用户同 id 即可；Q2 verify 状态码区分（Q9 修正为三字段）；Q3 删除不调 verify；Q4 首页全抄；Q5 只收 query；Q6 4401 关；Q7 bind 必带 mnpUserId；Q8 空态即管理空页+添加；Q10 查 D1 + host 强绑无放行；Q11 两卡纯展示 + 捐赠接口已挖；Q12 主键不可改、删当前断连、删 active 更新；Q13/Q14/Q19/Q20 openid 经 `/mnp/session`（小写 env）+ 缓存 openid；Q15/Q18/Q21 首页必连、细分 music types、全局单例；Q16 双字段全等；Q17/Q24 storage key 字面量；Q22 v1 范围；Q23 auth 放 URL 取 DO；Q25 未知 type 只 error。
