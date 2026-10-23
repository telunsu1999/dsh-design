# 06 · Remote Node（对等远程节点）模式设计

| 项 | 内容 |
|---|---|
| 状态 | **设计稿 v2**（只设计，未实现） |
| 日期 | 2026-10-23 |
| 依据 | DSH `0.2.1-rc.2`，本机 checkout `687f282e86`；文中行号基于该版本，源码后续可能漂移 |
| 前置文档 | [01-architecture.zh.md](01-architecture.zh.md)（ACP + SSH 现状）、[04-operations.zh.md](04-operations.zh.md)（限制清单） |
| M0 细化 | [07-remotenode-m0-protocol.zh.md](07-remotenode-m0-protocol.zh.md)：协议 v1、交付物同步对账算法、存储格式、状态机、M1 WBS |
| 修订 | v2 按反馈改为**对等（peer-to-peer）模型**：server/client 只是建链时的拨号端/监听端，连上后同权、可互调；模式与命名统一为 **remotenode**。v1 的"Hub 单向权威"稿作废。 |
| 一句话 | 每个 DSH 实例装同一个 `remotenode` 插件，任一侧的本地会话都可以在**对端**创建/驱动可续聊的远程会话；远程会话在两端都有持久来源标记；两侧对等互调，Web 有 `remotenode` 页签看对端与双向会话。 |

---

## 0. TL;DR

- **对等，不是主从**：任一侧都能主动调对端；连接建立时谁拨号、谁监听只是**传输角色**（NAT/防火墙决定），连上后双向 RPC 完全对称。
- **一个插件，两侧同装**：`@deepseek-ai/dsh-remotenode`（core，对等）+ `protocol` + `remotenode-web`（页签）+ `tool-remotenode`（模型工具）；不再拆成 server/client 两个包。
- **会话角色按会话算**：任一远程会话有 **initiator（发起方）** 和 **host（托管方）** 两个角色；同一节点可以同时是某些会话的发起方、另一些会话的托管方。
- **双向来源标记**：发起方铸 `linkId` 并在**自己的会话日志**写 `remotenode/catalog`；托管方在**自己的会话日志**写 `remotenode/origin`（首条用户消息 source 为 `remotenode-prompt`）。两边都持久、可审计，不改 `SessionHeader`、不升会话格式版本。
- **互调**：发起方 → 托管方发 `session.create/prompt/cancel/attach`；托管方 → 发起方发审批/提问请求 `interaction.request`；双方都用同一套 JSON-RPC。
- **交付物同步**：每条 link 一条**双向交付物通道**（记录/版本/墓碑 + 内容寻址字节）。任一侧 `present` 或 `remotenode_publish` 即同步清单；字节按策略自动/按需分块拉取、断点续传；两端持久化并通过序号向量对账收敛。3D/GLB 只是类型示例，不是设计中心。
- **传输**：默认独立端口的 **HTTPS + WSS**（JSON-RPC 2.0 语义），可选**裸 TCP**（同帧 + 长度前缀）；双向认证（TLS + 双端 secret 证明，或 mTLS）；不用 ACP 作主协议。
- **UI**：`remotenode` 全局面板（左侧栏顶部 `sidebar.panellist` 入口 + `main` 面板）。当前 Web GUI **没有横向顶部页签**；若要字面意义的横排顶栏，需要改 ui-layout 壳层（见 §8.1）。
- **路线**：M1 单对节点双向闭环 + 基础交付物同步（A→B/B→A 建会话、流式、中断、审批、`present`→deliverable.op→图片/文件同步）→ M2 完整交付物同步（版本/删除/离线对账/replica/大文件/输入文件）+ 本地多会话语义 → M3 多对端与安全加固 → M4 能力互调扩展 / 上游化。

---

## 目录

0. TL;DR
1. 需求与解读
2. 现状与可复用原语
3. 总体架构（对等模型）
4. 插件切分与打包
5. 身份、双向标记与数据模型
6. 协议设计（对等 Node ↔ Node）
7. 交互语义：与本地多会话对齐
8. Web UI：`remotenode` 页签
9. 持久化、恢复与生命周期
10. 安全与权限
11. 性能、成本与容量
12. 运维
13. 实施路线与验收
14. 风险、备选与取舍
15. 待你拍板的决策（附推荐默认）
附录 A 协议帧示例 · 附录 B 术语表 · 附录 C 参考文件索引 · 附录 D 交付物同步协议帧示例

---

## 1. 需求与解读

### 1.1 原始需求 + 你的修正

| # | 需求 | 设计含义 |
|---|---|---|
| 1 | 插件分为两部分，server 和 client | **修正后**：不按主从拆包；同一个 `remotenode` 插件两侧都装。"两部分"理解为连接的两端（可配置为监听/拨号），协议与权限对等 |
| 2 | client 通过 TCP 或 HTTP 接入 server；client 启动的会话要有 server 标记，代表哪个会话发起 | 任一侧都可接入另一侧；**双向**标记：托管方会话标"由对端哪个会话发起"，发起方会话标"我在对端创建了哪个会话" |
| 3 | 两侧交互模式和本地多会话保持一样的逻辑 | 双向 RPC 的方法面镜像本地 `session-controller`：列表/跟随/分页/发消息/打断/审批/状态/重连 |
| 4 | 上方有 clientnode 页签，查看当前调用的子 node 状态，含会话 | 改名 **`remotenode` 页**：对端节点列表、双向会话（我在对端发起的 + 对端在本机发起的）、状态与审批 |
| 5 | **Server 和 client 同级、可互调；名字叫 remotenode** | **本稿核心**：对等 peer 模型；拨号端/监听端只是建链角色；两侧都能调用对端、都能被对端调用 |

### 1.2 术语：不要再叫 server / client

| 术语 | 含义 | 归属层级 |
|---|---|---|
| **Remote Node 节点** | 一个运行 `remotenode` 插件的 DSH 实例，用稳定 `nodeId` 标识 | 节点 |
| **Peer Link 对等连接** | 两个节点之间的一条传输连接；由一侧拨号、另一侧监听（或双向同时拨号后去重） | 连接 |
| **dialer 拨号端 / listener 监听端** | 建链时的传输角色；**只影响连接方向，不影响权限** | 连接 |
| **initiator 发起方** | 发起某个远程会话的一侧：铸 `linkId`、控制会话、接收事件与审批请求 | 会话 |
| **host 托管方** | 实际运行该会话的一侧：跑完整 DSH Agent、上报事件、发起审批/提问 | 会话 |
| **同一个节点** | 可以同时是 A 会话的 initiator 和 B 会话的 host；可以同时监听和拨号多个对端 | — |

> 为什么还要区分拨号/监听：为了穿透 NAT/防火墙和避免端口暴露，连接总得由一侧主动建立；但"谁拨号"不赋予任何特权。连上后两侧运行同一套 `PeerLink` 代码，都能发请求。

### 1.3 目标 / 非目标

**目标（v1）**

1. 两个 DSH 节点可互连；任一侧都能发起远程会话；同一对节点可同时存在双向会话。
2. 远程会话可多轮续聊、可打断、可审批；托管端是完整 DSH Agent，可恢复。
3. 双向来源标记：托管方日志有 `remotenode/origin`，发起方日志有 `remotenode/catalog`；重开/重启后仍在，任一侧 UI 都能看出"这个会话是谁发起的"。
4. `remotenode` 页：对端节点状态（出站/入站、在线/降级/离线、版本、能力）、双向会话列表、会话详情（流式）、审批/提问入口。
5. 交互语义与本地多会话一致：同序事件、断线重连补历史、prompt 幂等、queue/steer、状态徽标。
6. 安全默认值合理：双向认证、per-link 凭据、审批 fail-closed、帧/批/并发限额、交付物隔离。
7. **交付物同步**：两端能持续同步交付物清单/版本/字节/删除；本机可预览/下载/原生打开，本机 Agent 可直接读镜像；反向也能把本地交付物发布给远端。

**非目标（v1）**

- 不做"任意工具/服务互调"（v1 只互调会话与交互；能力 RPC 见 M4）。
- 不做多跳中继 / 中心调度器 / 服务发现（每条 peer link 独立，可星形可互联，但没有路由层）。
- 不把远程会话并入本地全局会话列表 / 全局 `session-controller`（需要改中心包；见 §2.4、§8.4）。
- 不做远程会话 fork / 删除 / 归档 / 全文搜索（M3+ 再评估）。
- 不做 Hub 侧 LLM 代理（各节点用自己的模型 key，沿用现有 worker 模式；见 §11）。
- 不替换 Agent Teams：同机协同继续用 Team；跨机用 remotenode。
- 默认不暴露节点本地自有会话给对端（可配置；见 §10.3）。

### 1.4 设计原则

1. **对等**：协议、权限、能力两侧对称；没有"中心节点"假设，星形只是部署选择。
2. **两端各有真相，双向标记**：host 的 session 日志是内容真相；initiator 的会话日志是"我在对端创建了什么"的真相；两边都持久。
3. **复用 wire 契约**：事件形状对齐 `SessionWireEvent` / `SessionFollowFrame` / `SessionControlFrame`（`packages/api/session-controller/src/types.ts:450-599`），让两侧 UI/模型层都能按本地会话的方式处理。
4. **显式标记，拒绝推断**：不靠 cwd、标题、进程 id 猜来源；所有关联落在持久字段上。
5. **失败关闭**：审批/提问在超时、断链、对端重启后一律拒绝或取消，绝不默认放行。
6. **渐进增强**：M1 先做"双向能看、能发、能停、能批"，再补齐本地多会话全部语义。
7. **不碰会话格式版本**：优先 additive 扩展（新事件 key / 新 message source），避免 `SESSION_FORMAT_VERSION` 迁移链。

---

## 2. 现状与可复用原语

### 2.1 现有"子节点/远程"方式为什么不够

| 方式 | 能力 | 为什么满足不了 |
|---|---|---|
| 本地 subagent（spawn/fork） | 同进程、完整 Session、可续聊、可 steer | 强制同进程/同文件系统，不能跨机器（`docs/subsystems/agent-team.zh.md:1-10`、`docs/01-architecture.zh.md:53-58`） |
| ACP 子代理 + SSH（上一版方案） | 跨机器、一次性任务、最终文本 | 一任务一进程、无追问、无 steer、只回文本、审批自动放行、断线不恢复（`docs/04-operations.zh.md:50-63`） |
| Agent Team | 持久 roster、任务板、互相投递消息 | teammate 必须 `prepareContinuable`（本地 Agent），且共享同一工作目录（`docs/01-architecture.zh.md:53-58`） |
| SSH 执行世界 | 把 fs/进程/终端搬到远端 | 只支持 POSIX、整进程单一世界、Web 工作区不兼容（`docs/subsystems/ssh.zh.md`、`docs/01-architecture.zh.md:21-33`） |
| MCP（stdio / Streamable HTTP） | 单个工具桥、图片可回传 | 只有工具，没有多步自主会话与续聊（`docs/01-architecture.zh.md:44-51`） |
| 远程装整套 dsh web + 反代 | 浏览器直接用远端 | 等于把算力/密钥/会话都搬到远端，不是"对等协作"（`docs/01-architecture.zh.md:60-64`） |

结论：需要一个新的**对等远程会话域**；现有原语要么单向、要么一次性、要么同进程。

### 2.2 可复用原语清单

| 用途 | 可复用原语 | 位置 |
|---|---|---|
| 远程会话事件形状 | `SessionWireHeader` / `SessionWireEvent` / `SessionFollowFrame` / `SessionControlFrame` / `SessionProjectionUpdate` | `packages/api/session-controller/src/types.ts:450-599` |
| 本地会话驱动面 | `session/{list,create,prompt,cancel,page,follow,control,projections,updateQueue}` | `packages/api/session-controller/src/index.ts:275,461,513,524,536,547,598` |
| 事件/状态词表 | `agent/assistant-stream`、`session/event`、`api-session/{added,removed,status}`、`AgentStatus` | `docs/architecture.zh.md:67-130`、`packages/core/agent/src/runtime-types.ts:109` |
| 目录/来源标记先例 | `subagent/catalog`（chunked、版本化、fork 过滤）；message source 合并扩展 | `packages/subagent/subagent/src/catalog.ts:28-36`、`packages/session/session-format-v3-to-v4/src/message-sources.ts:15-33` |
| UI 顶层页面 | `sidebar.panellist`（list/root）+ `main`（keyed/root）+ `ctx.layout.selectPanel` | `packages/client/ui-plugin-manager/src/client/index.ts:67,111-150`、`packages/client/ui-layout/src/client/index.ts:68-119` |
| UI 插槽 | `conversation.session.header.lineage`、`conversation.session.header.actions`、`shell.overlay`、`sidebar.right.pane.tab` | `docs/subsystems/slots.zh.md` |
| 流式推送 | `RemoteSnapshotStream` / `@Remote({mode:'stream'})` / Gateway 逻辑流 | `docs/api-gateway.zh.md:62,168`、`packages/api/gateway/src/stream-protocol.ts:7,235-257` |
| 浏览器 RPC / 认证 | Connection 的 `/api` 信封、`/api/remote.mux` WS、launch token → HMAC cookie → Peer | `packages/client/connection/README.zh.md`（认证与 generation 节） |
| 重连策略 | 500ms 起、50–100% 抖动、上限 10s | `packages/client/connection/src/recovery-config.ts:6-21` |
| 简单 host 插件模板 | `PluginInventoryGateway extends TypertRemoteService` + `@Remote('list')` | `packages/host/plugin-inventory/src/index.ts:51,70` |
| 流式 Remote 模板 | `job.list` / `job.follow`（baseline + 增量） | `packages/api/job-controller/src/index.ts:75,90` |
| 持久会话驱动/恢复 | `ctx.agents.create/followup`、`session/event`、`ctx.subagents`（本地子代理） | `docs/subsystems/session.zh.md`、`docs/cookbook/extension-cookbook.zh.md` |
| 交付声明事件 | `deliverables/presented`：`{turn, callId, files: PresentedFile[]}`，**只记路径、不复制字节** | `packages/deliverables/tool-present/src/types.ts:15`、`docs/subsystems/deliverables.zh.md:9-19,136-138` |
| 附件/内容寻址 | `ctx.attachments`（`AttachmentId = sha256:<digest>`，先持久化后发布不可变引用）；`ctx.fileUploads` 浏览器流式上传 | `docs/subsystems/attachment.zh.md:5-20`、`packages/client/file-upload/README.zh.md` |
| 本机文件读写/预览 | `workspaceFiles.{stat,read,readBytes,list,changes}`；`dsh-resource://file/...`；`/api/file?path=` 鉴权读取 | `packages/api/workspace-files/README.zh.md:28-50,77-83` |
| 原生打开/交付卡片 | `dsh-host-open-in-app`（默认应用/编辑器打开）；`ui-deliverables`（交付卡片 + 侧栏预览 + 评论/打开） | `packages/host/open-in-app/README.zh.md`、`packages/client/ui-deliverables/README.zh.md` |

### 2.3 硬约束（对等模型下依然成立）

| 约束 | 来源 | 影响 |
|---|---|---|
| **`SessionHeader` 字段封闭**，V4 读取拒绝额外字段 | `packages/core/session/src/types.ts:90-132`、`packages/session/session-format-v3-to-v4/src/validation.ts:19-35` | 不能给会话 header 加 `nodeId`；标记只能放事件 / message source |
| **`SessionSummary` 封闭** | `packages/api/session-controller/src/types.ts:178-191` | 插件不能给本地会话列表行加 `nodeId`；远程会话不能直接混入全局列表 |
| **GUI 没有横向顶部页签** | `packages/client/ui-layout/src/client/index.ts:68-119`、`AppFrame.tsx:30-45` | `remotenode` 页最小落点是 panellist 全局面板；横排顶栏要做壳层改造 |
| **Typert Remote 构建期显式装配** | `packages/api/remotes/src/client/index.ts:5-30,197`、`docs/api-gateway.zh.md:82-84,102-124` | 完整 UI + 类型化 RPC 建议 in-tree bundle；纯 out-of-tree 需退化方案 |
| **会话 id 是进程本地裸串** | `packages/core/session/src/index.ts:1143-1150` | 远端 sessionId 必须 opaque；跨节点关联用发起方铸的 `linkId` |
| **审批/提问是进程内 agent-scoped waterfall** | `packages/interaction/user-approval/src/index.ts:215,247`、`packages/interaction/user-questions/src/index.ts:130-144,164-173` | host 侧要拦截成本地交互的"远程代理"：本地可答 + 转发给对端 |
| **浏览器认证是 cookie/token，不是对等认证** | `packages/client/connection/README.zh.md`（认证节）、`packages/api/remote-access/README.zh.md:83` | 不能直接拿浏览器 `/api` 当 node 间通道；对等通道要自建双向认证 |
| **无现成对等 RPC** | 调研：ACP 单向 stdio/自动机；Gateway 仅浏览器 Peer | 需要新写对等 PeerLink（JSON-RPC 双向请求 + 通知） |
| **浏览器 bundle HMR 有限** | `docs/subsystems/client-modules.zh.md:88-98`、`docs/subsystems/web-client.zh.md:77-87` | 新增 roster/Remote 要重建重启；开发用 `pnpm run dev:web` |
| **`present` 只有路径、没有字节副本** | `packages/deliverables/tool-present/README.zh.md:12,54-56` | 交付物字节必须由 remotenode 自己搬运/缓存；源文件删除或改动后声明会失效（需 stale/版本机制） |
| **附件上限与归一化** | `docs/subsystems/attachment.zh.md:5-20`（单图 20 MiB、每消息 20 张/200 MiB、长边归一化 2048） | 图片走附件通道；大文件/3D 模型不能塞进图片附件，必须走交付物字节通道 |
| **本机文件服务有界** | `packages/api/workspace-files/README.zh.md:60-68`（窗口 2 MiB、完整文件 32 MiB） | 浏览器预览/小文件读取可复用它；大文件下载要单独的分块/流式路由 |

