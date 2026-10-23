#!/usr/bin/env bash
# =============================================================================
# setup-pair-node.sh — 一次性「UI 配对测试节点」（第三实例）
#
# 用途：为 remotenode 的 UI 配对流程（SPEC §10）准备一个全新、可丢弃的 DSH 节点：
#   DSH_HOME=/tmp/.dsh-pair-node
#   nodeId=pair-node / nodeName=配对测试节点
#   Web :3082（API 探测 /api/remotenode/ping）
#   对等监听 127.0.0.1:47401（配对服务端端口）
#   peers=[]（模拟全新节点：不从 config.json 预置任何对端，只能通过配对建立）
#   日志/pid：/tmp/.dsh-pair-node/dsh-web.log / dsh-web.pid
# 不需要模型凭据（本实例只验证链路配对，不执行远程会话）。
#
# 行为（可重复执行）：
#   1. 若临时实例已在运行 → 先幂等停止（复用 stop-pair-node.sh），保证加载最新插件代码；
#   2. 首次运行：初始化 web profile 并 link 安装本 bundle，保证
#      @dsh-design/remotenode 在 dsh.profile.bundles 中、位于 @deepseek-ai/dsh-web-app 之后；
#   3. 写 config.json（peers=[]）；--fresh 额外清空 pairing.json/peers.json 等临时配对状态
#      （换发新配对令牌，便于干净重跑）；
#   4. 后台启动 3082 并轮询 ping 就绪；插件激活失败会快速失败并清理进程。
#
# 用法：bash scripts/setup-pair-node.sh [--fresh]
#   --fresh  清空临时实例的配对状态/令牌（默认保留上次状态）
# =============================================================================
set -euo pipefail

# ---------- 常量（绝对路径） ----------
NODE_BIN=/root/.nvm/versions/node/v22.22.1/bin/node
HARNESS_ROOT=/root/.openclaw/workspace/deepseek-harness
DSH_CLI="${HARNESS_ROOT}/apps/cli/lib/bin.js"
BUNDLE_DIR=/root/AiWork/DSH_Design/plugins/remotenode

PAIR_HOME=/tmp/.dsh-pair-node
PROFILE_DIR="${PAIR_HOME}/profiles/web"
PROFILE_MANIFEST="${PROFILE_DIR}/package.json"
RN_DIR="${PAIR_HOME}/remotenode"
RN_CONFIG="${RN_DIR}/config.json"
RN_WORKSPACE="${RN_DIR}/workspace"
RN_DATA="${RN_DIR}/data"
LOG_FILE="${PAIR_HOME}/dsh-web.log"
PID_FILE="${PAIR_HOME}/dsh-web.pid"

BUNDLE_NAME='@dsh-design/remotenode'
NODE_ID='pair-node'
NODE_NAME='配对测试节点'
LISTEN_HOST='127.0.0.1'
LISTEN_PORT='47401'
WEB_HOST='127.0.0.1'
WEB_PORT='3082'
READY_TIMEOUT_SECONDS=90
PING_URL="http://${WEB_HOST}:${WEB_PORT}/api/remotenode/ping"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FRESH=0
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH=1 ;;
    -h|--help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$arg（用法：bash scripts/setup-pair-node.sh [--fresh]）" >&2; exit 2 ;;
  esac
done

log()  { printf '[setup-pair] %s\n' "$*"; }
warn() { printf '[setup-pair][警告] %s\n' "$*" >&2; }
die()  { printf '[setup-pair][失败] %s\n' "$*" >&2; exit 1; }

# 本脚本只操作 /tmp/.dsh-pair-node；显式导出 DSH_HOME 给所有子进程。
export DSH_HOME="${PAIR_HOME}"

# ---------- 0. 前置自检 ----------
[ -x "$NODE_BIN" ]                || die "找不到 Node v22：$NODE_BIN"
[ -f "$DSH_CLI" ]                 || die "找不到 DSH CLI：$DSH_CLI"
[ -f "$BUNDLE_DIR/package.json" ] || die "找不到插件 bundle：$BUNDLE_DIR"
mkdir -p "$PAIR_HOME"

log "配对测试节点：DSH_HOME=${PAIR_HOME}，nodeId=${NODE_ID}，Web :${WEB_PORT}，对等监听 ${LISTEN_HOST}:${LISTEN_PORT}"

# ---------- 1. 停掉可能存在的旧实例（保证加载最新插件代码） ----------
if [ -f "$PID_FILE" ] || curl -fsS --max-time 2 "$PING_URL" >/dev/null 2>&1; then
  log "[1/6] 检测到旧实例，先幂等停止"
  bash "${SCRIPT_DIR}/stop-pair-node.sh" >/dev/null 2>&1 || true
fi

