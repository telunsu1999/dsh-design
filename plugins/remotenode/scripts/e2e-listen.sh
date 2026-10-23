#!/usr/bin/env bash
# =============================================================================
# e2e-listen.sh — remotenode「对等监听地址/端口可改」端到端验证（curl 驱动）
#
# 契约：plugins/remotenode/SPEC.md §11（监听地址/端口可配置）
# 两个实例：
#   大脑   : http://127.0.0.1:3080  (DSH_HOME=/root/.dsh,      nodeId=brain-linux，生产实例，只经 API 增删)
#   配对节点: http://127.0.0.1:3082  (DSH_HOME=/tmp/.dsh-pair-node, nodeId=pair-node，一次性实例，
#                                    复用 setup-pair-node.sh / stop-pair-node.sh 启动/停止)
#
# 流程：
#   T0 前置：起临时 pair-node（默认监听 47401）→ 两实例 ping/state 可用 →
#            §11 API 就绪（state.self 含 listenSource/listenOverride）→ 自愈旧覆盖 → 预清理配对残留
#   T1 读取默认监听与配对令牌（47401/config、override=false）
#   T2 POST /listen 改到自定义端口（默认 48401）→ 断言 ok:true、state.self.listen 更新、
#      48401 LISTEN、47401 不再 LISTEN、旧端口不可连、新端口可连
#   T3 3080 用**新端口 + 令牌**发起 /peers/pair → 3082 pendingPairs → approve →
#      3080 pair 返回 ok、双方 peers online（source=paired）
#   T4 失败分支：起一个临时 TCP 占用 48601 → POST /listen 到该端口 → ok:false；
#      原监听 48401 仍 LISTEN、链路仍 online、占用进程仍持有 48601
#   T5 reset:true → 回到 config.json 的 47401：state.self.listenOverride=false、
#      listenSource=config、47401 LISTEN、48401 释放；已建立链路仍 online
#      （附带观察 §11.2 peer.listen 通知是否把对端 paired 记录端口更新回 47401）
#   T6 清理：3080 remove pair-node（+ pair.revoke 观察）→ 两侧 peers 移除 →
#      3080 peers 只剩原有 config 节点（desktop-node）、pendingPairs 空、peers.json 无残留、
#      config.json 未被修改 → 停止临时实例
#
# 退出码：0=全部通过；1=有测试失败；2=环境/实现未就绪。
# 用法：
#   bash scripts/e2e-listen.sh              # 全自动：setup --fresh → 测试 → 清理 → stop
#   bash scripts/e2e-listen.sh --keep       # 结束后保留临时实例（便于排查/UI 查看）
#   bash scripts/e2e-listen.sh --no-setup   # 不自动 setup（假定 3082 已在跑），默认也不停止它
# 可用环境变量覆盖：CUSTOM_PORT（默认 48401）、BUSY_PORT（默认 48601）、CUSTOM_HOST（默认 0.0.0.0）
# =============================================================================
set -uo pipefail

BRAIN="${BRAIN_URL:-http://127.0.0.1:3080}"
PAIR="${PAIR_URL:-http://127.0.0.1:3082}"
BRAIN_NODE_ID='brain-linux'
PAIR_NODE_ID='pair-node'
DEFAULT_LISTEN_PORT=47401
CUSTOM_PORT="${CUSTOM_PORT:-48401}"
CUSTOM_HOST="${CUSTOM_HOST:-0.0.0.0}"
BUSY_PORT="${BUSY_PORT:-48601}"
PAIR_HOME=/tmp/.dsh-pair-node
WORK="${WORK_DIR:-/tmp/remotenode-listen-e2e}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN=/root/.nvm/versions/node/v22.22.1/bin/node
BRAIN_CONFIG_MARKER='/root/.dsh/remotenode/config.json'
BRAIN_PEERS_FILE='/root/.dsh/remotenode/data/peers.json'
PAIR_SETTINGS_FILE="${PAIR_HOME}/remotenode/data/settings.json"

KEEP=0
SETUP=1
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --no-setup) SETUP=0; KEEP=1 ;;
    -h|--help) sed -n '2,39p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$arg（用法：bash scripts/e2e-listen.sh [--keep] [--no-setup]）" >&2; exit 2 ;;
  esac
done
mkdir -p "$WORK"