### 2.4 两条整合深度路线（本设计选 A 起步）

| 路线 | 做法 | 优点 | 代价 |
|---|---|---|---|
| **A. 自包含远程会话域（本文推荐 v1）** | 新 Remote namespace + 新 `remotenode` 面板；远程会话不进本地 `session-controller` | 不碰中心包、风险小、协议独立演进 | 远程会话聊天/审批 UI 要新写一套 |
| **B. 深整合（M4 再评估）** | 把远程会话代理成"类本地 Session"，复用现有 Chat/审批/交付物栈 | 交互一致性最好、UI 代码最少 | 要改 `session-controller`/`session-query`/客户端 Session 模型，牵一发动全身 |

本文按 A 设计，B 的触发条件见 §8.4 / §14。

---

## 3. 总体架构（对等模型）

### 3.1 拓扑

```
┌──────────────── DSH 节点 A（例：本机 Linux，可交互/可无人值守）────────────────┐
│  本地会话 A1 ──remotenode 工具 / remotenode 页面──┐                             │
│  本地会话 A2 …                                    │                             │
│  插件 @deepseek-ai/dsh-remotenode（两侧同一套）    │                             │
│   ├ PeerManager        多对端表、连接去重、心跳/状态                              │
│   ├ Listener（可选）   接受入站连接（TLS + 双向认证）                             │
│   ├ Dialer（可选）     主动连接对端（NAT 友好）                                   │
│   ├ PeerLink           对等 JSON-RPC：call() + onRequest()（双向都可用）          │
│   ├ SessionHost        托管对端发起的会话（本地 Agent + origin 标记）             │
│   ├ SessionClient      驱动对端托管的会话（linkId + 事件窗口）                     │
│   ├ InteractionBroker  双向审批/提问：本地 UI ↔ 对端                              │
│   ├ RemotenodeController @Remote：list/control/follow（给本机浏览器）            │
│   └ DeliverableSync    交付物通道（记录/版本/oplog/对账）+ BlobStore（CAS/传输）    │
│                                                                                 │
│  Host 插件 dsh-tool-remotenode（模型工具：remotenode_*；两侧都有）                 │
└───────────────▲───────────────────────────────────┬─────────────────────────────┘
                │ 一条对等连接（WSS 或 TCP）         │ 浏览器 /api + mux（现有）
                │ 双向 RPC / 双向请求 / 双向通知     │
                │ 谁拨号谁监听只是建链，连上后同权    │
┌───────────────┴────────────────  DSH 节点 B（例：Windows 台式机）──────────────┐
│  同一个 @deepseek-ai/dsh-remotenode 插件                                         │
│  本地会话 B1（可由 A1 远程发起）↔ 对端会话 A1；B 的模型也可反向调用 A           │
│  节点 B 同样有 remotenode 页：看到 A、看到双向会话与审批                         │
└─────────────────────────────────────────────────────────────────────────────────┘
```

也可以多对端（A 同时连 B、C；B 同时连 A、C）：

```
   A ⇄ B
   ↕   ↕       每条边独立对等；没有中心调度器
   C ⇄ D
```

### 3.2 传输角色 vs 会话角色

| 视角 | 值 | 是否赋予特权 | 说明 |
|---|---|---|---|
| 传输角色（每条连接） | `dialer` / `listener` | **否** | 只决定 TCP/TLS 发起方向；用于 NAT/端口暴露控制 |
| 传输角色（双边配置） | 两侧都配 dialer 也可 | 否 | 同时拨号时按规则去重（§6.2） |
| 会话角色（每个远程会话） | `initiator` | 是：可创建/驱动/取消该会话 | 铸 `linkId`；在本地会话日志写 `remotenode/catalog` |
| 会话角色（每个远程会话） | `host` | 是：可执行/可托管 | 在本地会话日志写 `remotenode/origin`；上报事件、发审批 |
| 同一节点 | 可同时是多个会话的 initiator 和 host | — | 这是"同级互调"的直接体现 |

### 3.3 三条数据通路（都可能是双向的）

**通路 1：发起会话（任意方向）**

```
节点 A 的本地会话/用户/模型
  → remotenode_run / remotenode 页面
  → SessionClient：铸 linkId、记 requestId（幂等）
  → PeerLink.call('session.create', {linkId, prompt, label, ...})
  → 节点 B：SessionHost 创建本地 Agent（本地 sessionId=UUID）
      写 B 的会话日志：remotenode/origin + 首条 user message source=remotenode-prompt
  → 回 session.created {linkId, hostSessionId, header}
  → A：写自己的会话日志：remotenode/catalog
  → A 的浏览器 control 流更新
```

反向同理：B 的会话/模型也能对 A 发起 `session.create`。

**通路 2：事件（host → initiator，方向随会话角色翻转）**

```
host：session/event + agent/assistant-stream
  → EventTap 批处理（size/time 双阈值）
  → PeerLink.notify('event.session' / 'event.assistant', {linkId, ...})
  → initiator：EventRouter 校验 seq/epoch、去重、写 tail 缓存/投影
  → 浏览器 remotenode/follow 流（snapshot → 增量）
  → 详情页渲染 + 状态徽标
```

**通路 3：交互（host ↔ initiator，双向）**

```
host 工具审批 / 用户提问
  → InteractionBroker 生成 interactionId
  → 若审批 owner=initiator/双方：PeerLink.call('interaction.request')
  → initiator 的浏览器 remotenode 页展示审批卡（人决策）
  → PeerLink.call('interaction.resolve') 回 host
  → host 恢复工具执行；超时/断链 → 拒绝（fail-closed）
```

反向同理：A 托管的会话需要 B 的会话/人决策时，A 调 B。

### 3.4 关键设计决策总表

| 决策点 | 选择 | 理由 | 备选（见 §14.2） |
|---|---|---|---|
| 节点关系 | **对等 peer，无中心** | 你的修正；两侧都能主动调用 | 中心 Hub（v1 稿已否决） |
| 建链角色 | dialer/listener，仅传输层 | NAT 穿透与端口安全；不赋予权限 | 只允许单向拨号（弱） |
| 插件命名/包 | **`remotenode` 一个 core 插件 + protocol/web/tool** | 两侧同装同一套代码，避免两份实现漂移 | server/client 两包（否决） |
| 传输 | **独立 HTTP(S)+WSS；可选裸 TCP** | 双向 RPC、流、心跳、TLS、代理友好 | 浏览器 `/api`+mux（改中心包）；ACP（单向） |
| 协议 | **JSON-RPC 2.0 子集（双向请求 + 通知）** | 对称、成熟、易调试 | 自定义二进制；ACP |
| 认证 | **per-link 共享 secret + TLS（M1）；可选 mTLS** | 双侧互认、可轮换、无需中心 CA | 单向 token（不对称，否决）；中心签发（引入中心） |
| 会话身份 | **initiator 铸 `linkId`（UUID）；远端 sessionId opaque** | 双向对称、授权锚点、UI 可寻址 | host 铸 id（会让发起方依赖对端） |
| 来源标记 | **双方日志各写一条：`remotenode/catalog`（发起侧）+ `remotenode/origin`（托管侧）** | 双端持久、不改 header/格式版本 | 只写一侧（重启/迁移易丢） |
| 审批归属 | **默认双方可答、先到先得；可配置 owner** | 对等；无人值守 host 时由 initiator 答 | 固定 host / 固定 initiator |
| UI 落点 | **`sidebar.panellist` + `main` 全局面板** | 纯插件、与 Plugins 页同构 | 横向顶栏（壳层改造） |
| 交付物同步 | **每条 link 双向交付物通道：op 日志 + 序号向量对账 + 内容寻址字节** | 增量、可恢复、无共享目录；版本/删除可追踪 | 一次性传文件 / 共享目录（否决） |
| 远程会话 UI | **自定义 remotenode 会话视图（M1-M2）** | 不自伤中心包；渐进 | 深整合（M4） |

---

## 4. 插件切分与打包

### 4.1 包清单（建议 in-tree 新增 `packages/remotenode/*`）

| 包 | 面 | 内容 |
|---|---|---|
| `@deepseek-ai/dsh-remotenode-protocol` | 共享库 | 帧类型、方法名/通知常量、错误码、版本协商、JSON Schema/编解码、状态机枚举 |
| `@deepseek-ai/dsh-remotenode` | host（两侧同装） | `PeerManager`（含 listener/dialer/去重/心跳）、`PeerLink`（双向 RPC）、`SessionClient`（作为 initiator）、`SessionHost`（作为 host）、`EventRouter`、`InteractionBroker`、`OriginCatalog`、`CatalogStore`、`LinkStore`、`DeliverableStore`（记录/版本/index/oplog/applied）、`DeliverableSync`（op/sync/snapshot 对账）、`BlobStore`（CAS/ingress）、`ArtifactTransfer`（fetch/chunk/resume）、`ArtifactHttpRoute`（本机浏览器下载/上传）、`RemotenodeController`（`@Remote` + streams） |
| `@deepseek-ai/dsh-remotenode-web` | browser（两侧的 Web GUI 都可用） | `main` keyed 面板 `remotenode`、`sidebar.panellist` 入口、client model、会话视图、审批卡、i18n |
| `@deepseek-ai/dsh-tool-remotenode` | host（两侧同装） | `remotenode_*` 模型工具；注册进 standard/cordis/ptc 预设 scope |
| `@deepseek-ai/dsh-remotenode-app`（可选） | bundle | 把 core + web + tool 合成可安装 bundle；node 侧只需 core（+可选 tool） |

> **为什么不再拆 server/client 两个包**：两侧代码 100% 对称。拆开会导致两份实现漂移；"两部分"由配置和连接角色表达，而不是包结构。若部署上确实想给无人值守节点更小的安装集，可只装 `core`（不含 web），这是**裁剪**而不是另一套协议。

### 4.2 包 manifest 与构建

- core 插件：`TypertRemoteService` + `@Remote`（参考 `packages/host/plugin-inventory/src/index.ts:51,70`），流式方法参考 `packages/api/job-controller/src/index.ts:75,90`。
- web 插件：`dsh.client` + `exports['./client']` + `clientBundle(..., { hostPhase: true })`（参考 `packages/client/ui-plugin-manager/package.json:21-45`、`packages/client/tsdown.client.ts:115`）。
- 两侧安装同一个 bundle：Linux 与 Windows 的 `profile` 可以不同（`web` / `remotenode` 常驻 profile），但插件包相同。

### 4.3 装配行

| 位置 | 加什么 |
|---|---|
| `packages/bundle/web-app/cordis.patch.yml` | core 行 `remotenode`、`tool-remotenode`；浏览器 roster 行 `remotenode-web`（参考现有 `ui-plugin-manager` 行 `:318-319`） |
| 新 bundle `packages/bundle/remotenode-app/` | 可选：core + web + tool 的可安装 bundle（两个节点都用同一个 bundle） |
| 新 profile `remotenode` | `dsh-base` + `remotenode` core（+ 会话持久化 + 可选 tool/web），供无人值守节点常驻；如果节点也要 Web UI，用 `web` profile + 同一插件 |
| 预设 scope | 把 `tool-remotenode` 挂进 `standard`/`cordis`/`ptc`（否则模型看不到 `remotenode_*`） |

### 4.4 交付形态：in-tree bundle vs out-of-tree plugin

| 维度 | in-tree bundle（推荐） | out-of-tree plugin |
|---|---|---|
| Typert Remote 生成 | 根 tsdown 自动生成，类型安全 | 需自带生成/手写 RPC；`ctx.remote` 无类型合并 |
| 浏览器 roster | 一行进 `web-app` patch | 需自己的 bundle patch + `dsh.client` 清单 |
| 中心包装配 | 可改 `api-remotes` contribution 清单 | 只能 `$mount` 自己的 contribution |
| 迭代体验 | `pnpm run dev:web` + HMR | 每次改类型/roster 都要重装/重启 |
| 分发 | 跟 DSH 版本走 | 独立版本，需处理协议兼容 |

结论：**v1 先 in-tree**（当前从源码 checkout 运行 `apps/cli/lib/bin.js`，可构建）；接口稳定后再抽出独立 bundle。

> **实施注记（2026-10-23）**：按用户要求改为**插件模式（out-of-tree bundle）**落地，未 in-tree 化、未改 DSH 源码。一个可安装 bundle `@dsh-design/remotenode` 内含 protocol/core/web/tool 四层职责（见 [08](08-remotenode-plugin.zh.md) §2）；浏览器↔Host 数据走同源 `/api/remotenode/*`（先例 `dsh-memory` / `dsh-server-monitor`），面板用 `sidebar.panellist` + `main` keyed（即 §8.1 方案 A）。已通过双 DSH 实例端到端验证，实现与验收见 [08](08-remotenode-plugin.zh.md)，代码见 [plugins/remotenode/](../plugins/remotenode/README.md)。

### 4.5 节点运行形态

每个节点都装同一插件；差异只在配置：

```bash
# 节点 A（Linux 大脑，带 Web UI）
dsh --profile web          # remotenode 行 + listen + peers

# 节点 B（Windows 台式机，无人值守；也可是 web profile）
dsh --profile remotenode   # core + tool（无浏览器），由 PeerManager 保活
```

Windows 服务化：NSSM/计划任务；Linux：systemd。日志写 stderr/文件，**绝不让协议走到 stdout**。

### 4.6 最小文件集（设计视角）

```
packages/remotenode/protocol/
  package.json  tsconfig.json  src/{types,codec,methods,errors,version,state}.ts
packages/remotenode/core/
  package.json  tsconfig.host.json  tsdown.config.ts  cordis.patch.yml
  src/{index,peer-manager,listener,dialer,peer-link,session-client,session-host,
       event-router,interaction-broker,origin-catalog,catalog-store,link-store,
       deliverable-store,deliverable-sync,blob-store,artifact-transfer,artifact-http,controller,config,dedupe}.ts
packages/remotenode/web/
  package.json  tsconfig.client.json  tsdown.config.ts
  src/client/{index,model,page/*,transcript,composer,approval,locales.ts}
packages/remotenode/tool/
  package.json  src/index.ts        # 6 个模型工具
locale/{zh,en}.json · tests/*.spec.ts
```

---

## 5. 身份、双向标记与数据模型

### 5.1 标识符体系

| 标识 | 铸造者 | 生命周期 | 说明 |
|---|---|---|---|
| `nodeId` | 本节点配置/首次启动持久化 | 长期 | 节点稳定身份；peer 配置里引用 |
| `instanceEpoch` | 本节点进程启动时 | 进程级 | UUID；区分同一节点的不同进程实例 |
| `connectionId` | 每次建链随机生成 | 连接 | 传输连接标识；用于去重/日志 |
| `linkId` | **initiator** | 会话链接 | UUID；跨节点会话关联、授权、UI 寻址的锚点 |
| `hostSessionId` / `remoteSessionId` | host | 会话 | host 本地 DSH 会话 id；对 initiator 为 opaque |
| `initiatorSessionId` | initiator | 来源会话 | 发起该远程会话的本地会话 id |
| `requestId` | 调用方（任意一侧） | 单次命令 | 幂等键（create/prompt/cancel/queue/审批） |
| `interactionId` | host（或请求发起侧） | 单次交互 | 审批/提问请求 id；两侧去重 |
| `delegationDepth` | initiator 计算 | 会话链接 | 递归深度，防跨节点自调用成环 |

关系（以 A 发起、B 托管为例）：

```
A 的会话 A1（initiatorSessionId）
   └─ A 的日志：remotenode/catalog { linkId, peerNodeId=B, remoteSessionId=B1, ... }
                                 │
                                 └── linkId ──(A/B 两侧各存映射)──> B 的会话 B1
                                                                     │
                                          B 的日志：remotenode/origin { linkId, initiatorSessionId=A1, ... }
                                          首条 user message source: remotenode-prompt { linkId, initiatorSessionId, ... }
```

反向（B 发起、A 托管）完全同构，只是角色互换。

### 5.2 数据模型（TypeScript 示意）

