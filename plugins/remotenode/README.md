# @dsh-design/remotenode — DSH 远程节点插件

> **插件模式实现**：一个可安装的 DSH bundle（Host 半端 + Client 半端），不依赖补丁脚本、不改 DSH 源码。
> 设计文档：[docs/06-remotenode-design.zh.md](../../docs/06-remotenode-design.zh.md)（总体设计）、[docs/07-remotenode-m0-protocol.zh.md](../../docs/07-remotenode-m0-protocol.zh.md)（协议 v1 规格）。
> 实现说明与验收记录：[docs/08-remotenode-plugin.zh.md](../../docs/08-remotenode-plugin.zh.md)。

## 它做什么

两个各自运行 DSH 的实例（例如「Linux 大脑」+「Windows/GPU 台式机」）安装**同一个 bundle** 后：

1. 经 TCP + 每链路共享密钥握手建立**对等链路**（心跳、断线重连、双向拨号去重、`rtt` 展示）；
2. 任一侧都能在**对端**创建/驱动**可续聊的远程会话**（create / prompt / cancel / attach 断线续传 / 回合与工具事件回传 / running 状态），两个方向都支持；
3. 远程会话在两侧都有**来源标记**（我发起·运行在对端 / 对端发起·运行在本机），插件数据目录持久化，重启可恢复；
4. **交付物同步**：远程会话里 agent 调用 `present` 的文件，清单自动同步到对端；图片/小文件自动拉取字节，其余按需拉取（sha256 校验 + 内容寻址存储），可在面板里预览/下载；也支持主动把本机文件 `publish` 给对端；
5. 模型工具 `remotenode`（list_peers / list_sessions / start_session / prompt / cancel / transcript / deliverables / publish）；
6. Web GUI 出现「远程节点」侧栏入口 + 主面板：链路状态、双向会话、会话详情/转录/发消息/取消、交付物列表与下载。

```
┌────────────── DSH 实例 A（profile web, :3080）──────────────┐          ┌────────────── DSH 实例 B（:3081）──────────────┐
│ index.js（Host 插件）                                        │          │ index.js（同一个插件）                          │
│  ├ PeerManager   TCP 监听/拨号、握手、心跳、去重(:47201)      │◀════════▶│  ├ PeerManager (:47301)                         │
│  ├ SessionBridge ctx.sessionController 建/驱动本机会话        │ JSON-RPC │  ├ SessionBridge                                │
│  ├ DeliverableHub present→op 同步、CAS 字节、artifact 通道    │ +二进制帧 │  ├ DeliverableHub                               │
│  ├ /api/remotenode/*  ← client.js 轮询/下载                  │          │  └ /api/remotenode/*                            │
│  └ tools: remotenode                                         │          │                                                 │
│ client.js：sidebar「远程节点」+ main 面板                     │          │                                                 │
└──────────────────────────────────────────────────────────────┘          └─────────────────────────────────────────────────┘
```

## 安装

### 0) 在另一台机器上从 GitHub 安装（公开仓库）

仓库：<https://github.com/telunsu1999/dsh-design>（插件在 `plugins/remotenode/` 子目录）

```bash
# 方式 A：dsh CLI 从 GitHub 子目录安装（已在本机用一次性 DSH_HOME 验证）
dsh plugin --profile web add "github:telunsu1999/dsh-design#path:/plugins/remotenode"
# 然后在插件管理页启用 @dsh-design/remotenode；
# 或手动把 "@dsh-design/remotenode" 追加到 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles
#（位于 @deepseek-ai/dsh-web-app 之后），再重启 dsh web。
```

```bash
# 方式 B：git clone 后按本地路径安装（任何方式都能跑，含离线/内网）
git clone https://github.com/telunsu1999/dsh-design.git
# 在 DSH 会话里：plugin_manager(action: install_bundle, target: /path/to/dsh-design/plugins/remotenode)
```

> 仓库里只有源码与文档；运行时配置/密钥仍在各自机器的 `$DSH_HOME/remotenode/`，不会随仓库分发。

### 1) 装到「大脑」当前 profile（推荐用 Plugin Manager / 插件管理）

