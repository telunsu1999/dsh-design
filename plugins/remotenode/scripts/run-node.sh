#!/usr/bin/env bash
# =============================================================================
# run-node.sh — 后台启动第二 DSH 节点（远程 worker 角色）
#
# 实例参数（与 setup-node-profile.sh 保持绝对路径）：
#   DSH_HOME=/root/.dsh-node
#   DSH_PERMISSION_MODE=danger-full-access
#   node apps/cli/lib/bin.js web --host 127.0.0.1 --port 3081
#   workdir=/root/.openclaw/workspace/deepseek-harness
#   日志=/root/.dsh-node/dsh-web.log   pid=/root/.dsh-node/dsh-web.pid
#
# 行为：
#   - 幂等：已在运行（pid 有效且确为本节点进程）则只做健康探测后返回 0；
#   - 启动前检查 3081 未被占用、配置文件存在；启动后轮询
#     GET /api/remotenode/ping 直到就绪（默认 90s）；
#   - 绝不碰 3080（大脑仍在运行）。
# 用法：bash scripts/run-node.sh
# =============================================================================
set -euo pipefail

# ---------- 常量 ----------
NODE_BIN=/root/.nvm/versions/node/v22.22.1/bin/node
HARNESS_ROOT=/root/.openclaw/workspace/deepseek-harness
NODE_HOME=/root/.dsh-node
WEB_HOST=127.0.0.1
WEB_PORT=3081
LOG_FILE="${NODE_HOME}/dsh-web.log"
PID_FILE="${NODE_HOME}/dsh-web.pid"
RN_CONFIG="${NODE_HOME}/remotenode/config.json"
PROFILE_MANIFEST="${NODE_HOME}/profiles/web/package.json"
READY_TIMEOUT_SECONDS=90
PING_URL="http://${WEB_HOST}:${WEB_PORT}/api/remotenode/ping"

log()  { printf '[run-node] %s\n' "$*"; }
warn() { printf '[run-node][警告] %s\n' "$*" >&2; }
die()  { printf '[run-node][失败] %s\n' "$*" >&2; exit 1; }

# ---------- 小工具 ----------
pid_alive() {
  local pid="${1:-}"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null
}

# 确认 pid 就是本节点的 DSH web 进程（防 pid 复用 / 误判别的 node 进程）
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

port_listening() {
  local port="${1:-}"
  ss -ltnH "sport = :${port}" 2>/dev/null | grep -q .
}

http_ping() {
  curl -fsS --max-time 3 "$PING_URL" 2>/dev/null
}

# 只打印重定向目标；不读、不打印任何凭据/secret 内容。
log_tail() {
  [ -f "$LOG_FILE" ] && tail -n "${1:-25}" "$LOG_FILE" || true
}

# 只截取「本次启动」之后新增的日志（用于失败诊断，避免翻出旧错误）
log_since() {
  [ -f "$LOG_FILE" ] || return 0
  local offset="${log_offset:-0}"
  tail -c "+$((offset + 1))" "$LOG_FILE" 2>/dev/null || true
}

# ---------- 1. 前置检查 ----------
[ -x "$NODE_BIN" ]                 || die "找不到 Node v22：$NODE_BIN"
[ -f "$PROFILE_MANIFEST" ]         || die "第二节点 profile 未初始化（缺 ${PROFILE_MANIFEST}），请先跑 bash scripts/setup-node-profile.sh"
[ -f "$RN_CONFIG" ]                || die "第二节点插件配置缺失（缺 ${RN_CONFIG}），请先跑 bash scripts/setup-node-profile.sh"
[ -d "$HARNESS_ROOT" ]             || die "找不到 harness checkout：$HARNESS_ROOT"
mkdir -p "$NODE_HOME"

# ---------- 2. 已在运行？ ----------
if [ -f "$PID_FILE" ]; then
  old_pid="$(tr -d '[:space:]' < "$PID_FILE" 2>/dev/null || true)"
  if pid_is_our_node "$old_pid"; then
    log "第二 DSH 节点已在运行：pid=${old_pid}，Web http://${WEB_HOST}:${WEB_PORT}"
    if ping_json="$(http_ping)"; then
      log "健康探测通过：${ping_json}"
      exit 0
    fi
    warn "进程存在但 /api/remotenode/ping 暂不可达；可能仍在启动中或已卡住。"
    log "查看日志：tail -n 50 ${LOG_FILE}"
    exit 1
  fi
  if pid_alive "$old_pid"; then
    warn "pid 文件指向的进程 ${old_pid} 不是本节点 DSH web（可能 pid 被复用），将清理陈旧 pid 文件后继续。"
  else
    log "发现陈旧 pid 文件（进程 ${old_pid:-?} 已退出），清理后重新启动。"
  fi
  rm -f "$PID_FILE"
fi

# ---------- 3. 端口冲突检查（绝不碰 3080） ----------
if port_listening "$WEB_PORT"; then
  ss -ltnpH "sport = :${WEB_PORT}" >&2 || true
  die "端口 ${WEB_PORT} 已被占用；先排查其它实例（brain 应只在 3080）。"
fi
if port_listening 3080; then
  log "确认大脑仍在 3080 运行（本节点不占用 3080）。"
else
  warn "3080 当前没有监听进程——大脑可能未运行；本节点仍使用 ${WEB_PORT}。"
fi

