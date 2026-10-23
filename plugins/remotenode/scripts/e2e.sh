#!/usr/bin/env bash
# e2e.sh — remotenode 双节点端到端验证（HTTP API 驱动，不经过浏览器）。
#
# 依赖：
#   - 大脑实例  http://127.0.0.1:3080  (DSH_HOME=/root/.dsh, nodeId=brain-linux)
#   - 远程节点  http://127.0.0.1:3081  (DSH_HOME=/root/.dsh-node, nodeId=desktop-node)
#   节点侧可用 scripts/run-node.sh 启动。
#
# 用法：
#   ./scripts/e2e.sh            # 全流程：链路 → A→B 会话 → 交付物 → 反向 B→A → 断链恢复
#   ./scripts/e2e.sh links      # 只查链路
#   ./scripts/e2e.sh forward    # A→B：大脑让节点执行任务并 present 文件，验证交付物同步
#   ./scripts/e2e.sh reverse    # B→A：节点让大脑执行任务并 present 文件
#   ./scripts/e2e.sh reconnect  # 停/启节点，验证离线→恢复与 attach
#
# 说明：会真实调用模型（各节点自己的 key），prompt 已尽量短。
set -uo pipefail

BRAIN="${BRAIN_URL:-http://127.0.0.1:3080}"
NODE="${NODE_URL:-http://127.0.0.1:3081}"
WORK="${WORK_DIR:-/tmp/remotenode-e2e}"
NODE_DSH_HOME="${NODE_DSH_HOME:-/root/.dsh-node}"
NODE_WORKSPACE="${NODE_WORKSPACE:-$NODE_DSH_HOME/remotenode/workspace}"
mkdir -p "$WORK"

PASS=0
FAIL=0
say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
ok() { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }

need() { command -v "$1" >/dev/null 2>&1 || { echo "缺少命令：$1" >&2; exit 2; }; }
need curl
need jq

# GET/POST JSON, 失败时输出原始响应。
get() { curl -sS -m 20 "$1"; }
post() {
  local body='{}'
  if [ "$#" -ge 2 ] && [ -n "${2:-}" ]; then body="$2"; fi
  curl -sS -m 60 -X POST -H 'content-type: application/json' -d "$body" "$1"
}

# 轮询直到 jq 表达式为 true；参数：url jq表达式 超时秒 描述
wait_json() {
  local url="$1" expr="$2" timeout="${3:-20}" label="${4:-条件}"
  local deadline=$((SECONDS + timeout))
  while ((SECONDS < deadline)); do
    local body
    body="$(get "$url" 2>/dev/null || true)"
    if printf '%s' "$body" | jq -e "$expr" >/dev/null 2>&1; then
      printf '%s' "$body"
      return 0
    fi
    sleep 1
  done
  echo "  (等待超时：$label)" >&2
  return 1
}

wait_links() {
  say "1. 链路：等待 brain ↔ desktop-node 双方 online"
  local body
  body="$(wait_json "$BRAIN/api/remotenode/state" '.ok == true and (.peers[]? | select(.peerNodeId == "desktop-node") | .state) == "online"' "${1:-30}" "brain 看到 desktop-node online")" || return 1
  ok "brain 侧 desktop-node online"
  body="$(wait_json "$NODE/api/remotenode/state" '.ok == true and (.peers[]? | select(.peerNodeId == "brain-linux") | .state) == "online"' "${1:-30}" "node 看到 brain-linux online")" || return 1
  ok "node 侧 brain-linux online"
  echo "$body" | jq -r '.peers[] | "  peer \(.peerNodeId) state=\(.state) dir=\(.direction) rtt=\(.rttMs)"' 2>/dev/null || true
}

# 在指定实例上启动远程会话，返回 session id。
start_remote() {
  local base="$1" peer="$2" prompt="$3"
  local body
  body="$(post "$base/api/remotenode/session/start" "$(jq -nc --arg p "$peer" --arg t "$prompt" '{peerNodeId:$p, prompt:$t}')")"
  if [ "$(printf '%s' "$body" | jq -r '.ok')" != "true" ]; then
    echo "  start_session 失败：$body" >&2
    return 1
  fi
  printf '%s' "$body" | jq -r '.session.id'
}

