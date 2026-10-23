# remotenode 插件实现契约（v1 / M1 切片）

> 本文件是并行开发时的**唯一接口契约**。所有文件都必须严格按本契约实现；改契约前必须通知 Team Lead。
> 设计来源：[docs/06-remotenode-design.zh.md](../../docs/06-remotenode-design.zh.md)、[docs/07-remotenode-m0-protocol.zh.md](../../docs/07-remotenode-m0-protocol.zh.md)。
> 本插件是**插件模式**实现：一个可安装 bundle（Host 半端 + Client 半端），不是独立原型、不改 DSH 源码、不写 profile 的 patch。

## 1. 目标与非目标（v1）

目标（必须做到）：

1. 两个 DSH 实例（大脑 brain + 远程节点 node）各安装同一个 bundle，经 TCP + 共享密钥握手建立**对等链路**；
2. 任一侧都能在**对端**创建/驱动可续聊的远程会话（create / prompt / cancel / attach 断线续传 / 事件流回传 / running 状态）；
3. 会话在**两侧都有来源标记**：发起侧知道“我发起、运行在对端”，执行侧知道“对端发起”（插件存储，重启可恢复）；
4. 交付物同步：远程会话里 `present` 的文件元数据自动同步到对端；图片/小文件自动拉取字节，大文件按需拉取（sha256 校验 + 内容寻址存储）；可下载；
5. 模型工具 `remotenode`（list_peers / list_sessions / start_session / prompt / cancel / transcript / deliverables / publish）；
6. Web GUI：侧栏 `remotenode` 入口 + 主面板（对端列表、双向会话、会话详情/转录/prompt/cancel、交付物列表与下载）；
7. 双侧重启后链路恢复、会话重新 attach、交付物索引恢复。

非目标（v1 明确不做，写进 README 限制）：审批/提问跨节点转发（节点以 danger-full-access 无人值守运行）、流式 token、TLS/mTLS、多会话 queue/steer 之外的控制、文件上传到远端、版本墓碑/删除同步、Windows 实机验证、观察全部本地会话（只暴露远程会话）。

## 2. 文件与归属（并行开发写作用域）

| 文件 | 归属 | 说明 |
|---|---|---|
| `package.json` `cordis.patch.yml` `icon.svg` `locale/*.json` `README.md` | Lead / web-client（locale 文本） | bundle 清单、装配行、显示资源 |
| `index.js` | Lead | Host 装配：config、PeerManager、SessionBridge、DeliverableHub、HTTP API、tools |
| `lib/peer-link.js` `lib/peer-manager.js` `tests/peer.test.mjs` | peer-transport | TCP 帧层、握手接入、双向 RPC、心跳、监听/拨号/去重/重连 |
| `lib/ids.js` `lib/errors.js` `lib/frames.js` `lib/handshake.js` `lib/dedupe.js` `lib/deliverable.js` `lib/oplog.js` `lib/sync-engine.js` `lib/store.js` `tests/*.test.mjs`（上述模块） | protocol-lib | 协议核心（从原型移植 + 持久化） |
| `lib/session-bridge.js` `lib/deliverable-hub.js` `lib/routes.js` | Lead | DSH 集成 |
| `client.js` | web-client | 浏览器 ModuleLoader bundle（侧栏 + 主面板） |
| `scripts/setup-node-profile.sh` `scripts/run-node.sh` `scripts/stop-node.sh` `scripts/status-node.sh` | node-env | 第二 DSH 实例准备与运行 |
| `docs/`（工作区） | Lead | 说明文档 |

**代码规则**

- Host 侧纯 ESM `.js`，`"type": "module"`；**零第三方依赖、零 `@deepseek-ai/*` import**（只用 `node:*` 内置模块）。因为 out-of-tree bundle 通过 `ctx` 服务与 harness 交互，不 import harness 包。
- Client 侧只允许 `require('react')`（浏览器模块表提供），加 `ctx.slots` / `ctx.locale` / `ctx.layout` 服务。
- 一切对外监听回调必须防御式：插件故障不能拖垮 DSH/会话。
- 测试文件用 `node:test`；本机 Node 用 `/root/.nvm/versions/node/v22.22.1/bin/node`（PATH 里的 node 是 18，会挂）。
- 所有文件改完跑 `node --check <file>`；协议/传输/同步必须有测试。
- 不修改 DSH checkout、不修改当前 profile 的 package.json / cordis.patch.yml（安装由 Lead 用 plugin_manager 完成）。

