#!/usr/bin/env bash
# =============================================================================
# e2e-pairing.sh — remotenode「UI 配对」流程端到端验证（curl 驱动 HTTP API）
#
# 契约：plugins/remotenode/SPEC.md §10（节点管理：UI 配对 / 审批 / 删除）
# 两个实例：
#   大脑   : http://127.0.0.1:3080  (DSH_HOME=/root/.dsh,    nodeId=brain-linux，生产实例，只经 API 增删)
#   配对节点: http://127.0.0.1:3082  (DSH_HOME=/tmp/.dsh-pair-node, nodeId=pair-node，一次性实例)
#
# 流程：
#   T0 前置：两实例 ping/state 可用、§10 pairing API 字段就绪（未就绪 → 明确报错并退出码 2）
#   T1 从 3082 state 读取 pairing.token（只回显指纹片段）
#   T2 3080 POST /peers/pair {host,port:47401,token}（后台等待）→ 3082 pendingPairs 出现 brain-linux
#   T3 3082 POST /peers/approve {requestId, approve:true}
#   T4 3080 pair 请求返回 {ok:true, paired:true}
#   T5 两侧 state.peers 出现对端且 online、source=paired、removable=true
#   T6 双向删除：3080 remove pair-node、3082 remove brain-linux
#   T7 清理校验：两侧 peers 移除、3080 pendingPairs 空、3080 原配置节点不变、
#      3080 peers.json 无 pair-node 残留、/root/.dsh/remotenode/config.json 未被修改
#   T8 失败分支：3082 用错误 token 向 3080 发起 pair → ok:false（且不产生待审批残留）
#
# 行为：默认自动 setup 配对节点（--fresh 换新令牌）→ 跑测试 → 无论成败都尽力清理
#       3080/3082 的配对残留 → 默认最后停止配对节点。输出 PASS/FAIL 汇总与正确退出码：
#       0=全部通过；1=有测试失败；2=环境/实现未就绪。
#
# 用法：
#   bash scripts/e2e-pairing.sh            # 全自动：setup → 测试 → 清理 → stop
#   bash scripts/e2e-pairing.sh --keep     # 结束后保留配对节点运行（便于排查/UI 查看）
#   bash scripts/e2e-pairing.sh --no-setup # 不自动 setup（假定 3082 已在跑），默认也不停止它
# =============================================================================
set -uo pipefail

BRAIN="${BRAIN_URL:-http://127.0.0.1:3080}"
PAIR="${PAIR_URL:-http://127.0.0.1:3082}"
BRAIN_NODE_ID='brain-linux'
PAIR_NODE_ID='pair-node'
PAIR_LISTEN_PORT=47401
PAIR_HOME=/tmp/.dsh-pair-node
WORK="${WORK_DIR:-/tmp/remotenode-pairing-e2e}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRAIN_CONFIG_MARKER='/root/.dsh/remotenode/config.json'
BRAIN_PEERS_FILE='/root/.dsh/remotenode/data/peers.json'
PAIR_PEERS_FILE="${PAIR_HOME}/remotenode/data/peers.json"

KEEP=0
SETUP=1
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --no-setup) SETUP=0; KEEP=1 ;;
    -h|--help) sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$arg（用法：bash scripts/e2e-pairing.sh [--keep] [--no-setup]）" >&2; exit 2 ;;
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

api_get()  { curl -sS -m "${2:-10}" "$1" 2>/dev/null; }
api_post() { # url body [max_time]
  curl -sS -m "${3:-30}" -X POST -H 'content-type: application/json' -d "$2" "$1" 2>/dev/null
}
state_of() { api_get "$1/api/remotenode/state" "${2:-5}"; }
state_field() { state_of "$1" | jq -r "$2" 2>/dev/null; }
jbody() { jq -nc "$@" 2>/dev/null; }

# 基线：大脑原有 peers 列表 + config.json 指纹（测试后必须不变）
brain_baseline_peers='[]'
brain_config_md5=''
pair_baseline_peers='[]'