```ts
// === 连接（Peer Link） ===
interface PeerLinkRow {
  connectionId: string
  peerNodeId: string
  peerName: string
  peerPlatform: 'windows' | 'linux' | 'macos' | 'unknown'
  direction: 'outbound' | 'inbound'      // 本节点视角：我拨号 / 对端拨入
  status: 'connecting' | 'authenticating' | 'online' | 'degraded' | 'offline' | 'revoked'
  protocolVersion: number
  peerDshVersion: string
  capabilities: PeerCapabilities
  connectedAt: number | null
  lastHeartbeatAt: number | null
  metrics: { activeLinks: number; maxLinks: number; queueDepth?: number }
  lastError?: string
}

interface PeerCapabilities {
  assistantStream: boolean
  approvals: boolean
  questions: boolean
  attachments: boolean
  modelSelection: boolean
  resumeAfterRestart: boolean
  sessionVisibility: 'own-calls' | 'all'   // 对端允许我看它哪些本地会话
}

// === 我发起、运行在对端的会话 ===
interface RemoteSessionRow {
  linkId: string
  peerNodeId: string
  peerInstanceEpoch: string | null
  remoteSessionId: string | null
  initiatorSessionId: string            // 我的本地来源会话
  createdBy: 'agent' | 'user'
  label: string
  title?: string
  cwd?: string
  model?: { provider: string; model: string }
  status: RemoteSessionStatus
  cursor: { peerInstanceEpoch: string; streamEpoch: number; seq: number } | null
  lastActivityAt: number
  pendingInteractions: PendingInteractionSummary[]
  deliverables: DeliverableSummary[]
  error?: { code: string; message: string }
}

// === 对端发起、托管在本机的会话 ===
interface HostedSessionRow {
  linkId: string
  peerNodeId: string
  peerInstanceEpoch: string | null
  localSessionId: string                // 本机 session id（= 对方的 remoteSessionId）
  initiatorSessionId: string            // 对端的来源会话
  createdBy: 'agent' | 'user'
  label: string
  status: RemoteSessionStatus
  pendingInteractions: PendingInteractionSummary[]
  createdAt: number
}

type RemoteSessionStatus =
  | 'starting' | 'idle' | 'running'
  | 'waiting-approval' | 'waiting-input'
  | 'offline' | 'error' | 'closed'

interface PendingInteractionSummary {
  interactionId: string
  linkId: string
  role: 'we-answer' | 'peer-answers'   // 本节点视角
  kind: 'approval' | 'question'
  createdAt: number
  expiresAt: number
  summary: string
}

// === 交付物（同步摘要；完整记录/版本见 §7.5.2） ===
interface DeliverableSummary {
  deliverableId: string
  linkId: string
  originNodeId: string
  originSessionId: string
  name: string
  kind: 'image' | 'video' | 'audio' | 'text' | 'model3d' | 'archive' | 'other'
  size: number                  // 当前版本大小
  syncState: 'synced' | 'metadata-only' | 'pending' | 'partial' | 'stale' | 'removed' | 'error'
  versionCount: number
  updatedAt: number
}
```

### 5.3 发起方标记：`remotenode/catalog`（写在 initiator 的会话日志）

```ts
// 建议 schema v1；字段与 subagent catalog 对齐（chunked 可后续再加）
interface RemotenodeCatalogEvent {
  readonly version: 1
  readonly linkId: string                 // initiator 铸造的 UUID
  readonly peerNodeId: string
  readonly peerNodeName: string           // 创建时快照，对端改名不回写
  readonly peerInstanceEpoch: string
  readonly remoteSessionId: string
  readonly mode: 'remote-node'
  readonly label: string
  readonly createdBy: 'agent' | 'user'
  readonly delegationDepth: number
  readonly childCreatedAt: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'remotenode/catalog': RemotenodeCatalogEvent
  }
}
```

规则：

- 在**对端确认创建成功**（收到 `session.created`，含 `hostSessionId`，本机记作 `remoteSessionId`）后才写；失败不写（只发布成功事实）。
- 同 `linkId` 只写一次；重复创建被去重。
- fork 继承语义与 `subagent/catalog` 一致：fork 子会话会带 inherited 前缀；读取时按 inherited 事件数过滤，不让祖先的远程链接污染新 root（参考 `packages/subagent/subagent/src/catalog.ts:126,139-169`）。
- 新增 `remotenodeCatalog` Session projection（折叠 `remotenode/catalog`），供来源会话 UI / 模型工具读；`remotenode` 页则读本机 PeerManager 的索引，不逐会话扫日志。

### 5.4 托管方标记：`remotenode/origin` + `remotenode-prompt`

**托管方**在自己的会话日志里写一条 origin 事件（会话创建时）：

```ts
interface RemotenodeOriginEvent {
  readonly version: 1
  readonly linkId: string
  readonly initiatorNodeId: string
  readonly initiatorNodeName: string
  readonly initiatorInstanceEpoch: string
  readonly initiatorSessionId: string
  readonly hostSessionId: string
  readonly hostInstanceEpoch: string
  readonly createdBy: 'agent' | 'user'
  readonly label: string
  readonly delegationDepth: number
  readonly createdAt: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'remotenode/origin': RemotenodeOriginEvent
  }
}
```

并在**首条用户消息**（以及后续 prompt）上带 message source：

```ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'remotenode-prompt': {
      kind: 'remotenode-prompt'
      linkId: string
      initiatorNodeId: string
      initiatorSessionId: string
      requestId: string
      initiated: boolean        // 仅首条为 true
    }
  }
}
```

规则：

- origin 事件是**托管方**视角的权威标记："这个本地会话是 A 的 A1 会话通过 linkId 发起的"。
- 来源会话内容不注入托管方模型（避免跨机上下文泄漏）；是否在 system prompt 加一行 origin 元数据作为可配置项（默认关闭，M2 评估）。
- 加 source 是 additive，不改会话格式版本；V4 读取保留未知 kind（先例：`user-rpc` 的 `principal`，`docs/persistence-changes/2026-10-13-user-rpc-principal.zh.md:12,50`；`message-sources.ts:15-33`）。

### 5.5 双向一致性、防伪造与递归

| 点 | 规则 |
|---|---|
| 标记权威 | 每侧只写自己的日志：initiator 写 catalog，host 写 origin；对端不能替你写 |
| 一致性校验 | 每次 `event.session` 携带 `linkId + hostInstanceEpoch`；接收方校验与本地 link 映射一致，不一致丢弃并记安全日志 |
| 对账 | 重连时双方交换 `peer.catalog`，按 `linkId` 对齐；单边缺失 → 标 `unknown/closed` 并在 UI 提示 |
| 不可伪造 | `linkId` 由 initiator 铸；host 在 `session.create` 中验证 `initiatorNodeId/initiatorSessionId` 与对端身份/授权关系；任一侧都不能替对端改来源 |
| 递归深度 | `delegationDepth = 发起方所在会话的深度 + 1`；`remotenode_run` 超过 `maxDepth`（默认 2，可配）拒绝；防止 A→B→A 循环调用 |
| instanceEpoch | 判断对端是否重启；重启后不认旧连接，走恢复流程 |

### 5.6 状态机

**Peer Link**

```
idle ──dial/listen──▶ connecting ──TLS ok──▶ authenticating ──hello/welcome ok──▶ online
                                                            │                       │  │
                                                            │ auth fail             │  └── heartbeat miss ──▶ degraded ──timeout──▶ offline
                                                            ▼                       │                          │  ▲
                                                          closed ◀── revoke ────────┴────── heartbeat ok ──────┘
```

**Remote Session**（两侧同一状态机）

```
starting ──session.created──▶ idle ⇄ running
                                 │  │
                                 │  ├── approval 请求 ──▶ waiting-approval ──resolve──▶ running/idle
                                 │  └── question 请求 ──▶ waiting-input ──answer──▶ running/idle
                                 ├── turn 结束 ──▶ idle
                                 ├── error ──▶ error
                                 └── close ──▶ closed
任意状态 + peer link 断开 ──▶ offline（只读缓存；重连后按事件/快照恢复）
```

UI 徽标由各侧派生：`offline > error > waiting-approval > waiting-input > running > idle > starting > closed`。

### 5.7 与 `subagent/catalog` 的关系

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐）** | 新 `remotenode/catalog` + `remotenode/origin` + 两个 projection | 语义干净；双向对称；可独立演进 | 需要自己写来源 UI |
| B | 扩 `subagent/catalog` 到 v3 `remote-node` | 复用 `ui-subagent` lineage 与 `list_agents` | external 现有语义是"不可打开、不可续聊"，要改多处；工具语义混淆 |
| C | B + 新 SubagentProvider | 统一 `list_agents` | 同 B，多维护一层 |

建议 v1 用 A；M3 之后若"统一子节点视图"价值高，再把 A 投影适配到 lineage UI（纯展示层）。

---

## 6. 协议设计（对等 Node ↔ Node）

### 6.1 Carrier

| Carrier | 形态 | 默认 | 说明 |
|---|---|---|---|
| **HTTP(S)** | `POST /remotenode/v1/rpc`（unary）+ `GET /remotenode/v1/stream`（WebSocket upgrade） | ✅ | TLS；反向代理友好；双向 RPC |
| **TCP** | 配置端口，4 字节大端长度 + UTF-8 JSON 帧；TLS 可选 | 可选 | LAN/低开销；语义与 WSS 完全相同，只是 carrier |
| ACP | stdio/WS | 不用 | 只作为"非 DSH 节点"的兼容后端（M4） |

```ts
interface PeerCarrier {
  send(frame: JsonRpcFrame): void
  close(reason: string): void
  onFrame(handler: (frame: JsonRpcFrame) => void): () => void
  onClose(handler: (info: { code?: number; reason?: string }) => void): () => void
}
```

- 同一连接上，**双向都能发 request**；`id` 空间按方向独立（发送方自己保证唯一）。
- 两侧用同一个 `PeerLink` 实现：`peerLink.call(method, params)` / `peerLink.onRequest(handler)`；角色只在具体方法与数据上体现。
- **二进制帧只用于 artifact 传输**：`[4B 头长度][JSON 头][bytes]`，与 JSON 帧共用同一 carrier；TCP 下同样格式（外加长度前缀）。控制/事件仍是 JSON 文本帧。

### 6.2 握手与双向认证

```
listener（TLS server）                           dialer
      │  ◀────── TCP/TLS 连接 ────────────────  │
      │  ◀────── peer.hello ───────────────────  │  { nodeId, instanceEpoch, connectionId,
      │                                          │    protocol, capabilities, nonce, proof }
      │  ────── peer.welcome ──────────────────▶ │  { nodeId, instanceEpoch, protocol,
      │                                          │    capabilities, nonce, proof }
      │  ◀══════ 双向 JSON-RPC 开始 ══════════▶ │
```

- **认证（二选一，推荐前者起步）**
  - **shared secret + TLS**：每个 peer link 配一个高熵 `linkSecret`（32B），两侧持有。hello/welcome 各带基于双方 nonce 的 HMAC 证明，互相验证 nodeId 与持有关系；TLS 提供传输机密性（listener 证书由 dialer 校验）。
  - **mTLS**：两侧各持客户端证书，双向验证；无需共享 secret。
- 认证失败：`auth/invalid-proof` / `auth/unknown-peer`；断开并记审计。
- **连接去重**：若两侧同时拨号，会存在两条连接。规则：以 `(nodeIdA, nodeIdB)` 排序后，**由较小 nodeId 一侧发起的连接为规范连接**；其他重复连接由持有方关闭；若规范方向一直无法建立（NAT），在宽限时间后保留可用方向（两侧写同一规则，避免抖动）。
- **单连接多路复用**：所有会话共享一条 PeerLink；`linkId` 区分会话；避免每会话建连。
- 心跳：WSS ping 15s + `peer.heartbeat` 10s；30s 无心跳 → degraded，60s → offline（可配）。

### 6.3 帧格式

JSON-RPC 2.0 子集：

```ts
type JsonRpcFrame =
  | { jsonrpc: '2.0'; id: string; method: string; params?: unknown }       // request（双向）
  | { jsonrpc: '2.0'; id: string; result?: unknown; error?: RpcError }     // response
  | { jsonrpc: '2.0'; method: string; params: unknown }                    // notification

interface RpcError {
  code: number          // 见 §6.8
  message: string
  data?: { kind?: string; retryable?: boolean; [k: string]: unknown }
}
```

约定：

- `id` 由**发送方**铸造，同一连接内唯一；响应带同一 `id`。
- 事件/通知不丢：按会话 seq 可重放，断线重连后从游标续传。
- 每帧 ≤ 1 MiB；超限断开并记 `limit/frame-too-large`。
- 文本 JSON，便于调试；交付物元数据走 JSON 层，字节走 artifact 二进制通道（§6.4），不进 JSON-RPC 参数。
- JSON 帧上限 1 MiB；artifact chunk 默认 1 MiB、上限可配；两者共用连接但分别限流。

### 6.4 方法清单（双向；按"接收方在会话中的角色"约束）

> 读法：`session.*` 的接收方必须是该会话的 **host**；`interaction.request` 的接收方通常是 **initiator**（或按 owner 策略）；`peer.*` 两侧都可发。任一节点同时实现两侧分发器。

**连接/节点层（双向）**

| 方法 | 类型 | 说明 |
|---|---|---|
| `peer.hello` | req | 拨号端发起握手（含认证证明） |
| `peer.welcome` | resp | 监听端回应身份/能力/证明 |
| `peer.ping` | req | 健康检查（WSS 已有 ping/pong） |
| `peer.heartbeat` | notify | 每 10s：状态、指标、活跃 link 数 |
| `peer.status` | notify | 状态/能力变化 |
| `peer.catalog` | req | 交换各自视角的 link 记录，用于重连对账 |
| `peer.sessions` | req | 查询对端可见的会话清单（默认只返回我发起的） |
| `peer.configure` | req | 更新对端可见策略/心跳参数（可选） |
| `peer.goodbye` | notify | 主动下线 |

**会话层（caller=initiator，receiver=host）**

| 方法 | 类型 | 说明 |
|---|---|---|
| `session.create` | req | `{linkId, initiatorSessionId, prompt, label, cwd?, model?, agentPreset?, outputSchema?, delegationDepth, artifacts?}` |
| `session.prompt` | req | `{linkId, requestId, mode:'queue'|'steer', content, artifacts?}` |
| `session.cancel` | req | `{linkId, requestId}` |
| `session.queue.update` | req | 编辑/移除排队消息（M2） |
| `session.rename` | req | 标题同步（M2） |
| `session.setModel` | req | 模型选择（M2） |
| `session.attach` | req | `{linkId, cursors:{peerInstanceEpoch,streamEpoch,seq}, assistantStream:true}` → snapshot + 开始推送 |
| `session.page` | req | 向前翻历史（M2） |
| `session.detach` | req | 停止推送 |
| `session.close` | req | 软关闭，日志保留 |

**事件层（host → initiator，通知）**

| 方法 | 说明 |
|---|---|
| `event.session` | 持久事件批：`{linkId, hostSessionId, instanceEpoch, streamEpoch, seqFrom, records: SessionWireEvent[]}` |
| `event.assistant` | 瞬态 assistant 帧批 |
| `session.state` | 状态变化：`{linkId, status, reason?}` |
| `session.ack` | 命令回执（prompt/cancel/queue） |

**交付物同步层（双向；每来源自己的命名空间 + 序号）**

| 方法 | 类型 | 说明 |
|---|---|---|
| `deliverable.op` | notify | `{linkId, op:'upsert'\|'remove', originNodeId, originSeq, record? , deliverableId?, at?}`；接收方幂等应用 |
| `deliverable.sync` | req | 对账请求：`{linkId?, applied: {originNodeId: maxSeq}}` |
| `deliverable.syncResult` | resp | `{ops: DeliverableOp[]}` 或 `{snapshot: DeliverableRecord[], complete: true}`（op log 缺口时） |
| `deliverable.ack` | notify | `{linkId, originNodeId, appliedSeq}` 水位确认（可选） |
| `deliverable.list` | req | 当前清单（UI 首次打开/手动刷新） |

**字节层（双向；按 artifactId 内容寻址）**

| 方法 | 类型 | 说明 |
|---|---|---|
| `artifact.fetch` | req | `{artifactId, offset?}` 请求字节流；回 ack 后发二进制 chunk，最后 `artifact.end` |
| `artifact.chunk` | **binary** | 头 `{artifactId, offset, length}` + 载荷；默认 1 MiB |
| `artifact.end` | notify | `{artifactId, bytes, sha256, ok}`；接收方校验完整 hash |
| `artifact.window` | notify | 流控 credit（默认窗口 8 MiB；单传输串行） |
| `artifact.cancel` | notify | 任一方取消传输（断线自动取消） |
| `artifact.stale` | notify | 发布方源文件变更/删除，版本失效 |

> 规则：**元数据必达、字节按策略**；`deliverable.op` 幂等且只由 origin 发；接收方用 `applied` 向量对账；`artifactId` 是内容 hash，重复文件天然去重。