## 3. 运行时架构

```
┌─ brain DSH (profile web, 127.0.0.1:3080) ─────────────┐       ┌─ node DSH (DSH_HOME=/root/.dsh-node, :3081) ─┐
│ index.js                                              │       │ index.js                                     │
│  ├─ PeerManager  (net TCP listen 47201 / dial 对端)   │◀═════▶│  ├─ PeerManager (listen 47301 / dial brain)  │
│  ├─ SessionBridge  ←ctx.sessionController            │ JSON- │  ├─ SessionBridge ←ctx.sessionController       │
│  ├─ DeliverableHub ←session/event(deliverables/...)  │ RPC+  │  ├─ DeliverableHub                           │
│  ├─ routes: /api/remotenode/*                        │ chunk │  ├─ routes: /api/remotenode/*                │
│  └─ tools: remotenode                                │       │  └─ tools: remotenode                        │
│ client.js: sidebar + main 面板 ──HTTP──▶ routes       │       │ （Web UI 可选，本插件在 node 上照常加载）      │
└───────────────────────────────────────────────────────┘       └──────────────────────────────────────────────┘
```

- **链路 key** = `linkId = <较小 nodeId>~<较大 nodeId>`（两侧一致，持久化用）。
- 每个 link 上双方对称：都能 `request`，都能收发通知；会话的 host 是“会话被执行的那一侧”。
- 会话 key（UI 内）：`<linkId>:<linkSessionId>`；`linkSessionId = <发起方 nodeId>:<uuid>`，由发起方铸造，单 link 内唯一。
- 数据目录（默认 `$DSH_HOME/remotenode/data`）：`links.json`、`outbound.json`（我发起、对端执行）、`inbound.json`（对端发起、我执行）、`transcripts/<linkSessionKey>.jsonl`、`deliverables/<linkId>.json`、`blobs/<artifactId>`；配置文件默认 `$DSH_HOME/remotenode/config.json`；远程会话工作目录默认 `$DSH_HOME/remotenode/workspace`。

## 4. 配置（config.json 与 row config）

`index.js` 读取顺序：row `config`（cordis 行内的对象，可含 `configFile`）→ 读 JSON 文件 → 深合并（row 优先）。文件不存在时用默认值：`nodeId = 'node-' + os.hostname() 的安全化`，`listen.enabled = false`，`peers = []`，插件其余功能照常加载（HTTP API 可用，面板显示未配置）。

```jsonc
{
  "nodeId": "brain-linux",              // ^[a-z0-9][a-z0-9._-]{0,63}$
  "nodeName": "Linux 大脑",
  "listen": { "enabled": true, "host": "127.0.0.1", "port": 47201 },
  "peers": [
    {
      "nodeId": "desktop-node",
      "nodeName": "台式机 worker",
      "host": "127.0.0.1",
      "port": 47301,
      "secret": "64-hex-characters 或任意高熵字符串(>=32B)",
      "dial": "auto"                    // auto | off
    }
  ],
  "workspace": "/root/.dsh/remotenode/workspace",   // 远程会话 cwd（执行侧用）
  "dataDir": "/root/.dsh/remotenode/data",
  "autoFetchImages": true,
  "maxAutoFetchBytes": 15728640,        // > 该大小的文件只同步元数据
  "maxDeliverableBytes": 268435456,     // present 超过该大小拒绝发布
  "requestTimeoutMs": 30000,
  "heartbeatIntervalMs": 10000,
  "heartbeatTimeoutMs": 30000
}
```

- 同一 `linkId` 的 `secret` 两侧必须一致；握手用 HMAC challenge/response（见 §6.1）。
- `dial: off` 表示只接受对方拨入。

## 5. lib 模块契约（protocol-lib / peer-transport）

> 全部改名为 `.js`（去 `.mjs`），导出名与原型一致；原型源码在
> `/tmp/dsh-design-revert-20261023-1945/prototype/remotenode/src/`，测试在 `.../test/`。
> 除下面列出的**必须新增**能力外，保持原型语义。

