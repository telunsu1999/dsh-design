# 07 · Remote Node M0 细化：协议 v1 与交付物同步规格

| 项 | 内容 |
|---|---|
| 状态 | **设计规格（M0）**，未实现 |
| 日期 | 2026-10-23 |
| 依据 | DSH `0.2.1-rc.2`（checkout `687f282e86`）+ [06-remotenode-design.zh.md](06-remotenode-design.zh.md) v2 |
| 范围 | 协议 v1 帧/方法/错误码、交付物同步模型与对账算法、持久化格式、状态机、M1 任务拆解与验收 |
| 前置决策 | 按 06 §15 推荐默认冻结（见 §0.2），后续可调整但需同步修订本规格 |

---

## 目录

0. 范围与已冻结决策
1. 协议分层
2. 通用约定
3. 连接、认证与去重
4. `peer.*` 方法
5. `session.*` 方法
6. 事件流
7. `interaction.*`（审批/提问）
8. 交付物同步（M0 核心）
9. `artifact.*` 字节层
10. 浏览器侧 Remote API
11. 持久化格式
12. 配置 schema（M1）
13. 状态机汇总
14. 不变量与测试向量
15. M1 任务拆解与验收
16. 安全 checklist
17. 仍待确认
附录 A 错误码总表 · 附录 B 共享 secret 证明 · 附录 C 一次完整交换

---

## 0. 范围与已冻结决策

### 0.1 本规格要回答什么

1. 两端（对等节点）到底交换哪些帧、字段类型、校验规则、错误码？
2. 交付物（deliverable）如何建模、如何增量同步、如何对账、如何恢复？
3. 两端的本地存储（op log、applied 水位、索引、CAS、replica）具体长什么样？
4. 状态机与不变量是什么？哪些场景必须测？
5. M1 要写哪些包/文件、按什么顺序、怎么验收？

### 0.2 继承 06 的默认决策

| 决策 | 取值 |
|---|---|
| 插件 | 单一 core `@deepseek-ai/dsh-remotenode`，两侧同装；`protocol`/`web`/`tool` 分包 |
| 传输 | 独立端口 HTTPS+WSS（默认）；可选 TCP carrier；JSON-RPC 2.0 子集 + artifact 二进制帧 |
| 认证 | per-link shared secret + TLS（M1）；M2 加 mTLS/配对码 |
| 建链 | 双方都可 `dial: auto`；连接按"较小 nodeId 拨出的连接为规范连接"去重 |
| 会话角色 | 每会话 initiator / host；同一节点可同时兼任 |
| 标记 | initiator 写 `remotenode/catalog`；host 写 `remotenode/origin` + `remotenode-prompt` source；不改 SessionHeader/格式版本 |
| 审批 | 默认 owner=`both`（先到先得）；无人值守节点配 `initiator`；超时 fail-closed |
| 可见性 | 默认只暴露"对端在我这发起的会话" |
| 交付物同步 | `sync: preview`；`publishFromLocal: true`；墓碑 + `keepLocalCopies: true`；保留 5 个版本；native 交付卡 M2 |
| UI | `remotenode` 全局面板（sidebar panellist + main）；暂不做横向顶栏 |
| 模型凭据 | 各节点自己的 key |

### 0.3 M0 的完成定义（Exit Criteria）

- [ ] 本规格评审通过：帧/方法/错误码/存储格式不再大改
- [ ] 冻结一份 `protocol/v1` 的 TypeScript 类型与 JSON Schema（字段级）
- [ ] 冻结交付物 op/sync/snapshot 对账算法（伪代码级）与不变量
- [ ] 冻结 M1 任务拆解、依赖、验收用例
- [ ] 双进程测试脚手架设计（mock 帧录制/回放 + 双 dsh 进程）
- [ ] 安全评审 checklist 通过（认证、路径、配额、权限）

---

## 1. 协议分层

```
┌────────────────────────────────────────────────────────────┐
│ 应用层                                                      │
│  peer.*        节点/连接（hello、heartbeat、catalog、sessions）│
│  session.*     会话驱动（create/prompt/cancel/attach/page…） │
│  event.*       事件流（session/assistant 通知）              │
│  interaction.* 审批/提问（request/resolve/resolved/cancel）  │
│  deliverable.* 交付物同步（op/sync/syncResult/ack/list）     │
│  artifact.*    字节传输（fetch/chunk/end/window/cancel/stale）│
├────────────────────────────────────────────────────────────┤
│ 帧层   JSON-RPC 2.0（request/response/notification）         │
│        + binary artifact frame（[4B][JSON 头][bytes]）       │
├────────────────────────────────────────────────────────────┤
│ 传输层 WSS（默认）/ TCP carrier（同帧格式，长度前缀）          │
│        TLS（WSS 内置；TCP 可叠加）                           │
└────────────────────────────────────────────────────────────┘
```

方向约定：

- 所有方法名不带方向；方向由"谁是该资源的角色/拥有者"决定。
- `session.*`：接收方必须是该 `linkId` 的 **host**（创建/驱动会话的执行侧）。
- `interaction.request`：接收方是应答题的一侧（默认 initiator；owner 可配）。
- `deliverable.op`：**只能由该记录的 origin 发给 peer**；接收方不得替对端写它的命名空间。
- `artifact.*`：接收方是字节持有者（holder）；请求方按需拉取。
- `peer.*`：两侧都可发。

---

## 2. 通用约定

### 2.1 值与 ID

```ts
type Millis = number                  // Unix epoch 毫秒，整数
type NodeId = string                  // ^[a-z0-9][a-z0-9._-]{0,63}$
type LinkId = string                  // UUID v4
type DeliverableId = string           // UUID v4（origin 铸造）
type ArtifactId = string              // "sha256:<64 hex>"
type ConnectionId = string            // UUID v4（每次建链新铸）
type InstanceEpoch = string           // UUID v4（进程启动时铸）
type RequestId = string               // UUID v4（幂等键）
type InteractionId = string           // UUID v4（发起交互的一侧铸造）
type SessionId = string               // DSH SessionId（品牌字符串）
```

约束：

- 所有时间字段为毫秒整数，发送方时钟；接收方只用于展示/超时，不用于排序（排序用 `originSeq`）。
- `logicalPath`：斜杠分隔、UTF-8、不含 `..`/控制字符；由发布方生成，接收方只做展示与落盘清洗。
- 所有二进制（nonce/proof）用 base64url（无 padding）。

### 2.2 帧

```ts
type JsonRpcFrame =
  | { jsonrpc: '2.0'; id: string; method: string; params?: unknown }
  | { jsonrpc: '2.0'; id: string; result?: unknown; error?: RpcError }
  | { jsonrpc: '2.0'; method: string; params: unknown }

interface RpcError {
  code: number
  message: string                 // 稳定英文短语，不本地化
  data?: {
    kind?: string                 // 如 "deliverable/revision-gap"
    retryable?: boolean
    details?: Record<string, unknown>
  }
}
```

规则：