```bash
# 在 DSH 会话里让 agent 执行：
#   plugin_manager(action: install_bundle, target: /root/AiWork/DSH_Design/plugins/remotenode)
# 或命令行（等价于 profile 内 pnpm add + 选中 bundle）：
DSH_HOME=/root/.dsh node /root/.openclaw/workspace/deepseek-harness/apps/cli/lib/bin.js \
  plugin --profile web add /root/AiWork/DSH_Design/plugins/remotenode
```

安装后 bundle patch 会插入一行 Host 插件（id `remotenode`）并自动加载 Client 半端；**页面刷新一次**后侧栏出现「远程节点」。

### 2) 配「大脑」侧配置（`$DSH_HOME/remotenode/config.json`）

```jsonc
{
  "nodeId": "brain-linux",
  "nodeName": "Linux 大脑",
  "listen": { "enabled": true, "host": "127.0.0.1", "port": 47201 },
  "peers": [
    {
      "nodeId": "desktop-node",
      "nodeName": "台式机 worker",
      "host": "127.0.0.1",          // 真实部署填台式机地址/Tailscale IP
      "port": 47301,
      "secret": "<两侧一致的 32+ 字节高熵字符串>",
      "dial": "auto"
    }
  ],
  "workspace": "/root/.dsh/remotenode/workspace",
  "dataDir": "/root/.dsh/remotenode/data",
  "autoFetchImages": true,
  "maxAutoFetchBytes": 15728640
}
```

### 3) 准备「远程节点」实例（本机演示用脚本，第二 DSH_HOME）

```bash
cd /root/AiWork/DSH_Design/plugins/remotenode
bash scripts/setup-node-profile.sh   # 幂等：初始化 /root/.dsh-node + 安装本 bundle + 写 config + 复制凭据
bash scripts/run-node.sh             # 后台启动（:3081，对等监听 :47301）
bash scripts/status-node.sh
bash scripts/stop-node.sh
```

> 真实环境里第二台机器重复「安装 bundle → 拷配置（改 nodeId/peers/secret）→ 常驻启动」即可；
> 无人值守节点建议设置 `DSH_PERMISSION_MODE=danger-full-access`（本插件 v1 不做审批跨节点转发）。

### 4) 自检

```bash
bash scripts/e2e.sh links      # 双侧 online + rtt
bash scripts/e2e.sh all        # 全流程：A→B 会话+交付物、B→A 会话+交付物、断链恢复
```

## 使用

### 节点管理（UI 配对 / 审批 / 删除，v0.2.0）

不再需要手写 `config.json` 添加节点：

1. **服务端（被连接方）**：打开「远程节点」面板 → 顶部「配对令牌」卡片，点「显示/复制」拿到令牌（32 字节 hex；默认只显示指纹）。令牌可用「轮换」重新生成（若 `config.json` 里写了 `pairingToken`，则令牌固定、禁止轮换）。
2. **客户端（主动连接方）**：面板顶栏「添加节点」→ 填写对端 **地址（IP/域名）**、**端口**（对等监听端口，如 47301）、**配对令牌**，可选名称 → 提交。插件用配对协议（同一 TCP 端口、握手前）完成双向令牌证明。
3. **服务端审批**：服务端面板出现「配对请求」卡片（显示 nodeId / 名称 / 来源 IP / 时间）→ 点「批准」；批准后双方自动派生该链路的独立密钥、持久化节点并建立连接（不需要重启/改配置）。拒绝或 120 秒超时则客户端收到失败原因。
4. **删除节点**：面板节点行右侧「删除」（仅 UI 配对的节点可删；`config.json` 里的节点显示为「配置」，只能改配置文件）。删除会关闭链路，并通知对端把该配对一并移除。
5. 配对成功后节点持久化在 `$DSH_HOME/remotenode/data/peers.json`，配对令牌在 `.../data/pairing.json`（均为 600 权限）；重启后自动重连。

> 安全语义：令牌即共享密钥；配对连接用 HMAC 证明双方持有令牌，**人工审批**决定是否信任该节点；批准后为这一对节点派生独立链路密钥（`hmac(token, 'remotenode-link:v1:'+排序后nodeId)`），后续重连不再使用原始令牌。建议只在内网/Tailscale 暴露对等端口，并定期轮换令牌。

### 监听地址/端口（应对防火墙，v0.3.0）

对等监听端口不写死：面板「监听」卡片可以直接改**绑定地址 + 端口**，保存后立即生效（重建监听 socket，不用重启 DSH）：

