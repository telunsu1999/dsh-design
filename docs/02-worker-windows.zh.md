# 02 · 台式机 Worker 部署（原生 Windows）

目标：把一台 Windows 台式机变成 DSH worker 节点——大脑通过 SSH 启动 `dsh --profile acp`，
worker 在自己的机器上自主跑 ComfyUI / Blender，把产物写进 `C:\dsh-worker\workspace\out`。

> 全程无需 WSL。推荐 Windows 10/11 x64、专用本地账户、有线网络。

## 0. 前置条件

| 项 | 要求 | 检查 |
|---|---|---|
| 系统 | Windows 10/11 x64 | `winver` |
| Node.js | **≥ 22.19**（建议 22 LTS 或 24 LTS） | `node -v` |
| dsh CLI | 版本与大脑一致（本部署 `0.2.1-rc.2`） | `dsh --version` |
| GPU 驱动 | NVIDIA/AMD 最新驱动，`nvidia-smi` 正常 | `nvidia-smi` |
| ComfyUI | 已能本机 `http://127.0.0.1:8188` 出图 | 浏览器打开 |
| Blender | 已安装，知道 `blender.exe` 路径 | `& "C:\Program Files\...\blender.exe" --version` |
| 磁盘 | `C:\dsh-worker` 至少 20 GB（模型/产物另计） | — |
| 网络 | 大脑能访问台式机 22 端口（Tailscale 最省事） | 见 §6 |
| 账户 | 建议新建专用本地用户 `dshworker`（非管理员） | `net user` |

下文命令：台式机用 **PowerShell（管理员）**，大脑用 bash。

## 1. 安装 Node.js 与 dsh CLI

```powershell
winget install OpenJS.NodeJS.LTS
# 重开一个 PowerShell 让 PATH 生效
node -v                      # 必须 >= 22.19
npm install -g @deepseek-ai/dsh@0.2.1-rc.2
dsh --version
```

国内网络可先 `npm config set registry https://registry.npmmirror.com`。

## 2. 目录结构

```
C:\dsh-worker\
├─ run-acp.cmd
├─ tools\comfy.py, blender_job.py, example_scene.py
├─ workflows\*.json          # ComfyUI API 格式工作流
├─ workspace\
│  ├─ out\                   # 产物（大脑会 scp 拉取）
│  └─ tmp\
├─ .dsh\                     # DSH_HOME（不要和主用户的 ~/.dsh 混用）
│  ├─ .env                   # DEEPSEEK_API_KEY=...
│  ├─ AGENTS.md
│  └─ profiles\acp\cordis.patch.yml
└─ README.md
```

### 2.1 一键脚本（推荐）

把本项目的 `DSH_Design` 目录复制到台式机（例如 `C:\dsh-worker-src`），然后：

```powershell
cd C:\dsh-worker-src\scripts
.\setup-worker-windows.ps1 -ApiKey 'sk-...' -EnableSsh
```

脚本会：检查 Node → 安装 dsh → 建目录 → 复制 `worker\` 文件 → 写 `.env` → 首启生成 ACP profile → 写入 worker profile 补丁 → 可选启用 OpenSSH Server。

### 2.2 手动步骤（等价）

```powershell
# 建目录
New-Item -ItemType Directory -Force C:\dsh-worker\tools, C:\dsh-worker\workflows,
  C:\dsh-worker\workspace\out, C:\dsh-worker\workspace\tmp, C:\dsh-worker\.dsh | Out-Null

# 复制本项目 worker\ 下的文件
Copy-Item -Recurse -Force C:\dsh-worker-src\worker\* C:\dsh-worker\
Copy-Item -Force C:\dsh-worker-src\worker\AGENTS.md C:\dsh-worker\.dsh\AGENTS.md

# key
"DEEPSEEK_API_KEY=sk-..." | Set-Content C:\dsh-worker\.dsh\.env -Encoding ASCII