- `id` 由发送方铸造（UUID），连接内唯一；响应必须带同一 `id`。
- 通知无 `id`；事件/op 是通知（可靠靠对账，不靠重放内存缓冲）。
- 单帧 JSON ≤ 1 MiB；事件批 ≤ 200 条且 ≤ 1 MiB；超限 `limit/frame-too-large` 并断链。
- 未识别方法：`method/not-found`；未识别通知：忽略并记 debug 日志（向前兼容）。
- 二进制帧只用于 `artifact.chunk`（见 §9）。

### 2.3 二进制帧

```
offset  size   field
0       4B     headerLength（BE uint32）
4       N      JSON header（UTF-8）
4+N     M      payload bytes
```

```ts
interface ArtifactChunkHeader {
  artifactId: ArtifactId
  offset: number        // 0 起的字节偏移
  length: number        // payload 字节数（≤ chunkBytes）
  sha256Chunk?: string  // 可选：该 chunk 的 sha256（调试/快速失败）
}
```

### 2.4 能力协商

```ts
interface PeerCapabilities {
  assistantStream: boolean
  approvals: boolean
  questions: boolean
  deliverables: boolean
  attachments: boolean
  modelSelection: boolean
  resumeAfterRestart: boolean
  sessionVisibility: 'own-calls' | 'all'
  // 协议版本在 hello/welcome 的 protocol 字段单独给
}
```

- 能力只表达"支持与否"；具体限额在 `peer.welcome.limits`。
- 不认识的布尔能力按 false 处理；不认识的字段忽略。

### 2.5 版本

- `protocol: 1`；握手精确匹配，不做范围协商（M1 简单优先）。
- 帧内新增可选字段 = 同版本兼容；删除/改变语义 = 升 2。
- 未知方法返回 `method/not-found`；不得静默降级。
- Hub 双方版本展示在 `remotenode` 页。

---

## 3. 连接、认证与去重

### 3.1 握手时序

```
dialer (A)                                   listener (B)
  │ ─── TCP/TLS（A 验证 B 的证书/ca）────────▶ │
  │ ─── peer.hello（h1）────────────────────▶ │
  │ ◀──────────────────── peer.welcome（h1）─ │
  │ ◀════════ 双向 JSON-RPC 开始 ══════════▶ │
```

### 3.2 `peer.hello`（dialer → listener，request）

```ts
interface PeerHelloParams {
  protocol: 1
  nodeId: NodeId                          // dialer
  nodeName: string
  instanceEpoch: InstanceEpoch
  connectionId: ConnectionId
  platform: 'windows' | 'linux' | 'macos' | 'unknown'
  dshVersion: string
  capabilities: PeerCapabilities
  ts: Millis
  nonce: string                           // 32B base64url
  proof: string                           // 见 §3.4；mTLS 模式可空
  authMode: 'shared-secret' | 'mtls'
}
```

`peer.welcome`（response）：

```ts
interface PeerWelcomeResult {
  protocol: 1
  nodeId: NodeId                          // listener
  nodeName: string
  instanceEpoch: InstanceEpoch
  platform: 'windows' | 'linux' | 'macos' | 'unknown'
  dshVersion: string
  capabilities: PeerCapabilities
  ts: Millis
  nonce: string                           // listener 的 32B nonce
  proof: string                           // 见 §3.4
  limits: {
    heartbeatMs: number
    maxFrameBytes: number
    maxEventBatch: number
    maxSessions: number
    maxDeliverableBytes: number
    maxArtifactBytes: number
    chunkBytes: number
    windowBytes: number
    maxConcurrentTransfers: number
  }
}
```

### 3.3 校验规则

- `ts` 与本地时钟差 > 5 分钟 → `auth/clock-skew`。
- `nodeId` 必须与配置的对端条目一致（`peers[].nodeId`），否则 `auth/unknown-peer`。
- `protocol !== 1` → `protocol/unsupported`。
- 同一 `nonce` 重放 → `auth/replay`（每节点缓存最近 256 个 nonce，TTL 10 分钟）。
- `authMode` 不一致 → `auth/mode-mismatch`。
- 失败时：发送 JSON-RPC error 响应后关闭连接；记审计。

### 3.4 共享 secret 证明（规范）

- 双方配置 `linkSecret`（32B 随机，base64url 存储）。
- `HMAC-SHA256(key=linkSecret, msg=transcript)`，`proof = base64url(HMAC)`。

hello transcript（UTF-8，`\n` 分隔，最后无 `\n`）：

```
dsh-remotenode/1/hello
dialer=<dialer.nodeId>
dialerEpoch=<dialer.instanceEpoch>
listener=<listener.nodeId>
connectionId=<connectionId>
protocol=1
ts=<ts>
nonce=<nonce>
```

welcome transcript：hello transcript + 追加两行（顺序固定）：

```
welcomeNonce=<listener nonce>
welcomeTs=<listener ts>
```

- listener 用 `dialer` 提供的 hello 字段 + 自己的 nodeId/nonce/ts 计算期望 proof，校验 hello。
- dialer 用 hello transcript + welcome 的 nonce/ts 计算期望 proof，校验 welcome。
- mTLS 模式：双方校验证书链/指纹；`proof` 可为空，但仍交换 nonce/ts 防重放。

### 3.5 连接去重

记 `pairKey = [nodeIdA, nodeIdB].sort().join('|')`，`canonicalDialer = min(nodeIdA, nodeIdB)`。

```
onNewConnection(pairKey, candidate):
  existing = online[pairKey]
  if existing == null: accept(candidate)
  else:
    winner = (candidate.direction === 'outbound' && self.nodeId === canonicalDialer)
          || (candidate.direction === 'inbound'  && self.nodeId !== canonicalDialer)
    if winner: close(existing, 'peer/duplicate'); accept(candidate)
    else: close(candidate, 'peer/duplicate')
```

- 即"由较小 nodeId 一侧拨出的连接获胜"。
- 两侧独立计算，结果一致。
- 规范方向不可达（超时/防火墙）时，10s 宽限后接受可用方向，并在 `peer.status` 标 `canonicalFallback: true`；之后若规范方向出现，按规则替换。
- 每次去重决策记审计（双方 nodeId、connectionId、winner、reason）。

### 3.6 心跳与超时

- WSS ping 15s；`peer.heartbeat` 每 `heartbeatMs`（默认 10s）。
- 30s 无心跳 → `degraded`；60s → `offline` 并关闭连接。
- 重连：500ms 起、×2、上限 10s、50–100% 抖动；`offline` 后持续重试。
- 每次重连后：`peer.catalog` + `deliverable.sync`（见 §8.6）。

### 3.7 Link 状态机

```
connecting ──TLS/hello/welcome ok──▶ online ──heartbeat miss──▶ degraded ──timeout──▶ offline
    │                                  │  ▲                       │                    │
    │ auth fail / protocol             │  └──── heartbeat ok ──────┘                    │
    ▼                                  ▼                                               ▼
  failed                            revoked ◀──────────── secret revoked ────────────┘
                                                                  （重连失败直到换凭据）
```

- `failed` 是终态（本次尝试）；运维修复后重新 `dial/listen` 可再试。
- `offline` 仍可被重连触发 `connecting`。

---

## 4. `peer.*` 方法

