#!/usr/bin/env bash
# =============================================================================
# stop-node.sh — 幂等停止第二 DSH 节点（远程 worker 角色）
#
# 行为：
#   - 无 pid 文件 / 进程已退出 → 打印"未运行"并返回 0（可安全重复执行）；
#   - pid 有效且确为本节点 DSH web 进程 → SIGTERM 优雅退出，超时后 SIGKILL；
#   - pid 被复用/不属于本节点 → 拒绝杀进程，只清理陈旧 pid 文件；
#   - 日志文件保留不删除（/root/.dsh-node/dsh-web.log）。
# 用法：bash scripts/stop-node.sh
# =============================================================================
set -uo pipefail

# ---------- 常量 ----------
NODE_HOME=/root/.dsh-node
WEB_PORT=3081
LOG_FILE="${NODE_HOME}/dsh-web.log"
PID_FILE="${NODE_HOME}/dsh-web.pid"
TERM_TIMEOUT_SECONDS=20
KILL_TIMEOUT_SECONDS=5

log()  { printf '[stop-node] %s\n' "$*"; }
warn() { printf '[stop-node][警告] %s\n' "$*" >&2; }

pid_alive() {
  local pid="${1:-}"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null
}

pid_is_our_node() {
  local pid="${1:-}"
  pid_alive "$pid" || return 1
  local cmd
  cmd="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
  [[ "$cmd" == *"apps/cli/lib/bin.js"* ]] || return 1
  [[ "$cmd" == *" web "* ]] || return 1
  [[ "$cmd" == *"--port ${WEB_PORT}"* ]] || return 1
  grep -qzx "DSH_HOME=${NODE_HOME}" "/proc/${pid}/environ" 2>/dev/null || return 1
  return 0
}

# ---------- 1. 读取 pid ----------
if [ ! -f "$PID_FILE" ]; then
  log "第二 DSH 节点未运行（无 pid 文件 ${PID_FILE}），无需停止。"
  exit 0
fi
pid="$(tr -d '[:space:]' < "$PID_FILE" 2>/dev/null || true)"

if ! pid_alive "$pid"; then
  log "第二 DSH 节点未运行（pid ${pid:-?} 已退出），清理陈旧 pid 文件：${PID_FILE}"
  rm -f "$PID_FILE"
  exit 0
fi

if ! pid_is_our_node "$pid"; then
  warn "pid ${pid} 存活但不是本节点 DSH web 进程（可能 pid 被复用）；为避免误杀，不发送信号，只清理 pid 文件。"
  rm -f "$PID_FILE"
  exit 0
fi

# ---------- 2. 优雅停止 ----------
log "停止第二 DSH 节点：pid=${pid}（先 SIGTERM，最长等待 ${TERM_TIMEOUT_SECONDS}s）"
kill -TERM "$pid" 2>/dev/null || true

waited=0
while [ "$waited" -lt "$TERM_TIMEOUT_SECONDS" ] && pid_alive "$pid"; do
  sleep 1
  waited=$((waited + 1))
done

if pid_alive "$pid"; then
  warn "SIGTERM 后 ${TERM_TIMEOUT_SECONDS}s 仍未退出，发送 SIGKILL（pid=${pid}）"
  kill -KILL "$pid" 2>/dev/null || true
  waited=0
  while [ "$waited" -lt "$KILL_TIMEOUT_SECONDS" ] && pid_alive "$pid"; do
    sleep 1
    waited=$((waited + 1))
  done
fi

if pid_alive "$pid"; then
  warn "无法终止 pid=${pid}；pid 文件保留以便排查（日志：${LOG_FILE}）"
  exit 1
fi

# ---------- 3. 收尾 ----------
rm -f "$PID_FILE"
log "已停止（pid=${pid}），pid 文件已清理；日志保留：${LOG_FILE}"
if ss -ltnH "sport = :${WEB_PORT}" 2>/dev/null | grep -q .; then
  warn "端口 ${WEB_PORT} 仍有监听（可能其它进程占用）；可执行：ss -ltnp 'sport = :${WEB_PORT}'"
else
  log "端口 ${WEB_PORT} 已释放 ✓"
fi
exit 0