# ---------- 2. 目录骨架 / --fresh 清理配对状态 ----------
mkdir -p "$RN_DIR" "$RN_WORKSPACE" "$RN_DATA"
if [ "$FRESH" -eq 1 ]; then
  rm -f "${RN_DATA}/peers.json" "${RN_DATA}/pairing.json" "${RN_DATA}/links.json"
  log "[2/6] --fresh：已清空临时实例配对状态与令牌（下次启动自动生成新令牌）"
else
  log "[2/6] 目录就绪（保留既有配对状态；如需干净重跑加 --fresh）"
fi

# ---------- 3. 初始化 web profile 并安装插件 bundle（首次） ----------
need_install=0
if [ ! -f "$PROFILE_MANIFEST" ]; then
  need_install=1
elif ! RN_PROFILE_DIR="$PROFILE_DIR" RN_BUNDLE_NAME="$BUNDLE_NAME" "$NODE_BIN" <<'NODE' >/dev/null 2>&1
const fs = require('node:fs')
const path = require('node:path')
const dir = process.env.RN_PROFILE_DIR
const name = process.env.RN_BUNDLE_NAME
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
if (typeof (manifest.dependencies || {})[name] !== 'string') process.exit(3)
if (!fs.existsSync(path.join(dir, 'node_modules', ...name.split('/'), 'package.json'))) process.exit(4)
process.exit(0)
NODE
then
  need_install=1
fi
if [ "$need_install" -eq 1 ]; then
  log "[3/6] 初始化 web profile 并 link 安装 ${BUNDLE_NAME}"
  ( cd "$HARNESS_ROOT" && "$NODE_BIN" "$DSH_CLI" plugin --profile web add "$BUNDLE_DIR" )
else
  log "[3/6] profile 已存在且插件已链接，跳过安装"
fi

# ---------- 4. 保证 bundle 在 dsh.profile.bundles（web-app 之后） ----------
RN_PROFILE_DIR="$PROFILE_DIR" RN_BUNDLE_NAME="$BUNDLE_NAME" RN_AFTER_BUNDLE='@deepseek-ai/dsh-web-app' \
  "$NODE_BIN" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const dir = process.env.RN_PROFILE_DIR
const name = process.env.RN_BUNDLE_NAME
const after = process.env.RN_AFTER_BUNDLE
const manifestPath = path.join(dir, 'package.json')
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const current = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
const rest = current.filter(item => item !== name)
const anchor = rest.indexOf(after)
const next = anchor >= 0 ? [...rest.slice(0, anchor + 1), name, ...rest.slice(anchor + 1)] : [...rest, name]
if (JSON.stringify(current) === JSON.stringify(next)) process.exit(0)
manifest.dsh = manifest.dsh || {}
manifest.dsh.profile = manifest.dsh.profile || {}
manifest.dsh.profile.bundles = next
fs.writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n', { mode: 0o600 })
fs.chmodSync(manifestPath, 0o600)
NODE
log "[4/6] profile bundles 已确保包含 ${BUNDLE_NAME}（web-app 之后）"

# ---------- 5. 写 config.json（peers=[]，模拟全新节点） ----------
RN_CONFIG="$RN_CONFIG" RN_NODE_ID="$NODE_ID" RN_NODE_NAME="$NODE_NAME" \
  RN_LISTEN_HOST="$LISTEN_HOST" RN_LISTEN_PORT="$LISTEN_PORT" \
  RN_WORKSPACE="$RN_WORKSPACE" RN_DATA_DIR="$RN_DATA" \
  "$NODE_BIN" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const configPath = process.env.RN_CONFIG
const desired = {
  nodeId: process.env.RN_NODE_ID,
  nodeName: process.env.RN_NODE_NAME,
  listen: { enabled: true, host: process.env.RN_LISTEN_HOST, port: Number(process.env.RN_LISTEN_PORT) },
  peers: [],
  workspace: process.env.RN_WORKSPACE,
  dataDir: process.env.RN_DATA_DIR,
  autoFetchImages: true,
  maxAutoFetchBytes: 15728640,
}
const text = JSON.stringify(desired, undefined, 2) + '\n'
let existing = null
try { existing = fs.readFileSync(configPath, 'utf8') } catch { existing = null }
if (existing === text) process.exit(0)
fs.mkdirSync(path.dirname(configPath), { recursive: true })
fs.writeFileSync(configPath, text, { mode: 0o600 })
fs.chmodSync(configPath, 0o600)
NODE
chmod 600 "$RN_CONFIG"
log "[5/6] config.json 已就绪（peers=[]）：${RN_CONFIG}"

# ---------- 6. 端口检查 + 启动 3082 ----------
port_listening() { ss -ltnH "sport = :${1:-}" 2>/dev/null | grep -q .; }
if port_listening "$WEB_PORT"; then
  ss -ltnpH "sport = :${WEB_PORT}" >&2 || true
  die "端口 ${WEB_PORT} 已被占用；请先停止占用进程（bash scripts/stop-pair-node.sh）"