**交互层（双向）**

| 方法 | 方向 | 说明 |
|---|---|---|
| `interaction.request` | host → initiator（或镜像给双方） | 审批/提问请求；返回 ack，后续用 resolve |
| `interaction.resolve` | 应答方 → 请求方 | `{interactionId, decision}` |
| `interaction.resolved` | 请求方 → 另一方 | 本地已解决（另一方 UI 清除） |
| `interaction.cancel` | 任一方 | 超时/会话结束，撤销 |

> 因为会话角色可以翻转，A 可能刚给 B 发 `session.create`，随后又收到 B 发来的 `session.create`；两个方向互不干扰（各自 linkId/id 空间）。

### 6.5 事件流、游标、快照与恢复

对齐本地 `session/follow`（`packages/api/session-controller/src/types.ts:493-570`）：

- **游标**：`{ peerInstanceEpoch, streamEpoch, seq }`。
- **attach snapshot**：`{ header: SessionWireHeader, cursor, records: SessionHistoryRecord[], hasMore, projections, assistantStream? }`；records 为尾部窗口（建议 ≥ 50 条消息 / ≥ 2 个 turn）。
- **后续通知**：`event.session` 按 seq 连续；`event.assistant` 只对已 attach 且活跃 attempt 推送。
- **断线重连**：
  1. 连接恢复后，双方先 `peer.catalog` 对账（哪些 link 还在）。
  2. initiator 对每个活跃 link 发 `session.attach`。
  3. 若 `peerInstanceEpoch` 相同：host 从 `seq+1` 重放；若不同：host 重新打开持久会话（或返 `not-resumable`），发新 snapshot，initiator **replace** 窗口。
- **不变量**：同一 link 的事件 seq 严格递增；重复丢弃、gap 触发 re-attach（不猜测补洞）。
- **快照一致性**：snapshot `cursor.seq` 是已包含的最大 seq；之后事件必须 `> cursor.seq`。

### 6.6 幂等、顺序、背压

- **幂等**：`session.create` 的 `linkId` 由 initiator 铸，host 若已存在返回既有结果；`prompt/cancel/queue` 带 `requestId`，host 保留有界去重表。
- **顺序**：同一 link 的命令由 initiator 串行化；host 按到达顺序处理；事件保序，不得异步乱序。
- **背压**：host 每 link 发送队列上限；assistant 瞬态帧可丢最旧，持久事件阻塞发送；initiator 慢消费者用 snapshot + 有界增量。
- **限流**：每连接帧速率、每 link prompt 速率、每节点并发会话上限。
- **心跳/超时**：见 §6.2。

### 6.7 交互（审批/提问）的双向路由

```
host（托管方）                                   initiator（发起方）
 工具审批/提问
   → interaction.request ─────────────────────▶  浏览器 remotenode 页展示
   （host 本地 UI 也可能同时展示）
   ◀───────────────────── interaction.resolve   人决策（任一侧先答有效）
   → 工具继续；另一方收到 interaction.resolved 清除待办
```

规则：

- **owner 策略**（两侧可配，默认 `both`）：
  - `both`：host 本地 UI 与 initiator 都可答，**先到先得**；另一方收到 resolved。
  - `initiator`：只允许发起方答（适合无人值守 host）。
  - `host`：只允许 host 本地答（适合本地有人但 initiator 无人）。
- **一次性**：`interactionId` 只能 resolve 一次；重复返回 `interaction/already-resolved`。
- **超时 fail-closed**：host 侧默认 5 分钟（可配）到点以"拒绝"收口，并通知另一方 `interaction.cancel`。
- **断链**：host 等待继续；超过 timeout 拒绝；重连后 pending 对账（`interaction.cancel`/`expired`）。
- **审批选项**：`allow-once` / `allow-session`（同 link 同工具本会话内不再问）/ `reject`；`allow-session` 是**应答侧策略**，host 只收到最终决策。
- **提问**：支持单选/多选/自由文本；答案回传后 host 的 user-question waterfall 继续。
- **模型不可审批**：不提供 `remotenode_approve` 工具；模型只能请求，不能批准。

### 6.8 错误码

> M0 完整错误码表见 [07-remotenode-m0-protocol.zh.md](07-remotenode-m0-protocol.zh.md) 附录 A；下表为摘要，编号以 07 为准。

| code | kind | retryable | 场景 |
|---|---|---|---|
| 4001 | `auth/invalid-proof` | 否 | proof 校验失败 |
| 4002 | `auth/unknown-peer` | 否 | nodeId 未配置 |
| 4003 | `auth/clock-skew` | 是（校时） | ts 偏差 > 5min |
| 4004 | `auth/replay` | 否 | nonce 复用 |
| 4005 | `auth/mode-mismatch` | 否 | shared-secret vs mtls |
| 4010 | `protocol/unsupported` | 否 | 协议版本不符 |
| 4011 | `method/not-found` | 否 | 未知方法 |
| 4012 | `peer/duplicate` | 否 | 连接去重 |
| 4013 | `peer/offline` | 是 | 命令到达时连接已断 |
| 4020 | `session/unknown` | 否 | link 不存在 |
| 4021 | `session/not-authorized` | 否 | 非 initiator |
| 4022 | `session/busy` | 是 | host 写忙 |
| 4023 | `session/not-resumable` | 否 | 重启后无法恢复 |
| 4024 | `session/depth-exceeded` | 否 | 递归超限 |
| 4030 | `interaction/expired` | 否 | 交互过期 |
| 4031 | `interaction/already-resolved` | 否 | 重复 resolve |
| 4032 | `interaction/denied` | 否 | 策略拒绝 |
| 4040 | `deliverable/unknown` | 否 | 记录不存在 |
| 4041 | `deliverable/revision-gap` | 是（sync） | op 缺口 |
| 4042 | `deliverable/unauthorized` | 否 | 非本源/非该 link |
| 4043 | `deliverable/op-invalid` | 否 | 畸形/倒退/复用墓碑 id |
| 4050 | `artifact/not-found` | 否 | artifactId 未知 |
| 4051 | `artifact/unauthorized` | 否 | 未持有 manifest/非该 link |
| 4052 | `artifact/bad-offset` | 是 | offset 不匹配 |
| 4053 | `artifact/stale` | 是（重新发布） | 源变化/删除 |
| 4054 | `artifact/too-large` | 否 | 超 per-file 上限 |
| 4055 | `artifact/hash-mismatch` | 是（重试） | 整文件校验失败 |
| 4056 | `artifact/quota-exceeded` | 否（清理后） | per-link/CAS 配额 |
| 4060 | `limit/frame-too-large` | 否 | 帧超限 |
| 4061 | `limit/rate` | 是 | 限流 |
| 4090 | `peer/internal` | 是（有限） | 未归类异常 |

### 6.9 断线、重启与版本升级

| 场景 | 行为 |
|---|---|
| 网络闪断 | dialer 侧指数退避重连（500ms→10s，抖动 50–100%）；listener 侧等待；两侧 link 状态 `offline/degraded`；恢复后 `peer.catalog` + attach |
| 一侧进程重启 | 对端看到断开 → 重连；重启侧用 `instanceEpoch` 变化；各自从本地日志恢复会话；无法恢复 → `not-resumable` |
| 两侧同时重启 | 各自启动，按配置的 dialer 重连；`peer.catalog` 对账；以各自会话日志为内容真相 |
| 重复连接 | 按 §6.2 规则去重；两侧日志记 `peer/duplicate` |
| 协议版本不兼容 | `peer.hello` 失败 → `protocol/unsupported`；页面上标红"需要升级对端"；不接受降级运行 |
| 凭据轮换 | 两侧更新 secret/证书；旧连接断开，重连用新凭据；提供宽限窗口 |

### 6.10 协议安全（威胁模型摘要）

| 威胁 | 对策 |
|---|---|
| 未授权节点接入 | 双向认证（secret 证明/mTLS）+ TLS；未配置的 nodeId 拒绝 |
| 中间人 | TLS + 证书/secret 验证；公网建议 Tailscale/WireGuard |
| 伪造来源 | 每侧只写自己的日志；事件校验 `linkId + instanceEpoch`；对端不能改你的 catalog/origin |
| 重放/重复命令 | requestId 去重、seq 幂等、nonce 防重放 |
| 恶意对端超大/畸形帧 | 帧上限、批上限、schema 校验、限流、超限断链 |
| 恶意对端伪造审批预览 | 审批卡标"来自对端"；严格模式只按 allowlist；关键工具默认拒绝 |
| 对端诱导本机执行危险操作 | 对端只能调用协议方法；审批人决策；深度/能力白名单 |
| 提示注入（对端输出进入本机上下文） | 输出作为 tool result/notice 标不可信；不得触发自动审批 |
| 本地会话被对端窥探 | 默认只暴露"对端发起的会话"；`exposeLocalSessions` 需显式开启 |
| 递归调用成环 | `delegationDepth` + `maxDepth`；工具层拒绝 |
| 对端读取本机任意文件 | 只发布显式交付物；`deliverables.roots` 白名单 + `realpath` + 拒绝符号链接 |
| 超大文件/磁盘打满/路径遍历 | per-file/per-link 配额；逻辑路径按来源命名空间隔离；分块流式写 `.part` |
| 恶意 MIME / HTML/SVG XSS | magic bytes 嗅探；沙箱 CSP + `Content-Disposition: attachment`；不自动执行 |
| 未授权同步/拉取 | 通道绑定 linkId；校验 originNodeId/seq；浏览器只走本机认证路由 |
| 传输篡改/半包 | sha256 内容寻址 + `artifact.end` 校验；hash 不符重试 |
| 伪造交付物操作/乱序 | 每来源 op + originSeq；只能写自己命名空间；对账重放 + 去重 |
| 同步分叉/丢操作 | op log + applied 向量 + 全量 snapshot 兜底 |
| 删除传播误删 | 墓碑 + `keepLocalCopies` 默认保留本地副本 |

### 6.11 协议版本策略

- `protocol: 1` 冻结后只增不改；破坏性改动升 `2`，双方保留一个版本窗口。
- 能力用 `capabilities` 协商，不靠版本号猜。
- 未知方法返回 `method/not-found`；不得静默降级。
- 协议包与 `dshVersion` 不强制一致；页面展示双方版本。

---

## 7. 交互语义：与本地多会话对齐

### 7.1 能力映射表（两侧对称）

| 本地能力（session-controller） | 本地 API | remotenode 协议 | v1 | 备注 |
|---|---|---|---|---|
| 会话列表 | `session/list` | `peer.sessions` + `event.control` | ✅ | 两侧各自能看到"我发起的"与"托管在本机的" |
| 创建会话 | `session/create` | `session.create` | ✅ | initiator 铸 linkId；host 建 Agent |
| 跟随事件 | `session/follow` | `session.attach` + `event.session/assistant` | ✅ | 复用 `SessionFollowFrame` 形状 |
| 向前翻历史 | `session/page` | `session.page` | M2 | |
| 发消息（排队） | `session/prompt` queue | `session.prompt` queue | ✅ | requestId 幂等 |
| 插话（steer） | `session/prompt` steer | `session.prompt` steer | ✅ | host Agent 的 inbox 原语义 |
| 打断 | `session/cancel` | `session.cancel` | ✅ | 与本地取消同义 |
| 队列编辑/移除 | `session/updateQueue` | `session.queue.update` | M2 | |
| 审批 | 本地 waterfall | `interaction.request/resolve` | ✅ | 双向；owner 可配 |
| 用户提问 | 本地 waterfall | `interaction.request/resolve` | M2 | host 是 root Agent，可拦截 |
| 模型选择 | `session/selectModel` | `session.setModel` | M2 | 由 host 目录决定可用性 |
| 重命名 | `session/rename` | `session.rename` | M2 | |
| 状态/待交互 | `session/control` 投影 | `peer.heartbeat`/`event.control`/`session.state` | ✅ | 两侧 UI 徽标 |
| 附件/图片 | 本地上传/attachment | `deliverable.op` + `artifact.fetch` | M2 | 图片附件/交付物通道；路径映射 |
| 会话恢复 | 冷恢复 | attach + host resume | M2 | 一侧重启后 |
| fork/删除/归档/搜索 | 各自 API | 不做 | M3+ | 远程会话默认只关闭不删除 |

> M1 覆盖核心闭环（列表/看/发/断/批）；M2 补齐 queue、恢复、附件、问答、改名、模型选择。

### 7.2 模型侧工具（两侧都有）

| 工具 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `remotenode_list` | `{ peer?, includeClosed? }` | 对端 + 会话摘要 | 只读；看有哪些对端/会话 |
| `remotenode_run` | `{ peer, prompt, label?, cwd?, model?, wait?, timeoutMs?, outputSchema? }` | `{ linkId, status }` 或最终结果 | 在对端创建会话；默认 `wait:false`，完成回 settled 通知 |
| `remotenode_prompt` | `{ linkId, content, mode }` | `{ accepted: true }` | 续聊/插话 |
| `remotenode_status` | `{ linkId?, peer?, waitMs? }` | 状态/结果 | 轮询/等待 |
| `remotenode_cancel` | `{ linkId }` | `{ accepted: true }` | 中断当前 turn |
| `remotenode_close` | `{ linkId }` | `{ closed: true }` | 软关闭，保留日志 |
| `remotenode_publish` | `{ linkId, paths, logicalPath?, note? }` | `DeliverableSummary[]` | 把本地文件发布到该 link 的交付物通道（两侧都可调；`present` 的批量/补充入口） |
| `remotenode_deliverables` | `{ linkId, origin? }` | `DeliverableSummary[]` | 查看通道清单：来源/版本/同步状态/大小 |
| `remotenode_fetch` | `{ deliverableId \| artifactId, dest? }` | 本地路径/状态 | 显式同步字节（策略=`metadata` 时用；大文件按需） |
| `remotenode_sync` | `{ linkId? }` | `{ started: true }` | 触发一次对账/批量同步（可选） |

设计要点：

- 两侧都注册这些工具；模型通过 `peer` 选择对端。单对端时 `peer` 可省略。
- prompt 由发起方模型生成，必须**自包含**（host 看不到发起方上下文）。
- `wait:false` 时立即返回；远程会话结束 → initiator 的 origin 会话收到一条 `user/message`，source 为 `remotenode-settled`（类似 `subagent-settled`，`docs/subsystems/subagent.zh.md:189-206`），触发后续轮次。
- 工具注册到 `standard`/`cordis`/`ptc` 预设（或独立 `remotenode` preset），按节点启用。
- **模型不能审批**；审批由人/策略。
- 交付物同步不需要新工具也能工作：插件监听两端 link 会话的 `deliverables/presented`（`present` 已在 standard/ptc/cordis preset 中），自动发布到通道；`remotenode_publish` 只用于未走 `present` 的文件（见 §7.5）。

### 7.3 递归、深度与工具权限

- 远程会话的 model 也可能再调 `remotenode_run`（嵌套委托）。`delegationDepth` 每层 +1；超过 `maxDepth`（默认 2，可配 0 表示禁止）拒绝。
- 工具可配置 `peers` 白名单：某节点的模型只能调用指定对端。
- 不允许"调用自己"：`peer == 本节点 nodeId` 直接拒绝（防环的最低层）。
- 若两侧互为对端（A⇄B），A→B→A 的调用会被 depth 拦截。

### 7.4 审批/提问 owner 规则

| 场景 | 默认 | 可配置 |
|---|---|---|
| 无人值守 host（台式机） | 由 initiator（人所在侧）答 | `owner: 'initiator'` |
| 有人值守 host | 双方可答、先到先得 | `owner: 'both'` |
| initiator 也无人值守 | host 本地策略/tool allowlist 处理 | `owner: 'host'` |
| 超时/断链 | 拒绝（fail-closed） | 超时值可配 |

### 7.5 交付物同步（Deliverable Sync）

> 这一节的核心不是"传文件"，而是：**每条 link 有一条双向的交付物通道（deliverable channel）**。两端都可以发布交付物；对端持续同步「元数据 + 字节 + 版本 + 删除墓碑」，离线可排队、重连可对账、崩溃可恢复。3D 模型/GLB 只是其中一种类型示例，不是设计中心。

#### 7.5.1 目标与边界

**做**

- **双向**：initiator 和 host 都能发布交付物；两端看到同一份"交付物清单"（带来源标记）。
- **持续同步**：发布即推送元数据；字节按策略自动/按需同步；版本变化、删除也会同步。
- **可对账**：断线、重启、丢操作后用每组发布者的序号向量（vector）做增量对账；缺口大时退化为全量快照。
- **可落地**：对端字节落到本地 CAS / 只读副本目录，本机 UI 可预览/下载/原生打开，本机 Agent 也能直接读。
- **不阻塞会话**：大文件后台传输、断点续传、可暂停；失败不污染会话日志。

**不做**

