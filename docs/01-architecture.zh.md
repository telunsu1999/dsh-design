# 01 · 架构与方案对比

本项目回答的问题：**能否让本机作为“大脑”，把任务委托给一台高性能 Windows 台式机节点？**

结论：**能，但需要用“ACP 远程子代理 + SSH 桥”组合实现；DSH 目前没有现成的多节点调度功能。**

以下引用均相对 DSH 源码仓库根（`/root/.openclaw/workspace/deepseek-harness`）。

## 1. 约束

| 约束 | 内容 |
|---|---|
| 大脑 | 本机 Linux 上的 `dsh web`：Web UI、模型调用、Session、插件宿主都留在这里 |
| worker | 用户自己的 **原生 Windows** 台式机，有强 GPU、ComfyUI、Blender |
| 委托粒度 | 按任务委托（生图、建模），而不是把整个会话的执行世界搬走 |
| 现状要求 | 不能破坏现有 Web 会话；最好无需重启大脑（或只需一次重启） |
| 成本 | 可接受每次委托使用独立模型上下文，但不想为琐事付费 |

## 2. DSH 现有原语盘点

### 2.1 SSH 远程执行世界（`packages/ssh/*`）

DSH 能把文件系统、进程、终端、沙箱、LSP 搬到一台远程 **POSIX** 主机，Harness/模型/Session 留在本机（`packages/ssh/README.md:12`、`docs/subsystems/ssh.md:5`）。

不适合本项目的四个硬伤：

1. **不支持 Windows 远端**：helper 发布目标只有 Linux/macOS x64/arm64，明确“不增加 Windows 或 musl 支持”（`.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.md`「Helper deployment」节；`packages/ssh/ssh-helper-runtime/README.md:95`）。
2. **一个 dsh 进程只有一个执行世界**：`ctx.fs`/`ctx.subprocess`/`ctx.sandbox` 是部署级单例，无法“本地日常 + 偶尔 GPU”按任务路由，也不能同进程并存两个世界。
3. **Web 组合不兼容**：Web 的工作区注册、新建会话 `mkdir`、`present` 打开、变更卡片仍走宿主 `node:fs`（`docs/subsystems/ssh.md:27`、`packages/workspace/workspace/src/paths.ts:52`、`packages/deliverables/tool-present/README.md:90`），把执行世界切到远端后这些功能会坏或在本机误建目录。
4. **无 artifact 回传设计**：大文件、图片回传要另行解决（`docs/subsystems/ssh.md` 的「Composition scope」/决策记录「Deferred work」）。

**结论：❌ 不作为主方案。** 若未来台式机改成 Linux 且只跑 headless CLI，可另议。

### 2.2 ACP 远程子代理（`packages/acp` + `packages/subagent/subagent-acp`）— 选定

- `dsh --profile acp` 是一个 ACP v1 服务端，用 **stdio 上的 ndJSON JSON-RPC** 暴露 session/prompt/权限/取消等能力（`docs/cli-help.md:85-96`、`packages/acp/README.md:12`）。
- `@deepseek-ai/dsh-subagent-acp` 是 ACP 客户端 backend：`command`/`args` 可配置为任意可执行文件，每次 run 起一个子进程（`packages/subagent/subagent-acp/README.md`「Configuration」；源码 `src/index.ts:81-116`）。
- 已知限制（官方 README 明确）：一任务一进程、无追问、只收集最终文本、权限自动应答、workspace 只支持本地路径（`packages/subagent/subagent-acp/README.md`「Known Limitations」）。

因此可以把 `command` 配成 `ssh`（或本项目提供的桥），让远端跑 `dsh --profile acp`——**机械上可行**，但官方明确“remote workspace mapping is not designed”。本项目补上了这块（见 §3.3）。

**结论：✅ 选定。** 它保留了“任务级委托”的正确粒度，且不影响大脑的其他会话。

### 2.3 MCP 远程工具（`packages/mcp/mcp-client`）

DSH 内置 MCP 客户端：支持 **stdio** 与 **streamable-http**，工具名 `mcp__<serverName>__<tool>`，图片结果会落盘为 attachment 并在 Web 工具卡内联显示（`packages/mcp/mcp-client/README.md:57`、`docs/subsystems/attachment.md`）。配置写在 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 或 `--patch`。

- 优点：大脑保留工具循环，单次调用延迟低；图片原生回传。
- 缺点：需要你在台式机常驻一个 MCP server（如 ComfyUI MCP），且它只暴露“工具”，不负责多步自主任务（例如“先建场景、再打灯、再渲染、再导出 GLB”）。

**结论：⭕ 可选补充/二期。** 本方案先用完整子代理；将来可加一个 `mcp__comfy__*` 直连通道做快速出图。

### 2.4 Agent Teams / Workflow