# 首启：生成 $DSH_HOME\profiles\acp（首次会自动创建，-EOF 立即退出）
cmd /c "type nul | C:\dsh-worker\run-acp.cmd"
```

首启后在 `C:\dsh-worker\.dsh\profiles\acp\` 会出现 `package.json`、`cordis.yml`、`cordis.patch.yml`。
把 [config/worker-acp.patch.yml](../config/worker-acp.patch.yml) 复制为 `cordis.patch.yml`（覆盖前先备份）。

> `dsh --profile acp` 的 shipped 组合已经包含：Windows 下的 `pwsh` 工具（bash 自动禁用）、
> 文件/搜索/jobs/skill 工具、`deepseek-official` 默认模型。补丁只用于改模型或加 MCP。

## 3. 配置 `run-acp.cmd`

文件已由脚本复制。按需改三处：

```bat
set "DSH_HOME=C:\dsh-worker\.dsh"
set "COMFYUI_URL=http://127.0.0.1:8188"
set "BLENDER_EXE=C:\Program Files\Blender Foundation\Blender 4.5\blender.exe"
```

注意：

- **stdout 是 ACP 协议通道**：不要在这个脚本里 `echo` 任何内容，否则协议帧会被污染；
- 脚本要能被 SSH 以非交互方式执行：使用绝对路径、不要依赖用户级 PATH 之外的东西；
- `call "%APPDATA%\npm\dsh.cmd" --profile acp` 是核心命令，其余都是环境变量。

本机自测（应正常退出、无输出）：

```powershell
cmd /c "type nul | C:\dsh-worker\run-acp.cmd"
echo "exit=$LASTEXITCODE"   # 期望 0
```

## 4. 配置 worker 的模型与可选 MCP

- 默认模型由 ACP profile 决定（`deepseek-official` / `deepseek-v4-flash`）。若想与大脑一致：
  编辑 `C:\dsh-worker\.dsh\profiles\acp\cordis.patch.yml`（模板见 `config/worker-acp.patch.yml`）：

  ```yaml
  - id: acp
    config:
      provider: deepseek-official
      model: deepseek-flash
  ```

- 可选：给 worker 挂本机 MCP server（例如 ComfyUI MCP）。注意 server 的 stdout 必须只输出 MCP 协议帧，日志必须走 stderr。模板见 `config/worker-acp.patch.yml` 注释。

改完 profile 后不用重启（每次委托都会起新进程、重读配置）。

## 5. OpenSSH Server（台式机）

```powershell
# 管理员 PowerShell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
Get-Service sshd
Get-NetTCPConnection -LocalPort 22 -State Listen
# 防火墙（通常安装时已自动建规则）
Get-NetFirewallRule -Name OpenSSH-Server-In-TCP
```

### 5.1 专用账户（推荐）

```powershell
net user dshworker "一个强密码" /add
# 可选：允许远程桌面登录（一般不需要）
# 不建议加入 Administrators
```

用 `dshworker` 账户登录一次，确保 `C:\Users\dshworker` 存在，并让它能访问 ComfyUI/Blender 与 `C:\dsh-worker`（若目录在 C 盘公共位置，默认可读；需要写 `C:\dsh-worker` 时给 Modify 权限）。

### 5.2 大脑公钥

在大脑上：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/dsh_worker -N '' -C 'dsh-brain-worker'
cat ~/.ssh/dsh_worker.pub
```

在台式机（用 `dshworker` 登录后）：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.ssh" | Out-Null
# 把公钥内容粘贴进去（一行）
Add-Content -Path "$env:USERPROFILE\.ssh\authorized_keys" -Value 'ssh-ed25519 AAAA... dsh-brain-worker'
icacls "$env:USERPROFILE\.ssh\authorized_keys" /inheritance:r /grant "$env:USERNAME:F" /grant "SYSTEM:F"
```

### 5.3 安全选项

- 只在内网/Tailscale 暴露 22；不要做公网端口映射（若必须：改非标准端口 + 仅 key + 防火墙限源 IP）。
- 不需要 scp 拉产物时，可在 `authorized_keys` 行首加
  `command="C:/dsh-worker/run-acp.cmd",no-port-forwarding,no-agent-forwarding,no-X11-forwarding`
  强制该 key 只能启动 ACP。**注意：需要 scp 时不要加**（scp/sftp 会被强制命令挡住），或另配只读 key。
- `dshworker` 不应是管理员，不应能读其他用户目录。

## 6. 网络：让大脑连上台式机

### 6.1 Tailscale（推荐，大脑是云服务器时最稳）

```powershell
# 台式机
winget install Tailscale.Tailscale
tailscale up          # 浏览器登录同一账号
tailscale ip -4       # 记下 100.x.y.z
```

大脑（若可安装 Tailscale）：

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4
ping -c1 <台式机的100.x地址>
```

### 6.2 反向 SSH 隧道（大脑连不到台式机时）

台式机（管理员计划任务，开机执行）：