- 不做通用文件系统同步/目录镜像/远端挂载：只同步**被声明为交付物**的文件。
- 不同步会话工作目录的全部内容（避免隐私与成本失控）。
- 不允许对端读取任意本地文件：只能读该 link 通道里显式发布的内容。
- 3D 预览不是核心能力（见 §7.5.8 的处理方式），核心是同步语义。

#### 7.5.2 交付物模型（逻辑记录 + 内容寻址字节 + 版本）

```ts
/** 一条交付物（逻辑记录，稳定身份；跨版本不变） */
interface DeliverableRecord {
  deliverableId: string              // 发布方铸造的 UUID，跨版本稳定
  linkId: string
  originNodeId: string               // 谁发布的（两端各占一个命名空间）
  originSessionId: string            // 发布它的会话（host 或 initiator 会话）
  logicalPath: string                // 通道内逻辑路径，天然按来源隔离：
                                     //   "<originNodeId>/<originSessionId>/<name>"
  name: string                       // 展示文件名（basename）
  kind: 'image' | 'video' | 'audio' | 'text' | 'model3d' | 'archive' | 'other'
  createdAt: number
  updatedAt: number
  /** 发布方全局单调递增（同一 origin 跨 link 不重复）；用于严格排序与去重 */
  originSeq: number
  /** 当前版本（内容寻址） */
  current: DeliverableVersion
  /** 历史版本（策略保留；默认 5 个） */
  versions: DeliverableVersion[]
  /** 删除墓碑：保留记录，字节可回收 */
  deleted?: { at: number; originSeq: number }
  description?: string
}

interface DeliverableVersion {
  artifactId: string                 // "sha256:<hex>"，内容寻址
  size: number
  mime: string
  createdAt: number
  originSeq: number                  // 该版本对应的发布操作序号
  note?: string
}
```

设计要点：

- **身份按来源隔离**：`originNodeId + originSessionId + logicalPath` 决定逻辑记录归属；两端各自只能改自己的命名空间，因此**不会出现同一路径的写冲突**（A 与 B 的同名文件是两条记录，UI 用来源徽标区分）。
- **内容寻址**：`artifactId = sha256(bytes)`；同一文件多版本/重复发布只存一份字节（CAS 去重）。
- **版本化**：同一 `deliverableId` 重新发布 = 新 `DeliverableVersion`；旧版本按策略保留，UI 可看历史。
- **删除是墓碑**：`deleted` 保留记录与历史，默认不物理删除历史字节（可配 TTL），避免误删不可恢复。
- **同步单位是"记录 + 版本 + 字节"**：元数据永远同步；字节按策略（§7.5.5）。

两端对称的存储布局：

```
$DSH_HOME/remotenode/
  deliverables/
    index.json                   # DeliverableRecord 索引（按 link）
    ops/<originNodeId>.jsonl     # 本节点发出的操作日志（有界，供对账重放）
    applied.json                 # 每个 origin 已应用到的 originSeq（向量）
    cas/sha256/<hh>/<hex>        # 内容寻址字节（两端同构、可去重）
    replica/<originNodeId>/<linkId>/<logicalPath>   # 可选只读镜像（策略=all）
    partial/<artifactId>.part    # 断点续传临时文件
  links.json                     # link ↔ cursor/状态
```

- **replica 只读**：镜像目录默认只读（便于本地 Agent 直接读路径、UI 打开）；修改请走"发布新交付物"而不是编辑镜像。
- **`keepLocalCopies`**（默认 true）：对端删除/清理时，本地镜像保留并标"对端已删除"，不静默删用户文件。
- **配额**：per-file（默认 1 GiB）、per-link（10 GiB）、CAS 总量（如 50 GiB）；LRU 只清理字节，索引/墓碑保留。

#### 7.5.3 同步协议：事件溯源 + 序号向量对账

```
发布方（origin）                         同步方（peer）
  deliverable.op {upsert|remove, originSeq} ──▶  应用；记录 applied[origin] = seq
  ◀──────────────── deliverable.sync {appliedVec}   （重连/定时/手动）
  ── deliverable.syncResult {ops[] | snapshot} ──▶  补齐缺口
  ◀──────────────── deliverable.ack {originSeq}      （可选：确认水位）
```

规则：

- **每来源全局严格递增**：`originSeq` 由发布方按 `originNodeId` 全局单调递增（op/记录都带 linkId）；同步方按 `(originNodeId, originSeq)` 去重，重复操作幂等。
- **对账向量**：每端维护 `applied: Map<originNodeId, maxSeq>`；重连时交换；对方从 `maxSeq+1` 补发操作的快照（有界 op log）；缺口超出保留窗口时发 `snapshot`（该来源的完整记录集）。
- **最终一致**：不要求全局顺序；UI 按记录状态显示（同步中/已同步/仅元数据/已删除）。同一记录的版本按 `originSeq` 排序。
- **发送即持久**：发布方先把操作写自己的 op log/index，再发网络；失败重试由对账兜底（不是内存队列）。
- **反熵**：连接期间实时推 op；重连、定时（如 60s）、手动刷新都会跑一次 `deliverable.sync`。
- **删除**：以 `remove` 墓碑同步；本地镜像默认保留（`keepLocalCopies`），索引状态 `removed`。
- **字节与元数据分离**：元数据必须同步；字节按 §7.5.5 策略同步；因此两端"清单"总是一致的，字节可能滞后。

同步状态（UI/模型看到的）：

| 状态 | 含义 |
|---|---|
| `synced` | 元数据 + 当前版本字节都在本地 |
| `metadata-only` | 只有元数据，字节未拉取（按需/策略） |
| `pending` | 字节在排队/传输中 |
| `partial` | 有断点续传中间态 |
| `stale` | 发布方源文件变化/版本被替换，需重新同步 |
| `removed` | 对端已删除（本地副本可能保留） |
| `error` | 传输/校验失败（可重试） |

#### 7.5.4 发布触发：两侧都能发

| 触发 | 侧 | 说明 | 阶段 |
|---|---|---|---|
| **① `present` 事件拦截（主路径）** | host / initiator 都能 | 任一侧 Agent 调 `present`；插件监听该侧会话的 `deliverables/presented` 事件，把文件发布到该 link 的交付物通道。远端无浏览器也能工作 | M1 |
| ② `remotenode_publish` 工具 | 任一侧模型 | 显式发布文件（可带 `logicalPath`/`note`/`version` 语义）；用于批量、非 `present` 场景 | M1 |
| ③ outbox 扫描（可选） | 插件 | 会话结束扫描 `deliverables.outboxRoots`（默认关闭），把新增文件发布 | M2 |

`present` 的关键事实：它只记录**绝对路径清单**（`PresentedFile { path, description? }`），不复制字节；`deliverables/presented` 是持久 Session 事件（`{turn, callId, files}`，`packages/deliverables/tool-present/src/types.ts:15`、`docs/subsystems/deliverables.zh.md:136-138`）。

- **哪些 `present` 会进通道**：只处理"属于该 link 的两端会话"——initiator 的 origin 会话、host 的远程会话；普通本地会话的 `present` 默认不进任何通道（避免误同步）。
- **路径白名单**：文件必须在 `deliverables.roots` 内（默认就是会话 cwd/workspace）；否则 `present` 成功但不发布，记告警并回 notice。
- **默认双向发布**：`deliverables.publishFromLocal: true`（可关）——initiator 自己会话里 `present` 的文件也同步给 host，供远端 Agent 直接使用。
- 同一文件重复 `present`：映射到同一 `logicalPath`，比较内容 hash；变了就发新版本，没变不重复发。

**输入方向同样走通道**：本机 `present`/`remotenode_publish` → 本机 CAS → `deliverable.op` 同步给 host；host 按策略拉字节到 replica/inbox，图片可转 `ctx.attachments` 引用，其他文件把本地路径写进 prompt 附加上下文。这样「本机交付物给远端用」和「远端交付物给本机用」是同一条通道、同一套版本/对账语义。

#### 7.5.5 字节同步：内容寻址 + 按需/策略 + 断点续传

元数据先到，字节按策略流动：

| 策略 `deliverables.sync` | 行为 | 适用 |
|---|---|---|
| `metadata` | 只同步清单；点开/显式 fetch 才拉字节 | 省带宽，最保守 |
| `preview`（默认） | 预览类（图片/小文本，≤8 MiB）自动拉；其余按需 | 日常体验最佳 |
| `all-small` | ≤32 MiB 全部自动拉 | 小文件协作为主 |
| `all` | 全部自动镜像（受配额限制） | 强同步/离线工作 |

- `preview` 判定：`kind=image`、或 text/markdown/json 且 size ≤ 8 MiB；可用 per-deliverable `note/preview` 覆盖。
- 传输方法见 §6.4 字节层：`artifact.fetch / artifact.chunk / artifact.end`；chunk 1 MiB、窗口 8 MiB、每 link 默认 1 并发（可配 2）。
- **断点续传**：`.part` 保留；重连带 offset；`end` 后整文件 sha256 校验；失败重试 2 次后标 error。
- **版本切换**：发布方发新版本 → `deliverable.op` 先到；同步方按策略拉新字节；旧版本字节按保留策略回收。
- **源变化检测**：发布方保存 `sourcePath + stat 指纹`；fetch 前重 stat，变化则 `artifact.stale` + 重新发布。
- **可选 HTTP 快通道（M3）**：holder 广告 `artifactHttpBase`；可达时用 `GET /remotenode/v1/artifact/<id>` + `Range`，否则回退 PeerLink。默认不启用。

#### 7.5.6 浏览器与 UI：同步状态可见

| 方向 | 路由/界面 | 说明 |
|---|---|---|
| 下载/预览 | `GET /remotenode/v1/artifact/<artifactId>`（本机 exact Fetch，复用 Connection 浏览器认证） | 从本机 CAS/replica 读；支持 `Range`、`ETag`；HTML/SVG 沙箱 CSP |
| 上传（本地发布） | `POST /remotenode/v1/upload`（流式请求体） | 浏览器 → 本机 CAS → 发布到 link → 同步给对端；不直连对端 |
| 打开/预览 | 现有 `ui-deliverables` / 侧栏预览 / `open-in-app` | 落到本机后复用；3D 见 §7.5.8 |
| 同步控制 | `remotenode` 页「交付物」视图 | 全部同步/暂停/重试/仅元数据/删除镜像等 |

**`remotenode` 页的「交付物」视图**（核心 UI）：

- 按 link 分组，列出**双方**发布的交付物：名称、来源（本机/对端 + 会话）、kind/size、**同步状态**、版本数、更新时间。
- 操作：预览、下载、打开（原生/侧栏）、立即同步、暂停、查看历史版本、复制对端路径、在文件管理器中显示。
- 过滤器：只看我发布的 / 只看对端发布的 / 只看未同步 / 只看图片/模型。
- 顶部汇总：待同步字节数、失败数、配额占用。
- **来源会话**：M1 工具卡显示"N 个交付物 · 查看"；M2 物化到本机后向来源会话追加本地 `deliverables/presented`，复用原生交付卡片（或自定义 `turnTail` 卡，见 §15）。
- **本地 Agent 可用**：同步到 replica 的路径可直接被本地工具读取；模型工具 `remotenode_deliverables` 可查清单。

#### 7.5.7 端到端示例（3D 只是类型示例）

场景：本机 A 让台式机 B 做一个低模猫 GLB，并交付；之后 A 的本地 Agent 还要基于它做二次处理。

```
1. A 的模型：remotenode_run(peer=desktop-01, prompt="做低模猫，GLB + 预览图")
2. B 的模型：Blender → out/cat.glb + out/cat-preview.png → present([...])
3. B 插件：拦截 deliverables/presented → 校验路径 → 发布两条交付物
   → deliverable.op(upsert) 推给 A（元数据：name/size/kind/version/originSeq）
4. A：清单立刻出现两条（状态 metadata-only）；按 sync=preview：
   - PNG 自动拉字节 → synced，内联预览
   - GLB 保持 metadata-only（默认不自动拉大文件）
5. A 用户点开/下载 GLB → artifact.fetch → B 分块发送 → A 校验 sha256
   → CAS + replica（若策略 all）→ 状态 synced；可原生打开或交给本地 Agent
6. 后续 B 重新发布 GLB（新版本）：
   - deliverable.op(upsert, originSeq+1) → A 更新记录/版本列表
   - A 按策略拉新字节；旧版本按保留策略保留/回收
7. A 本地 Agent 需要基于 GLB 修改时：
   - 读 replica 路径（只读）→ 生成自己的新交付物 → 在自己的命名空间发布
   - B 侧同步到该新记录（来源=A），不会与 B 的记录冲突
8. 任一时刻双向/离线/重启：各自 op log + applied 向量对账，清单收敛
```

**结论**：3D 模型只是"一种交付物"；真正设计的是**通道、记录、版本、同步状态与对账**。预览只是 UI 的按类型呈现。

#### 7.5.8 交付物类型与呈现矩阵

| 类型 | 同步默认 | 预览/打开 | 备注 |
|---|---|---|---|
| 图片 png/jpg/webp/gif | 自动（preview） | 内联/侧栏 | 可走图片附件归一化（≤20 MiB） |
| 视频/音频 | 按需 | 播放器（现有 Markdown） | 大文件 Range；可配自动 |
| 文本/md/json/代码 | 自动（≤8 MiB） | 文本预览 | 复用 `workspaceFiles.read` |
| **3D：glb/gltf/obj/blend** | 按需（metadata-only） | 无内置 3D 查看器：下载/默认应用打开；建议发布方同时发布预览 PNG | 3D 预览非核心；可选 M4 three.js 查看器 |
| Office | 按需 | 下载；或远端先转 PDF 再发布 | 转换是发布方可选步骤 |
| 压缩包/二进制 | 按需 | 下载 | 大小上限 + hash 校验 |

#### 7.5.9 安全与限额

| 风险 | 对策 |
|---|---|
| 对端读取本机任意文件 | 只发布显式文件；路径必须在 `deliverables.roots` 白名单；`realpath` 后校验；拒符号链接/目录/设备 |
| 路径遍历 / Windows 盘符/UNC | 规范化 + 前缀比较（Windows 大小写不敏感）；文件名清洗；逻辑路径按来源命名空间隔离 |
| 超大文件/磁盘打满 | per-file / per-link / CAS 配额；`artifact/too-large`、`artifact/quota-exceeded`；流式写 `.part` |
| 删除传播导致数据丢失 | 墓碑 + `keepLocalCopies` 默认保留本地副本；物理删除有 TTL |
| 恶意 MIME / HTML/SVG XSS | magic bytes 嗅探；沙箱 CSP + `Content-Disposition: attachment`；不自动执行 |
| 传输篡改/半包 | sha256 内容寻址 + `artifact.end` 校验；不符重试 |
| 未授权同步/拉取 | 通道绑定 linkId；同步方校验请求方 nodeId/角色；浏览器只走本机认证路由 |
| 版本爆炸 | 每记录保留 N 个版本（默认 5）；op log 有界；LRU 回收 |
| 审计 | 发布/同步/删除/失败记录 `deliverableId, artifactId, linkId, origin, seq` |

#### 7.5.10 失败、对账与一致性场景

| 场景 | 行为 |
|---|---|
| 对端离线 | 本地继续发布/记录 op；对端上线后 `deliverable.sync` 补齐 |
| 操作丢失/乱序 | 按 originSeq 去重排序；缺口→增量补发；超出 op log→全量 snapshot |
| 一侧重启 | 从 index/op log/applied 恢复；重连对账，不重发已应用内容 |
| 两侧同时发布同名文件 | 来源命名空间隔离，两条记录并存；UI 按来源展示，无冲突 |
| 源文件被修改 | 新版本 op；同步方拉新字节；旧版本按策略保留 |
| 源文件被删除 | 发布方发 `remove` 墓碑；本地副本保留并标 `removed` |
| 传输中断 | `.part` 续传；重连或手动重试 |
| 磁盘满/配额超限 | 拒绝新字节，标 error；清单仍同步；清理后可重试 |
| 校验失败 | 丢弃 `.part`，重试 2 次；仍失败标 error + 审计 |
| 反向一致性 | 定期反熵（60s）+ 手动"立即同步"；不一致时以 op log 重放收敛 |

### 7.6 会话生命周期裁剪（v1 语义）

| 操作 | v1 行为 |
|---|---|
| 关闭会话 | 取消当前 turn → 释放 Agent → 保留日志与链接行（`closed`）；M2 支持 reopen |
| 对端断链 | 会话状态 `offline`；本地缓存只读；重连后恢复 |
| 发起方会话删除 | link 仍在（孤儿）；remotenode 页可见；标"来源已删除" |
| host 删除本地会话 | initiator 收到 `session/unknown`，链接标错误 |
| 超时未完成 | 不自动关闭；由人/模型 `remotenode_cancel` 或 `remotenode_close` |

---

## 8. Web UI：`remotenode` 页签

### 8.1 落点：现状没有"横向顶部页签"

