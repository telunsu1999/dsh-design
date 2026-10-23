# 05 · 验证记录（回环测试）

日期：2026-10-23
环境：本机 Linux（DSH 部署容器）、DSH `0.2.1-rc.2`、Node `v22.22.1`、pnpm `11.28.5`
方法：不依赖 Windows 台式机，用两个独立 `DSH_HOME` 在这台机器上模拟“大脑 + worker”，
验证 ACP provider、工具挂载、协议链路与 cwd 改写。

## 测试 A：ACP 子代理委托（无桥）

**目的**：确认 `@deepseek-ai/dsh-subagent-acp` + 第二个 `tool-subagent` 能挂进 headless 组合，
完成一次真实委托并回收最终文本。

**配置**（临时 profile `/tmp/dsh-test-brain`，headless + patch）：

```yaml
- insert:
    - id: subagent-acp-worker
      name: '@deepseek-ai/dsh-subagent-acp'
      config:
        providerName: acp-worker
        command: /root/.nvm/versions/node/v22.22.1/bin/node
        args:
          - /root/.openclaw/workspace/deepseek-harness/apps/cli/lib/bin.js
          - --profile
          - acp
        permission: allow
        env:
          DSH_HOME: /tmp/dsh-test-worker          # 独立 worker home
          DEEPSEEK_API_KEY: !!js process.env.DEEPSEEK_API_KEY
    - id: tool-subagent-worker
      name: '@deepseek-ai/dsh-tool-subagent'
      config: { provider: acp-worker, toolName: subagent_worker, maxDepth: provider-managed }
```

**执行**（大脑进程带 `DEEPSEEK_API_KEY`）：

```bash
cd /tmp/dsh-test-brain/worker
DSH_HOME=/tmp/dsh-test-brain node <repo>/apps/cli/lib/bin.js --profile headless \
  --patch /tmp/dsh-test-brain/worker.patch.yml \
  "使用 subagent_worker 工具委托 worker：让它用 shell 执行 echo worker-ok，并把原始输出报告回来。"
```

**结果**：✅ 通过。

- 工具成功启动 ACP 子进程并返回 child id；
- worker 最终文本包含原样输出 `worker-ok`；
- 观察到：worker 首次因本机没有 `workspace-write` 沙箱后端失败，随后以 `danger-full-access` 重试成功——
  该重试的审批请求由大脑侧 `permission: allow` 自动放行，证明无人值守审批链路可用。

## 测试 B：桥的 cwd 改写

**目的**：验证 `acp-ssh-bridge.mjs` 把大脑侧 cwd（`/tmp/dsh-test-brain/worker`）改写为
worker 的固定工作目录（`/tmp/dsh-test-worker/workspace`），否则远端会拿到不存在的路径。

**配置**：与 A 相同，但 command 换成桥的 `--local` 模式（本机模拟远程启动）：

```yaml
        command: /root/.nvm/versions/node/v22.22.1/bin/node
        args:
          - /root/AiWork/DSH_Design/scripts/acp-ssh-bridge.mjs
          - --local
          - "node <repo>/apps/cli/lib/bin.js --profile acp"
          - /tmp/dsh-test-worker/workspace
```

**执行**：让 worker 执行 `pwd; echo HELLO-FROM-WORKER`。

**结果**：✅ 通过。worker 原始输出：

```
/tmp/dsh-test-worker/workspace
HELLO-FROM-WORKER
```

即 cwd 被正确改写为 worker 侧目录（未被改写成大脑的 cwd）。

## 测试 C：ComfyUI 脚本（mock 服务）

**目的**：在没有 GPU 的环境验证 `worker/tools/comfy.py` 的提交/轮询/下载逻辑。

**方法**：写一个最小 mock ComfyUI（`POST /prompt`、`GET /history/<id>`、`GET /view`），
用包含 `{{prompt}}`/`{{seed}}` 的模板运行：

```bash
python3 worker/tools/comfy.py list --workflows-dir /tmp/comfy-test/workflows
python3 worker/tools/comfy.py run --workflows-dir /tmp/comfy-test/workflows \
  --prompt "a cat" --out /tmp/comfy-test/out --comfy-url http://127.0.0.1:18188 --timeout 20
```

**结果**：✅ 通过。输出 JSON 含 `prompt_id`、`images[].path`，PNG 落盘到 `out/`。

## 测试 D：生产 Web profile 安装与热加载

**目的**：验证安装脚本对真实 `dsh web` profile（`/root/.dsh/profiles/web`）的改动可被运行中的服务接受。

**执行**：

```bash
DSH_HOME=/root/.dsh PROFILE=web \
DSH_CLI='node /root/.openclaw/workspace/deepseek-harness/apps/cli/lib/bin.js' \
./scripts/install-brain-worker.sh
```

**结果**：✅ 通过。

- `dsh plugin add` 成功把 `@deepseek-ai/dsh-subagent-acp@0.2.1-rc.2` 装入 web profile；
- 补丁追加后 `--dump-config` 输出包含 `subagent-acp-worker` / `tool-subagent-worker`；
- 运行中的 Web 服务通过 HMR 应用补丁：**当前会话立即获得 `subagent_worker` 工具**，
  `remote-worker` skill 同时出现在技能目录（无需重启、无需新开会话）；
- 备份文件：`/root/.dsh/profiles/web/cordis.patch.yml.bak-20261023-151459`。

## 尚未验证（需要真实台式机）

| 项 | 风险 | 验证方法 |
|---|---|---|
| Windows 安装 `dsh --profile acp` | 平台差异、PowerShell/cmd 细节 | 台式机执行 `cmd /c "type nul | C:\dsh-worker\run-acp.cmd"`，exit 0 |
| SSH 到 Windows OpenSSH | 认证、ACL、防火墙、PATH | `check-worker.sh` 六项 |
| 桥的 `--ssh` 模式 | ssh 参数拼接、stdin EOF、编码 | 新会话委托 `echo` 任务 |
| scp 拉产物（Windows 路径） | 正斜杠/空格/SFTP 行为 | `fetch-artifact.sh` 拉一张图 |
| ComfyUI 真实 workflow | 模型名、节点结构、占位符 | 台式机本机先跑通再委托 |
| Blender 渲染 | 引擎/GPU/无头细节 | `blender_job.py run --script example_scene.py` |
| 长任务/断线 | 无重连、进程清理 | 人为断开 Tailscale 观察失败语义 |

## 如何不依赖台式机复现回环验证

```bash
# 1) 准备两个 HOME
mkdir -p /tmp/dsh-loop/{brain,worker,worker/workspace}

# 2) 给“大脑”装 ACP backend（临时 profile，不动生产 profile）
DSH_HOME=/tmp/dsh-loop/brain node <repo>/apps/cli/lib/bin.js \
  plugin --profile headless add @deepseek-ai/dsh-subagent-acp@0.2.1-rc.2

# 3) 写入测试 B 的 patch（把 <repo> 换成真实路径），然后运行：
cd /tmp/dsh-loop/worker
DEEPSEEK_API_KEY=sk-... DSH_HOME=/tmp/dsh-loop/brain \
  node <repo>/apps/cli/lib/bin.js --profile headless \
  --patch /tmp/dsh-loop/brain/bridge.patch.yml \
  "用 subagent_worker 让 worker 执行 pwd 并报告输出"
```

> 注意：会产生真实模型调用费用；仅用于验证链路。