| 方法 | 类型 | 方向 | 说明 |
|---|---|---|---|
| `peer.hello` | req | dialer→listener | 握手（§3.2） |
| `peer.welcome` | resp | listener→dialer | 握手响应 |
| `peer.ping` | req | 双向 | `{at}` → `{at, serverTime}`；WSS 已有 ping，保留作应用层检查 |
| `peer.heartbeat` | notify | 双向 | `{at, metrics:{activeLinks, activeSessions, queuedBytes?}}` |
| `peer.status` | notify | 双向 | `{status, capabilities?, canonicalFallback?, reason?}` |
| `peer.catalog` | req | 双向 | 交换 link 记录用于会话恢复，见下 |
| `peer.sessions` | req | 双向 | 查询对端可见会话，见下 |
| `peer.configure` | req | 双向 | 更新可见性/心跳等（M2；M1 可只读能力） |
| `peer.goodbye` | notify | 双向 | `{reason}`，主动下线 |

### 4.1 `peer.catalog`

```ts
interface PeerCatalogParams {
  links: Array<{
    linkId: LinkId
    initiatorNodeId: NodeId
    initiatorSessionId: SessionId
    hostNodeId: NodeId
    hostSessionId: SessionId
    label: string
    status: RemoteSessionStatus
    createdAt: Millis
  }>
}
```

- 连接建立后双方各发一次；用于恢复"我发起的会话还在不在"。
- 对端返回 `{missing: LinkId[]}` 表示它已没有这些 link（host 重启/清理）。
- 收到 missing：本端把对应 link 标 `offline`/`not-resumable`，不自动重建（由人/模型决定重试）。

### 4.2 `peer.sessions`

```ts
interface PeerSessionsParams { linkIds?: LinkId[] }
interface PeerSessionsResult {
  sessions: Array<{
    linkId: LinkId
    hostSessionId: SessionId
    status: RemoteSessionStatus
    title?: string
    updatedAt: Millis
    deliverablesCount?: number
  }>
}
```

- 默认只返回"请求方作为 initiator 的 link"；`sessionVisibility: 'all'` 时才返回本机更多会话（M3）。

---

## 5. `session.*` 方法

### 5.1 方法与类型

```ts
interface SessionCreateParams {
  linkId: LinkId
  initiatorSessionId: SessionId
  label: string
  prompt: PromptPart[]
  cwd?: string
  model?: { provider: string; model: string; reasoningEffort?: string }
  agentPreset?: string
  outputSchema?: unknown                 // 可选；host 不支持则拒绝
  delegationDepth: number
  deliverables?: ArtifactRef[]           // 输入附件（M2）
}

type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'image'; artifactId: ArtifactId; mediaType: string; name?: string }

interface ArtifactRef {
  artifactId: ArtifactId
  name: string
  mime: string
}

interface SessionCreateResult {
  linkId: LinkId
  hostSessionId: SessionId
  header: SessionWireHeader             // 复用 session-controller 类型
  status: RemoteSessionStatus
}

interface SessionPromptParams {
  linkId: LinkId
  requestId: RequestId
  mode: 'queue' | 'steer'
  content: PromptPart[]
  artifacts?: ArtifactRef[]
}

interface SessionCancelParams { linkId: LinkId; requestId: RequestId }

interface SessionQueueUpdateParams {
  linkId: LinkId
  requestId: RequestId
  itemId: string
  action: { kind: 'edit'; content: Array<{ type: 'text'; text: string }> } | { kind: 'remove' } | { kind: 'steer' }
}

interface SessionRenameParams { linkId: LinkId; title: string }
interface SessionSetModelParams { linkId: LinkId; provider: string; model: string; reasoningEffort?: string }
interface SessionCloseParams { linkId: LinkId; requestId?: RequestId }

interface SessionAttachParams {
  linkId: LinkId
  cursors: { peerInstanceEpoch: InstanceEpoch; streamEpoch: number; seq: number }
  assistantStream?: true
}

interface SessionAttachSnapshot {
  linkId: LinkId
  hostSessionId: SessionId
  header: SessionWireHeader
  cursor: { peerInstanceEpoch: InstanceEpoch; streamEpoch: number; seq: number }
  records: SessionHistoryRecord[]
  hasMore: boolean
  projections: SessionProjectionBaseline
  assistantStream?: SessionAssistantStreamBaseline
}

interface SessionPageParams {
  linkId: LinkId
  throughSeq: number
  beforeSeq?: number
  maxMessages?: number
  turnWindow?: { minMessages: number; minTurns: number }
}
interface SessionPageResult { records: SessionHistoryRecord[]; hasMore: boolean }

interface SessionDetachParams { linkId: LinkId }
interface SessionAck { linkId: LinkId; requestId: RequestId; accepted: true }
```

约束：

- `session.create` 幂等键是 `linkId`（initiator 铸造，全局唯一）；host 已存在则返回既有结果。
- `session.prompt/cancel` 用 `requestId` 幂等；host 保留每 link 最近 256 个 requestId。
- `session.prompt` 的 `mode=steer` 语义 = host Agent inbox 的 steer；`queue` = 下一轮。
- `session.attach` 的 `cursors.streamEpoch` 每次观察代 +1；Node 重启后 `peerInstanceEpoch` 变。
- `session.detach` 只停止推送，不关闭会话。
- 所有 `session.*` 请求的 `originNodeId` 由连接身份推导，不在参数里传（防伪造）。

### 5.2 响应错误（节选）

| 场景 | 错误 |
|---|---|
| link 不存在/已关闭 | `session/unknown` |
| 非 initiator/策略拒绝 | `session/not-authorized` |
| host 会话写忙 | `session/busy` |
| 重启后无法恢复 | `session/not-resumable` |
| 深度超限 | `session/depth-exceeded` |
| 幂等命中 | 正常返回原结果（不报错） |

---

## 6. 事件流

### 6.1 通知

| 方法 | 参数 | 说明 |
|---|---|---|
| `event.session` | `{linkId, hostSessionId, instanceEpoch, streamEpoch, seqFrom, records: SessionWireEvent[]}` | 持久事件批；≤200 条/1 MiB |
| `event.assistant` | `{linkId, hostSessionId, instanceEpoch, streamEpoch, frames: SessionAssistantStreamFrame[]}` | 瞬态 assistant 帧批（可丢最旧） |
| `session.state` | `{linkId, status, reason?}` | 状态变化 |
| `session.ack` | `{linkId, requestId, accepted: true}` | 命令回执（也可直接 RPC response） |

### 6.2 游标与不变量

- 事件按 `(linkId, seq)` 严格递增；`seq` 是 host 会话日志 seq。
- 接收方维护 `recvSeqs: Map<linkId, {instanceEpoch, streamEpoch, lastSeq}>`。
- 重复 seq 丢弃；gap（`seq > last+1`）→ 发 `session.attach` 用当前 cursor 重同步（replace 窗口）；不得猜测补洞。
- `event.assistant` 只对已 attach 且活跃 attempt 推送；接收方按 `(attemptId, revision, index)` 去重/排序。
- 断线重连后先 `peer.catalog` → `deliverable.sync` → `session.attach`（顺序固定）。

---

## 7. `interaction.*`（审批/提问）