- 显示当前生效的 `enabled / host / port` 和来源（配置文件 / 面板设置 / 默认）；
- 「修改」弹窗：启用开关、绑定地址、端口；`0.0.0.0` 或网卡 IP 才能被外部连接（需要防火墙放行该端口），`127.0.0.1` 仅本机；
- 面板保存的值会持久化到 `$DSH_HOME/remotenode/data/settings.json`（优先级高于 `config.json`）；「恢复配置文件设置」可删除覆盖、回到 `config.json`；
- 端口占用/权限不足会返回错误且**原监听保持不变**；改端口后会对已配对节点发送 `peer.listen` 通知，对端自动更新拨号端口；`config.json` 静态配置的对端需要你手动把其 peers 端口改成新值（日志会提示）。
- 防火墙例子：只放行 `48401` 时，把监听改成 `0.0.0.0:48401`，客户端配对时填 `你的公网IP:48401`。

### Web 面板

侧栏「远程节点」→ 主面板：

- **链路**：对端名称、online/offline、方向（in/out）、RTT、最近心跳、来源标签（配置/已配对）与删除；
- **配对**：本机配对令牌（显示/复制/轮换）、待审批配对请求（批准/拒绝）、顶栏「添加节点」；
- **会话**：两组（我发起·运行在对端 / 对端发起·运行在本机），点进详情可看转录、发 prompt（Ctrl/Cmd+Enter）、取消运行中回合；
- **交付物**：按链路列出，显示大小/版本/同步状态（metadata / fetching / synced / error），可「拉取」「下载」，图片内联预览。

### 模型工具 `remotenode`

| action | 参数 | 说明 |
|---|---|---|
| `list_peers` | — | 列出节点与链路状态 |
| `list_sessions` | — | 列出双向远程会话 |
| `start_session` | `peerNodeId`, `text` | 在对端建会话并发送首条 prompt（prompt 必须自包含） |
| `prompt` | `sessionId`, `text` | 给远程会话追加消息 |
| `cancel` | `sessionId` | 取消当前回合 |
| `transcript` | `sessionId`, `limit?` | 读取转录 |
| `deliverables` | — | 列出交付物清单与同步状态 |
| `publish` | `peerNodeId`, `path`, `description?` | 把本机文件发布给对端 |

### HTTP API（面板与脚本使用，同源、仅 loopback）

`GET /api/remotenode/state`、`POST /api/remotenode/session/{start,prompt,cancel}`、`GET /api/remotenode/session/transcript`、`POST /api/remotenode/artifact/fetch`、`GET /api/remotenode/artifact?key=`、`POST /api/remotenode/publish`、`POST /api/remotenode/refresh`、`GET /api/remotenode/ping`。字段契约见 [SPEC.md](SPEC.md) §7。

## 目录结构

```
plugins/remotenode/
├── package.json          # bundle 清单：dsh.bundle.patch + dsh.client(web)
├── cordis.patch.yml      # 插入 Host 行（id: remotenode）
├── index.js              # Host 装配：config/runtime/peer/session/deliverable/routes/tool
├── client.js             # Client 半端：sidebar.panellist + main keyed 面板（仅 require('react')）
├── lib/
│   ├── ids|errors|frames|handshake|dedupe|deliverable|oplog|sync-engine|store.js   # 协议核心 + 持久化
│   ├── peer-link.js      # TCP 长度前缀帧、JSON-RPC 双向、二进制 artifact 帧、握手接入、心跳
│   ├── peer-manager.js   # 监听/拨号/退避重连/连接去重/peer state
│   ├── session-bridge.js # sessionController 集成、事件投影/回传、attach 续传、来源标记记录
│   ├── deliverable-hub.js# present 捕获、op/sync 对账、CAS blob、artifact 分块传输
│   └── routes.js         # /api/remotenode/*
├── locale/{zh,en}.json   # 插件清单显示文案
├── icon.svg
├── tests/                # node:test（86 项）
└── scripts/              # 第二节点准备/运行/自检/e2e
```

## 运行时数据（默认 `$DSH_HOME/remotenode/`）