### 5.1 `lib/ids.js`
`newId(prefix?)`, `sha256Hex(bytesOrString)`, `artifactIdForBytes(bytes)`, `artifactIdForString(text)`,
`isArtifactId(v)`, `isNodeId(v)`, `assertNodeId(v, label?)`, `isSafeLogicalPath(p)`,
`logicalPath(fileName)`, `sanitizeName(name)`, `randomHex(nBytes)`, `timingSafeEqualHex(a, b)`。

### 5.2 `lib/errors.js`
`ERRORS`（错误码表：`{code, retryable}`）、`ProtocolError`（`new ProtocolError(code, message, details?)`，有 `.code` `.details` `.retryable`）、`rpcErrorFor(error)` → `{code, message, data:{kind, retryable, details?}}`、`isRpcError(v)`、`errorCodeOf(error)`。

### 5.3 `lib/frames.js`
常量：`MAX_JSON_FRAME_BYTES`（1 MiB）、`MAX_CHUNK_BYTES`（1 MiB）、`MAX_EVENT_BATCH`（200）、`MAX_FRAME_BYTES = MAX_CHUNK_BYTES + 64 * 1024`。
函数：
- `request(id, method, params)`, `notification(method, params)`, `response(id, result)`, `errorResponse(id, rpcError)` — JSON-RPC 2.0 帧对象工厂；
- `validateJsonRpcFrame(value)` → `{ok:true, kind:'request'|'notification'|'response', id?, method?}` 或 `{ok:false, reason}`（未知 method 结构合法）；
- `encodeJsonFrame(frame)` → `Buffer`（UTF-8 JSON）；
- `decodeJsonFrame(buffer)` → 解析后的对象（非法 JSON 抛 ProtocolError('frame/invalid-json')）；
- `encodeBinaryFrame(header, payload)` → `Buffer`：`[4B BE headerLength][UTF-8 JSON header][payload]`；
- `decodeBinaryFrame(buffer)` → `{header, payload:Buffer}` 或 `null`；
- `isBinaryFramePayload(buffer)` → boolean：`buffer[0] === 0x7b`（`{`）为 JSON 帧，否则视为二进制帧（TCP carrier 用首字节区分；二进制头长度字段首字节恒为 0，见设计 §2.3）；
- `MAX_JSON_FRAME_BYTES` 在 encoder/decoder 两侧都要校验，超限抛 `ProtocolError('limit/frame-too-large')`。

### 5.4 `lib/handshake.js`
沿用原型导出：`PROTOCOL_VERSION`, `createHello(...)`, `verifyHello(...)`, `createWelcome(...)`, `verifyWelcome(...)`, `helloTranscript(...)`, `welcomeTranscript(...)`, `NonceCache`, `simulateHandshake(...)`。字段按 07 §3.2：`protocol/nodeId/nodeName/instanceEpoch/connectionId/platform/capabilities/nonce/proof/limits`。
proof = HMAC-SHA256(secret, transcript)，transcript 至少含 protocol、双方 nodeId、nonce、connectionId。

### 5.5 `lib/dedupe.js`
沿用原型：`canonicalDialer(nodeA, nodeB)`（字典序小者）、`decideConnection(...)`、`isCanonicalOutbound(...)`。

### 5.6 `lib/deliverable.js` / `lib/oplog.js` / `lib/sync-engine.js`
沿用原型。**新增**（持久化需要）：
- `sync-engine.exportState()` → 纯 JSON：`{ peerNodeId, nextSeq, ownRecords:[...], peer:{appliedSeq, records:[...]}, }`；
- `createSyncEngine({...options, state?})`：传入 `state` 时恢复（校验失败抛错）；`exportState()` 必须可由它 round-trip。
- `OpLog` 增加 `exportSince(seq)` / `size`（若原型已有等价能力可包装）。

### 5.7 `lib/store.js`（新增）
`createStore({ dataDir })` → 同步/异步文件持久化工具（全部防路径穿越）：
- `ensure()`：`mkdir -p` dataDir 子目录（`transcripts/`, `deliverables/`, `blobs/`）；
- `readJson(rel, fallback)` / `writeJson(rel, value)`（原子写：临时文件 + rename）；
- `appendJsonl(rel, value)` / `readJsonl(rel)`；
- `putBlob(artifactId, bytes)` → 写入 `blobs/<safeFileName>`；`hasBlob(id)`、`readBlob(id)` → Buffer|null、`statBlob(id)` → {bytes}|null；
- `resolvePath(rel)` 禁止绝对路径与 `..`；
- 所有 IO 失败抛带上下文的 Error（调用方兜底）。