fi
if port_listening "$LISTEN_PORT"; then
  warn "对等端口 ${LISTEN_PORT} 已被其它进程占用，临时实例可能无法监听该端口"
fi

touch "$LOG_FILE"; chmod 600 "$LOG_FILE"
printf '\n===== [%s] setup-pair-node.sh 启动 nodeId=%s DSH_HOME=%s web=%s:%s =====\n' \
  "$(date '+%F %T %Z')" "$NODE_ID" "$PAIR_HOME" "$WEB_HOST" "$WEB_PORT" >> "$LOG_FILE"
log_offset="$(stat -c '%s' "$LOG_FILE" 2>/dev/null || echo 0)"
log_since() {
  [ -f "$LOG_FILE" ] || return 0
  tail -c "+$(( ${log_offset:-0} + 1 ))" "$LOG_FILE" 2>/dev/null || true
}

log "[6/6] 启动：DSH_HOME=${PAIR_HOME} DSH_PERMISSION_MODE=danger-full-access node apps/cli/lib/bin.js web --host ${WEB_HOST} --port ${WEB_PORT}"
cd "$HARNESS_ROOT"
export DSH_PERMISSION_MODE=danger-full-access
nohup "$NODE_BIN" apps/cli/lib/bin.js web --host "$WEB_HOST" --port "$WEB_PORT" >> "$LOG_FILE" 2>&1 &
pair_pid=$!
printf '%s\n' "$pair_pid" > "$PID_FILE"
chmod 600 "$PID_FILE"
log "已拉起进程 pid=${pair_pid}，等待就绪（最长 ${READY_TIMEOUT_SECONDS}s，探测 ${PING_URL}）"

ready=0
elapsed=0
while [ "$elapsed" -lt "$READY_TIMEOUT_SECONDS" ]; do
  if ! kill -0 "$pair_pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    warn "进程已退出。本次启动日志末尾："
    log_since | tail -n 40 >&2
    die "配对测试节点启动失败，详见 ${LOG_FILE}"
  fi
  if ping_json="$(curl -fsS --max-time 2 "$PING_URL" 2>/dev/null)"; then
    ready=1
    break
  fi
  if [ -f "$LOG_FILE" ] && log_since | grep -qF "remotenode (@dsh-design/remotenode):"; then
    warn "remotenode 插件激活失败，已停止进程。错误摘录："
    log_since | grep -A4 -F "remotenode (@dsh-design/remotenode):" | head -n 14 >&2 || true
    kill -TERM "$pair_pid" 2>/dev/null || true
    sleep 1
    kill -KILL "$pair_pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    die "插件激活失败，详见 ${LOG_FILE}"
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done
[ "$ready" -eq 1 ] || { warn "等待 ${READY_TIMEOUT_SECONDS}s 未就绪；进程保留（pid=${pair_pid}）"; log_since | tail -n 40 >&2; exit 1; }

# ---------- 7. 汇总 ----------
state_json="$(curl -fsS --max-time 3 "http://${WEB_HOST}:${WEB_PORT}/api/remotenode/state" 2>/dev/null || true)"
self_node_id='?'; self_listen='?'; pairing_summary='?'; pending_count='?'
if command -v jq >/dev/null 2>&1 && [ -n "$state_json" ]; then
  self_node_id="$(printf '%s' "$state_json" | jq -r '.self.nodeId // "?"')"
  self_listen="$(printf '%s' "$state_json" | jq -c '.self.listen // {}')"
  # 只展示令牌指纹/长度，不打印完整令牌
  pairing_summary="$(printf '%s' "$state_json" | jq -r 'if (.pairing.token // null) then "token 前 8 位=" + (.pairing.token[0:8]) + "…（共 " + ((.pairing.token|length)|tostring) + " 位，fixedByConfig=" + ((.pairing.fixedByConfig // false)|tostring) + "）" else "无 pairing 字段（host 实现可能未就绪）" end')"
  pending_count="$(printf '%s' "$state_json" | jq -r '(.pendingPairs // []) | length')"
fi

cat <<EOF
[setup-pair] 完成。配对测试节点摘要：
  DSH_HOME     : ${PAIR_HOME}
  节点身份     : ${self_node_id} / ${NODE_NAME}
  Web          : http://${WEB_HOST}:${WEB_PORT}（ping: ${ping_json:-?}）
  对等监听     : ${self_listen}
  配对令牌     : ${pairing_summary}
  待审批请求   : ${pending_count}
  进程 pid     : ${pair_pid}（pid 文件 ${PID_FILE}）
  日志         : ${LOG_FILE}
  停止/状态    : bash scripts/stop-pair-node.sh [status]
  端到端配对   : bash scripts/e2e-pairing.sh（会自动 setup + 清理）
EOF