```ts
type InteractionKind = 'approval' | 'question'

interface InteractionRequestParams {
  interactionId: InteractionId
  linkId: LinkId
  kind: InteractionKind
  createdAt: Millis
  expiresAt: Millis
  payload:
    | { kind: 'approval'; tool: string; inputPreview: string; risk?: string;
        options: Array<{ id: string; label: string; decision: 'allow-once' | 'allow-session' | 'reject' }> }
    | { kind: 'question'; question: string; options?: string[]; multiple?: boolean; allowFreeform: boolean }
}

interface InteractionResolveParams {
  interactionId: InteractionId
  decision:
    | { kind: 'select'; optionId: string }
    | { kind: 'answer'; answers: string[] }
    | { kind: 'cancel' }
}
```

- 请求方（通常是 host）发 `interaction.request`，接收方回 ack 后，正式决策以 `interaction.resolve` 请求回传。
- 本地已解决时，解决方发 `interaction.resolved` 通知给对方清 UI；对方再回 `interaction.resolve` 视为已解决（幂等）。
- 超时：请求方本地计时到 `expiresAt` → 自行 fail-closed（拒绝），并发 `interaction.cancel`。
- 一个 `interactionId` 只能成功 resolve 一次；重复 `interaction/already-resolved`。
- 模型工具不得审批（无 `remotenode_approve`）。

---

## 8. 交付物同步（M0 核心）

### 8.1 命名空间与所有权

- 一条 link 有两个命名空间：`originNodeId = A` 和 `originNodeId = B`。
- **每个节点只发布/修改自己的命名空间**；对本端来说，远端 op 的 `originNodeId` 必须等于已认证的 peer nodeId。
- 因此不存在跨端写冲突；同名文件是两条记录，UI 按来源区分。

### 8.2 数据类型

```ts
type DeliverableKind = 'image' | 'video' | 'audio' | 'text' | 'model3d' | 'archive' | 'other'

interface DeliverableVersion {
  artifactId: ArtifactId          // "sha256:<hex>"
  size: number
  mime: string
  createdAt: Millis
  originSeq: number               // 该版本对应的发布 op
  note?: string
}

interface DeliverableRecord {
  deliverableId: DeliverableId    // origin 铸造，跨版本稳定
  linkId: LinkId
  originNodeId: NodeId
  originSessionId: SessionId
  logicalPath: string             // "<originNodeId>/<originSessionId>/<name>"（展示与落盘用）
  name: string
  kind: DeliverableKind
  createdAt: Millis
  updatedAt: Millis
  originSeq: number               // 发布方全局单调递增
  current: DeliverableVersion
  versions: DeliverableVersion[]  // 含 current；按 originSeq 升序；保留策略见 §8.5
  deleted?: { at: Millis; originSeq: number }
  description?: string
}

type DeliverableOp =
  | { op: 'upsert'; linkId: LinkId; originNodeId: NodeId; originSeq: number; record: DeliverableRecord }
  | { op: 'remove'; linkId: LinkId; originNodeId: NodeId; originSeq: number; deliverableId: DeliverableId; at: Millis }

interface DeliverableSnapshot {
  linkId: LinkId
  originNodeId: NodeId
  snapshotSeq: number             // 快照覆盖到的该 origin 最大 originSeq
  records: DeliverableRecord[]    // 完整集合（含墓碑记录）
  generatedAt: Millis
}
```

### 8.3 方法

| 方法 | 类型 | 参数 | 结果/说明 |
|---|---|---|---|
| `deliverable.op` | notify（双向） | `DeliverableOp` | 实时发布；接收方幂等应用并更新 applied |
| `deliverable.sync` | req | `{linkId, applied: Record<NodeId, number>}` | 请求增量 |
| `deliverable.syncResult` | resp | — | `{applied, ops: DeliverableOp[], snapshot?: DeliverableSnapshot, complete: boolean}` |
| `deliverable.ack` | notify | `{linkId, originNodeId, appliedSeq}` | 水位确认（可选但推荐） |
| `deliverable.list` | req | `{linkId}` | `{records: DeliverableRecord[]}`（UI 首次打开/手动刷新用；也可用 sync 空 applied） |

`deliverable.sync` 的 `applied` 语义：**请求方已应用到的对端 origin 的 originSeq 水位**。对端只返回 `seq > applied[对端 nodeId]` 的 op；若对端 op log 已不覆盖该水位（或请求方显式要求），返回 `snapshot`。

`deliverable.syncResult.complete`：`true` 表示返回的 ops/snapshot 已覆盖到对端当前水位；`false` 表示还有后续（分页），接收方应继续请求（M1 建议一页发完，简化）。

### 8.4 应用算法（接收方）

```text
on deliverable.op(op):
  auth: op.originNodeId === peer.nodeId else -> drop + audit (deliverable/unauthorized)
  if op.linkId != link: -> drop + audit
  if op.originSeq <= applied[peer]: -> ignore (duplicate)
  if op.originSeq > applied[peer] + 1:
      -> request deliverable.sync(linkId, applied)   // 补缺口
      -> return (暂不应用；等 sync)
  apply:
    if op.op == 'upsert':
        validateRecord(op.record)
        store.upsert(op.record)       // 幂等；同 deliverableId 覆盖为最新版本
    else:
        store.markRemoved(op.deliverableId, op.at)   // 墓碑；本地 replica 按 keepLocalCopies 处理
  applied[peer] = op.originSeq
  persist applied（防抖/批量）
  emit UI delta
```

```text
on deliverable.syncResult(res):
  if res.snapshot:
      replace all peer-origin records for link with snapshot.records
      applied[peer] = snapshot.snapshotSeq
  else:
      for op in res.ops: applySameAsAbove(op)      // 仍然按 seq 去重/顺序
  ack(linkId, peer, applied[peer])
```

`validateRecord`：

- `record.linkId === linkId`、`record.originNodeId === peer.nodeId`；
- `record.originSeq === op.originSeq`；
- `record.current.artifactId` 匹配 `^sha256:[0-9a-f]{64}$`；
- `record.versions` 非空且含 current；版本 `originSeq` 严格递增；
- `record.logicalPath` 不含 `..`、控制字符；`name` 非空；
- 失败：`deliverable/op-invalid`，审计，但不推进 applied（等待重发/快照）。

### 8.5 版本、墓碑与保留

- **新版本**：同 `deliverableId` 再次发布 → 追加 `DeliverableVersion`（新 artifactId），`current` 更新，`originSeq` 更新；`versions` 保留最近 `versionRetention`（默认 5）个，更早的从记录里裁剪（字节按 CAS 配额回收）。
- **删除**：发 `remove` op，记录置 `deleted`；不物理删记录；receiver 标 `removed`。
- **墓碑保留**：默认保留 30 天或直到 snapshot 明确不带；`keepLocalCopies: true` 时 replica 文件保留并标"对端已删除"。
- **重新发布已删除的 deliverableId**：禁止（`deliverable/op-invalid`）；发布方应铸新 `deliverableId`。
- **版本字节**：CAS 中按 artifactId 存；回收只影响 `versions` 中已裁剪的旧版本；`current` 永不回收（直到记录墓碑 + TTL）。