### 5.8 `lib/peer-link.js`（peer-transport）
```js
export function createPeerLink(options)
// options: {
//   socket, role: 'dialer'|'listener', nodeId, peerNodeId?, linkId?, secret, nodeName,
//   instanceEpoch, capabilities?, logger?, requestTimeoutMs?, heartbeatIntervalMs?, heartbeatTimeoutMs?,
//   peekPeerNodeId?: () => string|undefined,   // listener 在 hello 前无法知道对端；握手回调里用
//   handlers: { onRequest(link, method, params, ctx) -> Promise|value,
//               onNotification(link, method, params), onUp(link), onDown(link, reason) }
// }
// 返回 link: {
//   linkId, nodeId, get peerNodeId(), get state() 'handshaking'|'ready'|'closed',
//   get remote(): {nodeId,nodeName,platform,capabilities,limits} | null,
//   request(method, params, {timeoutMs}={}) -> Promise<result>,   // 对端 error 转 ProtocolError
//   notify(method, params), sendBinary(header, payload),          // sendBinary 用于 artifact.chunk
//   onRequest(fn), onNotification(fn),                           // 可追加处理器（先注册的先执行）
//   isReady(), close(reason), get lastSeen(), get rttMs?, stats,
// }
```
行为：
1. 把 socket 数据流切成 `[4B BE 长度][payload]` 帧；单帧 > `MAX_FRAME_BYTES` 断链；
2. 首字节是 `{` → JSON 帧；否则二进制帧 → 解码 header+payload 后回调 `onBinary(header, payload)`（handler 里加，默认只用于 artifact.chunk；由 index.js 注入）；
3. 握手：dialer 发 `peer.hello`（request），校验 `peer.welcome`；listener 等 `peer.hello`（用 `peekPeerNodeId`/config 找 secret 校验），回 `peer.welcome`；成功后 state=ready、回调 onUp；失败关闭并回调 onDown(reason)；
4. 双向 RPC：request 用自增 `r-<n>` id + Map 回调；notification 直接派发；未知 request method → 回 `method/not-found`；未知 notification 忽略；
5. 心跳：每 `heartbeatIntervalMs` 发 `{method:'peer.heartbeat', params:{status:'ready',time}}`；连续 `heartbeatTimeoutMs` 无任何入帧 → close('timeout')；收到 `peer.ping` request → 回 `{time}`；
6. close 时清理所有 pending request（reject ProtocolError('link/closed')），只回调一次 onDown。

### 5.9 `lib/peer-manager.js`（peer-transport）
```js
export function createPeerManager(options)
// options: { config, instanceEpoch, logger, handlers: { onLinkUp(link), onLinkDown(link, reason),
//            onRequest(link, method, params, ctx), onNotification(link, method, params) } }
// 返回 manager: {
//   async start(), async stop(),
//   get self(), get peers(), get links(),
//   state(): [{ peerNodeId, nodeName, configured, dial, state:'online'|'offline'|'dialing'|'error',
//               direction:'in'|'out'|null, linkId?, lastSeen?, rttMs?, remote?, error? }],
//   linkFor(nodeId), request(nodeId, method, params, opts), notify(nodeId, method, params),
//   broadcast(method, params), dialNow(nodeId), activeLinkCount(),
// }
```
行为：监听 `config.listen`（enabled 时）；为 `dial:'auto'` 的 peer 维护拨号循环（1s→2s→5s→10s→30s 上限退避）；握手失败/断链记录 `error` 并重连；**去重**：同 peer 两条链路时只保留 `dialerNodeId === canonicalDialer(self, peer)` 的那条，另一条 close('duplicate')，并在 3s 内不再因重复关闭立即重拨（避免抖动）；`state()` 给 UI 用（不含 secret）。

## 6. Lead 侧实现要点（index.js / session-bridge / deliverable-hub / routes）

