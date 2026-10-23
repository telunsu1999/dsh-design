#!/usr/bin/env bash
# install-brain-worker.sh — 在“大脑节点”上安装远程 worker 委托能力（幂等）
#
# 做的事：
#   1. 给 $DSH_HOME/profiles/<profile> 安装 @deepseek-ai/dsh-subagent-acp；
#   2. 备份并追加 provider/tool 补丁片段（带 maker，重复执行不会重复插入）；
#   3. 安装 remote-worker skill 到 $DSH_HOME/skills/remote-worker/；
#   4. 用 --dump-config 校验组合是否可解析。
#
# 用法（本机部署示例）：
#   DSH_HOME=/root/.dsh PROFILE=web \
#   DSH_CLI='node /root/.openclaw/workspace/deepseek-harness/apps/cli/lib/bin.js' \
#   ./scripts/install-brain-worker.sh
#
# 可选环境变量：
#   DSH_WORKER_SSH=ssh别名（默认 dsh-desktop）
#   DSH_WORKER_ACP_CMD=远端启动命令（默认 C:/dsh-worker/run-acp.cmd）
#   DSH_WORKER_WORKSPACE=远端工作目录（默认 C:/dsh-worker/workspace）
#   DSH_WORKER_VERSION=插件版本（默认 0.2.1-rc.2）
#   FORCE=1  重新生成补丁片段
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$HERE/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${PROFILE:-web}"
SSH_ALIAS="${DSH_WORKER_SSH:-dsh-desktop}"
REMOTE_CMD="${DSH_WORKER_ACP_CMD:-C:/dsh-worker/run-acp.cmd}"
REMOTE_CWD="${DSH_WORKER_WORKSPACE:-C:/dsh-worker/workspace}"
PLUGIN_VERSION="${DSH_WORKER_VERSION:-0.2.1-rc.2}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
BRIDGE="$PROJECT_DIR/scripts/acp-ssh-bridge.mjs"
PATCH="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"
MARKER_BEGIN="# >>> dsh-remote-worker"
MARKER_END="# <<< dsh-remote-worker"

if [[ -z "$NODE_BIN" ]]; then
  echo "找不到 node，请先安装 Node.js 22.19+ 或设置 NODE_BIN" >&2
  exit 1
fi
if [[ ! -f "$BRIDGE" ]]; then
  echo "找不到桥脚本：$BRIDGE" >&2
  exit 1
fi
if [[ ! -d "$DSH_HOME" ]]; then
  echo "DSH_HOME 不存在：$DSH_HOME" >&2
  exit 1
fi

# ---- 1. 定位 dsh CLI -----------------------------------------------------
if [[ -n "${DSH_CLI:-}" ]]; then
  read -r -a CLI <<<"$DSH_CLI"
elif command -v dsh >/dev/null 2>&1; then
  CLI=(dsh)
elif [[ -f "$PROJECT_DIR/../deepseek-harness/apps/cli/lib/bin.js" ]]; then
  CLI=("$NODE_BIN" "$PROJECT_DIR/../deepseek-harness/apps/cli/lib/bin.js")
else
  echo "找不到 dsh CLI；请设置 DSH_CLI='node /path/to/dsh/apps/cli/lib/bin.js' 或把 dsh 放进 PATH" >&2
  exit 1
fi
echo "[1/4] dsh CLI: ${CLI[*]}"

# ---- 2. 安装插件包 -------------------------------------------------------
installed=0
for candidate in \
  "$DSH_HOME/profiles/$PROFILE/node_modules/@deepseek-ai/dsh-subagent-acp" \
  "$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-subagent-acp"; do
  [[ -d "$candidate" ]] && installed=1
done
if [[ "$installed" -eq 1 ]]; then
  echo "[2/4] @deepseek-ai/dsh-subagent-acp 已安装，跳过"
else
  echo "[2/4] 安装 @deepseek-ai/dsh-subagent-acp@$PLUGIN_VERSION 到 profile '$PROFILE' ..."
  "${CLI[@]}" plugin --profile "$PROFILE" add "@deepseek-ai/dsh-subagent-acp@$PLUGIN_VERSION"