# ---------------------------------------------------------------------------
# 清理：删除两侧配对残留（幂等、多轮重试），供 trap 与开测前止损共用
# ---------------------------------------------------------------------------
sanitize_pairings() {
  local tag="$1"
  local i b_peers p_peers need_clean removed=0
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
  if [ "$removed" -eq 0 ]; then info "[$tag] 两侧均无配对残留"; fi
}

cleanup_on_exit() {
  local code=$?
  trap - EXIT INT TERM
  say "清理：确保大脑 3080 不残留 ${PAIR_NODE_ID}、临时节点 3082 不残留 ${BRAIN_NODE_ID}"
  sanitize_pairings '清理'
  # 终态复核（尽力而为，不改变退出码）
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
  info "运行 setup-pair-node.sh --fresh（停止旧实例 → 初始化/安装 → 启动 3082，换发新配对令牌）"
  if ! bash "$SCRIPT_DIR/setup-pair-node.sh" --fresh; then
    bad "setup-pair-node.sh 失败，无法继续"
    say "汇总：PASS=$PASS FAIL=$FAIL（环境未就绪，退出码 2）"
    exit 2
  fi
else
  info "跳过 setup（--no-setup）；假定 3082 已由 setup-pair-node.sh 启动"
fi

brain_ping="$(api_get "$BRAIN/api/remotenode/ping" 5)"
pair_ping="$(api_get "$PAIR/api/remotenode/ping" 5)"
if [ -z "$brain_ping" ] || ! printf '%s' "$brain_ping" | jq -e '.ok == true' >/dev/null 2>&1; then
  bad "大脑实例不可用：$BRAIN（ping 响应：${brain_ping:-<空>}）"
  say "汇总：PASS=$PASS FAIL=$FAIL（环境未就绪，退出码 2）"; exit 2
fi
if [ -z "$pair_ping" ] || ! printf '%s' "$pair_ping" | jq -e '.ok == true' >/dev/null 2>&1; then
  bad "配对测试节点不可用：$PAIR（ping 响应：${pair_ping:-<空>}）"
  say "汇总：PASS=$PASS FAIL=$FAIL（环境未就绪，退出码 2）"; exit 2
fi

brain_state="$(state_of "$BRAIN")"
pair_state="$(state_of "$PAIR")"
brain_node_id="$(printf '%s' "$brain_state" | jq -r '.self.nodeId // "?"' 2>/dev/null)"
pair_node_id="$(printf '%s' "$pair_state" | jq -r '.self.nodeId // "?"' 2>/dev/null)"
if [ "$brain_node_id" != "$BRAIN_NODE_ID" ]; then
  bad "大脑 nodeId 期望 ${BRAIN_NODE_ID}，实际 ${brain_node_id}（确认 3080 是生产大脑实例）"
  say "汇总：PASS=$PASS FAIL=$FAIL（环境未就绪，退出码 2）"; exit 2
fi
if [ "$pair_node_id" != "$PAIR_NODE_ID" ]; then
  bad "配对节点 nodeId 期望 ${PAIR_NODE_ID}，实际 ${pair_node_id}（确认 3082 是 setup-pair-node.sh 启动的实例）"
  say "汇总：PASS=$PASS FAIL=$FAIL（环境未就绪，退出码 2）"; exit 2
fi
ok "两实例可用：3080 nodeId=${brain_node_id}；3082 nodeId=${pair_node_id}"

brain_has_pairing="$(printf '%s' "$brain_state" | jq -r 'has("pairing")' 2>/dev/null)"
pair_has_pairing="$(printf '%s' "$pair_state" | jq -r 'has("pairing")' 2>/dev/null)"
if [ "$brain_has_pairing" != "true" ] || [ "$pair_has_pairing" != "true" ]; then
  bad "Host 侧 §10 配对实现尚未就绪：state.pairing 缺失（3080=${brain_has_pairing}, 3082=${pair_has_pairing}）"
  info "等待 Lead 合入 lib/pairing.js + /peers/pair|approve|remove API 后重跑本脚本"
  say "汇总：PASS=$PASS FAIL=$FAIL（实现未就绪，退出码 2）"
  exit 2
fi
ok "§10 API 字段就绪：两侧 state 均含 pairing / pendingPairs"

# 基线快照（清理残留前先记录「原有节点」，用于最终“生产实例未被扰动”校验）
brain_baseline_peers="$(printf '%s' "$brain_state" | jq -c '[.peers[]? | {peerNodeId, source}]' 2>/dev/null)"
pair_baseline_peers="$(printf '%s' "$pair_state" | jq -c '[.peers[]? | {peerNodeId, source}]' 2>/dev/null)"
if [ -f "$BRAIN_CONFIG_MARKER" ]; then
  brain_config_md5="$(md5sum "$BRAIN_CONFIG_MARKER" 2>/dev/null | awk '{print $1}')"
fi
info "3080 基线 peers：${brain_baseline_peers}"
info "3082 基线 peers：${pair_baseline_peers}"

# 开测前清掉上一次异常运行可能留下的配对残留
sanitize_pairings '预清理'

# ---------------------------------------------------------------------------
# T1. 读取配对令牌
# ---------------------------------------------------------------------------
say "T1 从 3082 state 读取 pairing.token"
pair_state="$(state_of "$PAIR")"
pairing_token="$(printf '%s' "$pair_state" | jq -r '.pairing.token // empty' 2>/dev/null)"
fixed_by_config="$(printf '%s' "$pair_state" | jq -r '.pairing.fixedByConfig // false' 2>/dev/null)"
if [ -n "$pairing_token" ] && printf '%s' "$pairing_token" | grep -Eq '^[0-9a-f]{64}$'; then
  ok "3082 pairing.token 合法（64 hex，指纹 ${pairing_token:0:8}…；fixedByConfig=${fixed_by_config}）"
else
  bad "3082 pairing.token 非法或缺失（长度 ${#pairing_token}）：${pairing_token:0:12}…"
  say "汇总：PASS=$PASS FAIL=$FAIL"; exit 1
fi

# ---------------------------------------------------------------------------
# T2. 3080 → 3082 发起配对（客户端异步等待审批）
# ---------------------------------------------------------------------------
say "T2 3080 POST /peers/pair {host:127.0.0.1, port:${PAIR_LISTEN_PORT}, token}（后台等待 3082 审批）"
pair_req_body="$(jbody --arg host 127.0.0.1 --argjson port "$PAIR_LISTEN_PORT" --arg token "$pairing_token" \
  '{host:$host, port:$port, token:$token}')"
pair_resp_file="${WORK}/pair-forward-response.json"
pair_err_file="${WORK}/pair-forward-stderr.txt"
: > "$pair_resp_file"; : > "$pair_err_file"
curl -sS -m 130 -X POST -H 'content-type: application/json' -d "$pair_req_body" \
  "$BRAIN/api/remotenode/peers/pair" > "$pair_resp_file" 2> "$pair_err_file" &
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
  ok "3082 pendingPairs 出现 brain-linux 的配对请求（requestId=${request_id}…，等待审批）"
else
  wait "$pair_curl_pid" 2>/dev/null
  info "pair 提前返回：$(cat "$pair_resp_file" 2>/dev/null)"
  info "stderr：$(cat "$pair_err_file" 2>/dev/null)"
  bad "3082 pendingPairs 未出现 brain-linux 配对请求（超时 40s）"
  say "汇总：PASS=$PASS FAIL=$FAIL"; exit 1
fi

# ---------------------------------------------------------------------------
# T3. 3082 审批通过
# ---------------------------------------------------------------------------
say "T3 3082 POST /peers/approve {requestId, approve:true}"
approve_body="$(jbody --arg rid "$request_id" '{requestId:$rid, approve:true}')"
approve_resp="$(api_post "$PAIR/api/remotenode/peers/approve" "$approve_body")"
if printf '%s' "$approve_resp" | jq -e '.ok == true' >/dev/null 2>&1; then
  ok "审批返回 ok:true（$approve_resp）"
else
  bad "审批失败：${approve_resp:-<空>}"
  say "汇总：PASS=$PASS FAIL=$FAIL"; exit 1
fi

# ---------------------------------------------------------------------------
# T4. 3080 pair 请求返回
# ---------------------------------------------------------------------------
say "T4 等待 3080 /peers/pair 返回"
wait "$pair_curl_pid" 2>/dev/null
pair_resp="$(cat "$pair_resp_file" 2>/dev/null)"
if printf '%s' "$pair_resp" | jq -e '.ok == true and .paired == true and .peer.peerNodeId == "'"$PAIR_NODE_ID"'"' >/dev/null 2>&1; then
  ok "3080 pair 返回 ok:true、paired:true（peer=$(printf '%s' "$pair_resp" | jq -c '.peer | {peerNodeId, nodeName, source, removable}' 2>/dev/null)）"
else
  info "stderr：$(cat "$pair_err_file" 2>/dev/null)"
  bad "3080 pair 返回异常（期望 ok:true/paired:true/peer.peerNodeId=${PAIR_NODE_ID}）：${pair_resp:-<空>}"
  say "汇总：PASS=$PASS FAIL=$FAIL"; exit 1
fi

# ---------------------------------------------------------------------------
# T5. 两侧 peers 出现对端且 online（source=paired, removable=true）
# ---------------------------------------------------------------------------
say "T5 轮询两侧 state.peers：互相出现且 online、source=paired"
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
  ok "3080 看到 ${PAIR_NODE_ID} state=online"
else
  bad "3080 未看到 ${PAIR_NODE_ID} online（当前：${brain_peer}）"
fi
if [ "$(printf '%s' "$brain_peer" | jq -r '.source // "config"' 2>/dev/null)" = "paired" ]; then
  ok "3080 侧 ${PAIR_NODE_ID} source=paired、removable=$(printf '%s' "$brain_peer" | jq -r '.removable // false')"
else
  bad "3080 侧 ${PAIR_NODE_ID} source 期望 paired，实际 $(printf '%s' "$brain_peer" | jq -r '.source // "config"' 2>/dev/null)"
fi
if [ "$(printf '%s' "$pair_peer" | jq -r '.state // "?"' 2>/dev/null)" = "online" ]; then
  ok "3082 看到 ${BRAIN_NODE_ID} state=online"
else
  bad "3082 未看到 ${BRAIN_NODE_ID} online（当前：${pair_peer}）"
fi
if [ "$(printf '%s' "$pair_peer" | jq -r '.source // "config"' 2>/dev/null)" = "paired" ]; then
  ok "3082 侧 ${BRAIN_NODE_ID} source=paired、removable=$(printf '%s' "$pair_peer" | jq -r '.removable // false')"
else
  bad "3082 侧 ${BRAIN_NODE_ID} source 期望 paired，实际 $(printf '%s' "$pair_peer" | jq -r '.source // "config"' 2>/dev/null)"
fi

# ---------------------------------------------------------------------------
# T6. 双向删除
# ---------------------------------------------------------------------------
say "T6 双向删除：3080 remove ${PAIR_NODE_ID}；3082 remove ${BRAIN_NODE_ID}"
remove_brain="$(api_post "$BRAIN/api/remotenode/peers/remove" "$(jbody --arg id "$PAIR_NODE_ID" '{peerNodeId:$id}')")"
info "3080 remove → ${remove_brain:-<空>}"
if printf '%s' "$remove_brain" | jq -e '.ok == true' >/dev/null 2>&1; then
  ok "3080 删除 paired 节点 ${PAIR_NODE_ID} 返回 ok:true"
else
  bad "3080 删除 ${PAIR_NODE_ID} 失败：${remove_brain:-<空>}"
fi

# 删除会先向在线对端发 pair.revoke 通知（SPEC §10.3）：观察 3082 是否被自动移除
revoke_seen=0
for _ in $(seq 1 20); do
  p_now="$(state_of "$PAIR" | jq -c '[.peers[]? | .peerNodeId]' 2>/dev/null)"
  if ! printf '%s' "$p_now" | grep -q "\"${BRAIN_NODE_ID}\""; then revoke_seen=1; break; fi
  sleep 0.25
done
if [ "$revoke_seen" -eq 1 ]; then
  ok "3082 收到 pair.revoke 后已自动移除 ${BRAIN_NODE_ID}"
else
  info "3082 未观察到自动 revoke 移除（将用显式 /peers/remove 清理）"
fi

remove_pair="$(api_post "$PAIR/api/remotenode/peers/remove" "$(jbody --arg id "$BRAIN_NODE_ID" '{peerNodeId:$id}')")"
info "3082 remove（幂等兜底）→ ${remove_pair:-<空>}"
if printf '%s' "$remove_pair" | jq -e '.ok == true' >/dev/null 2>&1; then
  ok "3082 删除 paired 节点 ${BRAIN_NODE_ID} 返回 ok:true"
else
  bad "3082 删除 ${BRAIN_NODE_ID} 失败：${remove_pair:-<空>}"
fi

# ---------------------------------------------------------------------------
# T7. 清理校验（生产实例零残留）
# ---------------------------------------------------------------------------
say "T7 清理校验：peers 移除、链路断开、3080 无残留、原配置节点未被扰动"
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
if printf '%s' "$b_peers_json" | jq -e 'index("'"$PAIR_NODE_ID"'") == null' >/dev/null 2>&1; then
  ok "3080 peers 已移除 ${PAIR_NODE_ID}"
else
  bad "3080 peers 仍含 ${PAIR_NODE_ID}"
fi
if printf '%s' "$p_peers_json" | jq -e 'index("'"$BRAIN_NODE_ID"'") == null' >/dev/null 2>&1; then
  ok "3082 peers 已移除 ${BRAIN_NODE_ID}"
else
  bad "3082 peers 仍含 ${BRAIN_NODE_ID}"
fi

# 3080 pendingPairs 不应有残留
b_pending="$(state_of "$BRAIN" | jq -c '.pendingPairs // []' 2>/dev/null)"
if [ "$b_pending" = '[]' ] || [ -z "$b_pending" ]; then
  ok "3080 pendingPairs 无残留（${b_pending:-空}）"
else
  bad "3080 pendingPairs 有残留：${b_pending}"
fi

# 3080 原有（config）节点必须原样保留：基线里的 peerNodeId 一个都不能少
missing_baseline='[]'
baseline_ids="$(printf '%s' "$brain_baseline_peers" | jq -r --arg pid "$PAIR_NODE_ID" '.[] | select(.peerNodeId != $pid) | .peerNodeId' 2>/dev/null)"
for base_id in $baseline_ids; do
  if ! printf '%s' "$b_peers_json" | grep -q "\"${base_id}\""; then
    missing_baseline="$(printf '%s' "$missing_baseline" | jq -c --arg id "$base_id" '. + [$id]')"
  fi
done
if [ "$missing_baseline" = '[]' ]; then
  baseline_display="$(printf '%s' "$brain_baseline_peers" | jq -c --arg pid "$PAIR_NODE_ID" '[.[] | select(.peerNodeId != $pid) | .peerNodeId]' 2>/dev/null)"
  ok "3080 原有节点全部保留（基线：${baseline_display}）"
else
  bad "3080 原有节点丢失：${missing_baseline}"
fi

# 3080 持久化文件无 pair-node 残留（只读校验，不修改）
if [ -f "$BRAIN_PEERS_FILE" ]; then
  if grep -q "$PAIR_NODE_ID" "$BRAIN_PEERS_FILE" 2>/dev/null; then
    bad "3080 peers.json 仍含 ${PAIR_NODE_ID}（残留：${BRAIN_PEERS_FILE}）"
  else
    ok "3080 peers.json 无 ${PAIR_NODE_ID} 残留（只读校验）"
  fi
else
  ok "3080 无 peers.json 持久化文件（无残留）"
fi
if [ -f "$PAIR_PEERS_FILE" ]; then
  if grep -q "$BRAIN_NODE_ID" "$PAIR_PEERS_FILE" 2>/dev/null; then
    bad "3082 peers.json 仍含 ${BRAIN_NODE_ID} 残留"
  else
    ok "3082 peers.json 无 ${BRAIN_NODE_ID} 残留（只读校验）"
  fi
else
  ok "3082 无 peers.json 持久化文件（无残留）"
fi

# 大脑静态 config.json 不得被修改
if [ -n "$brain_config_md5" ]; then
  brain_config_md5_after="$(md5sum "$BRAIN_CONFIG_MARKER" 2>/dev/null | awk '{print $1}')"
  if [ "$brain_config_md5" = "$brain_config_md5_after" ]; then
    ok "大脑 /root/.dsh/remotenode/config.json 未被修改（md5 一致）"
  else
    bad "大脑 config.json 被修改：${brain_config_md5} → ${brain_config_md5_after}"
  fi
else
  info "跳过 config.json 指纹校验（文件不存在）"
fi

# 链路断开：若仍能看到旧 peer 行，其 state 不应为 online（peers 已移除时视为已断开）
b_leftover="$(state_of "$BRAIN" | jq -c '[(.peers // [])[] | select(.state == "online")]' 2>/dev/null)"
info "3080 当前 online peers：${b_leftover}"

# ---------------------------------------------------------------------------
# T8. 失败分支：错误 token → ok:false
# ---------------------------------------------------------------------------
say "T8 失败分支：3082 用错误 token 向 3080 发起配对 → 期望 ok:false"
brain_listen_port="$(state_of "$BRAIN" | jq -r '.self.listen.port // 47201' 2>/dev/null)"
fake_token="$(printf 'deadbeef%.0s' $(seq 1 8))"   # 64 hex，但非大脑真实令牌
fake_body="$(jbody --arg host 127.0.0.1 --argjson port "$brain_listen_port" --arg token "$fake_token" \
  '{host:$host, port:$port, token:$token}')"
fake_resp="$(api_post "$PAIR/api/remotenode/peers/pair" "$fake_body" 60)"
info "3082 → 3080(fake token) 响应：${fake_resp:-<空>}"
if printf '%s' "$fake_resp" | jq -e '.ok == false' >/dev/null 2>&1; then
  ok "错误 token 被拒绝：ok:false（error=$(printf '%s' "$fake_resp" | jq -r '.error // "?"')）"
else
  bad "错误 token 未被拒绝（响应：${fake_resp:-<空>}）"
fi
sleep 0.5
b_pending_after_fail="$(state_of "$BRAIN" | jq -c '.pendingPairs // []' 2>/dev/null)"
if [ "$b_pending_after_fail" = '[]' ] || [ -z "$b_pending_after_fail" ]; then
  ok "失败配对未在 3080 产生待审批残留（pendingPairs 空）"
else
  bad "失败配对在 3080 留下待审批：${b_pending_after_fail}"
fi

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
say "汇总"
info "3080 终态 peers：$(state_of "$BRAIN" | jq -c '[.peers[]? | {peerNodeId, state, source}]' 2>/dev/null)"
info "3082 终态 peers：$(state_of "$PAIR" | jq -c '[.peers[]? | {peerNodeId, state, source}]' 2>/dev/null)"
printf '\n  PASS=%d  FAIL=%d\n' "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
  printf '  \033[32m结果：全部通过 ✓\033[0m\n'
  exit 0
else
  printf '  \033[31m结果：存在失败项 ✗\033[0m\n'
  exit 1
fi