### 6.1 Host plugin 形态
```js
export const name = 'remotenode'
export const inject = ['tools', 'webServer']          // sessionController/agents/approval 用 ctx.get? 直接注入更简单：inject: ['tools','webServer','sessionController','agents']
export function apply(ctx, config) { ... }            // 或 export default { name, inject, apply }
```
- 配置读取、store、PeerManager、SessionBridge、DeliverableHub 在 `apply` 内创建；所有注册用 `ctx.effect(...)` 包裹，返回 disposer；
- 服务严格可选：`ctx.get('sessionController')` 不存在时（headless profile）只跑链路+交付物，不提供会话能力；HTTP/tools 的相应动作返回 `{ok:false,error:'sessionController unavailable'}`。

### 6.2 会话桥
执行侧（收到 `session.create`）：
- 用 `ctx.sessionController.create({ cwd: cfg.workspace })` 建普通会话（先 `mkdir -p workspace`）；
- `linkSessionId` 由发起侧给；`session.create` 参数：`{ linkSessionId, prompt?: {requestId, text}, cwd? }`；返回 `{ linkSessionId, localSessionId, title? }`（localSessionId 不回传对端，仅本方 UI 显示时截断）；
- 用 `ctx.sessionController.prompt({ requestId, sessionId, mode:'queue', content:[{type:'text', text}] })` 下发 prompt；
- 订阅 `ctx.on('session/event', (session, event) => ...)`：只转 `user/message`、`assistant/message`、`tool/call`、`tool/result`、`deliverables/presented`、`turn/start`、`turn/end`、`session/title`(若有)；转成简化 JSON（§6.3）发 `event.session` 通知 `{ linkSessionId, seq, time, event }`；
- 订阅 `ctx.on('api-session/status', (sessionId, running) => ...)` → `session.state` 通知 `{ linkSessionId, state: running?'running':'idle' }`；
- `session.prompt` / `session.cancel` / `session.attach` / `session.list` 请求按契约处理；`session.attach` 返回 `{ events:[简化事件], state }`（从该 local session 的 `session.snapshotEvents()` 过滤映射，支持 `fromSeq`）；
- `deliverables/presented` 事件同时交给 DeliverableHub 发布（§6.4）。

发起侧：
- 记录 `outbound.json`: `{ key, linkId, peerNodeId, linkSessionId, title, createdAt, updatedAt, state, lastSeq, error? }`；
- `session.start`：选 link → `link.request('session.create', {linkSessionId, cwd})` → 记 outbound → 若有初始 prompt 再 request `session.prompt`；
- 收 `event.session` → 追加 `transcripts/<key>.jsonl`（先写文件再更新内存），`lastSeq` 单调；
- 收 `session.state` → 更新 state；
- 链路 up 时对每条本 link 的 outbound 会话发 `session.attach`（`fromSeq=lastSeq`）补历史；期间 pending 队列兜底；
- 断链：state='offline'，UI 可见，不丢 transcript。

事件简化（两端同一函数，写进 session-bridge）：
```js
{ type, seq, time,
  role?: 'user'|'assistant'|'tool', text?: string, name?: string, args?: string,
  isError?: boolean, files?: [{path, description}], turn?, reason?, usage? }
```
从原始事件 data 提取文本：content 数组里 `{type:'text'}` 拼接；tool/result 从 message.content 提取文本并取 `message.isError`；assistant 消息取文本首 4000 字；tool/call 取 name+arguments（截断 4000）。原始事件体积必须裁剪（单通知 < 64KB）。