fi

# ---- 3. 追加补丁片段 -----------------------------------------------------
mkdir -p "$(dirname "$PATCH")"
if [[ -f "$PATCH" ]] && grep -q "$MARKER_BEGIN" "$PATCH" && [[ "${FORCE:-0}" != "1" ]]; then
  echo "[3/4] 补丁片段已存在（FORCE=1 可强制重写），跳过"
else
  if [[ -f "$PATCH" ]]; then
    backup="$PATCH.bak-$(date +%Y%m%d-%H%M%S)"
    cp "$PATCH" "$backup"
    echo "[3/4] 已备份：$backup"
    if grep -q "$MARKER_BEGIN" "$PATCH"; then
      # 移除旧片段后再追加
      python3 - "$PATCH" "$MARKER_BEGIN" "$MARKER_END" <<'PY'
import sys
path, begin, end = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path, encoding='utf-8').read().splitlines(keepends=True)
out, skipping = [], False
for line in lines:
    if line.strip() == begin:
        skipping = True
        continue
    if line.strip() == end:
        skipping = False
        continue
    if not skipping:
        out.append(line)
open(path, 'w', encoding='utf-8').write(''.join(out))
PY
    fi
  fi
  cat >>"$PATCH" <<YAML

$MARKER_BEGIN (generated: $SSH_ALIAS)
- insert:
    - id: subagent-acp-worker
      name: '@deepseek-ai/dsh-subagent-acp'
      config:
        providerName: worker-acp
        command: $NODE_BIN
        args:
          - $BRIDGE
          - --ssh
          - $SSH_ALIAS
          - $REMOTE_CMD
          - $REMOTE_CWD
        permission: allow
        disposeEofGraceMs: 12000
        disposeGraceMs: 5000
    - id: tool-subagent-worker
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: worker-acp
        toolName: subagent_worker
        maxDepth: provider-managed
$MARKER_END
YAML
  echo "[3/4] 已写入补丁片段：$PATCH"
fi

# ---- 4. 安装 skill -------------------------------------------------------
SKILL_DIR="$DSH_HOME/skills/remote-worker"
if [[ -f "$PROJECT_DIR/config/remote-worker.SKILL.md" ]]; then
  mkdir -p "$SKILL_DIR/scripts"
  cp "$PROJECT_DIR/config/remote-worker.SKILL.md" "$SKILL_DIR/SKILL.md"
  cp "$PROJECT_DIR/scripts/fetch-artifact.sh" "$SKILL_DIR/scripts/fetch-artifact.sh"
  chmod +x "$SKILL_DIR/scripts/fetch-artifact.sh"
  echo "[4/4] 已安装 skill：$SKILL_DIR"
else
  echo "[4/4] 未找到 skill 模板，跳过"
fi

# ---- 校验 ---------------------------------------------------------------
echo "校验组合（--dump-config）..."
if "${CLI[@]}" --profile "$PROFILE" --dump-config >/tmp/dsh-brain-worker-dump.yml 2>/tmp/dsh-brain-worker-dump.err; then
  if grep -q 'subagent-acp-worker' /tmp/dsh-brain-worker-dump.yml; then
    echo "OK：provider 与 tool 已进入组合。"
  else
    echo "WARN：dump 中没有 subagent-acp-worker，请检查补丁是否被后续层覆盖。" >&2
  fi
else
  echo "WARN：--dump-config 失败，见 /tmp/dsh-brain-worker-dump.err" >&2
  tail -n 20 /tmp/dsh-brain-worker-dump.err >&2 || true
fi

cat <<EOF

完成。下一步：
  1. 在 ~/.ssh/config 配置别名 $SSH_ALIAS（详见 docs/03-brain-setup.zh.md）；
  2. 先跑 ./scripts/check-worker.sh 确认台式机侧就绪；
  3. 工具通常会被 HMR 热加载到当前会话；若看不到，新开会话即可；仍不行再重启
     dsh-web（systemctl restart dsh-web，会中断当前会话）。
EOF