调研结论（`packages/client/ui-layout/src/client/index.ts:68-119`、`AppFrame.tsx:30-45`、`ui-plugin-manager` 例子）：当前 Web Shell = 左侧栏（顶部全局面板图标行 `sidebar.panellist`）+ 中栏 `main`（keyed 面板）+ 右栏 `rightbar` + 若干 shell 槽。**没有浏览器式的横向顶部 tab bar。**

| 方案 | 做法 | 成本 | 推荐 |
|---|---|---|---|
| **A. 全局面板入口**（与 Plugins/Schedules 同构） | `sidebar.panellist` 注册 id=`remotenode`、order=20、图标+label；`main` 注册 key=`remotenode` 渲染页面；点击 `ctx.layout.selectPanel('remotenode')` | 纯插件，低风险，1 个新 client 包 | ✅ v1 |
| **B. 真·横向顶部页签** | 在 `ui-layout` root 声明新 child slot（如 `shell.tabs`），AppFrame 增加顶栏组件与布局；其他页面也可注册 | 壳层改动（非纯插件），需改 ui-layout + CSS + 测试，HMR/布局风险 | M3 可选；若你坚持横向顶栏再上 |

> 建议 v1 用 A；若"上方"必须是横排顶栏（浏览器 tab 那种），把 B 提到 M1 也可以，但要接受壳层改动与回归成本。

### 8.2 信息架构

```
┌ Remote Nodes ─────────────────────────────────────────────────────────────┐
│ [● 2 对端在线 / 3]  [待我审批 1]  [刷新]                    [添加对端]       │
├───────────────────┬──────────────────────────────────┬────────────────────┤
│ 对端节点            │ 会话                                │ 会话详情             │
│ ● desktop-01       │ 【我发起、运行在对端】                 │ 标题 / 状态 / 来源    │
│   ↑ 我拨号          │  ▸ 生成 1024 图 (running)            │ [打开来源会话] [中断] │
│   Windows GPU      │    来源：本机会话《…》                │ ┌ transcript ─────┐ │
│   会话 1/4         │  ▸ Blender 场景 (idle)               │ │ user/assistant  │ │
│ ○ node-c（对端拨入）│ 【对端发起、托管在本机】               │ │ tool 行         │ │
│   离线 12m         │  ▸ 文献整理 (waiting-approval)       │ └─────────────────┘ │
│                    │    来源：desktop-01 的会话《…》        │ [交付物: cat.glb ⇅] │
│                    │                                      │ [审批卡：bash ...]  │
│                    │                                      │ [输入框 queue/steer]│
└───────────────────┴──────────────────────────────────────┴────────────────────┘
```

页面分区：

1. **顶部状态条**：对端在线/总数、待我审批数、最后刷新；"添加对端"弹窗（生成/粘贴 secret、配置片段、连接测试）。
2. **对端列表**（左）：名称、平台、版本、方向（我拨号 / 对端拨入）、状态点、活跃会话数/上限、最后心跳；操作（查看会话、禁用/撤销凭据、复制 nodeId）。
3. **会话列表**（中），两组：
   - **我发起、运行在对端**（本节点是 initiator）：状态、来源本地会话、模型、最后活动、待审批徽标；
   - **对端发起、托管在本机**（本节点是 host）：标记来源对端会话、状态、待审批；点击可跳本地会话（现有 UI）。
4. **会话详情**（右/下）：
   - 头部：状态、来源/托管方、cwd、模型、cursor/最后事件时间；操作：中断、关闭、打开来源会话。
   - 转录：user/assistant/tool（复用 markdown/tool row/图片组件；M1 简化 transcript，M2 对齐 Chat）。
   - 交付物区：**双向清单**（来源、版本、同步状态）；预览/下载/打开/立即同步/暂停/历史版本；进度条、失败原因、配额提示。
   - 审批区：pending 审批卡（工具名、输入预览、风险提示、允许一次/本会话允许/拒绝、倒计时、owner 提示）。
   - 输入区：prompt（queue/steer 切换）、发送、中断、附件/文件（文件 → 交付物通道发布给对端）。
   - 空态/错误态：无对端、对端离线、会话不可恢复、来源已删除。
5. **全局徽标**：`shell.overlay` toast / 侧栏图标红点显示待审批；来源会话 header 加 chip。

### 8.3 数据流与 client model

```
本机 remotenode core 插件
  ├─ ctx.remote.remotenode.list()              ┐ unary：对端 + 会话全量
  ├─ ctx.remote.remotenode.control()            ┘ RemoteSnapshotStream：baseline + delta
  ├─ ctx.remote.remotenode.follow(linkId)       RemoteStream：会话事件流
  └─ ctx.remote.remotenode.deliverables(linkId) RemoteStream：交付物清单/同步状态增量
        │
        ▼
web 插件：RemotenodeModel（非 React，observable）
  ├─ peers / remoteSessions / hostedSessions / pendingInteractions / selectedLink
  ├─ deliverables（双来源、版本、同步状态）+ follow 窗口
  └─ commands：prompt / cancel / resolveInteraction / upload / fetch / sync / refresh
        │
        ▼
slots：main 面板 inject hooks → React 组件（page/list/detail/approval）
      sidebar.panellist 图标（待审批红点）
```

实现要点：

- core 插件的 `control` 用 `@Remote({mode:'stream'})` 返回 `RemoteSnapshotStream`，首帧完整 baseline，之后 upsert/remove（参考 `job.follow`，`packages/api/job-controller/src/index.ts:75,90`）。
- web 插件尽量用 stream，避免改 `api-remotes` 的转发事件白名单。
- client model 用 `createSnapshotStore` 思路（`packages/client/store`），slot 注册时 `inject` 暴露 hooks；组件不拿 transport。
- `follow(linkId)` 断线由 Gateway `RemoteStream` 重新打开；core 每次 attach 生成新 `streamEpoch` + snapshot，天然支持 replace 窗口。
- 状态徽标用 `ui-primitives` 的 `StateDot`/`Tag`。

### 8.4 与本地会话 UI 的整合

| 集成点 | 做法 | 阶段 |
|---|---|---|
| 来源会话 → 远程会话 | `remotenode_run` 工具卡：显示对端名 + link 状态 + "查看远程会话"按钮（`ctx.layout.selectPanel('remotenode')` + 选中 link） | M1 |
| 来源会话 header | `conversation.session.header.lineage` 或 `.actions` 加 chip："远程：desktop-01 · 1 running" | M2 |
| 托管在本机的远程会话 | 本地会话 header 加 chip："由 desktop-01 的会话 X 发起"；本地正常交互 | M2 |
| 全局待审批 | `shell.overlay` 通知 + panellist 红点；点击跳转审批 | M1 |
| 远程会话详情 → 来源 | "打开来源会话"→ `ctx.uiWorkspace.openSession(initiatorSessionId)` | M1 |
| 远端交付物 → 来源会话 | 同步落地后向来源会话追加本地 `deliverables/presented`，复用原生交付卡片（预览/打开/反馈）；或自定义 `conversation.chat.turnTail` 卡（见 §15） | M2 |
| 本机交付物 → 远端 | composer/`remotenode_publish` → 本机 CAS → `deliverable.op` + prompt 带 `artifacts` 引用；host 同步到 replica/inbox | M1 |
| 交付物统一视图 | remotenode 页「交付物」：双方来源、版本、同步状态、批量同步/暂停 | M1 |
| 远程会话在左侧全局会话列表 | v1 **不出现**（SessionSummary 封闭）；托管在本机的会话本来就是本地会话，会正常出现 | — |
| 转录组件 | M1 简化 transcript；M2 复用 markdown/tool row/图片组件；M4 评估复用 Chat 视图 | 分阶段 |

### 8.5 实现最小路径（文件级）

1. core 插件内：`@Remote('list')`、`@Remote({mode:'stream'}) control`、`@Remote({mode:'stream'}) follow`、`@Remote({mode:'stream'}) deliverables`。
2. `packages/api/remotes/src/client/index.ts`：加 `remotenode` contribution（in-tree 时）。
3. `packages/remotenode/web/`：`package.json`（`dsh.client` + `exports['./client']` + `clientBundle`）、`src/client/index.ts`（locale、main 面板、sidebar.panellist、controller、i18n）、`page/*`、`approval.tsx`、`deliverable-list.tsx`。
4. core 内实现 `DeliverableStore` + `DeliverableSync` + `BlobStore`；注册 artifact 下载/上传路由；web 用它们做交付物视图与同步操作。
5. `packages/bundle/web-app/cordis.patch.yml`：加 core 行与浏览器 roster 行（参考 `:318-319`）。
6. core 插件配置：`listen` + `peers` + `deliverables`（见 §12.2）。
7. 新 profile `remotenode`（无人值守节点）。
8. 测试：`*.client.spec.tsx`、`*.host.spec.ts`（peer-link/auth/dedupe/deliverable-sync）、双进程集成测试。

### 8.6 可访问性 / 性能 / i18n

- 状态点不能只靠颜色：加文字/aria-label。
- 会话详情长列表窗口化/分页；事件流按帧批更新，避免每 token setState。
- 对端状态/待审批走一条 baseline+delta 流，避免轮询；心跳只更新内存行。
- i18n：`remotenode` namespace，中英各一份；`sidebar.panellist` 的 `label` 用 thunk（`ui-sidebar` 会在 locale 切换时重投影，`packages/client/ui-sidebar/src/client/index.ts:63`）。

---

## 9. 持久化、恢复与生命周期

### 9.1 两侧对称存储

| 位置 | 内容 | 生命周期 | 是否真相 |
|---|---|---|---|
| **本机会话日志** | initiator 侧：`remotenode/catalog`；host 侧：`remotenode/origin` + `remotenode-prompt` source | 与会话同寿；fork 继承规则同 subagent | ✅ 各自视角的权威 |
| **`$DSH_HOME/remotenode/peers.yaml`** | 对端 nodeId/name、secret 引用、拨号/监听策略、能力白名单 | 运维管理 | ✅ 连接配置权威 |
| **`$DSH_HOME/remotenode/links.json`** | linkId ↔ (peerNodeId, peerInstanceEpoch, localSessionId/remoteSessionId)、状态、cursor、交付物摘要 | 可重建（扫本机会话日志 + 对端对账） | 派生索引 |
| **`$DSH_HOME/remotenode/pending/`**（可选） | 未决审批/提问 | 内存为主；重启取消 | 派生 |
| **`$DSH_HOME/remotenode/deliverables/index.json`** | 交付物记录/版本/同步状态 | 随 link（可重建） | 派生索引 |
| **`$DSH_HOME/remotenode/deliverables/ops/<origin>.jsonl`** | 本节点发出的 op log（对账重放） | 有界/滚动 | 派生 |
| **`$DSH_HOME/remotenode/deliverables/applied.json`** | 每个来源已应用到的 originSeq 水位 | 随 link | 派生 |
| **`$DSH_HOME/remotenode/deliverables/cas/sha256/...`** | 内容寻址字节（双向通用，去重） | 配额/LRU | 缓存 |
| **`$DSH_HOME/remotenode/deliverables/replica/<origin>/<link>/...`** | 只读镜像（sync=all） | 用户/清理 | 派生 |
| **`$DSH_HOME/remotenode/deliverables/partial/<artifactId>.part`** | 断点续传临时文件 | 24h TTL | 临时 |
| **host 本地 sessions** | 会话完整日志（含 origin 标记） | 长期 | ✅ 内容权威 |

### 9.2 启动 / 重连 / 对账

```
节点启动
  → 读 peers.yaml（本机 nodeId、对端列表、拨号/监听配置）
  → 启动 listener（如配置）；对 auto-dial 对端开始拨号（指数退避）
  → 连接建立 → peer.hello/welcome（双向认证）→ peer.catalog 对账
  → deliverable.sync 交换 applied 向量，补齐交付物清单（缺口大用 snapshot）
  → 对每个活跃 link：initiator 侧发 session.attach；host 侧准备 snapshot
  → 浏览器 remotenode 页出 baseline；后续增量
```

### 9.3 崩溃与分区场景矩阵

| 场景 | 本机表现 | 对端表现 | 恢复 |
|---|---|---|---|
| 一侧网络断 | link offline/degraded | 对称 | dialer 重连 + catalog 对账 + attach |
| 一侧进程崩 | 本地会话持久化 | link offline | 重启后 instanceEpoch 变；attach/snapshot 或 not-resumable |
| 两侧同时崩 | 各自恢复 | — | 按配置拨号重连；两侧日志独立恢复 |
| 重复连接 | 去重规则关闭一条 | 对称 | 保留规范连接，日志记录 |
| 协议版本不兼容 | 页面标红 | 对称 | 提示升级；不降级运行 |
| 凭据轮换 | 断旧连 | 对称 | 新凭据重连；宽限窗口 |
| 交付物同步中断/op 丢失 | 清单可能短暂不一致 | 对称 | 重连/定时反熵 `deliverable.sync`；缺口用 snapshot 收敛 |

### 9.4 保留与清理

- 会话日志：各自沿用本机策略。
- links.json：`closed` 默认保留 30 天（可配），过期只删索引行，不删会话日志。
- 事件 tail 缓存：每 link 有界（如 2000 事件 / 8 MiB），超出只留 snapshot 位置。
- 交付物字节：per link 配额（默认 10 GiB）/ replica 清理策略；CAS 按配额 LRU，索引/墓碑保留。
- 审计：连接/断开、认证失败、审批决策、凭据变更写 `$DSH_HOME/logs/remotenode.log`。

---

## 10. 安全与权限

### 10.1 信任边界

- **本机 owner**（本机用户）完全可信。
- **对端节点**是**半可信执行端**：它有自己的模型 key、能执行本地命令；本机只能假设它持有合法凭据，不能假设它诚实。
- **对端 → 本机的数据**一律视为不可信输入（业务数据 + 可能被提示注入污染）。
- **本机浏览器**走现有 owner 认证；`remotenode` 页不新增浏览器信任面。

### 10.2 认证与密钥管理

- 每个 peer link 一组凭据（两侧相同或互配）：
  - **M1 推荐**：`linkSecret`（32B 高熵）经安全渠道人工交换，存 `peers.yaml`（文件权限收紧）；握手用双方 nonce 的 HMAC 互相证明；TLS 保护传输。
  - **M2+**：mTLS（两侧证书）；或一次性配对码换长期凭据（M3）。
- 凭据轮换：两侧同时更新后重连；旧凭据撤销立即断开。
- 传输：非 loopback 必须 TLS；公网建议 Tailscale/WireGuard；可叠加 mTLS。
- 不在日志/错误消息中回显 secret；握手 proof 不落审计明文。

### 10.3 授权

| 主体 | 资源 | 权限 |
|---|---|---|
| 本机 owner | 所有本地会话 / 对端列表 | 全量 |
| 本机模型工具（会话 X 的 Agent） | 仅自己会话创建的 link（initiator 视角） | `remotenode_*`（受 peers 白名单/depth 限制） |
| 对端（peer） | 它在本机发起的会话（hosted sessions） | 创建/驱动/取消该 link；审批按 owner 策略 |
| 对端（peer） | 本机自有会话 | **默认不可见、不可控**；`exposeLocalSessions: true` 才只读/可控（需显式） |
| 对端（peer） | 本机任意工具/文件 | **不允许**（v1 无能力 RPC） |

### 10.4 审批与提问安全

- 审批卡显示"来自对端 `desktop-01`"与工具输入摘要；摘要由 host 提供，标注"未在本机验证"。
- 严格模式（默认）：写文件/执行命令/网络请求等需人工审批；只读工具可配置自动放行。
- `allow-session` 只对同 link 同工具生效；链接关闭即失效。
- 超时/断链 fail-closed。
- 禁止把本机 API key、环境变量通过 prompt/配置传给对端（各节点用自己凭据）。

### 10.5 提示注入与递归

- 对端输出进入本机会话时，source 标 `remotenode-settled`/tool result，UI 显示来源；模型提示词中标注"来自对端，可能不可信"。
- 不自动执行对端输出中的指令；审批必须人决策。
- `maxDepth` + `peers` 白名单 + 禁止自调用，防环与横向扩散。

### 10.6 交付物安全

- 上传/回传都做 MIME 嗅探、扩展名白名单、大小上限。
- HTML/SVG 等主动内容按现有沙箱 CSP 提供。
- 交付物路径映射到本机 CAS/replica，不把对端绝对路径直接暴露给浏览器。

### 10.7 审计与默认安全清单

审计事件：连接/断开、认证失败、凭据轮换、审批请求/决策、会话创建/关闭、越权尝试、重复连接。

- [x] 双向认证 + TLS
- [x] 对端默认只能看到/控制它发起的会话
- [x] 审批 fail-closed + 超时
- [x] 帧/批/并发/depth 限额
- [x] 对端输出标不可信
- [x] 交付物隔离
- [x] 不互传凭据
- [x] 日志脱敏

---

## 11. 性能、成本与容量