### 8.6 对账（anti-entropy）

触发：连接建立后、每 60s（可配）、手动"立即同步"、检测到 gap。

```text
reconcileLink(linkId):
  applied = load applied for link (per peer origin)
  res = rpc('deliverable.sync', {linkId, applied})
  apply(res)  // §8.4
  if res.complete == false: schedule follow-up
```

- 每端只维护"对端 origin"的水位；自己的 origin 自增由本地负责。
- 若对端返回 snapshot：以 snapshot 为准替换本端对远端 origin 的视图；本端自己 origin 的记录不受影响。
- 对账期间实时 op 仍然应用（按 seq 去重/排序）；snapshot 到达后按 `snapshotSeq` 丢弃旧 op。
- **不变量**：同一 link 的每个 origin，`applied` 单调不减；收到 seq ≤ applied 的 op/快照部分一律忽略。

### 8.7 发布端算法

```text
publish(linkId, sourcePath, meta):
  validate path ∈ deliverables.roots; lstat regular file; reject symlink
  artifactId = sha256(file bytes)              // 大文件：流式 hash，写 CAS 或先登记 sourcePath+stat
  logicalPath = "<originNodeId>/<originSessionId>/<name>"
  existing = store.findByLogicalPath(linkId, logicalPath)
  originSeq = store.nextSeq()                  // 全局递增
  deliverableId = existing?.id ?? uuid()
  record = upsert version into existing or new record
  append op to op log (fsync policy)
  update index / applied own origin
  send deliverable.op(upsert) to peer          // 失败靠对账补
  emit UI delta
```

- 同一 `logicalPath` 内容 hash 未变 → 不发布（幂等）。
- 内容变了 → 新版本。
- 发布前写入 op log，再发网络（崩溃恢复靠 op log 重放/对账）。
- op log 保留：默认 10,000 op 或 16 MiB / link / origin；超出后只保留 snapshot 兜底（快照按需生成）。

### 8.8 快照生成与恢复

- **何时生成**：对端请求的 `applied` 早于 op log 覆盖范围；或手动"全量校验"。
- **内容**：该 origin 在 link 下的全部记录（含墓碑），`snapshotSeq = 当前最大 originSeq`。
- **原子性**：生成时暂停该 link 的发布（或读时加读锁），保证 records 与 snapshotSeq 对应。
- **恢复端**：用 snapshot 替换远端 origin 视图；本地 replica 按新记录重建/清理；之后 live op 继续。

### 8.9 交付物同步状态（本端视图）

| state | 含义 |
|---|---|
| `metadata-only` | 记录已在，current 字节未拉取 |
| `pending` | 已排队/正在拉字节 |
| `partial` | `.part` 有中间态，可续传 |
| `synced` | 字节已完整校验并进 CAS |
| `stale` | 发布方源变化/版本被替换，需重新同步 |
| `removed` | 对端已删除（墓碑） |
| `error` | 校验失败/配额/权限等；可重试 |

状态由 `record` + 本地下载状态合成；不写进 op。

### 8.10 冲突与边界矩阵

| 场景 | 处理 |
|---|---|
| 重复 op | 按 `(originNodeId, originSeq)` 忽略 |
| op 乱序 | 缓存等待前驱（最多 64 个）或直接触发 sync；不得跳过 |
| seq 缺口 | `deliverable.sync` 补齐；补齐前不推进 applied |
| 对端 op log 不够 | `snapshot` 兜底 |
| 两侧同时发布同名文件 | 两个 origin 命名空间，两条记录；UI 分别展示 |
| 同一 deliverableId 先删后 upsert | 拒绝（`deliverable/op-invalid`），要求新 id |
| snapshot 与 live op 交错 | 先应用 snapshot，再丢弃 `seq <= snapshotSeq` 的 op |
| 本端 op 发送失败 | op 已在 op log；重连对账时补发 |
| 字节源被改/删 | publish 前 stat 检测；拉取时 `artifact.stale` |
| 本地 replica 写失败 | 标记 error；不影响元数据同步 |
| 磁盘满/配额 | 记录仍在，字节标 error；清理后重试 |

---

## 9. `artifact.*` 字节层

### 9.1 方法

| 方法 | 类型 | 说明 |
|---|---|---|
| `artifact.fetch` | req | `{artifactId, offset?}` → `{artifactId, size, chunkBytes}`，随后二进制 chunk + `artifact.end` |
| `artifact.chunk` | binary | 头 `{artifactId, offset, length, sha256Chunk?}` + 载荷；默认 1 MiB |
| `artifact.end` | notify | `{artifactId, bytes, sha256, ok}` |
| `artifact.window` | notify（可选） | `{artifactId, credits}` 流控；M1 可固定 8 MiB 不分帧 |
| `artifact.cancel` | notify | `{artifactId, reason}` |
| `artifact.stale` | notify | `{artifactId, reason:'source-changed'\\|'source-deleted', at}` |

### 9.2 规则

- 请求方必须已持有该 `artifactId` 的 manifest/记录（`deliverable` 同步到）才被允许 fetch；否则 `artifact/unauthorized`（M1 简化：只校验 link 归属 + artifact 归属记录）。
- 接收方校验 `offset`：必须等于已收字节数（或 0）；否则 `artifact/bad-offset`。
- 每个 chunk 可带 `sha256Chunk`；接收方可拒绝坏块并重试该 offset。
- `artifact.end` 的整文件 `sha256` 必须等于 artifactId；不符 `artifact/hash-mismatch`，丢弃 `.part`。
- 传输中断：保留 `.part` + `bytesReceived`；重连后从 offset 续传。
- 默认每 link 1 个并发传输；窗口 8 MiB；可配。
- 大文件可选 HTTP 快通道（M3）：`GET /remotenode/v1/artifact/<artifactId>` + Range；M1 只走 PeerLink。

### 9.3 字节同步触发

- 元数据（deliverable）到后，按 `deliverables.sync` 策略：
  - `metadata`：不自动拉；
  - `preview`：`kind=image` 或 text/md/json 且 size ≤ 8 MiB → 自动 fetch；
  - `all-small`：size ≤ 32 MiB → 自动；
  - `all`：全部自动（受配额/并发限制）。
- 用户点预览/下载、模型调用 `remotenode_fetch` 也触发。
- 自动拉取队列：每 link 一个有序队列（先 preview，再小的优先）；可暂停。

---

## 10. 浏览器侧 Remote API（`remotenode` namespace）

core 插件向本机浏览器暴露：

```ts
// unary
remotenode.list(): {
  peers: PeerLinkRow[]
  remoteSessions: RemoteSessionRow[]     // 我做 initiator
  hostedSessions: HostedSessionRow[]     // 对端发起、托管在本机
  pendingInteractions: PendingInteractionSummary[]
  deliverableCounts: Record<LinkId, { total: number; unsynced: number }>
}

remotenode.sync(linkId: LinkId): { started: true }
remotenode.fetch(deliverableId: DeliverableId): { started: true }
remotenode.resolveInteraction(interactionId: InteractionId, decision: InteractionDecision): { accepted: true }

// 注意：浏览器不允许传宿主路径。发布本地文件只走 POST /remotenode/v1/upload（流式），
// 由 core 校验大小/类型后落 CAS 并发布；remotenode_publish 是模型工具（本地路径）而非浏览器 API。

// streams
remotenode.control(): RemoteSnapshotStream<ControlFrame>       // peers/sessions/interactions 增量
remotenode.follow(linkId): RemoteStream<SessionFollowFrame>    // 复用 session-controller 帧形状
remotenode.deliverables(linkId): RemoteStream<DeliverablesFrame> // 交付物清单/状态增量
```