# 等远程会话 idle（且出现过交付物或完成轮次）。
wait_session_idle() {
  local base="$1" session_id="$2" timeout="${3:-240}"
  local deadline=$((SECONDS + timeout))
  while ((SECONDS < deadline)); do
    local body
    body="$(get "$base/api/remotenode/state" 2>/dev/null || true)"
    local state
    state="$(printf '%s' "$body" | jq -r --arg id "$session_id" '.sessions[]? | select(.id == $id) | .state' 2>/dev/null | head -1)"
    if [ "$state" = "idle" ]; then
      printf '%s' "$body"
      return 0
    fi
    sleep 3
  done
  echo "  (会话 $session_id 未在 ${timeout}s 内 idle)" >&2
  return 1
}

# 等某个交付物出现（按 origin node 过滤），返回 key。
wait_deliverable() {
  local base="$1" origin="$2" name_hint="${3:-}" timeout="${4:-60}"
  local deadline=$((SECONDS + timeout))
  while ((SECONDS < deadline)); do
    local body key
    body="$(get "$base/api/remotenode/state" 2>/dev/null || true)"
    key="$(printf '%s' "$body" | jq -r --arg o "$origin" --arg n "$name_hint" '.deliverables[]? | select(.originNodeId == $o) | select($n == "" or (.name | contains($n))) | .key' 2>/dev/null | head -1)"
    if [ -n "$key" ] && [ "$key" != "null" ]; then
      printf '%s' "$key"
      return 0
    fi
    sleep 2
  done
  echo "  (未等到来自 $origin 的交付物 ${name_hint})" >&2
  return 1
}

# 确保交付物字节已同步，并下载校验内容。
sync_and_verify_artifact() {
  local base="$1" key="$2" expect_text="$3" timeout="${4:-60}"
  local body sync
  body="$(post "$base/api/remotenode/artifact/fetch" "$(jq -nc --arg k "$key" '{key:$k}')")"
  if [ "$(printf '%s' "$body" | jq -r '.ok')" != "true" ]; then
    bad "交付物拉取失败：$body"
    return 1
  fi
  say "4. 交付物字节：下载并校验 sha256/内容"
  local file="$WORK/$(printf '%s' "$key" | sha256sum | cut -c1-12).bin"
  local code
  code="$(curl -sS -m 60 -o "$file" -w '%{http_code}' "$base/api/remotenode/artifact?key=$(jq -rn --arg k "$key" '$k|@uri')")"
  if [ "$code" != "200" ]; then
    bad "下载返回 HTTP $code"
    return 1
  fi
  if [ -n "$expect_text" ] && grep -q "$expect_text" "$file"; then
    ok "下载内容包含 ${expect_text}（$(wc -c < "$file") 字节）"
  elif [ -n "$expect_text" ]; then
    bad "下载内容不含 ${expect_text}"
    return 1
  else
    ok "下载成功（$(wc -c < "$file") 字节）"
  fi
}

scenario_forward() {
  say "2. A→B：大脑让 desktop-node 建会话、执行命令并 present 文件"
  local stamp="rn-$(date +%s)"
  local marker="hello-from-desktop-node-$stamp"
  local prompt
  prompt="这是远程节点联调。请用 bash 执行以下命令，不要做别的：mkdir -p out && printf '%s\\n' '$marker' > out/demo.txt；然后用绝对路径对 /root/.dsh-node/remotenode/workspace/out/demo.txt 调用 present 工具，最后一句只回复 DONE。"
  local session_id
  session_id="$(start_remote "$BRAIN" desktop-node "$prompt")" || { bad "A→B 启动会话失败"; return 1; }
  ok "大脑已在对端创建远程会话：$session_id"
  wait_session_idle "$BRAIN" "$session_id" 240 >/dev/null || { bad "A→B 会话未 idle"; return 1; }
  ok "远程会话完成（状态 idle）"
  local key
  key="$(wait_deliverable "$BRAIN" desktop-node demo.txt 90)" || { bad "A→B 交付物未同步"; return 1; }
  ok "大脑侧收到交付物清单：$key"
  sync_and_verify_artifact "$BRAIN" "$key" "$marker" || return 1
  printf '%s' "$key" > "$WORK/forward.key"
}