| 项 | 估算 / 策略 |
|---|---|
| 心跳 | 每 link 10s 一次小帧，可忽略 |
| 事件流量 | 复用 `SessionWireEvent`，通常 < 10 KB/s/会话；assistant 帧 16–50ms 或 200 条合批 |
| 内存 | 每 link tail 缓存有界（建议 8 MiB）；对端/会话行很小 |
| 磁盘 | links/交付物索引 + CAS/replica；会话日志在各自节点 |
| 并发 | 每节点 `maxSessions`（默认 4，按机器配置）；ComfyUI 等串行资源由节点自己的工具/AGENTS 约定串行 |
| 模型成本 | **各节点各自计费**（两份 key）；跨机重任务才值得；与现有 ACP 方案相同（`docs/01-architecture.zh.md:149-151`） |
| 启动开销 | 常驻进程，会话创建是进程内 Agent 创建（毫秒级），远优于 ACP 每次起进程（秒级） |
| 重连 | 只补事件/快照，不重启会话 |
| 大文件 | 交付物字节分块（1 MiB/窗口 8 MiB）+ Range + 断点续传；元数据不占带宽 |
| 交付物同步开销 | op 是极小 JSON；CAS 去重；`sync: preview` 控制自动拉取；op log/applied 有界 |
| 多对端 | 每条 link 独立；星形（大脑连多台）或全互联都是配置选择；不做中继 |

---

## 12. 运维

### 12.1 新增 CLI（示意）

```bash
# 两侧通用
dsh remotenode node id                         # 查看/生成本机 nodeId
dsh remotenode peer add --id desktop-01 --name "家里台式机" --secret-ref ...
dsh remotenode peer list
dsh remotenode peer secret rotate --id desktop-01
dsh remotenode peer disable --id desktop-01
dsh remotenode link list [--peer desktop-01]
dsh remotenode doctor                          # 监听/证书/对端连通检查
```

（v1 可先 YAML + 设置页；CLI 是 M3 运维体验项。）

### 12.2 配置示例（两侧同构）

**节点 A（Linux 大脑；监听 + 也主动拨号）**

```yaml
- insert:
    - id: remotenode
      name: '@deepseek-ai/dsh-remotenode'
      config:
        nodeId: brain-linux
        listen:
          host: 100.64.0.10        # Tailscale IP；必须具体 IP，不用 0.0.0.0
          port: 8910
          tls:
            certFile: /root/.dsh/certs/brain.crt
            keyFile: /root/.dsh/certs/brain.key
        heartbeatMs: 10000
        offlineAfterMs: 60000
        maxFrameBytes: 1048576
        maxSessions: 8
        maxDepth: 2
        exposeLocalSessions: false
        approvals:
          defaultOwner: both       # both | initiator | host
          timeoutMs: 300000
        deliverables:
          roots: [/root/AiWork/workspace, /tmp/dsh-out]
          publishFromLocal: true          # 本机 link 会话的 present 也同步给对端
          sync: preview                   # metadata | preview | all-small | all
          replicaDir: /root/.dsh/remotenode/deliverables/replica
          keepLocalCopies: true           # 对端删除时本地副本保留
          versionRetention: 5             # 每条保留版本数
          autoIngestMaxBytes: 67108864    # 发布时 ≤64MiB 直接进 CAS
          maxFileBytes: 1073741824        # 1 GiB
          maxLinkBytes: 10737418240       # 10 GiB
        peers:
          - nodeId: desktop-01
            name: 家里台式机
            dial: auto             # auto | never（auto=本机主动拨号；NAT 友好）
            url: wss://100.64.0.11:8910/remotenode/v1/stream
            secretRef: peers.desktop-01
            tls:
              caFile: /root/.dsh/certs/desktop-ca.pem

    - id: tool-remotenode
      name: '@deepseek-ai/dsh-tool-remotenode'
```

**节点 B（Windows 台式机；监听 + 可选拨号）**

```yaml
- insert:
    - id: remotenode
      name: '@deepseek-ai/dsh-remotenode'
      config:
        nodeId: desktop-01
        listen:
          host: 100.64.0.11
          port: 8910
          tls:
            certFile: C:/dsh-worker/certs/desktop.crt
            keyFile: C:/dsh-worker/certs/desktop.key
        maxSessions: 4
        maxDepth: 2
        exposeLocalSessions: false
        approvals:
          defaultOwner: initiator  # 台式机通常无人值守，交给发起方答
          timeoutMs: 300000
        deliverables:
          roots: [C:/dsh-worker/workspace]
          publishFromLocal: true
          sync: metadata                  # host 侧默认只同步清单，字节按需
          keepLocalCopies: true
          versionRetention: 5
          autoIngestMaxBytes: 67108864
          maxFileBytes: 1073741824
        peers:
          - nodeId: brain-linux
            name: Linux 大脑
            dial: auto
            url: wss://100.64.0.10:8910/remotenode/v1/stream
            secretRef: peers.brain-linux
```

> 两侧都 `dial: auto` 也可以；连接去重规则会保留一条规范连接。若只在 A 配 `auto`、B 配 `never`，则 B 只监听（同样对等，只是建链方向固定）。

### 12.3 日志/指标/健康检查

- 连接日志：连接/断开/认证失败/心跳超时/去重/协议错误。
- 每 link 指标：事件延迟、吞吐、重连次数、审批等待时长、活跃会话数。
- 健康检查：`GET /remotenode/v1/health`（TLS + 只读状态，不泄露凭据）。
- 排障表（节选）：

| 现象 | 可能原因 | 处理 |
|---|---|---|
| remotenode 页对端离线 | 未启动/网络/凭据错/双向认证失败 | 查对端日志、`dsh remotenode doctor`、时间同步 |
| 对端在线但建会话失败 | 版本不兼容/workspace 不存在/模型 key 缺失/深度超限 | 看 `session.created` 错误码与审计 |
| 会话卡 starting | `session.create` 超时/事件未回 | 查两侧 gateway 日志 |
| 审批不出现 | owner 策略不在本侧/页面未订阅/断线 | 检查 `approvals.defaultOwner`、刷新页面 |
| 重连后历史缺失 | 对端重启/快照 replace | 正常；`not-resumable` 则显示错误 |
| 两条连接/频繁重连 | 两侧都拨号且去重失败/网络抖动 | 看 `peer/duplicate` 日志与规范方向 |
| 图片不显示 | 交付物未同步/上限/路径映射 | 查 deliverable 状态、CAS 与 MIME |
| 远端交付物不出现 | `present` 路径不在 `deliverables.roots` / 不在 link 会话 / 对端离线 | 查两侧 deliverable 日志与 op 对账状态 |
| 交付物下载卡住 | 对端离线/传输中断/hash 重试 | 看 link 状态；重连后续传；检查 `.part` |
| 两端清单不一致 | op 丢失/对账未跑 | 点「立即同步」触发 `deliverable.sync`；查 applied 向量 |
| 3D 模型无法预览 | DSH 无内置 3D 查看器 | 让远端同时交付预览 PNG；下载后用 Blender/默认应用打开 |

---

## 13. 实施路线与验收

### 13.1 里程碑

