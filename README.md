# DSH 分布式 Worker：大脑节点 + 高性能台式机

> 📦 代码仓库（公开）：<https://github.com/telunsu1999/dsh-design> —— 含 Remote Node 插件、设计文档与验收记录。

> 目标：本机（Linux 服务器）继续充当 **大脑**——模型调用、Web UI、会话与编排都在这里；把家里性能更强的 **Windows 台式机** 作为 **worker 节点**，由大脑按任务委托生图（ComfyUI）、Blender 建模/渲染等重型任务。
>
> **✅ 插件模式实现（2026-10-23，v2 对等模型）**：**Remote Node 远程节点插件**已按设计 [docs/06](docs/06-remotenode-design.zh.md) / [docs/07](docs/07-remotenode-m0-protocol.zh.md) 实现为**可安装 DSH bundle**（Host + Client 半端，不改 DSH 源码、不写补丁脚本），并通过**双 DSH 实例真实端到端验证**：双向建远程会话、事件回传、断线续传、双向交付物同步、Web「远程节点」面板、模型工具 `remotenode`。用法见 [plugins/remotenode/README.md](plugins/remotenode/README.md)，实现与验收记录见 [docs/08](docs/08-remotenode-plugin.zh.md)。
>
> 下方 ACP + SSH 方案是更早的「一次性委托」实现（已可用但非插件模式），作为非 DSH agent / 无插件场景的备选保留。

## 插件模式（当前推荐）

```bash
# 1) 安装 bundle 到当前 web profile
#    本机：plugin_manager(action: install_bundle, target: /root/AiWork/DSH_Design/plugins/remotenode)
#    其他机器（从 GitHub）：
#      dsh plugin --profile web add "github:telunsu1999/dsh-design#path:/plugins/remotenode"
#      然后在插件管理里启用 @dsh-design/remotenode（或把 "@dsh-design/remotenode" 加进
#      ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles，重启 dsh web）
# 2) 配 $DSH_HOME/remotenode/config.json（nodeId / listen / peers / secret）
# 3) 第二节点：bash plugins/remotenode/scripts/setup-node-profile.sh
#      然后 bash plugins/remotenode/scripts/run-node.sh
# 4) 自检：bash plugins/remotenode/scripts/e2e.sh all
# 5) 打开 Web GUI → 侧栏「远程节点」
```

- 设计：[docs/06](docs/06-remotenode-design.zh.md)（总体）· [docs/07](docs/07-remotenode-m0-protocol.zh.md)（协议 v1）
- 实现：[plugins/remotenode/](plugins/remotenode/README.md)（含 SPEC.md 接口契约、scripts、tests）
- 验收：[docs/08-remotenode-plugin.zh.md](docs/08-remotenode-plugin.zh.md)

## 直接回答：DSH 有没有分布式方案？

**有原语，没有开箱即用的“多节点集群/调度器”。** DSH 0.2.1-rc.2 里有三块相关能力：

| 原语 | 能力 | 对本需求的结论 |
|---|---|---|
| **SSH 远程执行世界**（`packages/ssh/*`） | 把文件/进程/终端/沙箱/LSP 整个搬到远程 Linux/macOS 主机，模型与会话留在本机 | ❌ 不支持 Windows 远端；整进程一个执行世界，无法“本地日常 + 偶尔 GPU”按任务路由；Web 工作区 API 仍假设宿主文件系统，会坏 |
| **ACP 远程子代理**（`packages/acp` + `packages/subagent/subagent-acp`） | 每次委托在子进程里启动一个完整的 ACP agent，通过 stdio JSON-RPC 交互 | ✅ **选定路线**：把 command 包装成 SSH + 远端 `dsh --profile acp`，即可让台式机跑一个独立 DSH 子代理 |
| **MCP 扩展**（`packages/mcp/mcp-client`） | 给大脑挂远程工具（stdio / Streamable HTTP），工具结果可回传图片附件 | ⭕ 可选补充：想“大脑直接调 ComfyUI 单工具”时再上；本方案先用完整子代理 |
| Agent Teams / Workflow | 同进程多 agent 协作 / 编排 | ❌ 不能跨机器（teammate 强制本地、共享同一文件系统） |

所以：**“大脑 + 台式机子节点，按任务委托”可以实现，但不是官方成品，而是一套组合方案。** 本项目提供经过本机回环验证的完整实现：ACP 协议桥 + 配置 + worker 脚本 + 部署文档。

## 架构

