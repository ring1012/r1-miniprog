# 04 - 局域网模式设计（设备级，与公网设备并存）

> 公网模式见 `02/03`。局域网不是菜单，而是一种**设备类型**：
> 设备页统管两类设备（🌐公网走服务器，📡局域网只存本地），点卡片即进入；
> 头像区显示当前设备名 + 类型 badge。页面层 v2 信封两类设备完全复用。

## 1. 双类型总览

| 项 | 公网设备 | 局域网设备 |
|---|---|---|
| 来源 | `entry /mnp/query`（服务器） | `localStorage lanDevices`（本地，`{deviceId:"ip:port",name}`） |
| 增删 | 设备页表单（verify+bind/unbind，经 connector/entry） | `lan` 页（IP+测试+保存，不上报服务器） |
| 选中 | `activeDevice {kind:'cloud',deviceId}` | `activeDevice {kind:'lan',deviceId}`（同一指针，`utils/mode.ts`） |
| 传输 | `wss://{hostFor}/mnp/ws`（CF DO，鉴权） | `ws://{ip}:18888/ws/v2`（`V2WebSocket`，无鉴权） |
| 信封 | v2 | **同一套** |
| 特有页 | — | `sysconfig` 系统配置（LAN 选中时抽屉可见） |

## 2. 改动点（已实现）

1. `utils/mode.ts`：`LanDevice/ActiveDevice` + `getLanDevices/saveLanDevice/removeLanDevice`
   + `getActive/setActive/clearActive`（含老 `connMode/lanIp` 一次性迁移）+ IP 归一化/同网段预检。
2. `utils/ws-client.ts`：`connectLan(ip)` + `isLan()`；`open()` 按目标分支拼 url；
   LAN 跳过 `connection.hello`；未 OPEN 帧排队（`openQueue`，修 CONNECTING 即发的竞态）；
   心跳统一 3s；**LAN 传输自动打 `lan:true` 标记**（`sendRaw` 层，调用方无感）。
3. `pages/devices/devices`：公网区（原有逻辑 + 🌐/当前 badge + 选中写指针）与局域网区
   （📡 badge + 当前 badge + 本地删除）并存；两个添加入口。
4. `pages/lan/lan`：添加表单（备注名+IP+连接测试显 serial）→ 存本地 → 写选中指针 → speaker。
5. `pages/speaker/speaker`：按 `active` 分支建连（LAN 找不到记录则回设备页；老 `currentDevice`
   自动转指针）；`onShow` 比对 `kind:id` 变化重建连；头像副标题带 `📡 局域网 / 🌐 公网` badge；
   抽屉无模式切换项（选设备即切换），LAN 下多「⚙️ 系统配置」。
6. `pages/gateway/gateway`：active 为 lan 则直放 speaker。
7. `pages/sysconfig/sysconfig`：active 非 lan 显示提示；serial 取 `device.info`；
   verify 走 connector，bind/unbind 走 entry（不含 tg/bot）。
8. `app.json`：注册 `lan` + `sysconfig`。

## 3. 同设备双通道全同步（一个 DO 就是一个设备，不会串）

状态更新（含搜索结果）永远两边都发：
* LAN 触发（`V2WebSocket`）：直回请求方 + 广播其他 LAN 连接 + 推上 CF（云 mnp 同步）；
* 云触发（`V2CloudController`）：回 CF 请求方/推 CF 事件 + `broadcastV2Event` 同步 LAN（如连着）；
  覆盖控制回包/事件、上线全量、5s 进度节拍、`pushEvent`。
* 仅 `data.get` 与 error 帧是点对点回包，不广播。
* 无定时推送：播放进度不是状态变化（5s 节拍已停用，代码注释保留在 `V2CloudController` 底部）；状态变化推送由播放器状态回调接入后调用
  `pushPlayerState()/pushEvent()`，小程序侧进度靠本地 1s 插值 + 事件校准。
* 帧内 `lan:true` 保留为传输标记（日志可查），不再做路由门控。

## 4. 联调注意（域名报错必读）

> 官方依据：「局域网通信」文档——`wx.request / wx.connectSocket` 的 url 允许
> `${IP}:${PORT}/${PATH}` 格式，**当且仅当 IP 与手机 IP 处在同一网段、且不与本机 IP
> 相同**时才会成功；满足时**不进行安全域校验**，可用 `http/ws`。你的记忆是对的。

1. **你这次报错的 env 是 `Windows,mp` = 开发者工具模拟器**，它没有"手机同网段"概念，
   照样走域名校验 → 必报错。解法：开发者工具「详情 → 本地设置 → **不校验合法域名**」
   勾上（仅影响开发调试，正式版无效）。
2. **真机免白名单三条件**：① 手机与音箱连**同一 Wi-Fi**（同网段）；② 目标不是手机本机 IP；
   ③ iOS 首次会弹系统「本地网络」权限，必须允许。`lan` 页已加同网段预检
   （`getPhoneIp` + `/24` 启发式，`mode.ts`），不满足只警告不拦截。
3. 局域网 `V2WebSocket` 无 1s 推送、无鉴权：`request` 5s 超时即代表不可达；
   `speaker` 页 LAN 在线态现在靠 `device.info` 回包确认，不再定时器假装在线。
4. 切模式即重建连：`connectLan` 与 `connect` 互斥；`music-bar` snapshot 跨模式短暂旧数据，
   下一个事件纠正（last-wins）。
5. `sysconfig` 的绑定操作走公网 HTTP（entry/connector），弱网下 LAN 通但绑定失败属正常。
6. 兜底方案（暂不实现）：若某机型 `connectSocket` 直连 LAN 仍被拦，可改用
   `wx.createTCPSocket`（基础库 2.18+，同样只允许同局域网非本机 IP）手写 WS 握手+帧，
   但要多写一套帧编解码，仅在实测拦死时再做。

## 4. 验收

* [ ] lan 页输错 IP → 超时提示；输对 → serial 回显 → 进入后全部页面可用。
* [ ] 同一操作在双模式下表现一致（播/停/搜/EQ/版本读取）。
* [ ] 公网抽屉无「系统配置」；切 LAN 后出现；切回消失。
* [ ] sysconfig：verify 失败 toast；bind 成功后列表刷新；unbind 二次确认。