- Agent Teams 的 teammate 与 Lead 同进程、共享同一工作目录（`packages/experimental/agent-team-profile/README.md:106`），`spawn_teammate` 没有 driver/远程参数；teammate 还要求 `prepareContinuable`（可继续对话），ACP provider 不具备（`packages/subagent/subagent-acp/src/index.ts:81-86`）。
- Workflow 的 subagent provider 是全局配置，同样受“本地进程 + cwd”限制。

**结论：❌ 不能把 teammate 放到台式机。** 跨机协作用 §2.2 的子代理，本机内协作继续用 Agent Teams。

### 2.5 “把 dsh web 装到台式机 + 端口转发”

等于把大脑整体迁移到台式机：Web UI、密钥、Session 都过去，本机反而成了瘦客户端。不是“分布式”，而是换部署模型，且失去本机常驻能力。

**结论：❌ 不推荐。**

## 3. 选定方案详解

### 3.1 组件

| 组件 | 位置 | 职责 |
|---|---|---|
| `subagent_worker` 工具 | 大脑 | 模型可见的委托入口，调用 ACP provider |
| `@deepseek-ai/dsh-subagent-acp` | 大脑 | ACP 客户端：起进程、握手、发 prompt、收最终文本、应答权限 |
| `acp-ssh-bridge.mjs` | 大脑 | 转发 ACP 帧到 SSH；把 `session/new`/`session/resume` 的 cwd 改写为远端工作目录 |
| SSH（OpenSSH client） | 大脑 | 传输 + 认证边界 |
| OpenSSH Server | 台式机 | 接收连接、执行 `run-acp.cmd` |
| `dsh --profile acp` | 台式机 | worker 子代理本体（独立模型、独立工具） |
| `run-acp.cmd` | 台式机 | 设置 `DSH_HOME`/环境变量、切工作目录、启动 ACP 服务 |
| `AGENTS.md` | 台式机 `$DSH_HOME` | worker 行为约定（产物 JSON、无追问、安全） |
| `comfy.py` / `blender_job.py` | 台式机 | 生图/Blender 的确定性执行脚本 |
| `fetch-artifact.sh` | 大脑 | 把产物从台式机拉回本地 workspace |

### 3.2 一次委托的时序

```
用户 → 大脑模型: “生成一张……，用台式机”
大脑模型 → subagent_worker(prompt)
  subagent-acp → acp-ssh-bridge: spawn [node, bridge, --ssh, dsh-desktop, C:/dsh-worker/run-acp.cmd, C:/dsh-worker/workspace]
bridge → ssh -T dsh-desktop C:/dsh-worker/run-acp.cmd
台式机: run-acp.cmd → dsh --profile acp（等待 stdin 上的 ACP 帧）
bridge: 收到 session/new，params.cwd 改写为 C:/dsh-worker/workspace → 转发
worker: 创建会话，模型开始多步执行（pwsh / comfy.py / blender）
worker → ACP: agent_message_chunk（最终文本）
bridge → subagent-acp → 大脑模型: 完成通知 + 最终文本
大脑模型 → fetch-artifact.sh: scp 拉回 → present / read_image
```

### 3.3 两个关键点

**① cwd 映射（桥的核心价值）**

`subagent-acp` 在本地校验 cwd 是“绝对路径且可进入目录”（`packages/subagent/subagent/src/out-of-process.ts:104-112`），然后把这个路径原样作为 ACP `session/new` 的 `cwd` 发给服务端（`packages/subagent/subagent-acp/src/run.ts:492`）。远程 Windows 上不存在 `/root/AiWork/...` 这样的路径，会破坏 worker 的 working-directory / shell 默认目录。

桥在协议层做一次改写：`session/new`、`session/resume` 的 `params.cwd` → 固定的 `C:/dsh-worker/workspace`。远端进程的工作目录因此稳定、可写，与大脑当前项目解耦；大脑侧仍然通过 `subagent_worker` 工具的 `cwd` 参数满足本地校验（通常就是当前项目目录，实际不会被远端使用）。

**② 权限自动应答**

worker 的工具审批请求经 ACP 发回客户端；`subagent-acp` 用 `permission: allow` 自动选择 `allow_once`（`packages/subagent/subagent-acp/src/run.ts` 权限处理）。这是无人值守委托的必要条件，同时也意味着：**给大脑 SSH 访问权 ≈ 把台式机 worker 账户交给大脑**。安全建议见 §3.6。

### 3.4 结果协议（为什么是“文本 + 文件路径”）

ACP 客户端只收集最终 assistant 文本，图片/二进制不会过 ACP（`subagent/subagent-acp/src/run.ts:245-266`；README「Only committed agent_message_chunk text is collected」）。因此约定：

- worker 在最终回复里输出 `artifacts` JSON 代码块，列出**台式机绝对路径**（正斜杠）；
- 大脑用 `fetch-artifact.sh` 逐条拉回本地 `./out/`；
- 图片再 `read_image` / `present`，模型/视频用 `present`。

这避免了 base64 塞进文本（会超限、污染上下文、增加 token），也让大文件传输可重试、可断点。