```ts
type ControlFrame =
  | { type: 'baseline'; peers: PeerLinkRow[]; remoteSessions: RemoteSessionRow[];
      hostedSessions: HostedSessionRow[]; pendingInteractions: PendingInteractionSummary[] }
  | { type: 'peer'; row: PeerLinkRow }
  | { type: 'session'; row: RemoteSessionRow | HostedSessionRow }
  | { type: 'interaction'; row: PendingInteractionSummary }
  | { type: 'interaction-resolved'; interactionId: InteractionId }

type DeliverablesFrame =
  | { type: 'snapshot'; linkId: LinkId; records: DeliverableSummary[] }
  | { type: 'upsert'; linkId: LinkId; record: DeliverableSummary }
  | { type: 'remove'; linkId: LinkId; deliverableId: DeliverableId; at: Millis }
  | { type: 'state'; linkId: LinkId; deliverableId: DeliverableId; syncState: DeliverableSyncState; bytesReceived?: number }
```

路由（浏览器只连本机）：

```http
GET  /remotenode/v1/artifact/<artifactId>    # 下载/预览，支持 Range，认证同浏览器 Cookie
POST /remotenode/v1/upload                   # 流式上传 → 本机 CAS → publish
GET  /remotenode/v1/health                   # 只读健康检查
```

约束：

- 浏览器不拿到对端地址/token；URL 只出现本机 origin。
- artifact 下载路由只服务本机 CAS/replica；`artifactId` 必须在本地已知记录中，否则 404。
- 上传大小上限 = `maxFileBytes`；流式写 `.part`，完成后校验并生成 artifactId。

---

## 11. 持久化格式

### 11.1 会话事件（additive）

```ts
// SessionEventMap
interface RemotenodeCatalogEvent {
  version: 1
  linkId: LinkId
  peerNodeId: NodeId
  peerNodeName: string
  peerInstanceEpoch: InstanceEpoch
  remoteSessionId: SessionId          // = hostSessionId
  mode: 'remote-node'
  label: string
  createdBy: 'agent' | 'user'
  delegationDepth: number
  childCreatedAt: Millis
}

interface RemotenodeOriginEvent {
  version: 1
  linkId: LinkId
  initiatorNodeId: NodeId
  initiatorNodeName: string
  initiatorInstanceEpoch: InstanceEpoch
  initiatorSessionId: SessionId
  hostSessionId: SessionId
  hostInstanceEpoch: InstanceEpoch
  createdBy: 'agent' | 'user'
  label: string
  delegationDepth: number
  createdAt: Millis
}

// MessageSourceMap
'remotenode-prompt': {
  kind: 'remotenode-prompt'
  linkId: LinkId
  initiatorNodeId: NodeId
  initiatorSessionId: SessionId
  requestId: RequestId
  initiated: boolean
}

'remotenode-settled': {
  kind: 'remotenode-settled'
  linkId: LinkId
  peerNodeId: NodeId
  summary: string
  stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'
}
```

### 11.2 本机配置

`$DSH_HOME/remotenode/config.yaml`（内容同 §12；Cordis 配置也可以，二者取一）

### 11.3 link 索引 `links.json`

```json
{
  "v": 1,
  "links": {
    "6f1c2a7e-...": {
      "linkId": "6f1c2a7e-...",
      "peerNodeId": "desktop-01",
      "peerInstanceEpoch": "b7c8...",
      "role": "initiator",
      "initiatorSessionId": "session-42",
      "hostSessionId": "5b2e9a10-...",
      "label": "生成赛博朋克猫",
      "cursor": { "peerInstanceEpoch": "b7c8...", "streamEpoch": 3, "seq": 57 },
      "status": "idle",
      "deliverables": { "count": 2, "synced": 1 }
    }
  }
}
```

### 11.4 交付物索引 `deliverables/index.json`

```json
{
  "v": 1,
  "links": {
    "6f1c2a7e-...": {
      "own": { "nodeId": "brain-linux", "nextSeq": 13, "records": ["...DeliverableRecord..."] },
      "peer": { "nodeId": "desktop-01", "appliedSeq": 12,
                "records": ["...DeliverableRecord (peer origin)..."] }
    }
  },
  "updatedAt": 1730000006000
}
```

- 记录数组可直接嵌入（M1 简单）；记录多时拆 `records/<deliverableId>.json`。
- 原子写：`index.json.tmp` → fsync → rename。

### 11.5 op log `deliverables/ops/<originNodeId>.jsonl`

每行一个 JSON：

```json
{"v":1,"linkId":"6f1c2a7e-...","op":"upsert","originSeq":12,"at":1730000005000,"record":{"..."}}
{"v":1,"linkId":"6f1c2a7e-...","op":"remove","originSeq":14,"at":1730000100000,"deliverableId":"9d2e..."}
```

- 追加写；`fsync` 策略：每 N 条或每 1s（权衡：崩溃最多丢最近 1s 的 op，重放/对账可恢复；但丢 op 会导致 peer 永远收不到，除非本端从 index 重新生成 op。**推荐每条 fsync**，交付物 op 频率低）。
- 保留窗口：默认每 link 10,000 op / 16 MiB；超出时滚动并在 `deliverable.sync` 用 snapshot 兜底。
- 恢复：启动时先读 index，再重放 op log 中 `originSeq > index.lastSeq` 的尾部（防崩溃丢更新）。

### 11.6 applied 水位 `deliverables/applied.json`

```json
{
  "v": 1,
  "links": {
    "6f1c2a7e-...": { "desktop-01": 12 }
  }
}
```

- 键为 peer nodeId → 已应用的该 peer origin 的最大 originSeq。
- 防抖批量写（如每 200ms）；启动时若文件缺失，用 `deliverable.sync` 全量重建（applied=0）。

### 11.7 CAS 与 replica

```
deliverables/cas/sha256/<hh>/<hex>          # 内容寻址字节；只读 0444
deliverables/replica/<originNodeId>/<linkId>/<safeLogicalPath>
deliverables/partial/<artifactId>.part
```

- replica 是 CAS 的硬链接/复制（同盘用 hardlink，跨盘 copy）；只读。
- `keepLocalCopies: true` 时删除只标记，不删 replica 文件。
- 清理：CAS LRU（仅回收无记录引用的 blob）；replica 按 link 关闭/用户操作清理；`.part` 24h TTL。

---

## 12. 配置 schema（M1）

