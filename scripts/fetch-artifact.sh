#!/usr/bin/env bash
# fetch-artifact.sh — 把台式机 worker 生成的文件拉回大脑节点工作区
#
# 用法：
#   fetch-artifact.sh <远端路径> [本地目录]
#   DSH_WORKER_SSH=my-alias fetch-artifact.sh 'C:/dsh-worker/workspace/out/a.png' ./out
#
# 说明：
#   - 远端路径必须告诉 scp 是 Windows 正斜杠路径（脚本会自动把反斜杠转成正斜杠）；
#   - 优先用 scp（SFTP），失败时回退到 ssh + PowerShell base64（适合单文件）；
#   - 成功时把本地绝对路径打印到 stdout（最后一行），其余诊断写 stderr。
set -euo pipefail

HOST="${DSH_WORKER_SSH:-dsh-desktop}"
REMOTE_PATH="${1:-}"
LOCAL_DIR="${2:-./out}"

if [[ -z "$REMOTE_PATH" ]]; then
  echo "usage: $0 <remote-path> [local-dir]" >&2
  exit 2
fi

# 统一为正斜杠，避免 Windows 反斜杠在 scp 里被当成转义
REMOTE_PATH="${REMOTE_PATH//\\//}"
LOCAL_DIR="${LOCAL_DIR%/}"
mkdir -p "$LOCAL_DIR"
LOCAL_DIR="$(cd "$LOCAL_DIR" && pwd)"
BASENAME="$(basename "$REMOTE_PATH")"
TARGET="$LOCAL_DIR/$BASENAME"

SCP_OPTS=(-q -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)

log() { echo "[fetch-artifact] $*" >&2; }

# 1) scp：文件或目录
if scp "${SCP_OPTS[@]}" -r "$HOST:$REMOTE_PATH" "$LOCAL_DIR/" 2>/dev/null; then
  log "scp ok: $TARGET"
  echo "$TARGET"
  exit 0
fi

log "scp failed; falling back to ssh + PowerShell base64 (single file only)"

# 2) 回退：PowerShell 读取字节并 base64
PS_PATH="${REMOTE_PATH//\'/\'\'}"   # PowerShell 单引号转义
if B64="$(ssh -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new "$HOST" \
  "powershell -NoProfile -NonInteractive -Command \"[Convert]::ToBase64String([IO.File]::ReadAllBytes('$PS_PATH'))\"" 2>/dev/null)"; then
  printf '%s' "$B64" | base64 -d > "$TARGET"
  log "ssh/base64 ok: $TARGET"
  echo "$TARGET"
  exit 0
fi

log "both scp and ssh/base64 failed for: $REMOTE_PATH"
log "check: ssh $HOST 'cmd /c ver' ; path uses forward slashes; file exists; key has read permission"
exit 1