| 路径 | 内容 |
|---|---|
| `config.json` | 本节点身份、监听、peers、限额（600 权限，含 secret） |
| `data/outbound.json` | 我发起、运行在对端的会话记录 |
| `data/inbound.json` | 对端发起、运行在本机的会话记录 |
| `data/transcripts/*.jsonl` | 会话事件投影（断线/重启续传依据） |
| `data/deliverables/<linkId>.json` | 每链路同步引擎状态 + 字节来源索引 |
| `data/blobs/<artifactId>` | 内容寻址的交付物字节（sha256） |
| `workspace/` | 远程会话的工作目录（执行侧） |

## 协议子集（v1）

- **帧层**：TCP `[4B BE length][payload]`；payload 首字节 `{` 为 JSON-RPC 2.0 帧，否则为 `[4B BE headerLen][JSON header][bytes]` 二进制帧（仅 artifact.chunk）。
- **握手**：`peer.hello` / `peer.welcome`，每链路共享密钥 HMAC-SHA256 challenge/response（nonce 防重放）；nodeId 白名单；连接去重（较小 nodeId 发起的连接为规范连接）。
- **方法**：`peer.ping`、`peer.heartbeat`；`session.create|prompt|cancel|attach|list`、`event.session`、`session.state`；`deliverable.op|sync`；`artifact.fetch|end|chunk`（二进制）。
- **事件流**：把 DSH 会话的 `user/message`、`assistant/message`、`tool/call`、`tool/result`、`turn/*`、`step/*`、`deliverables/presented` 投影成紧凑 JSON 回传；断线重连用 `session.attach(fromSeq)` 从对端会话日志补历史。
- **交付物**：`present` 事件 → 计算 sha256 → `deliverable.op` upsert（版本递增）→ 对端 `handleOp`；缺口用 `deliverable.sync` 对账；字节走 `artifact.fetch` 分块 + sha256 校验 + CAS 落盘。

## 安全边界

- TCP 监听默认只绑 `127.0.0.1`；跨机部署请走内网/Tailscale 或在外层加 TLS（v1 未内置 TLS/mTLS，见限制）。
- 每链路一对共享密钥（`config.json` 600 权限）；握手证明防伪造/重放；未知 peer 直接拒绝。
- Web 面板走同源 `/api/remotenode/*`；`dsh web` 默认绑定 loopback，不要用 `0.0.0.0` 暴露该端口。
- 交付物按 sha256 内容寻址，落盘前校验；只同步 `present` 声明过的普通文件，超过 `maxDeliverableBytes` 拒绝；路径经过安全化（无穿越/控制字符）。
- 远程会话以节点自己的模型凭据运行（成本各算各的）；无人值守节点建议 danger-full-access，或 M2 接入审批转发。

## 已知限制（v1）

- 审批/提问**不跨节点转发**：对端会话以对端进程的审批策略运行（演示节点用 danger-full-access 无人值守）；
- 无流式 token：只回传持久化事件（assistant/message 等），面板不会逐字刷新；
- 无 TLS/mTLS 与配对码：仅共享密钥 + 明文 TCP（内网/Tailscale 场景）；
- `present` 自动发布只覆盖**远程会话**；本机普通会话的 `present` 不会自动同步（用 `publish` 工具/面板发布）；
- 版本历史只展示最新版；墓碑/删除同步、replica 只读镜像、断点续传窗口、queue/steer 的用户侧编辑、Windows 实机验证属于 M2+（见 [docs/08](../../docs/08-remotenode-plugin.zh.md)）；
- 递归深度限制未实现：远程节点上的会话也可以再调用 `remotenode` 工具（配置/提示词约束，未做协议级 depth）。

## 测试

```bash
cd /root/AiWork/DSH_Design/plugins/remotenode
/root/.nvm/versions/node/v22.22.1/bin/node --test tests/     # 86 项：ids/errors/frames/handshake/dedupe/deliverable/sync/store/peer
bash scripts/e2e.sh all                                      # 双实例端到端
bash scripts/e2e-pairing.sh                                  # UI 配对流程（临时第三实例，22 项）
bash scripts/e2e-listen.sh                                   # 监听端口变更流程（临时第三实例，39 项）
```

## 卸载

```bash
# 在 DSH 会话里：plugin_manager(action: remove_bundle, target: '@dsh-design/remotenode')
# 然后按需删除 $DSH_HOME/remotenode/（含 config 与 secret）
```