PASS=0
FAIL=0
say()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok()   { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少命令：$1" >&2; exit 2; }; }
need curl
need jq
need ss

api_get()  { curl -sS -m "${2:-10}" "$1" 2>/dev/null; }
api_post() { curl -sS -m "${3:-30}" -X POST -H 'content-type: application/json' -d "$2" "$1" 2>/dev/null; }
state_of() { api_get "$1/api/remotenode/state" "${2:-5}"; }
jbody() { jq -nc "$@" 2>/dev/null; }

port_listening() { ss -ltnH "sport = :${1:-}" 2>/dev/null | grep -q .; }

# 端口是否可建立 TCP 连接（成功=0）
tcp_connectable() {
  local port="${1:-}" host="${2:-127.0.0.1}"
  timeout 2 bash -c "exec 3<>/dev/tcp/${host}/${port}" 2>/dev/null
}

brain_baseline_peers='[]'
brain_config_md5=''
busy_pid=''

# ---------------------------------------------------------------------------
# 清理：临时端口占用进程 / 监听覆盖自愈 / 配对残留（幂等，trap 与预清理共用）
# ---------------------------------------------------------------------------
kill_busy() {
  if [ -n "${busy_pid:-}" ] && kill -0 "$busy_pid" 2>/dev/null; then
    kill -TERM "$busy_pid" 2>/dev/null || true
    sleep 0.3
    kill -KILL "$busy_pid" 2>/dev/null || true
    info "已释放临时占用端口 ${BUSY_PORT}（pid ${busy_pid}）"
  fi
  busy_pid=''
}

reset_pair_listen() {
  # 尽力把临时实例监听恢复为 config.json（47401），避免设置残留影响下一次运行
  local st override
  st="$(state_of "$PAIR" 2>/dev/null)"
  override="$(printf '%s' "$st" | jq -r '.self.listenOverride // false' 2>/dev/null)"
  if [ "$override" = "true" ]; then
    local r
    r="$(api_post "$PAIR/api/remotenode/listen" "$(jbody '{reset:true}')" 20)"
    info "清理：/listen {reset:true} → ${r:-<空>}"
  fi
}

sanitize_pairings() {
  local tag="$1" i b_peers p_peers need_clean removed=0
  for i in 1 2 3 4 5; do
    b_peers="$(state_of "$BRAIN" 2>/dev/null | jq -r '.peers[]?.peerNodeId' 2>/dev/null)"
    p_peers="$(state_of "$PAIR" 2>/dev/null | jq -r '.peers[]?.peerNodeId' 2>/dev/null)"
    need_clean=0
    if printf '%s\n' "$b_peers" | grep -qx "$PAIR_NODE_ID"; then
      local r
      r="$(api_post "$BRAIN/api/remotenode/peers/remove" "$(jbody --arg id "$PAIR_NODE_ID" '{peerNodeId:$id}')")"
      info "[$tag] 3080 remove $PAIR_NODE_ID → ${r:-<空>}"
      removed=$((removed + 1)); need_clean=1
    fi
    if printf '%s\n' "$p_peers" | grep -qx "$BRAIN_NODE_ID"; then
      local r
      r="$(api_post "$PAIR/api/remotenode/peers/remove" "$(jbody --arg id "$BRAIN_NODE_ID" '{peerNodeId:$id}')")"
      info "[$tag] 3082 remove $BRAIN_NODE_ID → ${r:-<空>}"
      removed=$((removed + 1)); need_clean=1
    fi
    [ "$need_clean" -eq 0 ] && break
    sleep 1
  done
  [ "$removed" -eq 0 ] && info "[$tag] 两侧均无配对残留"
}

cleanup_on_exit() {
  local code=$?
  trap - EXIT INT TERM
  say "清理：临时端口 / 监听覆盖 / 配对残留"
  kill_busy
  reset_pair_listen
  sanitize_pairings '清理'
  local b_after p_after
  b_after="$(state_of "$BRAIN" 2>/dev/null | jq -c '[.peers[]? | .peerNodeId]' 2>/dev/null)"
  p_after="$(state_of "$PAIR" 2>/dev/null | jq -c '[.peers[]? | .peerNodeId]' 2>/dev/null)"
  info "3080 peers 终态：${b_after:-<不可达>}"
  info "3082 peers 终态：${p_after:-<不可达>}"
  if printf '%s' "$b_after" | grep -q "\"${PAIR_NODE_ID}\""; then
    printf '  \033[31m[清理失败]\033[0m 3080 仍残留 %s，请人工处理！\n' "$PAIR_NODE_ID"
  fi
  if [ "$KEEP" -ne 1 ] && [ -x "$SCRIPT_DIR/stop-pair-node.sh" ]; then
    say "停止配对测试节点（保留日志 ${PAIR_HOME}/dsh-web.log）"
    bash "$SCRIPT_DIR/stop-pair-node.sh" || true
    # 实例已停：若仍有监听覆盖残留，直接清理一次性环境的 settings.json（不影响下次 setup）
    if [ -f "$PAIR_SETTINGS_FILE" ] && grep -q '"port"' "$PAIR_SETTINGS_FILE" 2>/dev/null; then
      rm -f "$PAIR_SETTINGS_FILE" && info "已清理一次性环境的 settings.json（监听覆盖残留）"
    fi
  else
    info "按参数保留配对测试节点运行（bash scripts/stop-pair-node.sh 可停止）"
  fi
  exit "$code"
}
trap cleanup_on_exit EXIT INT TERM

# ---------------------------------------------------------------------------
# T0. 环境准备 + 前置检查
# ---------------------------------------------------------------------------
say "T0 环境准备与前置检查"
if [ "$SETUP" -eq 1 ]; then
  info "运行 setup-pair-node.sh --fresh（启动 :3082 临时节点，默认监听 ${DEFAULT_LISTEN_PORT}，换发新令牌）"
  if ! bash "$SCRIPT_DIR/setup-pair-node.sh" --fresh; then
    bad "setup-pair-node.sh 失败，无法继续"
    say "汇总：PASS=$PASS FAIL=$FAIL（环境未就绪，退出码 2）"; exit 2
  fi
else
  info "跳过 setup（--no-setup）；假定 :3082 已由 setup-pair-node.sh 启动"
fi

brain_ping="$(api_get "$BRAIN/api/remotenode/ping" 5)"
pair_ping="$(api_get "$PAIR/api/remotenode/ping" 5)"
if [ -z "$brain_ping" ] || ! printf '%s' "$brain_ping" | jq -e '.ok == true' >/dev/null 2>&1; then
  bad "大脑实例不可用：$BRAIN（ping 响应：${brain_ping:-<空>}）"
  say "汇总：PASS=$PASS FAIL=$FAIL（环境未就绪，退出码 2）"; exit 2
fi
if [ -z "$pair_ping" ] || ! printf '%s' "$pair_ping" | jq -e '.ok == true' >/dev/null 2>&1; then
  bad "临时 pair-node 不可用：$PAIR（ping 响应：${pair_ping:-<空>}）"
  say "汇总：PASS=$PASS FAIL=$FAIL（环境未就绪，退出码 2）"; exit 2
fi
brain_state="$(state_of "$BRAIN")"
pair_state="$(state_of "$PAIR")"
brain_node_id="$(printf '%s' "$brain_state" | jq -r '.self.nodeId // "?"' 2>/dev/null)"
pair_node_id="$(printf '%s' "$pair_state" | jq -r '.self.nodeId // "?"' 2>/dev/null)"
if [ "$brain_node_id" != "$BRAIN_NODE_ID" ]; then
  bad "大脑 nodeId 期望 ${BRAIN_NODE_ID}，实际 ${brain_node_id}"
  say "汇总：PASS=$PASS FAIL=$FAIL（环境未就绪，退出码 2）"; exit 2
fi
if [ "$pair_node_id" != "$PAIR_NODE_ID" ]; then
  bad "临时节点 nodeId 期望 ${PAIR_NODE_ID}，实际 ${pair_node_id}"
  say "汇总：PASS=$PASS FAIL=$FAIL（环境未就绪，退出码 2）"; exit 2
fi
ok "两实例可用：3080 nodeId=${brain_node_id}；3082 nodeId=${pair_node_id}"

# §11 就绪检查：state.self 必须带 listenSource / listenOverride，且配对 API 就绪
brain_has_override="$(printf '%s' "$brain_state" | jq -r '.self | has("listenOverride")' 2>/dev/null)"
pair_has_override="$(printf '%s' "$pair_state" | jq -r '.self | has("listenOverride")' 2>/dev/null)"
pair_token="$(printf '%s' "$pair_state" | jq -r '.pairing.token // empty' 2>/dev/null)"
if [ "$brain_has_override" != "true" ] || [ "$pair_has_override" != "true" ] || [ -z "$pair_token" ]; then
  bad "Host 侧 §11 监听 API 尚未就绪：state.self.listenOverride 缺失（3080=${brain_has_override}, 3082=${pair_has_override}）或 pairing.token 缺失"
  info "等待 Lead 合入 lib/{settings-store,routes,peer-manager,index}.js 的 /listen 支持后重跑本脚本"
  say "汇总：PASS=$PASS FAIL=$FAIL（实现未就绪，退出码 2）"
  exit 2
fi
ok "§11 API 字段就绪：两侧 state.self 均含 listenSource/listenOverride，pairing token 可用"

# 基线快照：大脑原有 peers + config.json 指纹（测试后必须不变）
brain_baseline_peers="$(printf '%s' "$brain_state" | jq -c '[.peers[]? | {peerNodeId, source}]' 2>/dev/null)"
if [ -f "$BRAIN_CONFIG_MARKER" ]; then
  brain_config_md5="$(md5sum "$BRAIN_CONFIG_MARKER" 2>/dev/null | awk '{print $1}')"
fi
info "3080 基线 peers：${brain_baseline_peers}"

# 自愈：上次异常退出可能留下监听覆盖；本次从 config.json 默认值开始
pair_override="$(printf '%s' "$pair_state" | jq -r '.self.listenOverride // false' 2>/dev/null)"
if [ "$pair_override" = "true" ]; then
  info "检测到临时实例存在监听覆盖，先 reset 回 config.json 默认值"
  reset_pair_listen
  for _ in $(seq 1 30); do
    pair_override="$(state_of "$PAIR" | jq -r '.self.listenOverride // false' 2>/dev/null)"
    [ "$pair_override" = "false" ] && break
    sleep 0.5
  done
fi
info "3082 当前监听：$(state_of "$PAIR" | jq -c '.self.listen' 2>/dev/null)"

# 开测前清掉上一次异常运行可能留下的配对残留
sanitize_pairings '预清理'

# ---------------------------------------------------------------------------
# T1. 读取默认监听与令牌
# ---------------------------------------------------------------------------
say "T1 读取默认监听与配对令牌"
pair_state="$(state_of "$PAIR")"
pair_token="$(printf '%s' "$pair_state" | jq -r '.pairing.token // empty' 2>/dev/null)"
default_listen="$(printf '%s' "$pair_state" | jq -c '.self.listen // {}' 2>/dev/null)"
default_host="$(printf '%s' "$pair_state" | jq -r '.self.listen.host // "?"' 2>/dev/null)"
default_enabled="$(printf '%s' "$pair_state" | jq -r '.self.listen.enabled // false' 2>/dev/null)"
default_override="$(printf '%s' "$pair_state" | jq -r '.self.listenOverride | if . == null then "?" else tostring end' 2>/dev/null)"
default_source="$(printf '%s' "$pair_state" | jq -r '.self.listenSource // "?"' 2>/dev/null)"
info "3082 self.listen=${default_listen}，listenSource=${default_source}，listenOverride=${default_override}"

if [ -n "$pair_token" ] && printf '%s' "$pair_token" | grep -Eq '^[0-9a-f]{64}$'; then
  ok "3082 pairing.token 合法（64 hex，指纹 ${pair_token:0:8}…）"
else
  bad "3082 pairing.token 非法或缺失（长度 ${#pair_token}）"
  say "汇总：PASS=$PASS FAIL=$FAIL"; exit 1
fi
if [ "$default_enabled" = "true" ] && [ "${default_listen}" != "{}" ] \
   && [ "$(printf '%s' "$pair_state" | jq -r '.self.listen.port // 0' 2>/dev/null)" = "$DEFAULT_LISTEN_PORT" ]; then
  ok "默认监听为 config.json 的 ${default_host}:${DEFAULT_LISTEN_PORT}（enabled=true）"
else
  bad "默认监听异常：期望 127.0.0.1:${DEFAULT_LISTEN_PORT} enabled=true，实际 ${default_listen}"
fi
if [ "$default_override" = "false" ]; then
  ok "初始 state.self.listenOverride=false（无运行时覆盖）"
else
  bad "初始 listenOverride 期望 false，实际 ${default_override}"
fi
if port_listening "$DEFAULT_LISTEN_PORT"; then
  ok "端口 ${DEFAULT_LISTEN_PORT} 处于 LISTEN"
else
  bad "端口 ${DEFAULT_LISTEN_PORT} 未 LISTEN（初始监听未生效）"
fi

# ---------------------------------------------------------------------------
# T2. POST /listen 改到自定义端口
# ---------------------------------------------------------------------------
say "T2 POST /listen 改监听为 ${CUSTOM_HOST}:${CUSTOM_PORT}"
listen_body="$(jbody --arg host "$CUSTOM_HOST" --argjson port "$CUSTOM_PORT" '{enabled:true, host:$host, port:$port}')"
listen_resp="$(api_post "$PAIR/api/remotenode/listen" "$listen_body" 20)"
info "POST /listen → ${listen_resp:-<空>}"
if printf '%s' "$listen_resp" | jq -e '.ok == true' >/dev/null 2>&1; then
  ok "/listen 返回 ok:true"
else
  bad "/listen 修改监听失败：${listen_resp:-<空>}"
fi

new_listen='{}'; new_override='?'; new_source='?'
for _ in $(seq 1 30); do
  pair_state="$(state_of "$PAIR")"
  new_listen="$(printf '%s' "$pair_state" | jq -c '.self.listen // {}' 2>/dev/null)"
  new_port="$(printf '%s' "$pair_state" | jq -r '.self.listen.port // 0' 2>/dev/null)"
  new_override="$(printf '%s' "$pair_state" | jq -r '.self.listenOverride | if . == null then "?" else tostring end' 2>/dev/null)"
  new_source="$(printf '%s' "$pair_state" | jq -r '.self.listenSource // "?"' 2>/dev/null)"
  [ "$new_port" = "$CUSTOM_PORT" ] && [ "$new_override" = "true" ] && break
  sleep 0.5
done
info "3082 self.listen=${new_listen}，listenSource=${new_source}，listenOverride=${new_override}"

if [ "$(printf '%s' "$pair_state" | jq -r '.self.listen.port // 0' 2>/dev/null)" = "$CUSTOM_PORT" ]; then
  ok "state.self.listen.port=${CUSTOM_PORT}"
else
  bad "state.self.listen.port 期望 ${CUSTOM_PORT}，实际 $(printf '%s' "$pair_state" | jq -r '.self.listen.port // "?"' 2>/dev/null)"
fi
if [ "$(printf '%s' "$pair_state" | jq -r '.self.listen.host // ""' 2>/dev/null)" = "$CUSTOM_HOST" ]; then
  ok "state.self.listen.host=${CUSTOM_HOST}"
else
  bad "state.self.listen.host 期望 ${CUSTOM_HOST}，实际 $(printf '%s' "$pair_state" | jq -r '.self.listen.host // "?"' 2>/dev/null)"
fi
if [ "$new_override" = "true" ] && [ "$new_source" = "settings" ]; then
  ok "listenOverride=true、listenSource=settings（运行时覆盖已生效）"
else
  bad "listenOverride/listenSource 期望 true/settings，实际 ${new_override}/${new_source}"
fi

# 新端口 LISTEN / 旧端口不再 LISTEN（给内核一点时间）
for _ in $(seq 1 20); do
  if port_listening "$CUSTOM_PORT" && ! port_listening "$DEFAULT_LISTEN_PORT"; then break; fi
  sleep 0.25
done
if port_listening "$CUSTOM_PORT"; then
  ok "ss: ${CUSTOM_PORT} LISTEN（${CUSTOM_HOST}）"
else
  bad "ss: ${CUSTOM_PORT} 未 LISTEN"
fi
if port_listening "$DEFAULT_LISTEN_PORT"; then
  bad "旧端口 ${DEFAULT_LISTEN_PORT} 仍在 LISTEN（应已关闭）"
else
  ok "旧端口 ${DEFAULT_LISTEN_PORT} 已不再 LISTEN"
fi
if tcp_connectable "$CUSTOM_PORT"; then
  ok "新端口 127.0.0.1:${CUSTOM_PORT} 可建立 TCP 连接"
else
  bad "新端口 127.0.0.1:${CUSTOM_PORT} 不可连接"
fi
if tcp_connectable "$DEFAULT_LISTEN_PORT"; then
  bad "旧端口 127.0.0.1:${DEFAULT_LISTEN_PORT} 仍可连接（应拒绝）"
else
  ok "旧端口 127.0.0.1:${DEFAULT_LISTEN_PORT} 已不可连接（connection refused）"
fi

# ---------------------------------------------------------------------------
# T3. 用新端口 + 新令牌配对
# ---------------------------------------------------------------------------
say "T3 3080 用新端口 ${CUSTOM_PORT} + token 发起配对 → 3082 审批 → 双方 online"
pair_req_body="$(jbody --arg host 127.0.0.1 --argjson port "$CUSTOM_PORT" --arg token "$pair_token" \
  '{host:$host, port:$port, token:$token}')"
pair_resp_file="${WORK}/pair-listen-response.json"
: > "$pair_resp_file"
curl -sS -m 130 -X POST -H 'content-type: application/json' -d "$pair_req_body" \
  "$BRAIN/api/remotenode/peers/pair" > "$pair_resp_file" 2>/dev/null &
pair_curl_pid=$!

request_id=''
for _ in $(seq 1 160); do
  pending_json="$(state_of "$PAIR" | jq -c --arg nid "$BRAIN_NODE_ID" '[.pendingPairs[]? | select(.nodeId == $nid)][0] // null' 2>/dev/null)"
  request_id="$(printf '%s' "$pending_json" | jq -r '.requestId // empty' 2>/dev/null)"
  [ -n "$request_id" ] && break
  if ! kill -0 "$pair_curl_pid" 2>/dev/null; then break; fi
  sleep 0.25
done
if [ -n "$request_id" ]; then
  ok "3082 pendingPairs 出现 ${BRAIN_NODE_ID} 配对请求（requestId=${request_id}…）"
else
  wait "$pair_curl_pid" 2>/dev/null
  info "pair 提前返回：$(cat "$pair_resp_file" 2>/dev/null)"
  bad "3082 pendingPairs 未出现配对请求（新端口 ${CUSTOM_PORT} 未被配对流程使用？）"
  say "汇总：PASS=$PASS FAIL=$FAIL"; exit 1
fi

approve_resp="$(api_post "$PAIR/api/remotenode/peers/approve" "$(jbody --arg rid "$request_id" '{requestId:$rid, approve:true}')")"
if printf '%s' "$approve_resp" | jq -e '.ok == true' >/dev/null 2>&1; then
  ok "3082 审批返回 ok:true（${approve_resp}）"
else
  bad "审批失败：${approve_resp:-<空>}"
  say "汇总：PASS=$PASS FAIL=$FAIL"; exit 1
fi

wait "$pair_curl_pid" 2>/dev/null
pair_resp="$(cat "$pair_resp_file" 2>/dev/null)"
if printf '%s' "$pair_resp" | jq -e '.ok == true and .paired == true and .peer.peerNodeId == "'"$PAIR_NODE_ID"'"' >/dev/null 2>&1; then
  ok "3080 pair 返回 ok:true、paired:true（peer=$(printf '%s' "$pair_resp" | jq -c '.peer | {peerNodeId, source, removable}' 2>/dev/null)）"
else
  bad "3080 pair 返回异常：${pair_resp:-<空>}"
  say "汇总：PASS=$PASS FAIL=$FAIL"; exit 1
fi

brain_peer='null'; pair_peer='null'
for _ in $(seq 1 80); do
  brain_peer="$(state_of "$BRAIN" | jq -c --arg id "$PAIR_NODE_ID" '[.peers[]? | select(.peerNodeId == $id)][0] // null' 2>/dev/null)"
  pair_peer="$(state_of "$PAIR" | jq -c --arg id "$BRAIN_NODE_ID" '[.peers[]? | select(.peerNodeId == $id)][0] // null' 2>/dev/null)"
  if [ "$(printf '%s' "$brain_peer" | jq -r '.state // "?"' 2>/dev/null)" = "online" ] \
     && [ "$(printf '%s' "$pair_peer" | jq -r '.state // "?"' 2>/dev/null)" = "online" ]; then
    break
  fi
  sleep 0.5
done
info "3080 → ${PAIR_NODE_ID}: ${brain_peer}"
info "3082 → ${BRAIN_NODE_ID}: ${pair_peer}"
if [ "$(printf '%s' "$brain_peer" | jq -r '.state // "?"' 2>/dev/null)" = "online" ]; then
  ok "3080 看到 ${PAIR_NODE_ID} state=online（source=$(printf '%s' "$brain_peer" | jq -r '.source // "?"' 2>/dev/null)）"
else
  bad "3080 未看到 ${PAIR_NODE_ID} online（当前：${brain_peer}）"
fi
if [ "$(printf '%s' "$pair_peer" | jq -r '.state // "?"' 2>/dev/null)" = "online" ]; then
  ok "3082 看到 ${BRAIN_NODE_ID} state=online（source=$(printf '%s' "$pair_peer" | jq -r '.source // "?"' 2>/dev/null)）"
else
  bad "3082 未看到 ${BRAIN_NODE_ID} online（当前：${pair_peer}）"
fi

# ---------------------------------------------------------------------------
# T4. 失败分支：改到被占用端口
# ---------------------------------------------------------------------------
say "T4 失败分支：POST /listen 到被占用端口 ${BUSY_PORT}"
# 用 Node 临时监听 BUSY_PORT 模拟“端口被占用”
"$NODE_BIN" -e '
  const net = require("node:net")
  const port = Number(process.argv[1])
  const server = net.createServer(socket => socket.destroy())
  server.listen(port, "127.0.0.1", () => console.log(`busy on ${port}`))
  setInterval(() => {}, 1 << 30)
' "$BUSY_PORT" > "${WORK}/busy-port.log" 2>&1 &
busy_pid=$!
busy_ok=0
for _ in $(seq 1 40); do
  if port_listening "$BUSY_PORT"; then busy_ok=1; break; fi
  sleep 0.25
done
if [ "$busy_ok" -eq 1 ]; then
  info "临时占用端口 ${BUSY_PORT} 已就绪（pid ${busy_pid}）"
else
  bad "无法临时占用端口 ${BUSY_PORT}，失败分支无法验证"
fi

if [ "$busy_ok" -eq 1 ]; then
  busy_body="$(jbody --arg host 127.0.0.1 --argjson port "$BUSY_PORT" '{enabled:true, host:$host, port:$port}')"
  busy_resp="$(api_post "$PAIR/api/remotenode/listen" "$busy_body" 20)"
  info "POST /listen（被占用端口）→ ${busy_resp:-<空>}"
  if printf '%s' "$busy_resp" | jq -e '.ok == false' >/dev/null 2>&1; then
    ok "改到被占用端口被拒绝：ok:false（error=$(printf '%s' "$busy_resp" | jq -r '.error // "?"' 2>/dev/null)）"
  else
    bad "改到被占用端口未被拒绝（响应：${busy_resp:-<空>}）"
  fi
  # 原监听保持不变
  after_fail_state="$(state_of "$PAIR")"
  if [ "$(printf '%s' "$after_fail_state" | jq -r '.self.listen.port // 0' 2>/dev/null)" = "$CUSTOM_PORT" ]; then
    ok "失败后 state.self.listen.port 仍为 ${CUSTOM_PORT}（原监听未被破坏）"
  else
    bad "失败后 state.self.listen.port 变为 $(printf '%s' "$after_fail_state" | jq -r '.self.listen.port // "?"' 2>/dev/null)（期望 ${CUSTOM_PORT}）"
  fi
  if port_listening "$CUSTOM_PORT"; then
    ok "失败后原监听端口 ${CUSTOM_PORT} 仍 LISTEN"
  else
    bad "失败后原监听端口 ${CUSTOM_PORT} 不再 LISTEN"
  fi
  # 链路仍 online
  link_ok=0
  for _ in $(seq 1 10); do
    b_now="$(state_of "$BRAIN" | jq -r --arg id "$PAIR_NODE_ID" '[.peers[]? | select(.peerNodeId == $id)][0].state // "?"' 2>/dev/null)"
    p_now="$(state_of "$PAIR" | jq -r --arg id "$BRAIN_NODE_ID" '[.peers[]? | select(.peerNodeId == $id)][0].state // "?"' 2>/dev/null)"
    if [ "$b_now" = "online" ] && [ "$p_now" = "online" ]; then link_ok=1; break; fi
    sleep 0.5
  done
  if [ "$link_ok" -eq 1 ]; then
    ok "监听修改失败后已建立链路仍 online（3080↔3082）"
  else
    bad "监听修改失败后链路异常（3080=${b_now:-?}, 3082=${p_now:-?}）"
  fi
  kill_busy
fi

# ---------------------------------------------------------------------------
# T5. reset:true 回到 config.json 默认监听
# ---------------------------------------------------------------------------
say "T5 POST /listen {reset:true} → 回到 config.json 的 ${DEFAULT_LISTEN_PORT}"
reset_resp="$(api_post "$PAIR/api/remotenode/listen" "$(jbody '{reset:true}')" 20)"
info "POST /listen {reset:true} → ${reset_resp:-<空>}"
if printf '%s' "$reset_resp" | jq -e '.ok == true' >/dev/null 2>&1; then
  ok "reset 返回 ok:true"
else
  bad "reset 失败：${reset_resp:-<空>}"
fi

reset_override='?'; reset_source='?'
for _ in $(seq 1 40); do
  pair_state="$(state_of "$PAIR")"
  reset_override="$(printf '%s' "$pair_state" | jq -r '.self.listenOverride | if . == null then "?" else tostring end' 2>/dev/null)"
  reset_source="$(printf '%s' "$pair_state" | jq -r '.self.listenSource // "?"' 2>/dev/null)"
  reset_port="$(printf '%s' "$pair_state" | jq -r '.self.listen.port // 0' 2>/dev/null)"
  if [ "$reset_override" = "false" ] && [ "$reset_port" = "$DEFAULT_LISTEN_PORT" ]; then break; fi
  sleep 0.5
done
info "3082 self.listen=$(printf '%s' "$pair_state" | jq -c '.self.listen' 2>/dev/null)，listenSource=${reset_source}，listenOverride=${reset_override}"
if [ "$reset_override" = "false" ] && [ "$reset_source" = "config" ]; then
  ok "reset 后 listenOverride=false、listenSource=config"
else
  bad "reset 后 listenOverride/listenSource 期望 false/config，实际 ${reset_override}/${reset_source}"
fi
if [ "$(printf '%s' "$pair_state" | jq -r '.self.listen.port // 0' 2>/dev/null)" = "$DEFAULT_LISTEN_PORT" ]; then
  ok "state.self.listen.port 回到 ${DEFAULT_LISTEN_PORT}"
else
  bad "state.self.listen.port 期望 ${DEFAULT_LISTEN_PORT}，实际 $(printf '%s' "$pair_state" | jq -r '.self.listen.port // "?"' 2>/dev/null)"
fi
for _ in $(seq 1 20); do
  if port_listening "$DEFAULT_LISTEN_PORT" && ! port_listening "$CUSTOM_PORT"; then break; fi
  sleep 0.25
done
if port_listening "$DEFAULT_LISTEN_PORT"; then
  ok "${DEFAULT_LISTEN_PORT} 重新 LISTEN（默认监听已恢复）"
else
  bad "${DEFAULT_LISTEN_PORT} 未重新 LISTEN"
fi
if port_listening "$CUSTOM_PORT"; then
  bad "自定义端口 ${CUSTOM_PORT} 仍 LISTEN（应释放）"
else
  ok "自定义端口 ${CUSTOM_PORT} 已释放"
fi
# §11.3：监听重建不影响已建立链路
link_ok=0
for _ in $(seq 1 20); do
  b_now="$(state_of "$BRAIN" | jq -r --arg id "$PAIR_NODE_ID" '[.peers[]? | select(.peerNodeId == $id)][0].state // "?"' 2>/dev/null)"
  p_now="$(state_of "$PAIR" | jq -r --arg id "$BRAIN_NODE_ID" '[.peers[]? | select(.peerNodeId == $id)][0].state // "?"' 2>/dev/null)"
  if [ "$b_now" = "online" ] && [ "$p_now" = "online" ]; then link_ok=1; break; fi
  sleep 0.5
done
if [ "$link_ok" -eq 1 ]; then
  ok "reset 重建监听后已建立链路仍 online（未受影响）"
else
  bad "reset 后链路异常（3080=${b_now:-?}, 3082=${p_now:-?}）"
fi
# 可选观察：§11.2 peer.listen 通知应把 3080 侧 paired 记录的 port 更新回 47401
peer_listen_updated=0
for _ in $(seq 1 20); do
  if [ -f "$BRAIN_PEERS_FILE" ]; then
    recorded_port="$(jq -r --arg id "$PAIR_NODE_ID" '[.peers[]? | select(.nodeId == $id)][0].port // empty' "$BRAIN_PEERS_FILE" 2>/dev/null)"
    if [ "$recorded_port" = "$DEFAULT_LISTEN_PORT" ]; then peer_listen_updated=1; break; fi
  fi
  sleep 0.5
done
if [ "$peer_listen_updated" -eq 1 ]; then
  ok "peer.listen 通知生效：3080 的 paired 记录 port 已更新为 ${DEFAULT_LISTEN_PORT}"
else
  info "未观察到 3080 paired 记录 port 更新（§11.2 peer.listen 通知观察项，不影响主流程）"
fi

# ---------------------------------------------------------------------------
# T6. 清理（生产实例零残留）
# ---------------------------------------------------------------------------
say "T6 清理：删除配对、确认 3080 只剩原有 config 节点"
remove_brain="$(api_post "$BRAIN/api/remotenode/peers/remove" "$(jbody --arg id "$PAIR_NODE_ID" '{peerNodeId:$id}')")"
info "3080 remove ${PAIR_NODE_ID} → ${remove_brain:-<空>}"
if printf '%s' "$remove_brain" | jq -e '.ok == true' >/dev/null 2>&1; then
  ok "3080 删除 ${PAIR_NODE_ID} 返回 ok:true"
else
  bad "3080 删除 ${PAIR_NODE_ID} 失败：${remove_brain:-<空>}"
fi
revoke_seen=0
for _ in $(seq 1 20); do
  p_now="$(state_of "$PAIR" | jq -c '[.peers[]? | .peerNodeId]' 2>/dev/null)"
  if ! printf '%s' "$p_now" | grep -q "\"${BRAIN_NODE_ID}\""; then revoke_seen=1; break; fi
  sleep 0.25
done
if [ "$revoke_seen" -eq 1 ]; then
  ok "3082 收到 pair.revoke 后已自动移除 ${BRAIN_NODE_ID}"
else
  info "3082 未观察到自动 revoke 移除（用显式 /peers/remove 清理）"
fi
remove_pair="$(api_post "$PAIR/api/remotenode/peers/remove" "$(jbody --arg id "$BRAIN_NODE_ID" '{peerNodeId:$id}')")"
info "3082 remove（幂等兜底）→ ${remove_pair:-<空>}"
if printf '%s' "$remove_pair" | jq -e '.ok == true' >/dev/null 2>&1; then
  ok "3082 删除 ${BRAIN_NODE_ID} 返回 ok:true"
else
  bad "3082 删除 ${BRAIN_NODE_ID} 失败：${remove_pair:-<空>}"
fi

b_peers_json='[]'; p_peers_json='[]'
for _ in $(seq 1 40); do
  b_peers_json="$(state_of "$BRAIN" | jq -c '[.peers[]? | .peerNodeId]' 2>/dev/null)"
  p_peers_json="$(state_of "$PAIR" | jq -c '[.peers[]? | .peerNodeId]' 2>/dev/null)"
  if ! printf '%s' "$b_peers_json" | grep -q "\"${PAIR_NODE_ID}\"" \
     && ! printf '%s' "$p_peers_json" | grep -q "\"${BRAIN_NODE_ID}\""; then
    break
  fi
  sleep 0.5
done
info "3080 peers：${b_peers_json}"
info "3082 peers：${p_peers_json}"
if printf '%s' "$b_peers_json" | jq -e --arg id "$PAIR_NODE_ID" 'index($id) == null' >/dev/null 2>&1; then
  ok "3080 peers 已移除 ${PAIR_NODE_ID}"
else
  bad "3080 peers 仍含 ${PAIR_NODE_ID}"
fi
if printf '%s' "$p_peers_json" | jq -e --arg id "$BRAIN_NODE_ID" 'index($id) == null' >/dev/null 2>&1; then
  ok "3082 peers 已移除 ${BRAIN_NODE_ID}"
else
  bad "3082 peers 仍含 ${BRAIN_NODE_ID}"
fi

# 大脑原有节点保留 + pendingPairs 空
baseline_ids="$(printf '%s' "$brain_baseline_peers" | jq -r --arg pid "$PAIR_NODE_ID" '.[] | select(.peerNodeId != $pid) | .peerNodeId' 2>/dev/null)"
missing_baseline='[]'
for base_id in $baseline_ids; do
  if ! printf '%s' "$b_peers_json" | grep -q "\"${base_id}\""; then
    missing_baseline="$(printf '%s' "$missing_baseline" | jq -c --arg id "$base_id" '. + [$id]')"
  fi
done
if [ "$missing_baseline" = '[]' ]; then
  baseline_display="$(printf '%s' "$brain_baseline_peers" | jq -c --arg pid "$PAIR_NODE_ID" '[.[] | select(.peerNodeId != $pid) | .peerNodeId]' 2>/dev/null)"
  ok "3080 原有节点全部保留（${baseline_display}）"
else
  bad "3080 原有节点丢失：${missing_baseline}"
fi
b_pending="$(state_of "$BRAIN" | jq -c '.pendingPairs // []' 2>/dev/null)"
if [ "$b_pending" = '[]' ] || [ -z "$b_pending" ]; then
  ok "3080 pendingPairs 无残留（${b_pending:-空}）"
else
  bad "3080 pendingPairs 有残留：${b_pending}"
fi
if [ -f "$BRAIN_PEERS_FILE" ]; then
  if grep -q "$PAIR_NODE_ID" "$BRAIN_PEERS_FILE" 2>/dev/null; then
    bad "3080 peers.json 仍含 ${PAIR_NODE_ID} 残留"
  else
    ok "3080 peers.json 无 ${PAIR_NODE_ID} 残留（只读校验）"
  fi
else
  ok "3080 无 peers.json 持久化文件（无残留）"
fi
if [ -n "$brain_config_md5" ]; then
  brain_config_md5_after="$(md5sum "$BRAIN_CONFIG_MARKER" 2>/dev/null | awk '{print $1}')"
  if [ "$brain_config_md5" = "$brain_config_md5_after" ]; then
    ok "大脑 /root/.dsh/remotenode/config.json 未被修改（md5 一致）"
  else
    bad "大脑 config.json 被修改：${brain_config_md5} → ${brain_config_md5_after}"
  fi
fi

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
say "汇总"
info "3080 终态 peers：$(state_of "$BRAIN" | jq -c '[.peers[]? | {peerNodeId, state, source}]' 2>/dev/null)"
info "3082 终态 listen：$(state_of "$PAIR" | jq -c '.self.listen' 2>/dev/null)"
info "3082 终态 peers：$(state_of "$PAIR" | jq -c '[.peers[]? | {peerNodeId, state, source}]' 2>/dev/null)"
printf '\n  PASS=%d  FAIL=%d\n' "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
  printf '  \033[32m结果：全部通过 ✓\033[0m\n'
  exit 0
else
  printf '  \033[31m结果：存在失败项 ✗\033[0m\n'
  exit 1
fi