```ts
interface RemotenodeConfig {
  nodeId: NodeId
  nodeName?: string
  listen?: {
    transport: 'ws' | 'tcp'
    host: string                    // 具体 IP，拒绝 0.0.0.0/:: 通配
    port: number
    tls?: { certFile: string; keyFile: string }
  }
  peers: Array<{
    nodeId: NodeId
    name: string
    dial: 'auto' | 'never'          // auto=本机主动拨号；never=只接受入站
    url?: string                    // wss://host:port/remotenode/v1/stream 或 tcp://host:port
    secretRef: string               // 指向 $DSH_HOME/remotenode/secrets/<ref>
    tls?: { caFile?: string; pinnedSha256?: string }
  }>
  heartbeatMs: number               // 默认 10000
  offlineAfterMs: number            // 默认 60000
  maxFrameBytes: number             // 默认 1048576
  maxSessions: number               // 默认 4
  maxDepth: number                  // 默认 2
  exposeLocalSessions: boolean      // 默认 false
  approvals: { defaultOwner: 'both' | 'initiator' | 'host'; timeoutMs: number } // 300000
  deliverables: {
    roots: string[]                 // 允许发布的目录绝对路径
    publishFromLocal: boolean       // 默认 true
    sync: 'metadata' | 'preview' | 'all-small' | 'all'   // 默认 preview
    replicaDir?: string             // 默认 $DSH_HOME/remotenode/deliverables/replica
    keepLocalCopies: boolean        // 默认 true
    versionRetention: number        // 默认 5
    autoIngestMaxBytes: number      // 默认 67108864
    maxFileBytes: number            // 默认 1073741824
    maxLinkBytes: number            // 默认 10737418240
    maxConcurrentTransfers: number  // 默认 1
    partialTtlMs: number            // 默认 86400000
    opLogMaxOps: number             // 默认 10000
  }
}
```

Cordis 配置示例见 06 §12.2；本规格只要求字段语义与默认值一致。

---

## 13. 状态机汇总

### 13.1 RemoteSession

```
starting ──create ok──▶ idle ⇄ running
                         │  │
                         │  ├─ approval ─▶ waiting-approval ──resolve──▶ running/idle
                         │  ├─ question ─▶ waiting-input ──answer──▶ running/idle
                         │  ├─ turn end ─▶ idle
                         │  └─ error ─▶ error
                         └─ close ─▶ closed
任意状态 + link 断开 ─▶ offline（重连后按 attach/事件恢复）
```

### 13.2 Deliverable（记录生命周期）

```
(none) ──upsert(seq n)──▶ active/current(v1)
active ──upsert(seq m>n)──▶ active/current(v2)   （versions 追加）
active ──remove(seq k)────▶ tombstoned          （replica 按 keepLocalCopies）
tombstoned ──（禁止 upsert 同 id）
```

### 13.3 本端同步状态（由记录+字节状态合成）

```
metadata-only ──fetch 开始──▶ pending ──部分到达──▶ partial ──完成/校验──▶ synced
synced ──源版本变化/失效──▶ stale ──重新 fetch──▶ pending
任意 ──remove op──▶ removed
任意 ──失败且不可重试──▶ error
```

### 13.4 Interaction

```
pending ──resolve(valid)──▶ resolved
pending ──本地已解决──▶ resolved（发 resolved 通知）
pending ──expiresAt 到──▶ expired（请求方 fail-closed + cancel）
```

---

## 14. 不变量与测试向量

### 14.1 不变量（必须由测试守住）

1. 每 link 每 origin 的 `appliedSeq` 单调不减。
2. 任何时刻 `record.versions` 的 `originSeq` 严格递增，且 `current.originSeq === record.originSeq`。
3. op 的 `originNodeId` 等于已认证 peer，否则永不应用。
4. 同一 `(originNodeId, originSeq)` 至多应用一次。
5. 收到 snapshot 后，所有 `seq ≤ snapshotSeq` 的 op 被忽略。
6. 墓碑记录不允许再被 upsert（同 id）。
7. artifactId=`sha256(bytes)`；`artifact.end` 校验失败时不得进 CAS。
8. 元数据（deliverable）与字节（artifact）解耦：字节缺失不影响记录存在与状态同步。

### 14.2 测试向量（节选）

| # | 输入序列 | 期望 |
|---|---|---|
| V1 | B: upsert seq1 (cat.glb v1) → A | A 记录存在，metadata-only |
| V2 | V1 + 重复 seq1 | A 忽略，状态不变 |
| V3 | V1 + upsert seq3（跳过 2） | A 触发 sync；补齐 seq2 后 applied=3 |
| V4 | V3 但 B op log 已不含 seq2 | B 返回 snapshot(seq3)；A 以 snapshot 替换视图 |
| V5 | V1 + upsert seq2（v2 版本） | A versions=[v1,v2]，current=v2，按策略拉新字节 |
| V6 | V5 + remove seq4 | A 标 removed；replica 保留（keepLocalCopies），UI 显示已删除 |
| V7 | 同 `logicalPath` 内容不变再 publish | 不产生新 op/版本 |
| V8 | A 断网期间 B 发 seq5..8 | A 重连 sync(applied=4) → 收到 5..8 → applied=8 |
| V9 | A 收到 seq 乱序 5,6,8,7 | 缓存/触发 sync；最终 applied=8 且顺序正确 |
| V10 | 两侧同时发布同名 `cat.glb` | 两条记录（origin A/B），互不覆盖 |
| V11 | snapshot 与 live op 交错 | snapshot 后忽略旧 seq；终态一致 |
| V12 | artifact 传输中断在 3.5 MiB | 重连带 offset=3.5MiB 续传；end 校验通过 |
| V13 | artifact 内容与 manifest 不符 | hash-mismatch；丢弃 .part；重试 2 次后 error |
| V14 | peer 发 originNodeId=自己 | 拒绝（unauthorized）+ 审计 |
| V15 | 两侧重启后重连 | peer.catalog + deliverable.sync + session.attach 后状态收敛 |

### 14.3 崩溃注入点

- publish 后、写 op log 前 → 重启后无该 op（用户需重新发布；UI 不应显示已发布）。
- 写 op log 后、发网络前 → 重启后 op log 有；重连对账补发。
- 收到 op 后、写 applied 前 → 重启后可能重复应用；幂等去重保证无副作用。
- 传输中崩溃 → `.part` 续传。
- snapshot 生成中崩溃 → 丢弃半成品，下次重新生成。

---

## 15. M1 任务拆解与验收

### 15.1 WBS（建议顺序）

| # | 任务 | 交付物 | 依赖 | 估时 |
|---|---|---|---|---|
| M1-1 | `protocol` 包 | TS 类型、JSON Schema、编解码/校验、错误码表、版本常量 | M0 | 2d |
| M1-2 | 连接层 | listener/dialer、TLS、hello/welcome proof、去重、心跳、重连 | M1-1 | 3d |
| M1-3 | peer/session 方法 | peer.catalog/sessions、session.create/prompt/cancel/attach/page/close、事件流 | M1-2 | 4d |
| M1-4 | 会话标记 | catalog/origin 事件、prompt source、settled source、projection | M1-3 | 2d |
| M1-5 | 交付物核心 | DeliverableStore、op/oplog/applied、sync/snapshot、replica 骨架 | M1-1 | 4d |
| M1-6 | 字节传输 | artifact.fetch/chunk/end、CAS、断点续传、hash 校验 | M1-5 | 2d |
| M1-7 | 浏览器 API + UI | `remotenode` Remote、client model、页面（对端/双向会话/交付物视图/审批卡）、下载/上传路由 | M1-3/5/6 | 5d |
| M1-8 | 模型工具 | remotenode_list/run/prompt/status/cancel/close/publish/deliverables/fetch/sync | M1-3/5 | 2d |
| M1-9 | 装配/profile/bundle | web-app 行、remotenode profile、配置校验 | M1-2/7 | 1d |
| M1-10 | 测试与验收 | 双进程 harness、单元/集成/安全用例、故障注入 | 全部 | 3d |