### 6.3 交付物同步（v1 子集）
- `DeliverableHub` 每个 link 一个 `syncEngine`（protocol-lib），状态从 `store` 恢复，变更后节流 300ms 持久化；
- 发布（执行侧 present）：收到 `deliverables/presented`（仅当该 session 是本 link 的 inbound 会话）→ 对每个 file：`fs.stat` 必须普通文件、size ≤ `maxDeliverableBytes`、算 sha256、logicalPath=sanitizeName(basename) 去重；`engine.publish({...})` → 广播 `deliverable.op` 通知；同时把交付物列表记录到 `deliverables/<linkId>.json`（由 engine.exportState 持久化即可）；
- 接收：`deliverable.op` 通知 → `engine.handleOp(op)`（失败 needSync 时发 `deliverable.sync` 请求对账）；落盘；若记录是 image 且 `autoFetchImages` 且 bytes ≤ maxAutoFetchBytes → 自动 `artifact.fetch`；
- `deliverable.sync` 请求：`{ watermarks:{[originNodeId]:seq} }` → `engine.handleSyncRequest`；响应 `{applied, ops, complete}` → 对端 `handleSyncResult`；
- `artifact.fetch` 请求：`{artifactId, maxBytes?}` → holder 从 `store` 或本地文件读字节，按 `MAX_CHUNK_BYTES` 分块发二进制帧 `artifact.chunk`（header `{artifactId, offset, length, sha256Chunk?}`，payload）；最后 `artifact.end` 通知；接收方按 offset 拼装、校验 sha256、`store.putBlob`；
- HTTP `POST /api/remotenode/artifact/fetch` 触发按需拉取并等待完成（超时 30s）；`GET /api/remotenode/artifact?key=` 返回本地 CAS 字节（Content-Type 按扩展名；`Content-Disposition: attachment; filename="..."`）；
- `remotenode publish`（工具/UI）可把任意本地文件作为交付物发布给指定 peer（合成一个 originSessionId='local-publish' 的记录，直接可 fetch）。

### 6.4 HTTP API（`/api/remotenode` 前缀，webServer 注册；GET 读、POST 写，JSON `{ok:...}`）
见 §7 的精确字段；所有 handler 必须 try/catch → `{ok:false,error:String(err?.message??err)}`，HTTP 200（除 artifact 字节流）；`Cache-Control: no-store`。

### 6.5 模型工具（root ctx）
`ctx.tools.register({ name:'remotenode', description:..., parameters:{...}, output:{schema, render}, execute })`（纯对象，无需 defineTool）。
参数：`action`（enum：`list_peers` `list_sessions` `start_session` `prompt` `cancel` `transcript` `deliverables` `publish`）、`peerNodeId?`、`sessionId?`、`text?`、`path?`、`description?`、`limit?`。
execute 直接调用本插件内部同一条代码路径（与 HTTP API 相同），返回 `{ ok, ... }`；`start_session` 默认不等任务完成（异步返回 session 信息 + 提示用户到面板查看）；说明文字中文。
同时在 root ctx 用 `ctx.systemPrompt.section({ text })` 加一小段指引（可选，若 API 不明确则跳过，勿猜测签名）。

## 7. HTTP API 精确契约（web-client 按此实现）

统一前缀 `http://<same-origin>/api/remotenode`。

### GET `/api/remotenode/state`
```jsonc
{ "ok": true,
  "self": { "nodeId": "brain-linux", "nodeName": "Linux 大脑", "instanceEpoch": "…", "protocol": 1,
            "dataDir": "/root/.dsh/remotenode/data", "listen": {"enabled":true,"host":"127.0.0.1","port":47201} },
  "peers": [ { "peerNodeId":"desktop-node", "nodeName":"台式机 worker", "state":"online", "direction":"out",
               "linkId":"brain-linux~desktop-node", "lastSeen": 1761…, "rttMs": 4,
               "remote": {"nodeId":"desktop-node","nodeName":"台式机 worker","platform":"linux"},
               "error": null } ],
  "sessions": [ { "id":"brain-linux~desktop-node:brain-linux:uuid", "linkId":"…", "linkSessionId":"…",
                  "peerNodeId":"desktop-node", "direction":"outbound"|"inbound",
                  "state":"running"|"idle"|"offline"|"error"|"starting",
                  "title":"…", "createdAt":0, "updatedAt":0, "lastSeq":0, "error":null,
                  "deliverableCount": 0 } ],
  "deliverables": [ { "key":"<linkId>|<originNodeId>|<deliverableId>", "linkId":"…", "peerNodeId":"…",
                      "originNodeId":"desktop-node", "deliverableId":"…", "sessionId":"…|null",
                      "logicalPath":"cat.png", "name":"cat.png", "kind":"image"|"model"|"file",
                      "bytes":12345, "sha256":"…", "version":1,
                      "syncState":"metadata"|"fetching"|"synced"|"error",
                      "localAvailable": true, "error":null, "createdAt":0, "updatedAt":0 } ] }
```

### POST `/api/remotenode/session/start`
body `{ peerNodeId, prompt?, cwd? }` → `{ ok:true, session:{…同 sessions 元素…} }`；链路不通 → `{ok:false,error:'peer offline'}`。