```powershell
ssh -N -R 22022:localhost:22 root@<大脑公网IP>
# 建议用 autossh 或 schtasks 定时保活；需要大脑 sshd 允许 root 登录或换专用账号
```

大脑 `~/.ssh/config` 指向本机 22022。

### 6.3 大脑 `~/.ssh/config`

```
Host dsh-desktop
  HostName 100.x.y.z          # 或 127.0.0.1 + Port 22022（反向隧道）
  User dshworker
  IdentityFile ~/.ssh/dsh_worker
  IdentitiesOnly yes
  BatchMode yes
  StrictHostKeyChecking accept-new
  ServerAliveInterval 30
  ServerAliveCountMax 4
  ConnectTimeout 15
```

测试：

```bash
ssh dsh-desktop "cmd /c echo dsh-worker-ok"
ssh dsh-desktop "dsh --version"
```

## 7. ComfyUI 与 Blender

### 7.1 ComfyUI

1. 启动 ComfyUI：`python main.py --listen 127.0.0.1 --port 8188`（或 ComfyUI Desktop）；
2. 在界面里准备一个能出图的工作流 → 菜单导出 **API 格式** JSON；
3. 保存到 `C:\dsh-worker\workflows\default.json`（详见 `worker\workflows\README.md`）；
4. 确认模板里有 `{{prompt}}` / `{{seed}}` 占位符（`comfy.py` 会替换）；
5. 本机自测：

```powershell
cd C:\dsh-worker
python tools\comfy.py list
python tools\comfy.py run --workflow default --prompt "一只戴宇航头盔的柴犬" --out C:\dsh-worker\workspace\out
```

成功会输出 JSON（含 `images[].path`），并把 PNG 下载到 `out\`。

### 7.2 Blender

1. 记下 `blender.exe` 路径，写进 `run-acp.cmd` 的 `BLENDER_EXE`；
2. 自测：

```powershell
cd C:\dsh-worker
python tools\blender_job.py run --script tools\example_scene.py --out C:\dsh-worker\workspace\out
```

成功会生成 `blender-demo.png`、`blender-demo.glb`、`blender-demo.blend`。
渲染默认 Cycles；Eevee 在无显示环境可能黑屏，不推荐。

## 8. 从大脑验证端到端

```bash
cd /root/AiWork/DSH_Design
./scripts/check-worker.sh          # 6 项：SSH/dsh/目录/ComfyUI/Blender/ACP 管道

# 单独验证 ACP 进程能被 SSH 拉起（空输入应立即退出）
printf '' | ssh -o BatchMode=yes dsh-desktop 'C:/dsh-worker/run-acp.cmd'; echo "exit=$?"
```

然后在大脑**新开一个会话**（见 `docs/03-brain-setup.zh.md`），说：

> 用 subagent_worker 让台式机执行：`pwd; echo hello-from-worker`，把原始输出报告回来。

成功后再试生图与 Blender，最后用 `fetch-artifact.sh` 拉回产物。

## 9. 可选：开机自启

- **ComfyUI**：用“任务计划程序”在用户登录时启动（或 ComfyUI Desktop 自带设置）。
- **worker DSH 本身不需要常驻**：每次委托由 SSH 拉起 `run-acp.cmd`，任务结束进程退出。
- 若用反向隧道：把隧道命令注册为“计算机启动时”任务，并勾选失败重启。

## 10. 卸载 / 回滚

```powershell
# 台式机
Remove-Item -Recurse -Force C:\dsh-worker
Remove-Item -Recurse -Force "$env:USERPROFILE\.ssh\authorized_keys"   # 或删掉对应公钥行
npm uninstall -g @deepseek-ai/dsh
Set-Service sshd -StartupType Manual; Stop-Service sshd
# 选项：移除 OpenSSH 能力
# Remove-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Stop-Task -TaskName <反向隧道/ComfyUI 自启任务> 2>$null
```

大脑侧回滚见 `docs/03-brain-setup.zh.md` §6。

## 11. 安全复核清单

- [ ] `dshworker` 是普通用户，不是管理员；
- [ ] 22 端口未暴露公网（或仅 Tailscale 网段）；
- [ ] 大脑私钥 `chmod 600`，未提交到 Git；
- [ ] `authorized_keys` 权限仅该用户 + SYSTEM；
- [ ] worker `.env` 只含它自己的 key，权限收紧；
- [ ] ComfyUI 只监听 `127.0.0.1`；
- [ ] 了解 `permission: allow` 的含义：worker 的工具审批会被自动批准。
