<#
.SYNOPSIS
  在 Windows 台式机上安装 DSH worker 节点（创建目录、复制文件、安装 dsh CLI、首启生成 profile）。

.DESCRIPTION
  以管理员或普通用户运行均可；启用 OpenSSH Server 需要管理员。
  该脚本不会自动修改系统 PATH；node/npm 需预先安装（脚本会检查）。

.EXAMPLE
  .\setup-worker-windows.ps1 -ApiKey 'sk-...'
  .\setup-worker-windows.ps1 -InstallDir 'D:\dsh-worker' -ApiKey 'sk-...' -BlenderExe 'D:\Blender\blender.exe' -EnableSsh
#>
[CmdletBinding()]
param(
  [string]$InstallDir = 'C:\dsh-worker',
  [string]$ApiKey = '',
  [string]$ComfyUrl = 'http://127.0.0.1:8188',
  [string]$BlenderExe = '',
  [string]$DshVersion = '0.2.1-rc.2',
  [switch]$EnableSsh,
  [switch]$SkipDshInstall
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Text) { Write-Host "`n== $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host "   OK  $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "   !!  $Text" -ForegroundColor Yellow }

Write-Step '1. 检查 Node.js / npm'
$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $node -or -not $npm) {
  throw ' 未找到 node/npm。请先安装 Node.js 22.19+（https://nodejs.org 或 winget install OpenJS.NodeJS.LTS）后重跑本脚本。'
}
$nodeVersion = (& node --version).TrimStart('v')
Write-Ok "node $nodeVersion"
if ([version](($nodeVersion -replace '-.*$','')) -lt [version]'22.19.0') {
  throw "Node.js 版本过低：$nodeVersion，需要 >= 22.19"
}

Write-Step '2. 安装/检查 dsh CLI'
$dshCmd = Join-Path $env:APPDATA 'npm\dsh.cmd'
if (-not $SkipDshInstall -and -not (Test-Path $dshCmd)) {
  Write-Host "   npm install -g @deepseek-ai/dsh@$DshVersion"
  & npm install -g "@deepseek-ai/dsh@$DshVersion"
  if ($LASTEXITCODE -ne 0) { throw 'dsh CLI 安装失败' }
}
if (Test-Path $dshCmd) { Write-Ok "dsh: $dshCmd" } else { Write-Warn "未找到 $dshCmd（如已安装到其他位置可忽略）" }

Write-Step '3. 创建目录结构'
$dirs = @(
  $InstallDir,
  (Join-Path $InstallDir 'tools'),
  (Join-Path $InstallDir 'workflows'),
  (Join-Path $InstallDir 'workspace'),
  (Join-Path $InstallDir 'workspace\out'),
  (Join-Path $InstallDir 'workspace\tmp'),
  (Join-Path $InstallDir '.dsh'),
  (Join-Path $InstallDir '.dsh\skills')
)
foreach ($dir in $dirs) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
Write-Ok $InstallDir

Write-Step '4. 复制 worker 文件'
$source = Join-Path (Split-Path $PSScriptRoot -Parent) 'worker'
if (-not (Test-Path $source)) { throw "找不到源文件目录：$source（请在完整项目目录中运行本脚本）" }
Copy-Item -Force (Join-Path $source 'run-acp.cmd') (Join-Path $InstallDir 'run-acp.cmd')
Copy-Item -Force (Join-Path $source 'tools\*.py') (Join-Path $InstallDir 'tools\')
Copy-Item -Force (Join-Path $source 'workflows\README.md') (Join-Path $InstallDir 'workflows\README.md')
Copy-Item -Force (Join-Path $source 'README.md') (Join-Path $InstallDir 'README.md')
Copy-Item -Force (Join-Path $source 'AGENTS.md') (Join-Path $InstallDir '.dsh\AGENTS.md')
Write-Ok 'run-acp.cmd / tools / AGENTS.md'

# 按参数定制 run-acp.cmd
$runAcp = Join-Path $InstallDir 'run-acp.cmd'
$runText = Get-Content -Raw -Encoding UTF8 $runAcp
$runText = $runText -replace 'set "COMFYUI_URL=.*"', ('set "COMFYUI_URL=' + $ComfyUrl + '"')
if ($BlenderExe) {
  $runText = $runText -replace 'set "BLENDER_EXE=.*"', ('set "BLENDER_EXE=' + $BlenderExe + '"')
}
Set-Content -Path $runAcp -Value $runText -Encoding ASCII
Write-Ok "run-acp.cmd（COMFYUI_URL=$ComfyUrl）"

Write-Step '5. 写入 API key / profile 补丁'
$envFile = Join-Path $InstallDir '.dsh\.env'
if ($ApiKey) {
  "DEEPSEEK_API_KEY=$ApiKey" | Set-Content -Path $envFile -Encoding ASCII
  Write-Ok "$envFile"
} elseif (Test-Path $envFile) {
  Write-Ok '.env 已存在，保留'
} else {
  Write-Warn "未提供 -ApiKey；请手动写入 $envFile（DEEPSEEK_API_KEY=...）"
}

$profileDir = Join-Path $InstallDir '.dsh\profiles\acp'
if (-not (Test-Path (Join-Path $profileDir 'package.json'))) {
  Write-Host '   首次启动，生成 ACP profile（约 10 秒）...'
  $env:DSH_HOME = Join-Path $InstallDir '.dsh'
  $cmd = 'type nul | "' + $runAcp + '"'
  & cmd /c $cmd
  Write-Ok "profile: $profileDir"
}
$workerPatchSource = Join-Path (Split-Path $PSScriptRoot -Parent) 'config\worker-acp.patch.yml'
if (Test-Path $workerPatchSource) {
  $target = Join-Path $profileDir 'cordis.patch.yml'
  if (Test-Path $target) { Copy-Item -Force $target "$target.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" }
  Copy-Item -Force $workerPatchSource $target
  Write-Ok "profile 补丁: $target"
}

if ($EnableSsh) {
  Write-Step '6. 启用 OpenSSH Server'
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $isAdmin) { Write-Warn '需要管理员权限，跳过 OpenSSH 安装；请用管理员 PowerShell 重跑 -EnableSsh' }
  else {
    Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null
    Set-Service -Name sshd -StartupType Automatic
    Start-Service sshd
    if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
    }
    Write-Ok 'sshd 已启动'
  }
}

Write-Step '完成。剩余人工步骤'
$userProfile = $env:USERPROFILE
Write-Host @"
  1) 在大脑节点生成 key 并把公钥追加到本机：
       $userProfile\.ssh\authorized_keys
     并收紧 ACL（管理员 PowerShell）：
       icacls "$userProfile\.ssh\authorized_keys" /inheritance:r /grant "$env:USERNAME:F" /grant "SYSTEM:F"
  2) 确保本机与大脑网络互通（Tailscale / 反向 SSH 隧道 / 端口映射三选一）。
  3) 在大脑节点配置 ~/.ssh/config 别名 dsh-desktop，然后运行：
       ./scripts/check-worker.sh
  4) 把 ComfyUI 工作流按 API 格式导出到：
       $InstallDir\workflows\*.json
  5) 如需自定义 Blender 路径，编辑：
       $InstallDir\run-acp.cmd 里的 BLENDER_EXE
"@ -ForegroundColor Gray