# ---------- 4. 启动 ----------
# 日志过大时先轮转，保留上一份
if [ -f "$LOG_FILE" ] && [ "$(stat -c '%s' "$LOG_FILE" 2>/dev/null || echo 0)" -gt 5242880 ]; then
  mv -f "$LOG_FILE" "${LOG_FILE}.1"
  log "日志超过 5MiB，已轮转为 ${LOG_FILE}.1"
fi
touch "$LOG_FILE"
chmod 600 "$LOG_FILE"
printf '\n===== [%s] run-node.sh 启动 nodeId=desktop-node DSH_HOME=%s web=%s:%s =====\n' \
  "$(date '+%F %T %Z')" "$NODE_HOME" "$WEB_HOST" "$WEB_PORT" >> "$LOG_FILE"
# 本次启动在日志中的起始字节偏移：只在这之后的内容里判断插件激活失败，避免旧日志干扰
log_offset="$(stat -c '%s' "$LOG_FILE" 2>/dev/null || echo 0)"

log "启动第二 DSH 节点（nodeId=desktop-node，Web ${WEB_HOST}:${WEB_PORT}，日志 ${LOG_FILE}）"
cd "$HARNESS_ROOT"
export DSH_HOME="$NODE_HOME"
export DSH_PERMISSION_MODE=danger-full-access
nohup "$NODE_BIN" apps/cli/lib/bin.js web --host "$WEB_HOST" --port "$WEB_PORT" >> "$LOG_FILE" 2>&1 &
node_pid=$!
printf '%s\n' "$node_pid" > "$PID_FILE"
chmod 600 "$PID_FILE"
log "已拉起进程 pid=${node_pid}，等待就绪（最长 ${READY_TIMEOUT_SECONDS}s，探测 ${PING_URL}）"

# ---------- 5. 等待就绪 ----------
ready=0
elapsed=0
while [ "$elapsed" -lt "$READY_TIMEOUT_SECONDS" ]; do
  if ! pid_alive "$node_pid"; then
    rm -f "$PID_FILE"
    warn "进程已退出（启动失败）。本次启动日志末尾："
    log_since | tail -n 40 >&2
    die "第二 DSH 节点启动失败，详见 ${LOG_FILE}"
  fi
  if ping_json="$(http_ping)"; then
    ready=1
    break
  fi
  # 插件激活失败（web 进程活着但 remotenode 行未挂载）：快速失败并停止进程，避免占着 3081 误导测试
  if [ -f "$LOG_FILE" ] && log_since | grep -qF "remotenode (@dsh-design/remotenode):"; then
    warn "日志显示 remotenode 插件激活失败（Web 进程仍在但 /api/remotenode 不可用），已停止该进程。错误摘录："
    log_since | grep -A4 -F "remotenode (@dsh-design/remotenode):" | head -n 14 >&2 || true
    kill -TERM "$node_pid" 2>/dev/null || true
    sleep 2
    if pid_alive "$node_pid"; then kill -KILL "$node_pid" 2>/dev/null || true; fi
    rm -f "$PID_FILE"
    die "插件激活失败，详见 ${LOG_FILE}；修复插件后重跑本脚本。"
  fi
  if [ $((elapsed % 10)) -eq 0 ] && [ "$elapsed" -gt 0 ]; then
    log "…仍在等待（已 ${elapsed}s，pid=${node_pid}）"
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

if [ "$ready" -ne 1 ]; then
  warn "等待 ${READY_TIMEOUT_SECONDS}s 后 /api/remotenode/ping 仍未就绪；进程保留（pid=${node_pid}）以便排查。本次启动日志末尾："
  log_since | tail -n 40 >&2
  log "可用：bash $(dirname "$0")/status-node.sh；停止：bash $(dirname "$0")/stop-node.sh"
  exit 1
fi

# ---------- 6. 就绪汇总 ----------
log "就绪：pid=${node_pid}，HTTP http://${WEB_HOST}:${WEB_PORT}"
log "ping → ${ping_json}"

state_json="$(curl -fsS --max-time 3 "http://${WEB_HOST}:${WEB_PORT}/api/remotenode/state" 2>/dev/null || true)"
if [ -n "$state_json" ]; then
  if command -v jq >/dev/null 2>&1; then
    self_node_id="$(printf '%s' "$state_json" | jq -r '.self.nodeId // "?"' 2>/dev/null || echo '?')"
    self_listen="$(printf '%s' "$state_json" | jq -c '.self.listen // {}' 2>/dev/null || echo '?')"
    peers_state="$(printf '%s' "$state_json" | jq -c '[.peers[]? | {peerNodeId, state, direction}]' 2>/dev/null || echo '?')"
    log "state.self.nodeId=${self_node_id}，self.listen=${self_listen}"
    log "state.peers=${peers_state}"
  else
    log "state 摘要：$(printf '%s' "$state_json" | head -c 400)"
  fi
fi

if port_listening 47301; then
  log "对等监听端口 47301 已在 LISTEN ✓"
else
  warn "对等监听端口 47301 尚未 LISTEN（host 侧 peer-transport 可能还未启用监听；Web API 已可用）。"
fi
log "3080（大脑）未占用检查：$(port_listening 3080 && echo '大脑在 3080 ✓' || echo '3080 无监听')"
log "日志：${LOG_FILE}  pid 文件：${PID_FILE}"
log "状态：bash $(dirname "$0")/status-node.sh ；停止：bash $(dirname "$0")/stop-node.sh"