scenario_reverse() {
  say "5. B→A：节点让大脑建会话（纯文本、无工具审批），再由节点发布文件给大脑"
  local stamp="rn-rev-$(date +%s)"
  local pong="PONG-$stamp"
  local prompt="不要调用任何工具。只回复这一行：$pong"
  local session_id
  session_id="$(start_remote "$NODE" brain-linux "$prompt")" || { bad "B→A 启动会话失败"; return 1; }
  ok "节点已在脑侧创建远程会话：$session_id"
  wait_session_idle "$NODE" "$session_id" 180 >/dev/null || { bad "B→A 会话未 idle"; return 1; }
  ok "反向远程会话完成（状态 idle）"
  local transcript
  transcript="$(get "$NODE/api/remotenode/session/transcript?sessionId=$(jq -rn --arg s "$session_id" '$s|@uri')")"
  if printf '%s' "$transcript" | jq -e --arg p "$pong" '[.events[]? | select(.role == "assistant") | .text] | join(" ") | contains($p)' >/dev/null 2>&1; then
    ok "节点侧转录收到大脑回复：$pong"
  else
    bad "节点侧转录中没有 $pong"
    return 1
  fi
  # 反向交付物：节点发布一个本机文件给大脑（不依赖审批），大脑拉取字节
  local file="$WORK/reverse-from-node.txt"
  printf '%s\n' "reverse-artifact-$stamp" > "$file"
  local body
  body="$(post "$NODE/api/remotenode/publish" "$(jq -nc --arg p brain-linux --arg f "$file" --arg d '反向交付物测试' '{peerNodeId:$p, path:$f, description:$d}')")"
  if [ "$(printf '%s' "$body" | jq -r '.ok')" != "true" ]; then
    bad "节点发布交付物失败：$body"
    return 1
  fi
  ok "节点已向大脑发布本地文件"
  local key
  key="$(wait_deliverable "$BRAIN" desktop-node reverse-from-node.txt 60)" || { bad "大脑侧未收到反向交付物"; return 1; }
  ok "大脑侧收到反向交付物清单：$key"
  sync_and_verify_artifact "$BRAIN" "$key" "reverse-artifact-$stamp" || return 1
}

scenario_reconnect() {
  say "6. 断链恢复：停掉节点进程 → 大脑侧 offline → 重启 → 重新 attach 历史会话"
  local before
  before="$(get "$BRAIN/api/remotenode/state" | jq -r '.sessions | length')"
  info "重连前大脑侧远程会话数：$before"
  bash "$(dirname "$0")/stop-node.sh" >/dev/null 2>&1 || true
  wait_json "$BRAIN/api/remotenode/state" '(.peers[]? | select(.peerNodeId == "desktop-node") | .state) == "offline"' 40 "大脑侧 desktop-node offline" >/dev/null \
    && ok "节点停止后大脑侧显示 offline" || bad "大脑侧未在 40s 内变 offline"
  bash "$(dirname "$0")/run-node.sh" >/dev/null 2>&1 || true
  wait_json "$BRAIN/api/remotenode/state" '(.peers[]? | select(.peerNodeId == "desktop-node") | .state) == "online"' 90 "节点重启后 online" >/dev/null \
    && ok "节点重启后链路恢复 online" || bad "节点重启后链路未恢复"
  local after
  after="$(get "$BRAIN/api/remotenode/state" | jq -r '.sessions | length')"
  if [ "$after" -ge "$before" ]; then ok "远程会话记录保留（$before → $after）"; else bad "会话记录丢失（$before → $after）"; fi
  local offline_count
  offline_count="$(get "$BRAIN/api/remotenode/state" | jq -r '[.sessions[] | select(.state == "offline")] | length')"
  if [ "$offline_count" = "0" ]; then ok "重连后没有遗留 offline 会话"; else bad "仍有 $offline_count 个 offline 会话"; fi
}

summary() {
  say "汇总"
  printf '  通过 %d，失败 %d\n' "$PASS" "$FAIL"
  [ "$FAIL" -eq 0 ] || exit 1
}

mode="${1:-all}"
case "$mode" in
  links) wait_links 30; summary ;;
  forward) wait_links 30 && scenario_forward && summary ;;
  reverse) wait_links 30 && scenario_reverse && summary ;;
  reconnect) wait_links 30 && scenario_reconnect && summary ;;
  all)
    wait_links 30 || bad "链路未就绪"
    scenario_forward || true
    scenario_reverse || true
    scenario_reconnect || true
    summary
    ;;
  *)
    echo "用法：$0 [all|links|forward|reverse|reconnect]" >&2
    exit 2
    ;;
esac
