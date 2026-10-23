# 08 · Remote Node 插件模式实现（v1 / M1 切片）

> 状态：**已实现并通过双实例端到端验证**（2026-10-23）。
> 关联设计：[06 · Remote Node 总体设计](06-remotenode-design.zh.md) · [07 · 协议 v1 规格](07-remotenode-m0-protocol.zh.md)。
> 代码：[plugins/remotenode/](../plugins/remotenode/README.md)。

## 1. 与「刚才那版」的差别

上一版（已还原）是**独立参考实现**：零依赖 Node 库 + 确定性网络模拟器 + `node --test` 单测，只能证明协议/同步算法自洽，**没有接进 DSH**。

本版是**插件模式实现**：

| 维度 | 上一版（已还原） | 本版 |
|---|---|---|
| 形态 | 仓库外独立原型目录 | 可安装 DSH **bundle**（`dsh.bundle.patch` + `dsh.client`），Plugin Manager 可装卸 |
| 宿主体内 | 无 | Host 插件在 DSH 进程内：`ctx.sessionController` / `ctx.tools` / `ctx.webServer` / `ctx.on('session/event')` |
| 会话 | 未接 DSH | 真实 DSH 会话：对端建会话、prompt、cancel、事件回传、断线 attach |
| Web | 无 | 侧栏「远程节点」+ 主面板（链路/双向会话/转录/交付物/下载） |
| 模型工具 | 无 | `remotenode` 工具（8 个 action），模型可主动委托 |
| 传输 | 模拟网络 | 真实 TCP（JSON-RPC 帧 + 二进制 artifact 帧）、共享密钥握手、心跳、去重、重连 |
| 验证 | 单测 + 模拟 | 86 项单测 + **双 DSH 实例**真实端到端（双向会话 + 交付物 + 重启恢复） |

协议核心（ids/errors/frames/handshake/dedupe/deliverable/oplog/sync-engine）从上一版**移植**进 `plugins/remotenode/lib/`（仍由独立单测覆盖），其余（传输、DSH 集成、持久化、Web、工具、脚本）为本版新写。

## 2. 包结构（对照设计 06 §4.1）

