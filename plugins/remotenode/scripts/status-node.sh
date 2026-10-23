#!/usr/bin/env bash
# =============================================================================
# status-node.sh — 查看第二 DSH 节点（远程 worker 角色）运行状态
#
# 输出：pid 文件内容 / 进程存活与 cmdline / uptime 与内存 /
#       Web 端口 3081 与对等端口 47301 的 LISTEN 情况 /
#       HTTP 探测：/api/remotenode/ping、/api/remotenode/state（self.nodeId、
#       self.listen、peers 状态）/ 3080（大脑）对照 / 日志与 pid 文件路径。
#
# 退出码：0 = 进程在运行且 ping 正常；1 = 未运行或探测失败。
# 用法：bash scripts/status-node.sh
# =============================================================================
set -uo pipefail

# ---------- 常量 ----------
NODE_HOME=/root/.dsh-node
WEB_HOST=127.0.0.1
WEB_PORT=3081
PEER_PORT=47301
LOG_FILE="${NODE_HOME}/dsh-web.log"
PID_FILE="${NODE_HOME}/dsh-web.pid"
BASE_URL="http://${WEB_HOST}:${WEB_PORT}/api/remotenode"

log() { printf '[status-node] %s\n' "$*"; }

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

port_line() {
  local port="${1:-}"
  local line
  line="$(ss -ltnpH "sport = :${port}" 2>/dev/null | head -n 1)"
  if [ -n "$line" ]; then
    printf 'LISTEN  %s\n' "$line"
  else
    printf '未监听  :%s\n' "$port"
  fi
}

# ---------- 基本信息 ----------
log "第二 DSH 节点状态（nodeId=desktop-node，DSH_HOME=${NODE_HOME}）"
log "pid 文件：${PID_FILE}"
log "日志文件：${LOG_FILE}"
echo "---- 进程 ----"

pid=''
if [ -f "$PID_FILE" ]; then
  pid="$(tr -d '[:space:]' < "$PID_FILE" 2>/dev/null || true)"
else
  log "pid 文件不存在（节点未通过 run-node.sh 启动或已停止）。"
fi

running=0
if [ -n "$pid" ] && pid_is_our_node "$pid"; then
  running=1
  cmd="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
  start_time="$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//' || true)"
  etime="$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  rss_kb="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
  printf '运行中  pid=%s  启动=%s  已运行=%s  内存≈%s MiB\n' \
    "$pid" "${start_time:-?}" "${etime:-?}" "$([ -n "$rss_kb" ] && echo $((rss_kb / 1024)) || echo '?')"
  printf 'cmdline: %s\n' "$cmd"
elif [ -n "$pid" ] && pid_alive "$pid"; then
  printf '异常    pid=%s 存活但不是本节点 DSH web（pid 复用或非本脚本启动），可执行 stop-node.sh 清理 pid 文件\n' "$pid"
  pid=''
elif [ -n "$pid" ]; then
  printf '未运行  pid 文件陈旧（pid=%s 已退出）\n' "$pid"
else
  printf '未运行\n'
fi

echo "---- 端口 ----"
printf 'Web  :%s   ' "$WEB_PORT"; port_line "$WEB_PORT"
printf 'Peer :%s   ' "$PEER_PORT"; port_line "$PEER_PORT"
printf '大脑 Web :3080   '; port_line 3080
printf '大脑 peer :47201 '; port_line 47201

echo "---- HTTP 探测 ----"
ping_ok=0
if ping_json="$(curl -fsS --max-time 3 "${BASE_URL}/ping" 2>/dev/null)"; then
  ping_ok=1
  log "GET ${BASE_URL}/ping → ${ping_json}"
else
  log "GET ${BASE_URL}/ping → 失败（节点未运行或未就绪）"
fi

state_json="$(curl -fsS --max-time 3 "${BASE_URL}/state" 2>/dev/null || true)"
if [ -n "$state_json" ]; then
  if command -v jq >/dev/null 2>&1; then
    log "state.self.nodeId = $(printf '%s' "$state_json" | jq -r '.self.nodeId // "?"')"
    log "state.self.nodeName = $(printf '%s' "$state_json" | jq -r '.self.nodeName // "?"')"
    log "state.self.listen = $(printf '%s' "$state_json" | jq -c '.self.listen // {}')"
    log "state.self.dataDir = $(printf '%s' "$state_json" | jq -r '.self.dataDir // "?"')"
    log "state.peers = $(printf '%s' "$state_json" | jq -c '[.peers[]? | {peerNodeId, nodeName, state, direction, linkId, lastSeen, error}]')"
    log "state.sessions 数量 = $(printf '%s' "$state_json" | jq -r '(.sessions // []) | length')，deliverables 数量 = $(printf '%s' "$state_json" | jq -r '(.deliverables // []) | length')"
  else
    log "GET ${BASE_URL}/state → ${state_json}"
  fi
else
  log "GET ${BASE_URL}/state → 失败"
fi

echo "---- 日志尾部 ----"
if [ -f "$LOG_FILE" ]; then
  tail -n 8 "$LOG_FILE"
else
  log "日志文件不存在"
fi

if [ "$running" -eq 1 ] && [ "$ping_ok" -eq 1 ]; then
  echo "结论：运行中且 HTTP 健康 ✓"
  exit 0
elif [ "$running" -eq 1 ]; then
  echo "结论：进程在运行，但 HTTP 探测失败（看日志尾部）"
  exit 1
else
  echo "结论：节点未运行"
  exit 1
fi