### 3.5 网络拓扑（三选一）

| 方式 | 适用 | 做法 | 评价 |
|---|---|---|---|
| **Tailscale（推荐）** | 大脑是云服务器、台式机在家用 NAT 后 | 两端装 Tailscale，登录同一 tailnet；大脑用 `100.x.y.z` 或 MagicDNS 名作 SSH HostName | 免公网端口、WireGuard 加密、ACL 可控 |
| 反向 SSH 隧道 | 大脑无法主动连台式机、但台式机可出网 | 台式机开机任务执行 `ssh -N -R 22022:localhost:22 root@<大脑IP>`；大脑 `Host dsh-desktop / HostName 127.0.0.1 / Port 22022` | 免装 Tailscale，但要维持隧道与重连（autossh/计划任务） |
| 端口映射 | 家庭宽带有公网 IP | 路由器把 22 映射到台式机；大脑用公网地址 | 最不安全，**不建议**把 22 暴露公网；至少改端口 + fail2ban + 仅 key |

### 3.6 安全模型

- **信任边界 = SSH**：ACP 本身无认证（`packages/acp/README.md:12` 说明它是 trusted-program 协议），SSH key 就是授权。
- 台式机建议建 **专用低权本地账户**（如 `dshworker`），只授予 `C:\dsh-worker` 与 ComfyUI/Blender 所需权限；不要把管理员账户的 key 交给大脑。
- 大脑侧私钥权限 `600`，`~/.ssh/config` 固定 `IdentitiesOnly yes`、`BatchMode yes`。
- 如不需要 scp 拉产物，可在 `authorized_keys` 给该 key 加 `command="C:/dsh-worker/run-acp.cmd"` 强制命令（只允许启动 ACP，不允许任意 shell）；**需要 scp 时不要加**，或另配一把只读 key。
- 不要在 worker prompt 里传密钥；worker 的 key 只放它自己的 `$DSH_HOME\.env`。
- 提示注入：worker 的最终文本会进入大脑上下文；对“读取远程文件内容”类任务保持警惕，不要让它把不可信内容当指令执行。
- SSH 只绑 Tailscale/内网；Windows 防火墙只放行来源网段。

### 3.7 并发、超时与资源

- 每次委托 = 一个新 worker DSH 进程（启动约数秒）+ 一轮独立模型上下文。
- 大脑侧 `maxActiveSubagents` 默认 8（`packages/subagent/subagent/src/index.ts`），同时最多 8 个委托；受限的是 SSH/CPU，不是 GPU。
- ComfyUI 单实例**严格串行**（单 prompt worker 线程）；多个生图任务会在 ComfyUI 队列排队，`comfy.py` 默认 900s 超时、超时会尝试 cancel。
- Blender 可多进程，但建议一 GPU 一实例；本项目默认串行使用。
- ACP 没有 prompt 超时：长任务可持续；但 worker 进程在取消/EOF 时会被清理，台式机侧最好把超长任务写成可恢复的文件产物。
- **无重连**：SSH 断线 = 该次委托失败（结果可能未知）；重试即重新委托。

### 3.8 成本

- worker 是完整 DSH：`deepseek-flash` 一眼一任务上下文，约等于大脑再花一份 token；
- 一次 3D 任务可能 20–50 步工具调用，比把同样流程放大脑更贵，但省大脑上下文、可并行；
- 建议：把“重、长、可自包含”的任务交给 worker；简单问答留在大脑。

## 4. 为什么不用 SSH 执行世界（补充说明）

如果只用“远程壳/远程文件”而不要完整子代理，DSH 的 SSH provider 家族设计更干净，但它要求：两端都是 Linux/macOS、执行世界整进程替换、Web 组合另行适配、artifact 自管。这三条与本次“Windows 台式机 + 保留 Web 大脑 + 按任务路由”冲突，因此不作为主路线。未来若你愿意在台式机装 WSL2 并接受“整个会话都在远端”，可以另开一个 profile 试 `ssh` 家族（helper 需自行构建、无 Windows target）。

## 5. 演进路线

1. **上游化**：给 `subagent-acp` 增加 `remoteCwd`（或 `cwdMap`）配置，就不需要桥；可向上游提 PR。
2. **MCP 快通道**：台式机常驻 Streamable HTTP MCP（ComfyUI 单工具），大脑按 URL 挂载，图片直接回传；适合“快速出图”，与 ACP 委托并存。
3. **多 worker**：复制 provider/tool 行（不同 SSH 别名 / 不同 `toolName`），按任务类型路由（生图 vs 渲染 vs 视频）。
4. **常驻 worker**：当前每任务起进程；将来可让台式机常驻一个 ACP 连接池/任务队列（目前 subagent-acp 明确不做进程池）。
5. **产物服务**：台式机跑只读 artifact HTTP（Tailscale + token），大脑 `curl` 拉大文件，替代 scp。