设计建议的 in-tree 四包（protocol/core/web/tool）在本版中仍按**职责**拆在同一个 out-of-tree bundle 内（见 [README 目录结构](../plugins/remotenode/README.md#目录结构)）：

| 设计包 | 本版对应 |
|---|---|
| `dsh-remotenode-protocol` | `lib/{ids,errors,frames,handshake,dedupe,deliverable,oplog,sync-engine}.js` |
| `dsh-remotenode` (core) | `index.js` + `lib/{peer-link,peer-manager,session-bridge,deliverable-hub,store,routes}.js` |
| `dsh-remotenode-web` | `client.js` |
| `dsh-tool-remotenode` | `index.js` 内 `registerTools()`（同一个 bundle，避免多包安装） |
| `dsh-remotenode-app` (bundle) | `package.json` + `cordis.patch.yml` |

**这是对设计 06 §4.4「v1 先 in-tree」的有意偏离**：用户明确要求「走插件模式、不要动 DSH 源码」，因此用 out-of-tree bundle。代价与对策：

- 无 Typert 代码生成 → 浏览器↔Host 数据走**同源 HTTP `/api/remotenode/*`**（先例：已安装的 `dsh-memory` / `dsh-server-monitor` 同样做法），而不是 `@Remote` 流；
- 不新增中心包 → 面板是纯插件（`sidebar.panellist` + `main` keyed），与选定的设计 06 §8.1 方案 A 一致；
- 跨包只通过 Cordis service（`sessionController` / `tools` / `webServer` / `systemPrompt` / `sessions`）交互，不 import harness 包。

## 3. 已实现功能（对照 06 §13.1 M1 / 07 §15）

| 能力 | 状态 | 说明 |
|---|---|---|
| TCP 对等链路 + 共享密钥握手 + 心跳 + 去重 + 退避重连 | ✅ | `peer-link.js` / `peer-manager.js`；rtt 展示 |
| 双向创建/驱动远程会话（create/prompt/cancel/attach/list） | ✅ | 经 `ctx.sessionController`；两个方向都已实测 |
| 会话事件回传（回合/步骤/用户/助手/工具调用/工具结果/交付物） | ✅ | `session/event` → 紧凑投影 → `event.session`；attach 补历史 |
| 双向来源标记 + 持久化 | ✅ | `outbound.json` / `inbound.json` + 转录 jsonl；面板分组展示 |
| 断线/重启恢复 | ✅ | 重连自动 `session.attach(fromSeq)`；交付物引擎状态恢复；实测 3 个会话跨节点重启保持 |
| 交付物清单同步（present 捕获 → deliverable.op → 对账 sync） | ✅ | 版本递增、按链路命名空间隔离、op log + applied 水位对账 |
| 字节同步（artifact.fetch 分块 + sha256 + CAS） | ✅ | 图片自动拉取（`autoFetchImages` + `maxAutoFetchBytes`），其余按需 |
| 主动发布本机文件给对端 | ✅ | 工具/面板/HTTP `publish` |
| Web 面板（链路/双向会话/转录/发消息/取消/交付物/下载/预览） | ✅ | `client.js` 1800+ 行，纯 React + 主题 token |
| 模型工具 `remotenode`（8 action）+ 系统提示小节 | ✅ | 模型实测可 `list_peers` / `start_session` / `transcript` |
| 单测（协议/同步/存储/传输） | ✅ | 86/86 |
| 审批/提问跨节点转发 | ⏳ M2 | v1 对端按自己的审批策略运行（演示节点 danger-full-access） |
| 流式 token 回传 | ⏳ M2 | 只回传持久化事件 |
| TLS/mTLS、配对码、secret 轮换 | ⏳ M2/M3 | 当前共享密钥 + 明文 TCP（内网/Tailscale） |
| 墓碑/删除同步、replica、断点续传窗口 | ⏳ M2 | 引擎已支持 remove/版本保留，v1 UI/自动路径未接 |
| 本机普通会话 `present` 自动同步（双向 present 拦截） | ⏳ M2 | v1 远程会话 present 自动；本机用 publish |
| 递归 depth 限制、多对端压测、Windows 实机 | ⏳ M2/M3 | 代码支持多 peers，未压测；Windows 未验证 |

## 4. 端到端验收记录

环境：同一台机器两个独立 DSH 实例（同一 checkout、不同 `DSH_HOME`）：

| 角色 | DSH_HOME | Web | 对等监听 | nodeId |
|---|---|---|---|---|
| 大脑（当前 Web GUI） | `/root/.dsh` | 127.0.0.1:3080 | 47201 | `brain-linux` |
| 远程节点 | `/root/.dsh-node` | 127.0.0.1:3081 | 47301 | `desktop-node` |

最终汇总证据：`bash plugins/remotenode/scripts/e2e.sh all` → **16 PASS / 0 FAIL**（2026-10-23 20:11）；单测 `node --test tests/` → **86/86 PASS**。

分项证据（`bash plugins/remotenode/scripts/e2e.sh`）：

1. **链路**：两侧 `/state` 均显示对方 `online`（direction out/in、rtt 1–27ms），`ss -ltnp` 见 47201/47301 LISTEN；
2. **A→B 会话 + 交付物**（`e2e.sh forward`，6/6 PASS）：大脑发起远程会话，节点模型执行 `printf > out/demo.txt` 并 `present`；大脑侧收到清单，`artifact/fetch` + `GET /artifact` 下载 38 字节并校验内容；
3. **B→A 会话 + 交付物**（`e2e.sh reverse`，8/8 PASS）：节点在脑侧建会话（纯文本回复验证转录回传 `PONG-…`），再由节点 `publish` 本机文件给大脑，大脑拉取并校验字节；
4. **断链恢复**（`e2e.sh reconnect`，6/6 PASS）：停节点 → 大脑侧 offline → 重启 → online；3 个远程会话记录完整保留且无遗留 offline 状态；
5. **模型工具**：在当前会话中直接调用 `remotenode(list_peers)` / `start_session` / `transcript` 均成功（远程会话回复 `TOOL-OK-…` 可在转录中读到）；
6. **面板**：`cordis_inspect_query` 的 Client `Slots` 显示 `sidebar.panellist` 增加 `remotenode`(order 20)、`main` 增加 key `remotenode`，`active: true`（真实浏览器已热加载）；另用 Playwright + 真实 Chrome 对运行中的 3080 GUI 做了只读集成验证：面板真实渲染、真实链路/6 个会话/4 个交付物与 API 一致、真实转录加载、真实 artifact 下载字节一致（截图见 [docs/assets/remotenode-panel-list.png](assets/remotenode-panel-list.png) 与 [detail](assets/remotenode-panel-detail.png)）。面板按钮类变更动作（start/prompt/cancel/fetch/publish/refresh）在拦截的 SPEC §7 fixture 上逐一点击验证过请求与交互；
7. **安装形态**：`plugin_manager install_bundle` 返回 `application: applied`；Host 行经 HMR 模块替换生效（无需重启 dsh-web），`/api/remotenode/ping` 可用。

复现步骤见 [plugins/remotenode/README.md](../plugins/remotenode/README.md#安装) 与 `scripts/`。

## 5. 数据流（v1 实际路径）

**远程会话**（initiator=大脑，host=节点）：

```
大脑面板/工具 → POST /api/remotenode/session/start
  → SessionBridge.startRemoteSession(link) → session.create (RPC)
  → 节点 SessionBridge: ctx.sessionController.create({cwd=workspace})
      → sessionController.prompt(...) → 节点 Agent 运行
      → ctx.on('session/event') 投影 → event.session 通知 → 大脑落 transcript
      → ctx.on('api-session/status') → session.state → 大脑更新 running/idle
  → 断线重连：session.attach(fromSeq) → 节点从会话日志回放缺失事件
```

**交付物**（节点 present → 大脑）：

```
节点 Agent 调 present 工具 → 会话追加 deliverables/presented
  → 节点 DeliverableHub: stat/hash(stream) → engine.publish(artifactId,size,...)
  → deliverable.op 通知 → 大脑 engine.handleOp → 清单记录（metadata）
  → 图片且 ≤maxAutoFetchBytes：大脑 artifact.fetch → 节点二进制 chunk 流 → sha256 校验 → CAS
  → 面板 GET /api/remotenode/artifact?key=… → 下载/预览
  → 缺口：deliverable.sync {applied} ↔ {ops|snapshot} 对账
```

## 6. 关键实现说明

- **会话驱动**：不重造 Session，直接复用 `ctx.sessionController`（`create` / `prompt` / `cancel` / `inspect`）；因此远程会话在节点上是**普通 DSH 会话**（可被本地 UI/工具/持久化正常对待）。initiator 侧只保存投影副本来渲染面板与断线续传。
- **来源标记**：v1 落在插件存储（`outbound.json` / `inbound.json`），不改 `SessionHeader`/`SessionSummary` 中心结构（06 §5 的硬约束）；面板据此分组。会话正文里节点端 runtime context 会显示其 workspace，但不会显示“由谁发起”（M2 可加 system-prompt context）。
- **link 身份**：`linkId = <较小 nodeId>~<较大 nodeId>`（两侧一致），会话 key = `linkId:linkSessionId`；`linkSessionId` 由发起方铸造。
- **持久化**：outbound/inbound 记录 + transcript jsonl + 每链路 sync-engine `exportState()`；`store.js` 原子写、路径防护；CAS blob 落盘前校验 sha256。
- **HMR**：bundle 以 `link:` 形式安装，Host 代码改动通过 Plugin Manager 重组合触发模块替换（本轮实际用 `set_bundle` 触发，无需重启 3080）；Client 代码改动由 client-modules HMR 加载。
- **安全**：TCP 默认 loopback；共享密钥 HMAC；未知 nodeId 拒绝；`/api/remotenode/*` 依赖 loopback 与本机同源。

## 7. 已知问题 / 下一步（建议 M2 优先级）

1. **审批转发**（最高价值）：执行侧把 `approval/request` 经 link 转发给发起侧面板，先到先得 + fail-closed；解锁「节点以 ask 策略无人值守」。
2. **本机普通会话 `present` 自动同步**：监听本机 link 相关会话的 `deliverables/presented`，补齐双向交付物（现在远程会话自动、本机走 publish）。
3. **流式 token**：转发 `agent/assistant-stream` 帧（面板增量渲染）。
4. **版本/墓碑同步**：`engine.remove()` 已就绪，补 UI 与 `deliverable.op` 的 remove 路径。
5. **TLS/mTLS 或配对码**；多对端压测、大型 artifact 背压/断点续传。
6. **递归 depth**：在 `session.create` 参数里带 depth，超过上限拒绝（设计 06 §7.3）。
7. in-tree 化（若上游接纳）：按 06 §4.1 拆包 + Typert Remote，可去掉 HTTP 轮询、换流式面板。