| 阶段 | 目标 | 主要交付 | 验收标准 |
|---|---|---|---|
| **M0**（2–3 天） | 冻结决策与协议 | 本文档评审、协议 v1 草案、威胁模型、双进程测试脚手架 | 决策项拍板；帧/方法/错误码评审通过 |
| **M1**（1–2 周） | 单对节点**双向**闭环 + 基础交付物同步 | core（peer-link/auth/listener/dialer）+ SessionHost/SessionClient + attach/事件流 + 双向标记 + `remotenode` 页（对端/双向会话/详情/审批/**交付物视图**）+ `tool-remotenode` 基础工具 + DeliverableStore/op/oplog/applied + `present` 拦截 + 图片自动同步/浏览器下载 | A 在 B 建会话、B 在 A 建会话都能跑；流式/中断/审批；页面同时看到两组会话；两侧日志各有标记；远端 `present` 的交付物清单自动同步到本机，图片自动拉取、文件可下载；两侧重启后能恢复 |
| **M2**（1.5–2.5 周） | 完整交付物同步 + 本地多会话语义 | 双向 `present`/publish、版本/墓碑、离线 op 排队与 `deliverable.sync` 对账、`sync: preview/all`、replica 只读镜像、大文件断点续传、native 交付卡；queue/steer、page、重连补历史、用户提问、改名、模型选择、审批 owner 策略 | 断网 30s 后清单/字节自动收敛；任一侧重启后不留分叉；远端删除会同步为墓碑且本地副本默认保留；GLB 断点续传；审批超时 fail-closed |
| **M3**（1.5–2 周） | 多对端与安全加固 | 多对端、连接去重、secret 轮换/mTLS、审计、限流/背压、Windows 服务化、CLI、孤儿/清理；artifact HTTP 快通道（Range）、配额/LRU、版本保留策略 | 3 对端并发；越权/伪造/重放/路径遍历/伪造 op 测试通过；压测（4 会话/节点 + 大文件同步）稳定 |
| **M4**（评估） | 能力互调 / 上游化 | 能力 RPC（对端工具/服务白名单调用）、协议文档化、作为 DSH 子系统提案；评估"代理成类本地 Session" | 上游评审；或能力互调原型；或 B 路线原型 |

> 工作量按 1 名熟悉 DSH 的开发者估算；M0 必须先做，避免边写边改协议。

### 13.2 测试策略

- **单元**：帧编解码、版本协商、认证证明、连接去重、link 状态机、审批状态机、去重表、事件连续性、深度限制。
- **集成（同机双进程）**：两个 `dsh` 进程互连；覆盖 A→B 与 B→A 建会话、双向 prompt/cancel、审批、断连重连、进程重启、同时拨号去重。
- **UI**：`*.client.spec.tsx`（页面、两组会话、审批卡、空态）；`pnpm run dev:web` 手工验收。
- **故障注入**：断网 5s/30s/2min、一侧 kill -9、两侧同时重启、重复帧、乱序帧、超大帧、慢消费者、同时拨号。
- **安全**：错误 secret、未配置 nodeId、伪造 linkId、跨 link 操作、审批重放、递归深度、恶意帧、本地会话窥探、伪造 `deliverable.op`/跨来源写/路径遍历/未授权拉取/超大文件。
- **交付物同步**：`present` 拦截→op；两端清单收敛；乱序/重复/丢 op 对账；op log 缺口→snapshot；版本更新/墓碑/`keepLocalCopies`；断点续传/hash 校验/`stale`；浏览器 Range 下载；输入文件发布到远端；配额拒绝。
- **兼容性**：两侧版本矩阵（v1 协议内）；Windows 10/11（路径/ACL/服务）。

### 13.3 演示剧本（贴合你的 GPU 台式机场景）

1. Linux 大脑新会话："用台式机生成一张 1024×1024 的赛博朋克猫，然后展示给我。"
2. 大脑模型调 `remotenode_list` → 看到 `desktop-01`；调 `remotenode_run`（prompt 自包含）。
3. Windows 台式机创建会话；大脑 `remotenode` 页出现"我发起、运行在对端"的会话，状态 running，可点进去看流式事件。
4. 台式机用 Blender 生成低模猫，写 `out/cat.glb` 并渲 `out/cat-preview.png`，然后调 `present([...])`；要执行写文件/命令时，大脑弹出审批卡（无人值守台式机，审批 owner=initiator）；点"允许一次"；继续。
5. 大脑侧两条交付物记录自动同步：预览 PNG 按 `sync: preview` 自动拉字节并内联；GLB 为 metadata-only，显示大小/同步状态/下载按钮。点下载 → 分块/断点续传 → 校验 sha256 → CAS + replica，可"用默认应用打开"（Blender）或交给本地 Agent。
6. 完成：台式机上报最终文本；来源会话收到 settled 通知 + 交付物摘要；两端 `remotenode` 页看到同一份清单（来源/版本/同步状态）。若台式机重新发布 GLB，大脑侧收到新版本并按策略拉取。
7. 反向验证：在台式机的 `remotenode` 页/模型工具对 Linux 大脑发起一个会话（例如"帮我在大脑上跑个测试"），大脑侧会话带"由 desktop-01 发起"标记；反向也可传文件。
8. 重启任一侧：对端短暂 offline→online，会话恢复；未完成的下载可续传；两侧页面状态正确。
9. 全程两侧本地其他会话互不影响。

### 13.4 验收清单（v1 必须）

- [ ] 双向认证 + TLS + 连接去重
- [ ] A→B 与 B→A 建会话、流式、中断、审批
- [ ] `remotenode` 页：对端列表 + 两组会话 + 详情 + 审批
- [ ] 双向标记持久（两侧各自日志）
- [ ] 交付物通道：两端 `present`/publish → 清单自动同步（来源/版本/同步状态）
- [ ] 字节同步：图片自动、大文件按需、断点续传、sha256 校验、`stale`
- [ ] 同步对账：断网/重启后 op 收敛；重复/乱序/丢 op 不产生分叉
- [ ] 删除墓碑 + 本地副本保留；版本更新可见
- [ ] 本机交付物可反向上传到远端；配额/未授权路径被拒
- [ ] 审批 fail-closed + owner 策略
- [ ] 断线重连 + 任一侧重启恢复
- [ ] 限额/背压/depth 限制
- [ ] 单测/集成/安全测试通过
- [ ] 文档：协议 + 部署 + 排障

---

## 14. 风险、备选与取舍

### 14.1 风险表

| 风险 | 影响 | 缓解 |
|---|---|---|
| 对等协议的请求方向容易写乱 | 调试困难/死锁 | 明确"会话角色约束"；每方法标注 caller/receiver 角色；双向各写一组集成测试 |
| 同时拨号/重复连接 | 双会话/事件重复 | 确定性去重规则 + 日志 + 两侧一致实现 |
| 远程会话 UI 与本地 Chat 不一致 | 体验割裂 | M1 简化但明确；M2 复用 markdown/tool/图片；M4 评估深整合 |
| 事件重放/游标 bug | 历史错乱/重复 | 不变量 + 去重 + gap snapshot；故障注入测试 |
| 审批双答/超时 | 会话卡住/不一致 | 先到先得 + resolved 广播 + 超时 fail-closed |
| 对端版本/协议漂移 | 连不上/行为不一致 | 严格 hello 协商；页面标红；升级指引 |
| 各节点模型 key | 成本翻倍/凭据管理 | 沿用现有模式；各节点独立 key；成本提示 |
| 递归调用成环 | 资源耗尽 | depth + peers 白名单 + 禁止自调用 |
| 交付物同步分叉/误删 | 清单不一致/文件丢失 | op log + applied 对账；墓碑 + keepLocalCopies；定时反熵 |
| 中心包改动（若走 B） | 回归风险 | v1 走 A；B 只做评估原型 |
| 顶部页签诉求未满足 | 观感不符 | §8.1 方案 B（M3 壳层改动）可作为选项 |

### 14.2 备选方案对比

| 方案 | 复用度 | 改造量 | 安全 | 重连 | 流式 | 结论 |
|---|---|---|---|---|---|---|
| **本设计：对等 PeerLink + WSS/TCP + JSON-RPC** | 中高（复用 wire 类型/UI 原语） | 中 | 自建双向认证，可控 | 自建（退避/游标） | 双向 | ✅ 推荐 |
| 中心 Hub 模型（v1 初稿） | 中高 | 中 | 单向 token | 类似 | 双向 | ❌ 与"同级互调"冲突 |
| 复用浏览器 `/api` + `/api/remote.mux` | 高 | 中（需改 principal/admission/remote-access，且浏览器 Peer 不是对等） | 复用 cookie/RBAC | 复用退避 | 复用 WS 流 | ❌ 单向浏览器模型，不适合 node 间对等 |
| ACP over WS/HTTP（SDK 实验传输） | 中高 | 中（补鉴权/路由/loadSession） | 弱（automation-only） | 需 loadSession | SSE/WS | ❌ 单向、缺 UI/审批语义 |
| SSH 执行世界 | 低 | 高 | 强 | 无 | 管道 | ❌ Windows/整世界限制 |
| MCP 工具桥 | 低 | 高 | 中 | 有 | 有限 | ⭕ 补充（单工具快通道） |

### 14.3 为什么不用 ACP 作为主协议（详细）

1. **定位**：ACP 明确是 automation-only，不提供 DSH 展示数据（计划/标题/todo/终端视图/elicitation），`packages/acp/acp/README.zh.md:32-34,94-100`。
2. **能力缺口**：`session/load`、fork、附加目录、客户端文件系统都不支持（同文件 `:80`），无法做"续聊 + 历史回放"。
3. **审批语义**：只有一次性 allow/reject（`packages/acp/acp/src/index.ts:160-177`），没有"本会话允许"、没有两侧 owner 策略。
4. **鉴权**：`authenticate` 立即成功、无 authMethods（`:190-192`），必须外挂 SSH/TLS，Windows 不友好。
5. **事件粒度**：只发标准 `session/update`，没有 `SessionWireEvent` / assistant 增量 / projection，无法让两侧 UI 与本地会话对齐。
6. **方向性**：ACP 是 client→server 单向模型，不满足"同级互调"。
7. **结论**：ACP 保留为"接入非 DSH 标准 ACP agent"的后端（M4），不作为 remotenode 协议。

### 14.4 为什么不用浏览器 `/api` 做节点通道

- 浏览器 Connection 的 Peer 由 cookie/token 认证；非 owner Peer 需要 remote-access policy；exact Fetch 默认 403（`packages/api/remote-access/README.zh.md:83`）。
- 它的模型是"浏览器客户端 → Host"单向调用 + host 推流，不是两个 DSH 实例对等互调。
- 改造它需要新增 principal kind、admission、双向调用语义，收益不如独立 PeerLink 清晰。

---

## 15. 待你拍板的决策（附推荐默认）

| # | 决策 | 推荐默认 | 备选 |
|---|---|---|---|
| 1 | **"上方的 remotenode 页签"** | 左侧栏顶部全局面板入口 + `main` 面板（纯插件） | 改 ui-layout 加横向顶栏（壳层改动，M1/M3） |
| 2 | 对端认证方式 | per-link shared secret + TLS（M1）；M2 加 mTLS/配对码 | 只 mTLS；中心签发（引入中心，否决） |
| 3 | 审批默认 owner | `both`（双方可答、先到先得）；无人值守节点配 `initiator` | 固定 host / 固定 initiator |
| 4 | 对端可见性 | 默认只暴露"对端在我这发起的会话"（`exposeLocalSessions:false`） | 允许看全部本地会话（更开放） |
| 5 | 连接方向 | 双方都可配 `dial: auto`；去重取规范连接；默认台式机拨号到大脑（NAT 友好） | 固定单向 |
| 6 | 多对端拓扑 | v1 支持多对端（星形/互联都可），无中继 | v1 只支持单对端 |
| 7 | Node 模型凭据 | 各节点带自己的 key（沿用现状） | 互相代理 LLM（成本/安全/实现都更重） |
| 8 | v1 UI 深度 | 对端列表 + 双向会话 + 简化转录 + prompt/cancel/审批 + **交付物视图**（先能用） | 首版就完整 Chat/附件/问答（工期翻倍） |
| 9 | 交付物默认同步策略 | `sync: preview`（清单必达 + 预览自动 + 大文件按需） | `metadata`（省带宽）/ `all`（强同步、离线可用） |
| 10 | 本机发布默认 | `publishFromLocal: true`：link 会话里的 `present` 也同步给对端（双向） | 只允许远端→本机（单向） |
| 11 | 删除/版本策略 | 墓碑 + `keepLocalCopies: true` + 保留 5 个版本 | 立即物理删除 / 只留最新版 |
| 12 | 来源会话呈现 | M2 落地后追加本地 `deliverables/presented`，复用原生交付卡（推荐） | 自定义 `turnTail` 交付物卡 |

> 如果只回一句：我建议 **1A + 2 shared secret + 3 both（台式机 initiator） + 4 不暴露 + 5 双向 auto + 6 多对端 + 7 各自 key + 8 分阶段 + 9 preview + 10 双向发布 + 11 墓碑/保留副本/5 版本 + 12 原生交付卡**。

---

## 附录 A：协议帧示例

**A.1 握手（A 拨号到 B）**

```json
{"jsonrpc":"2.0","id":"h1","method":"peer.hello","params":{
  "protocol":1,
  "nodeId":"brain-linux",
  "nodeName":"Linux 大脑",
  "instanceEpoch":"a1b2...",
  "connectionId":"c-9f...",
  "platform":"linux",
  "dshVersion":"0.2.1-rc.2",
  "capabilities":{"assistantStream":true,"approvals":true,"questions":true,
                  "attachments":true,"modelSelection":true,"resumeAfterRestart":true,
                  "sessionVisibility":"own-calls"},
  "nonce":"nA-...",
  "proof":"hmac-sha256(...)"
}}
```

```json
{"jsonrpc":"2.0","id":"h1","result":{
  "protocol":1,
  "nodeId":"desktop-01",
  "nodeName":"家里台式机",
  "instanceEpoch":"b7c8...",
  "platform":"windows",
  "dshVersion":"0.2.1-rc.2",
  "capabilities":{"assistantStream":true,"approvals":true,"questions":true,
                  "attachments":true,"modelSelection":true,"resumeAfterRestart":true,
                  "sessionVisibility":"own-calls"},
  "heartbeatMs":10000,
  "maxFrameBytes":1048576,
  "maxEventBatch":200,
  "nonce":"nB-...",
  "proof":"hmac-sha256(...)"
}}
```

**A.2 A 在 B 上创建会话**

```json
{"jsonrpc":"2.0","id":"c-1","method":"session.create","params":{
  "linkId":"6f1c2a7e-9b1d-4e2a-8c3f-0a1b2c3d4e5f",
  "initiatorSessionId":"session-42",
  "initiatorNodeId":"brain-linux",
  "label":"生成赛博朋克猫",
  "prompt":[{"type":"text","text":"在 C:/dsh-worker/workspace 下生成一张 1024x1024 的赛博朋克猫 PNG，输出 artifacts JSON。"}],
  "cwd":"C:/dsh-worker/workspace",
  "model":{"provider":"deepseek-official","model":"deepseek-flash"},
  "delegationDepth":1
}}
```

```json
{"jsonrpc":"2.0","id":"c-1","result":{
  "linkId":"6f1c2a7e-...",
  "hostSessionId":"5b2e9a10-7c44-4f0b-9d1e-2a3b4c5d6e7f",
  "header":{"version":4,"id":"5b2e9a10-...","createdAt":1730000000123,
            "cwd":"C:/dsh-worker/workspace","isSeeded":false},
  "status":"running"
}}
```

**A.3 B（host）上报事件给 A（initiator）**

```json
{"jsonrpc":"2.0","method":"event.session","params":{
  "linkId":"6f1c2a7e-...",
  "hostSessionId":"5b2e9a10-...",
  "instanceEpoch":"b7c8...",
  "streamEpoch":1,
  "seqFrom":41,
  "records":[
    {"type":"event","event":{"type":"tool/call","seq":41,"time":1730000002000,"data":{}}}
  ]
}}
```

**A.4 B 向 A 请求审批（host → initiator）**

```json
{"jsonrpc":"2.0","id":"i-7","method":"interaction.request","params":{
  "interactionId":"0d9e...",
  "linkId":"6f1c2a7e-...",
  "kind":"approval",
  "createdAt":1730000003000,
  "expiresAt":1730000303000,
  "payload":{
    "tool":"bash",
    "inputPreview":"python comfy.py --prompt ... --out out/cat.png",
    "risk":"writes files"
  }
}}
```

```json
{"jsonrpc":"2.0","id":"r-7","method":"interaction.resolve","params":{
  "interactionId":"0d9e...",
  "decision":{"kind":"select","optionId":"allow-once"}
}}
```

**A.5 反向：B 在 A 上创建会话（证明对等）**

```json
{"jsonrpc":"2.0","id":"c-2","method":"session.create","params":{
  "linkId":"9a8b7c6d-...",
  "initiatorSessionId":"session-7",
  "initiatorNodeId":"desktop-01",
  "label":"在大脑上跑回归测试",
  "prompt":[{"type":"text","text":"运行 pnpm test，把失败摘要写出来。"}],
  "cwd":"/root/AiWork/project",
  "delegationDepth":1
}}
```

**A.6 重连对账**

```json
{"jsonrpc":"2.0","id":"cat-1","method":"peer.catalog","params":{
  "links":[
    {"linkId":"6f1c2a7e-...","initiatorNodeId":"brain-linux","initiatorSessionId":"session-42",
     "hostNodeId":"desktop-01","hostSessionId":"5b2e9a10-...","status":"running"},
    {"linkId":"9a8b7c6d-...","initiatorNodeId":"desktop-01","initiatorSessionId":"session-7",
     "hostNodeId":"brain-linux","hostSessionId":"session-88","status":"idle"}
  ]
}}
```

## 附录 B：术语表

| 术语 | 含义 |
|---|---|
| Remote Node | 参与对等连接的 DSH 实例，用 `nodeId` 标识 |
| Peer Link | 两节点间的一条传输连接；dialer/listener 只是建链角色 |
| initiator | 发起某个远程会话的一侧；铸 linkId、控制会话、接收事件与审批 |
| host | 托管某个远程会话的一侧；跑 Agent、上报事件、发起审批 |
| linkId | 跨节点会话关联标识，由 initiator 铸造 |
| connectionId | 一次传输连接的标识，用于去重/日志 |
| instanceEpoch | 节点进程实例标识，重启即变 |
| streamEpoch | 一次 attach 观察代，重连/重建观察面时 +1 |
| remotenode/catalog | initiator 会话日志里的"我在对端创建了哪个会话" |
| remotenode/origin | host 会话日志里的"这个会话由对端哪个会话发起" |
| interaction | 审批/提问的远程交互请求 |
| fail-closed | 无法决策时拒绝，而不是放行 |

## 附录 C：参考文件索引（关键事实来源）

| 主题 | 路径 |
|---|---|
| 架构 / profile / 事件 / 会话日志 | `docs/architecture.zh.md:13-47,67-130` |
| 会话 wire 类型 | `packages/api/session-controller/src/types.ts:450-599` |
| 本地会话驱动面 | `packages/api/session-controller/src/index.ts:275,461,513,524,536,547,598` |
| `SessionHeader` 封闭 / V4 校验 | `packages/core/session/src/types.ts:90-132`、`packages/session/session-format-v3-to-v4/src/validation.ts:19-35` |
| subagent catalog / external 语义 | `packages/subagent/subagent/src/catalog.ts:28-36,126,139-169`、`docs/subsystems/subagent.zh.md:229,379` |
| ACP 能力与限制 | `packages/acp/acp/README.zh.md:60-80,94-116`、`packages/acp/acp/src/index.ts:160-177,190-192,378-380` |
| 浏览器连接 / 认证 / 重连 | `packages/client/connection/README.zh.md`（认证与 generation 节） |
| Remote 方法 / stream | `docs/api-gateway.zh.md:62,168`、`packages/api/gateway/src/stream-protocol.ts:7,235-257` |
| Remote 访问控制 | `packages/api/remote-access/README.zh.md:27-44,83` |
| Web 布局与面板槽 | `packages/client/ui-layout/src/client/index.ts:68-119`、`AppFrame.tsx:30-45` |
| 面板注册范例 | `packages/client/ui-plugin-manager/src/client/index.ts:67,111-150` |
| Sidebar panellist 契约 | `packages/client/ui-sidebar/src/client/contract/slots.ts:35`、`SidebarRoot.tsx:71,280` |
| 客户端插件/roster | `docs/subsystems/client-modules.zh.md`、`packages/bundle/web-app/cordis.patch.yml:318-319` |
| 后台任务流范例 | `packages/api/job-controller/src/index.ts:75,90` |
| 上一版 ACP 方案与限制 | `docs/01-architecture.zh.md`、`docs/04-operations.zh.md:50-63` |
| `present` / 交付事件 | `packages/deliverables/tool-present/src/types.ts:15`、`docs/subsystems/deliverables.zh.md:9-19,136-138` |
| 附件内容寻址与上限 | `docs/subsystems/attachment.zh.md:5-20` |
| 本机文件读取/预览服务 | `packages/api/workspace-files/README.zh.md:28-50,60-68,77-83` |
| 浏览器上传/下载载体 | `packages/client/file-upload/README.zh.md`、`packages/client/connection/README.zh.md` |
| 原生打开与交付卡片 | `packages/host/open-in-app/README.zh.md`、`packages/client/ui-deliverables/README.zh.md` |

---

## 附录 D：交付物同步协议帧示例

**D.1 `present` 拦截 → 发布 op（host → peer）**

host 侧（伪代码）：

```ts
ctx.on('session/event', (event) => {
  if (event.type !== 'deliverables/presented') return
  const link = links.ofSession(event.sessionId)          // 只处理 link 两端的会话
  if (!link) return
  for (const file of event.data.files)
    deliverableStore.publish(link.linkId, file.path)     // 校验 roots → 版本/op → 写 op log
})
```

```json
{"jsonrpc":"2.0","method":"deliverable.op","params":{
  "linkId":"6f1c2a7e-...",
  "op":"upsert",
  "originNodeId":"desktop-01",
  "originSeq":12,
  "record":{
    "deliverableId":"9d2e...",
    "linkId":"6f1c2a7e-...",
    "originNodeId":"desktop-01",
    "originSessionId":"5b2e9a10-...",
    "logicalPath":"desktop-01/5b2e9a10-.../cat.glb",
    "name":"cat.glb",
    "kind":"model3d",
    "createdAt":1730000005000,
    "updatedAt":1730000005000,
    "originSeq":12,
    "current":{"artifactId":"sha256:9f2c...","size":12897408,
               "mime":"model/gltf-binary","createdAt":1730000005000,"originSeq":12},
    "versions":[{"artifactId":"sha256:9f2c...","size":12897408,
                 "mime":"model/gltf-binary","createdAt":1730000005000,"originSeq":12}]
  }
}}
```

**D.2 重连对账：sync → 增量 ops，缺口用 snapshot**

```json
{"jsonrpc":"2.0","id":"s-1","method":"deliverable.sync","params":{
  "linkId":"6f1c2a7e-...",
  "applied":{"desktop-01":11,"brain-linux":7}
}}
```

```json
{"jsonrpc":"2.0","id":"s-1","result":{
  "ops":[
    {"linkId":"6f1c2a7e-...","op":"upsert","originNodeId":"desktop-01",
     "originSeq":12,"record":{"deliverableId":"9d2e...","name":"cat.glb"}}
  ]
}}
```

缺口超出 op log（或手动全量）：

```json
{"jsonrpc":"2.0","id":"s-2","method":"deliverable.sync","params":{
  "linkId":"6f1c2a7e-...","applied":{"desktop-01":2}
}}
```

```json
{"jsonrpc":"2.0","id":"s-2","result":{
  "snapshot":[{"deliverableId":"9d2e...","originNodeId":"desktop-01","originSeq":12,
               "current":{"artifactId":"sha256:9f2c...","size":12897408}}],
  "complete":true
}}
```

**D.3 字节同步：fetch → chunk → end**

```json
{"jsonrpc":"2.0","id":"f-1","method":"artifact.fetch","params":{
  "artifactId":"sha256:9f2c...","offset":0
}}
```

```json
{"jsonrpc":"2.0","id":"f-1","result":{
  "artifactId":"sha256:9f2c...","size":12897408,"chunkBytes":1048576
}}
```

```text
[4B headerLen][{"artifactId":"sha256:9f2c...","offset":0,"length":1048576}][1 MiB bytes]
[4B headerLen][{"artifactId":"sha256:9f2c...","offset":1048576,"length":1048576}][1 MiB bytes]
```

```json
{"jsonrpc":"2.0","method":"artifact.end","params":{
  "artifactId":"sha256:9f2c...","bytes":12897408,"sha256":"9f2c...","ok":true
}}
```

**D.4 删除墓碑**

```json
{"jsonrpc":"2.0","method":"deliverable.op","params":{
  "linkId":"6f1c2a7e-...",
  "op":"remove",
  "originNodeId":"desktop-01",
  "originSeq":14,
  "deliverableId":"9d2e...",
  "at":1730000100000
}}
```

**D.5 浏览器下载（本机路由，支持 Range）**

```http
GET /remotenode/v1/artifact/sha256:9f2c...
Range: bytes=0-1048575
Cookie: <browser session>

HTTP/1.1 206 Partial Content
Content-Type: model/gltf-binary
Content-Disposition: attachment; filename="cat.glb"
Accept-Ranges: bytes
ETag: "sha256:9f2c..."
```

**D.6 本机发布（输入方向）**

```http
POST /remotenode/v1/upload
Content-Type: application/octet-stream
X-Remotenode-Link: 6f1c2a7e-...
Cookie: <browser session>

<streamed bytes>
```

```json
{"deliverableId":"a3f1...","originNodeId":"brain-linux","name":"ref.png",
 "current":{"artifactId":"sha256:7d3e...","size":245760,"mime":"image/png"}}
```

**D.7 时序汇总**

```
B 模型 present → B publish（op 入 op log）→ deliverable.op → A
A 应用 op（清单出现）→ 按 sync=preview 自动 artifact.fetch（PNG）
A 校验 sha256 → CAS → 状态 synced；GLB 保持 metadata-only，用户点开再拉
B 重新发布 GLB（新版本 op）→ A 更新版本列表 → 按策略拉新字节
A 发布自己的交付物（本机 present/publish）→ deliverable.op → B
断网/重启 → 双方 deliverable.sync(applied) 对账 → 缺口补发或 snapshot → 收敛
```

---

> **下一步**：M0 细化规格见 [07-remotenode-m0-protocol.zh.md](07-remotenode-m0-protocol.zh.md)（协议 v1 帧/方法/错误码、交付物同步对账算法、存储格式、状态机、M1 WBS）。本系列只做设计，未写实现代码。