```
┌─────────────────── 大脑节点（本机 Linux，现有 dsh web）───────────────────┐
│  Web UI / 模型调用 / Session 持久化 / 工具编排                             │
│    └─ 模型调用 subagent_worker（新增工具）                                 │
│         └─ @deepseek-ai/dsh-subagent-acp（ACP 客户端 backend）             │
│              └─ acp-ssh-bridge.mjs ── 改写 session cwd + 透明转发协议       │
└───────────────────────────────┬────────────────────────────────────────────┘
                                │  SSH stdio（ACP v1 / ndJSON）
┌───────────────────────────────┴────────────────────────────────────────────┐
│  台式机 worker 节点（Windows，独立 DSH 进程，每次任务一个）                 │
│    dsh --profile acp                                                       │
│      ├─ pwsh / 文件工具 / skill / jobs                                     │
│      ├─ ComfyUI HTTP API（127.0.0.1:8188）→ PNG                            │
│      └─ blender --background → GLB / 渲染图                                │
│    工作目录 C:\dsh-worker\workspace，产物写 out\                            │
└────────────────────────────────────────────────────────────────────────────┘
             产物回传：大脑 scp 拉回本地 workspace → read_image / present
```

一次委托的数据流：

1. 大脑模型调用 `subagent_worker`，prompt 是自包含任务（worker 看不到当前会话）。
2. `subagent-acp` 启动桥进程 → 桥通过 `ssh -T` 启动台式机 `run-acp.cmd`。
3. worker 的 DSH 以 ACP server 模式启动，`session/new` 的 cwd 被桥改写成 `C:/dsh-worker/workspace`。
4. worker 模型自主执行多步任务：跑 ComfyUI 脚本、Blender、读写文件。
5. worker 把结果写成最终文本（含 `artifacts` JSON 路径清单）返回；ACP 只回文本，不回二进制。
6. 大脑用 `fetch-artifact.sh` 把文件 scp 回本地，再 `present` / `read_image` 给用户看。

## 已验证 / 未验证

已在**本机回环**（大脑与“worker”同一台 Linux，worker 用独立 `DSH_HOME` 的 `dsh --profile acp` 模拟）验证：

- ✅ `subagent-acp` provider + `subagent_worker` 工具挂载、ACP 握手、任务下发与结果回收；
- ✅ 桥对 `session/new` 的 cwd 改写（worker 里 `pwd` 输出 `.../workspace`，而不是大脑目录）；
- ✅ 工具审批经 ACP `permission: allow` 自动放行，worker 能在无人值守下完成 bash 任务；
- ✅ 生产 `web` profile 安装 + HMR 热加载（`subagent_worker` 已出现在运行中的 Web 会话，`remote-worker` skill 自动发现）。

尚未在真实环境验证（需要你的台式机）：

- ⏳ Windows 上 `dsh --profile acp` 的安装/运行细节；
- ⏳ SSH 到 Windows OpenSSH 的链路、`scp` 路径语义；
- ⏳ ComfyUI 实际 workflow 与 Blender 渲染；
- ⏳ 长任务（>5 分钟）与异常恢复。

验证证据与复现步骤见 [docs/05-verification.zh.md](docs/05-verification.zh.md)。

## 快速开始

**台式机（Windows，管理员 PowerShell）**

```powershell
# 1) 安装 Node 22.19+ 与 dsh CLI
winget install OpenJS.NodeJS.LTS
npm install -g @deepseek-ai/dsh@0.2.1-rc.2

# 2) 把本项目 worker\ 目录准备好后执行（会创建 C:\dsh-worker、写入 ACP profile）
cd <本项目>\scripts
.\setup-worker-windows.ps1 -ApiKey 'sk-...' -EnableSsh

# 3) 把大脑节点的公钥追加到 C:\Users\<用户>\.ssh\authorized_keys
#    并保证 22 端口可从大脑访问（推荐 Tailscale）
```

**大脑节点（本机）**

```bash
# 1) 安装 provider/tool 补丁 + skill（幂等，会自动备份 patch）
DSH_HOME=/root/.dsh PROFILE=web \
DSH_CLI='node /root/.openclaw/workspace/deepseek-harness/apps/cli/lib/bin.js' \
./scripts/install-brain-worker.sh

# 2) 配置 ~/.ssh/config 别名 dsh-desktop 后自检
./scripts/check-worker.sh

# 3) 新开一个会话（当前会话的工具列表已固定），然后说：
#    “用 subagent_worker 让台式机生成一张 1024x1024 的图，然后把结果拉回来展示”
```

## 文件索引

