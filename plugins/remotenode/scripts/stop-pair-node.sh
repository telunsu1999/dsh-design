#!/usr/bin/env bash
# =============================================================================
# stop-pair-node.sh — 配对测试节点（DSH_HOME=/tmp/.dsh-pair-node）的停止/状态
#
# 用法：
#   bash scripts/stop-pair-node.sh            # 停止（幂等；只杀该实例，保留日志）
#   bash scripts/stop-pair-node.sh status     # 打印进程/端口/HTTP 状态（健康返回 0，否则 1）
#   bash scripts/stop-pair-node.sh --help
#
# 安全：仅当 pid 的 cmdline 含 apps/cli/lib/bin.js web --port 3082 且
#       /proc/<pid>/environ 中 DSH_HOME=/tmp/.dsh-pair-node 时才发送信号。
# =============================================================================
set -uo pipefail

NODE_BIN=/root/.nvm/versions/node/v22.22.1/bin/node
PAIR_HOME=/tmp/.dsh-pair-node
WEB_HOST=127.0.0.1
WEB_PORT=3082
PEER_PORT=47401
LOG_FILE="${PAIR_HOME}/dsh-web.log"
PID_FILE="${PAIR_HOME}/dsh-web.pid"
PING_URL="http://${WEB_HOST}:${WEB_PORT}/api/remotenode/ping"
STATE_URL="http://${WEB_HOST}:${WEB_PORT}/api/remotenode/state"
TERM_TIMEOUT_SECONDS=20
KILL_TIMEOUT_SECONDS=5

log()  { printf '[pair-node] %s\n' "$*"; }
warn() { printf '[pair-node][警告] %s\n' "$*" >&2; }

ACTION="${1:-stop}"
case "$ACTION" in
  stop|status|--help|-h) ;;
  *) echo "未知参数：$ACTION（用法：bash scripts/stop-pair-node.sh [stop|status]）" >&2; exit 2 ;;
esac
if [ "$ACTION" = "--help" ] || [ "$ACTION" = "-h" ]; then
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

pid_alive() {
  local pid="${1:-}"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null
}

pid_is_pair_node() {
  local pid="${1:-}"
  pid_alive "$pid" || return 1
  local cmd
  cmd="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
  [[ "$cmd" == *"apps/cli/lib/bin.js"* ]] || return 1
  [[ "$cmd" == *" web "* ]] || return 1
  [[ "$cmd" == *"--port ${WEB_PORT}"* ]] || return 1
  grep -qzx "DSH_HOME=${PAIR_HOME}" "/proc/${pid}/environ" 2>/dev/null || return 1
  return 0
}

port_listening() { ss -ltnH "sport = :${1:-}" 2>/dev/null | grep -q .; }

read_pid() {
  [ -f "$PID_FILE" ] || { printf ''; return 0; }
  tr -d '[:space:]' < "$PID_FILE" 2>/dev/null || true
}

# ---------------------------------------------------------------- status
if [ "$ACTION" = "status" ]; then
  log "配对测试节点状态（DSH_HOME=${PAIR_HOME}，nodeId=pair-node，Web :${WEB_PORT}，对等 :${PEER_PORT}）"
  pid="$(read_pid)"
  running=0
  if [ -n "$pid" ] && pid_is_pair_node "$pid"; then
    running=1
    cmd="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
    etime="$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    printf '运行中  pid=%s  已运行=%s\ncmdline: %s\n' "$pid" "${etime:-?}" "$cmd"
  elif [ -n "$pid" ] && pid_alive "$pid"; then
    printf '异常    pid=%s 存活但不是配对测试节点（pid 复用）；可执行本脚本 stop 清理 pid 文件\n' "$pid"
  else
    printf '未运行（pid 文件：%s）\n' "${pid:-无}"
  fi
  printf 'Web  :%s  %s\n' "$WEB_PORT" "$(port_listening "$WEB_PORT" && ss -ltnpH "sport = :${WEB_PORT}" 2>/dev/null | head -n1 || echo '未监听')"
  printf 'Peer :%s  %s\n' "$PEER_PORT" "$(port_listening "$PEER_PORT" && ss -ltnpH "sport = :${PEER_PORT}" 2>/dev/null | head -n1 || echo '未监听')"
  ping_ok=0
  if ping_json="$(curl -fsS --max-time 3 "$PING_URL" 2>/dev/null)"; then
    ping_ok=1
    log "ping → ${ping_json}"
  else
    log "ping → 失败（节点未运行或未就绪）"
  fi
  state_json="$(curl -fsS --max-time 3 "$STATE_URL" 2>/dev/null || true)"
  if [ -n "$state_json" ] && command -v jq >/dev/null 2>&1; then
    log "nodeId=$(printf '%s' "$state_json" | jq -r '.self.nodeId // "?"')  listen=$(printf '%s' "$state_json" | jq -c '.self.listen // {}')"
    # 令牌只显示前 8 位，避免泄漏完整配对令牌
    log "pairing=$(printf '%s' "$state_json" | jq -r 'if (.pairing.token // null) then (.pairing.token[0:8]) + "…（共 " + ((.pairing.token|length)|tostring) + " 位）" else "（无 pairing 字段，host 实现可能未就绪）" end')"
    log "peers=$(printf '%s' "$state_json" | jq -c '[.peers[]? | {peerNodeId, state, source}]')"
    log "pendingPairs=$(printf '%s' "$state_json" | jq -c '[.pendingPairs[]? | {requestId, nodeId, nodeName}]')"
  fi
  if [ "$running" -eq 1 ] && [ "$ping_ok" -eq 1 ]; then exit 0; else exit 1; fi
fi

# ---------------------------------------------------------------- stop
if [ ! -f "$PID_FILE" ]; then
  log "配对测试节点未运行（无 pid 文件），无需停止。"
  exit 0
fi
pid="$(read_pid)"
if ! pid_alive "$pid"; then
  log "配对测试节点未运行（pid ${pid:-?} 已退出），清理陈旧 pid 文件。"
  rm -f "$PID_FILE"
  exit 0
fi
if ! pid_is_pair_node "$pid"; then
  warn "pid ${pid} 存活但不是配对测试节点（可能 pid 复用）；为避免误杀，不发送信号，只清理 pid 文件。"
  rm -f "$PID_FILE"
  exit 0
fi

log "停止配对测试节点：pid=${pid}（SIGTERM，最长 ${TERM_TIMEOUT_SECONDS}s）"
kill -TERM "$pid" 2>/dev/null || true
waited=0
while [ "$waited" -lt "$TERM_TIMEOUT_SECONDS" ] && pid_alive "$pid"; do
  sleep 1
  waited=$((waited + 1))
done
if pid_alive "$pid"; then
  warn "SIGTERM 后未退出，发送 SIGKILL（pid=${pid}）"
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
rm -f "$PID_FILE"
log "已停止（pid=${pid}），pid 文件已清理；日志保留：${LOG_FILE}"
if port_listening "$WEB_PORT"; then
  warn "端口 ${WEB_PORT} 仍有监听（可能其它进程占用）"
else
  log "端口 ${WEB_PORT} 已释放 ✓"
fi
exit 0