### POST `/api/remotenode/session/prompt`
body `{ sessionId, text, mode?:'queue'|'steer' }` → `{ok:true}`。

### POST `/api/remotenode/session/cancel`
body `{ sessionId }` → `{ok:true}`。

### GET `/api/remotenode/session/transcript?sessionId=…`
→ `{ ok:true, session:{…}, events:[ { seq, time, type, role?, text?, name?, args?, isError?, files?, turn?, reason? } ] }`（按 seq 升序）。

### POST `/api/remotenode/refresh`
→ `{ok:true}`：对所有离线 peer 立即重拨。

### POST `/api/remotenode/artifact/fetch`
body `{ key }` → `{ok:true, syncState}`（等待完成，最长 30s；失败 `{ok:false,error}`）。

### GET `/api/remotenode/artifact?key=…`
→ 成功：`200` + 原始字节 + `Content-Type` + `Content-Disposition: attachment; filename="…"`；
→ 本地无字节：`409` + JSON `{ok:false,error:'artifact not synced', syncState:"metadata"}`。

### POST `/api/remotenode/publish`
body `{ peerNodeId, path, description? }` → `{ok:true, deliverable:{…}}`（路径必须在执行侧可读；size 超限报错）。

### GET `/api/remotenode/ping`
→ `{ok:true, self:{nodeId,nodeName}}`（安装自检用）。

## 8. Client UI 要求（web-client）

- `window.__ModuleLoader__.load({ id: '@dsh-design/remotenode', factory(require){...} })`；
- `inject: ['slots','locale','layout']`（缺失时容错）；`apply(ctx)` 内：
  - `ctx.locale.register('remotenode', { zh, en })`（若无 locale 服务则用内置字典）；
  - `ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name:'sidebar.panellist', id:'remotenode', order:20, label: () => t('panel'), locale:'remotenode' }, Icon))`；
  - `ctx.slots.inject('main', () => ctx.slots.register({ name:'main', key:'remotenode', locale:'remotenode' }, Page))`；
- 页面规格：
  - 顶栏：标题「远程节点」、本机 nodeId/监听、刷新按钮；
  - 「链路」卡片：每个 peer 名称、状态点（online 绿/offline 灰/error 红）、方向、RTT、最近心跳；
  - 「会话」两栏/两组：「我发起的（运行在对端）」「对端发起的（运行在本机）」；行：标题/对端/状态/更新时间/交付物数；点击进入详情；
  - 会话详情：返回按钮、状态徽标、转录滚动区（user/assistant/tool-call/tool-result/交付物 各样式）、prompt 输入框 + 发送（Ctrl/Cmd+Enter）、取消按钮（running 时）、轮询 2s 增量刷新；
  - 「交付物」卡片：按 link 分组；行：图标/文件名、大小、版本、同步状态（metadata/fetching/synced/error）、按钮「拉取」（metadata 状态）、「下载」（synced）、图片内联预览缩略图；
  - 空态与错误提示；未配置对端时提示编辑 `$DSH_HOME/remotenode/config.json`；
  - 所有请求 `fetch(…, {cache:'no-store'})`，失败显示错误条并继续轮询；组件异常不能白屏（用防御式取值）。
- 样式：全部用 `--dsw-alias-*` 主题 token；类名前缀 `rn-`；一个 React `<style>` 元素注入；不得 import 其他 harness client 包；不得操作 document.body。
- 国际化：中文为主，`locale/en.json`、`locale/zh.json` 只放 `meta.title`/`meta.description`（插件清单显示用）；页面文案用 client 内字典。

## 9. 验证入口（Lead 用）

- 单测：`cd plugins/remotenode && /root/.nvm/versions/node/v22.22.1/bin/node --test tests/`；
- 语法：`/root/.nvm/versions/node/v22.22.1/bin/node --check index.js` 等；
- 安装：`plugin_manager install_bundle target=<绝对目录>`（Lead 执行）；
- 双实例：`bash scripts/setup-node-profile.sh`（node-env 实现）→ `bash scripts/run-node.sh` → 面板/HTTP 验证；
- 端到端脚本：Lead 写 `scripts/e2e.sh`（curl 驱动 HTTP API 演示双向会话 + 交付物）。