| 路径 | 作用 |
|---|---|
| [docs/01-architecture.zh.md](docs/01-architecture.zh.md) | 方案对比、为何选 ACP、桥与 cwd 设计、网络/安全/成本 |
| [docs/02-worker-windows.zh.md](docs/02-worker-windows.zh.md) | 台式机 Windows 部署步骤（含 ComfyUI/Blender/SSH/Tailscale） |
| [docs/03-brain-setup.zh.md](docs/03-brain-setup.zh.md) | 大脑节点接入、验证、使用与回滚 |
| [docs/04-operations.zh.md](docs/04-operations.zh.md) | 排障手册、限制清单、安全边界 |
| [docs/05-verification.zh.md](docs/05-verification.zh.md) | 回环验证记录与复现方法 |
| [docs/06-remotenode-design.zh.md](docs/06-remotenode-design.zh.md) | **新**：Remote Node（对等远程节点）模式设计：对等 peer 协议、双向来源标记、remotenode 页签、双向交付物同步、实施路线与待拍板决策 |
| [docs/07-remotenode-m0-protocol.zh.md](docs/07-remotenode-m0-protocol.zh.md) | **M0 细化**：协议 v1 帧/方法/错误码、交付物同步对账算法、存储格式、状态机、测试向量、M1 WBS 与验收 |
| [plugins/remotenode/README.md](plugins/remotenode/README.md) | **插件模式实现**：Remote Node bundle（Host+Client）、安装/配置/使用/限制 |
| [plugins/remotenode/SPEC.md](plugins/remotenode/SPEC.md) | 插件实现接口契约（lib API、HTTP API、协议方法、数据格式） |
| [docs/08-remotenode-plugin.zh.md](docs/08-remotenode-plugin.zh.md) | 插件模式实现说明与双实例端到端验收记录 |
| [config/brain-worker.patch.yml](config/brain-worker.patch.yml) | （旧 ACP 方案）大脑 profile 补丁片段（provider + 工具） |
| [config/worker-acp.patch.yml](config/worker-acp.patch.yml) | worker ACP profile 补丁（模型/MCP 可选） |
| [config/remote-worker.SKILL.md](config/remote-worker.SKILL.md) | 大脑侧 skill：教模型何时/如何委托、如何拉产物 |
| [scripts/acp-ssh-bridge.mjs](scripts/acp-ssh-bridge.mjs) | ACP-over-SSH 桥（cwd 改写 + 双向转发，无依赖） |
| [scripts/install-brain-worker.sh](scripts/install-brain-worker.sh) | 大脑一键安装（幂等） |
| [scripts/check-worker.sh](scripts/check-worker.sh) | 大脑↔worker 六项自检 |
| [scripts/fetch-artifact.sh](scripts/fetch-artifact.sh) | 从 worker 拉取产物（scp + base64 回退） |
| [scripts/setup-worker-windows.ps1](scripts/setup-worker-windows.ps1) | 台式机一键准备（目录/客户端/首启/profile/OpenSSH） |
| [worker/run-acp.cmd](worker/run-acp.cmd) | 台式机 SSH 启动入口 |
| [worker/AGENTS.md](worker/AGENTS.md) | worker 行为约定（产物 JSON、无追问、安全） |
| [worker/tools/comfy.py](worker/tools/comfy.py) | ComfyUI 提交/轮询/下载（仅标准库） |
| [worker/tools/blender_job.py](worker/tools/blender_job.py) | Blender 无界面任务包装器 |
| [worker/tools/example_scene.py](worker/tools/example_scene.py) | 示例 bpy 脚本（渲染 + GLB 导出） |

## 成本与安全（摘要）

- **成本**：worker 是完整 DSH，用自己的 DeepSeek key、独立上下文；每次委托 ≈ 两份模型计费。适合“重任务”，不适合把琐碎步骤都推过去。
- **安全**：大脑上的 SSH 私钥等价于台式机 worker 账户的远程执行权；建议专用低权 Windows 账户、只在内网/Tailscale 暴露 SSH、不要 `0.0.0.0` 暴露 22 端口、worker 产物目录独立。
- **权限**：大脑侧 ACP `permission: allow` 会自动批准 worker 的工具审批请求（无人值守所需）；若想更严格，可改 `reject` 并预先在 worker 允许必要工具，但会显著降低可用性。
- **限制**：一次委托一个独立进程、无追问/续聊、只回最终文本（二进制另走 scp）、SSH 断线不重连、ComfyUI 单实例串行。

更完整清单见 [docs/04-operations.zh.md](docs/04-operations.zh.md)。