> 单人不并行约 28 人日（4–5 周）；本表按"含交付物同步 + 对账 + 测试"的完整 M1 估。若只做最小闭环（单节点、单向、无完整 UI）可压缩到约 2 周；06 §13 的 1–2 周是乐观下限，本表更接近可验收工期。

### 15.2 M1 验收（可演示）

1. 启动两个本地 dsh 进程（不同 DSH_HOME / 不同 nodeId），配置 shared secret；双方 `remotenode` 页显示对端 online。
2. A 会话 `remotenode_run` → B 创建会话；A 页出现 running、流式事件；B 页出现"由 A 发起"。
3. B 会话执行工具触发审批；A 页弹审批卡；点允许；继续；超时用例 fail-closed。
4. B 会话 `present` 两个文件：A 清单自动出现（元数据）；图片自动拉取并预览；大文件按需拉取、断点续传、sha256 校验。
5. B 重新发布大文件 → A 出现新版本；B 删除 → A 标 removed 且 replica 保留。
6. 断网 30s：B 继续发布；A 恢复后对账补齐；无重复/丢失。
7. 任一侧 kill -9 重启：清单、版本、会话状态恢复一致（允许 offline 短暂）。
8. A 本地会话 `present` 的文件同步到 B（`publishFromLocal`）。
9. 安全用例：错误 secret / 伪造 origin / 未授权 fetch / 路径遍历均被拒。

### 15.3 测试脚手架

- **单元**：`protocol` codec/校验；op 应用状态机（纯函数，输入 op 序列，断言记录/applied）。
- **集成（双进程）**：真实 `dsh --profile remotenode` + 测试控制器；端口随机、临时 DSH_HOME；帧录制/回放。
- **故障**：代理层丢帧/延迟/断连；kill 进程；磁盘满（小配额）；时钟偏移。
- **UI**：`*.client.spec.tsx` + `pnpm run dev:web` 手工验收。
- **安全**：见 §16 checklist。

---

## 16. 安全 checklist（M0/M1）

- [ ] 非 loopback 强制 TLS；私钥/secret 文件权限 0600（Windows ACL 收紧）
- [ ] 每 link 独立 secret；轮换流程与宽限窗口
- [ ] hello/welcome 双向证明；nonce 防重放；时钟偏移拒绝
- [ ] 连接去重确定性；重复连接审计
- [ ] 只有 initiator 能驱动其 link；`originNodeId` 由连接身份推导
- [ ] `deliverables.roots` 白名单 + realpath + 拒符号链接/目录/设备
- [ ] 逻辑路径清洗（`..`/控制字符/Windows 保留名/UNC）
- [ ] per-file/per-link/CAS 配额；流式写 `.part`；磁盘满回滚
- [ ] artifact 只允许已存在记录引用；fetch 校验 offset/整文件 hash
- [ ] MIME 嗅探；HTML/SVG 沙箱 CSP + attachment；不自动执行
- [ ] 墓碑 + `keepLocalCopies`，避免删除传播造成数据丢失
- [ ] 审批 fail-closed；模型无审批工具；远程审批卡标"来自对端"
- [ ] 审计：连接/认证失败/去重/发布/同步/删除/越权
- [ ] 日志不落 secret/token/proof 明文

---

## 17. 仍待确认（M0 评审时需要拍板）

| # | 问题 | 建议 |
|---|---|---|
| 1 | `deliverable.syncResult` 是否需要分页（大通道记录多） | M1 一次返回；记录 > 2000 时再分页 |
| 2 | `artifact.window` 是否 M1 就做流控 | M1 固定窗口；M2 做 credit |
| 3 | 交付物字节是否默认进 replica（`sync=all` 才进） | 默认 preview 只进 CAS；`all` 才进 replica |
| 4 | 本机 `present` 是否默认全部双向同步 | 是（`publishFromLocal: true`），可关 |
| 5 | 来源会话是否 M1 就注入 native 交付卡 | M2；M1 用工具卡 + 交付物视图 |
| 6 | 快通道 HTTP Range 是否 M1 做 | M3；M1 只走 PeerLink |

---

## 附录 A：错误码总表（v1）

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
| 4022 | `session/busy` | 是 | 写忙 |
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

## 附录 B：共享 secret 证明（伪代码）

```ts
function helloTranscript(p: PeerHelloParams, listenerNodeId: NodeId): string {
  return [
    'dsh-remotenode/1/hello',
    `dialer=${p.nodeId}`,
    `dialerEpoch=${p.instanceEpoch}`,
    `listener=${listenerNodeId}`,
    `connectionId=${p.connectionId}`,
    `protocol=${p.protocol}`,
    `ts=${p.ts}`,
    `nonce=${p.nonce}`,
  ].join('\n')
}

function welcomeTranscript(hello: string, w: PeerWelcomeResult): string {
  return [hello, `welcomeNonce=${w.nonce}`, `welcomeTs=${w.ts}`].join('\n')
}

const expectedHelloProof = b64url(hmacSha256(linkSecret, helloTranscript))
const expectedWelcomeProof = b64url(hmacSha256(linkSecret, welcomeTranscript))
```

- 比较使用常量时间比较。
- proof 不写日志；审计只记 success/fail 与 nodeId/connectionId。

## 附录 C：一次完整交换（摘要）

```
A(dialer)                          B(listener)
  TCP/TLS ────────────────────────▶
  peer.hello(h1) ─────────────────▶ 校验 nodeId/ts/nonce/proof
  ◀───────────────── peer.welcome(h1)
  校验 welcome proof
  ◀══════════════ 双向 RPC ═══════▶
  peer.catalog ⇄ peer.catalog
  deliverable.sync(applied) ⇄ deliverable.sync(applied)
  session.attach(cursor) ⇄ snapshot + event.session…
  B 发布交付物：deliverable.op(upsert) ──▶ A 应用（metadata-only）
  A 自动预览：artifact.fetch ──▶ B chunk×N ──▶ A end 校验 → synced
  A 发布本机交付物：deliverable.op(upsert) ──▶ B 应用
  断网 30s（B 继续 publish，op 写本地 log）
  重连：peer.catalog → deliverable.sync(applied) → 补 op → 收敛
```

---

> **下一步**：本规格评审通过后，进入 M1 实现拆解（按 §15.1 WBS 建任务板）；实现前先搭 `protocol` 包与纯函数 op 状态机做 TDD，再接连接层与 UI。
