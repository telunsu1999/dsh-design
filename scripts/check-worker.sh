#!/usr/bin/env bash
# check-worker.sh — 大脑节点自检：SSH 连通性、worker dsh、目录、ComfyUI、Blender、ACP 管道
#
# 用法：
#   DSH_WORKER_SSH=dsh-desktop ./check-worker.sh
#   ./check-worker.sh --host dsh-desktop
set -uo pipefail

HOST="${DSH_WORKER_SSH:-dsh-desktop}"
WORK_DIR="${DSH_WORKER_WORKSPACE:-C:/dsh-worker/workspace}"
RUN_ACP="${DSH_WORKER_ACP_CMD:-C:/dsh-worker/run-acp.cmd}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --workspace) WORK_DIR="$2"; shift 2 ;;
    --acp) RUN_ACP="$2"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=accept-new "$HOST")
PASS=0
FAIL=0

ok()   { echo "PASS  $*"; PASS=$((PASS + 1)); }
bad()  { echo "FAIL  $*"; FAIL=$((FAIL + 1)); }
warn() { echo "WARN  $*"; }

echo "== 1. SSH 连通性 ($HOST)"
if "${SSH[@]}" "cmd /c echo dsh-worker-ok" 2>/dev/null | grep -q dsh-worker-ok; then
  ok "ssh 可执行命令"
else
  bad "ssh 无法执行远程命令（检查 ~/.ssh/config、key、防火墙、Tailscale）"
fi

echo "== 2. worker dsh CLI"
if VERSION="$("${SSH[@]}" "dsh --version" 2>/dev/null)" && [[ -n "$VERSION" ]]; then
  ok "dsh --version = $VERSION"
elif VERSION="$("${SSH[@]}" "cmd /c \"%APPDATA%\\npm\\dsh.cmd --version\"" 2>/dev/null)"; then
  ok "dsh --version = $VERSION（绝对路径）"
else
  bad "远程找不到 dsh（npm i -g @deepseek-ai/dsh，或检查 PATH）"
fi

echo "== 3. worker 工作目录"
if "${SSH[@]}" "powershell -NoProfile -Command \"if (Test-Path '$WORK_DIR') { 'EXISTS' } else { 'MISSING' }\"" 2>/dev/null | grep -q EXISTS; then
  ok "工作目录存在: $WORK_DIR"
else
  bad "工作目录不存在: $WORK_DIR"
fi
if "${SSH[@]}" "powershell -NoProfile -Command \"try { Set-Content -Path '$WORK_DIR/_health.txt' -Value ok -ErrorAction Stop; Remove-Item '$WORK_DIR/_health.txt' -ErrorAction SilentlyContinue; 'WRITABLE' } catch { 'READONLY' }\"" 2>/dev/null | grep -q WRITABLE; then
  ok "工作目录可写"
else
  bad "工作目录不可写"
fi

echo "== 4. ComfyUI（worker 本机 HTTP）"
COMFY_URL="${COMFYUI_URL:-http://127.0.0.1:8188}"
if "${SSH[@]}" "powershell -NoProfile -Command \"try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 8 '$COMFY_URL/system_stats').StatusCode } catch { 'DOWN' }\"" 2>/dev/null | grep -q 200; then
  ok "ComfyUI 在线: $COMFY_URL"
else
  bad "ComfyUI 不可用: $COMFY_URL（生图任务会失败）"
fi

echo "== 5. Blender"
if "${SSH[@]}" "powershell -NoProfile -Command \"try { (Get-Command blender -ErrorAction Stop).Source } catch { 'NOT_IN_PATH' }\"" 2>/dev/null | grep -qv NOT_IN_PATH; then
  ok "blender 在 PATH 中"
elif "${SSH[@]}" "powershell -NoProfile -Command \"if (Test-Path 'C:\\Program Files\\Blender Foundation') { (Get-ChildItem 'C:\\Program Files\\Blender Foundation' -Directory | Select-Object -Last 1).FullName } else { 'MISSING' }\"" 2>/dev/null | grep -q 'Blender'; then
  warn "blender 不在 PATH，但检测到安装目录；请设置 run-acp.cmd 里的 BLENDER_EXE"
else
  bad "未检测到 Blender"
fi

echo "== 6. ACP stdio 管道（空输入应立即 EOF 退出）"
if printf '' | timeout 45 "${SSH[@]}" "$RUN_ACP" >/dev/null 2>/tmp/check-worker-acp.err; then
  ok "run-acp.cmd 可启动并正常退出"
else
  bad "run-acp.cmd 启动失败（stderr: $(tail -c 500 /tmp/check-worker-acp.err 2>/dev/null | tr '\n' ' ')）"
fi

echo
echo "结果：$PASS 通过，$FAIL 失败"
[[ "$FAIL" -eq 0 ]]
