#!/usr/bin/env bash
# =============================================================================
# setup-node-profile.sh — 第二 DSH 节点（远程 worker 角色）环境准备（幂等）
#
# 用途：在同一台机器上准备一个独立的 DSH 实例，扮演 remotenode 插件的
#       「远程节点」一端（nodeId=desktop-node，Web :3081，对等监听 :47301），
#       与大脑实例（nodeId=brain-linux，Web :3080，对等监听 :47201）互连。
#
# 做什么（可重复执行，结果一致）：
#   1. 用 DSH_HOME=/root/.dsh-node 初始化 web profile（模板：dsh-base + dsh-web-app）
#      并安装本仓库插件 bundle @dsh-design/remotenode（link: 本地目录）；
#   2. 保证 @dsh-design/remotenode 出现在 profile package.json 的
#      dsh.profile.bundles 中，且位于 @deepseek-ai/dsh-web-app 之后；
#   3. 写 $DSH_HOME/remotenode/config.json（节点身份 / 监听 / 对端 / 工作目录）；
#      对端共享 secret 取自大脑侧 /root/.dsh/remotenode/peer-secret.txt
#      （文件缺失时才回退 openssl 生成并醒目告警：两边必须一致，否则握手失败）；
#      把 secret 另存 /root/.dsh-node/remotenode/peer-secret.txt（600，不打印内容）；
#   4. 复制模型凭据（.credentials.yaml / llm-deepseek/，600，不打印内容）；
#   5. 建 workspace / data 目录；最后跑一次 --dump-config 自检。
#
# 约束：不修改大脑 /root/.dsh；不安装到大脑 profile；不改插件源码。
# 用法：bash scripts/setup-node-profile.sh [--force]
#       --force 强制重跑 plugin add（默认仅在缺失/未链接时安装）
# =============================================================================
set -euo pipefail

# ---------- 常量（全部绝对路径） ----------
NODE_BIN=/root/.nvm/versions/node/v22.22.1/bin/node
HARNESS_ROOT=/root/.openclaw/workspace/deepseek-harness
DSH_CLI="${HARNESS_ROOT}/apps/cli/lib/bin.js"
BUNDLE_DIR=/root/AiWork/DSH_Design/plugins/remotenode

NODE_HOME=/root/.dsh-node
BRAIN_HOME=/root/.dsh
BRAIN_SECRET_FILE="${BRAIN_HOME}/remotenode/peer-secret.txt"

PROFILE_DIR="${NODE_HOME}/profiles/web"
PROFILE_MANIFEST="${PROFILE_DIR}/package.json"

RN_DIR="${NODE_HOME}/remotenode"
RN_CONFIG="${RN_DIR}/config.json"
RN_SECRET_FILE="${RN_DIR}/peer-secret.txt"
RN_WORKSPACE="${RN_DIR}/workspace"
RN_DATA_DIR="${RN_DIR}/data"

BUNDLE_NAME='@dsh-design/remotenode'
NODE_ID='desktop-node'
NODE_NAME='台式机 worker'
PEER_NODE_ID='brain-linux'
PEER_NODE_NAME='Linux 大脑'
LISTEN_HOST='127.0.0.1'
LISTEN_PORT='47301'
PEER_HOST='127.0.0.1'
PEER_PORT='47201'

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    -h|--help) sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$arg（用法：bash scripts/setup-node-profile.sh [--force]）" >&2; exit 2 ;;
  esac
done

# ---------- 小工具 ----------
log()  { printf '[setup-node] %s\n' "$*"; }
warn() { printf '[setup-node][警告] %s\n' "$*" >&2; }
die()  { printf '[setup-node][失败] %s\n' "$*" >&2; exit 1; }

# 本脚本只操作第二节点目录；显式导出 DSH_HOME，后续所有 dsh/node 子进程都指向它。
export DSH_HOME="${NODE_HOME}"

# ---------- 0. 前置自检 ----------
[ -x "$NODE_BIN" ]   || die "找不到 Node v22：$NODE_BIN"
[ -f "$DSH_CLI" ]    || die "找不到 DSH CLI：$DSH_CLI"
[ -d "$BUNDLE_DIR" ] || die "找不到插件 bundle 目录：$BUNDLE_DIR"
[ -f "$BUNDLE_DIR/package.json" ] || die "bundle 缺少 package.json：$BUNDLE_DIR/package.json"
if [ -d "${BRAIN_HOME}/profiles/web" ] && [ ! -d "${NODE_HOME}" ]; then
  log "检测到大脑 profile 位于 ${BRAIN_HOME}/profiles/web；本脚本只写 ${NODE_HOME}，不动大脑。"
fi

log "目标节点目录：${NODE_HOME}（nodeId=${NODE_ID}，Web :3081，对等监听 ${LISTEN_HOST}:${LISTEN_PORT}）"

# ---------- 1. 目录骨架 ----------
mkdir -p "$RN_DIR" "$RN_WORKSPACE" "$RN_DATA_DIR"
log "[1/6] 目录就绪：${RN_DIR}（workspace/data 已建）"

# ---------- 2. 初始化 web profile 并安装插件 bundle ----------
# 需要重装的条件：profile 不存在 / 依赖未登记 / node_modules 里链接缺失 / --force
need_install=0
if [ "$FORCE" -eq 1 ]; then
  need_install=1
elif [ ! -f "$PROFILE_MANIFEST" ]; then
  need_install=1
elif ! RN_PROFILE_DIR="$PROFILE_DIR" RN_BUNDLE_NAME="$BUNDLE_NAME" "$NODE_BIN" <<'NODE' >/dev/null 2>&1
const fs = require('node:fs')
const path = require('node:path')
const dir = process.env.RN_PROFILE_DIR
const name = process.env.RN_BUNDLE_NAME
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
const deps = manifest.dependencies || {}
if (typeof deps[name] !== 'string') process.exit(3)
const entry = path.join(dir, 'node_modules', ...name.split('/'), 'package.json')
if (!fs.existsSync(entry)) process.exit(4)
process.exit(0)
NODE
then
  need_install=1
fi

if [ "$need_install" -eq 1 ]; then
  log "[2/6] 初始化/安装 web profile 与插件（首次会创建 ${PROFILE_DIR}）"
  # dsh plugin --profile web add <本地目录>：profile 不存在时先按 web 模板初始化，
  # 再以 pnpm add link:<dir> 安装，并自动把新 bundle 追加进 dsh.profile.bundles。
  ( cd "$HARNESS_ROOT" && "$NODE_BIN" "$DSH_CLI" plugin --profile web add "$BUNDLE_DIR" )
  log "[2/6] plugin add 完成"
else
  log "[2/6] profile 已存在且 ${BUNDLE_NAME} 已链接，跳过 plugin add（--force 可强制重跑）"
fi

# ---------- 3. 保证 bundle 在 dsh.profile.bundles 中，且紧跟 @deepseek-ai/dsh-web-app ----------
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
// 幂等策略：先摘掉旧位置，再插到 web-app 之后（找不到 web-app 时追加到末尾）。
const rest = current.filter(item => item !== name)
const anchor = rest.indexOf(after)
const next = anchor >= 0
  ? [...rest.slice(0, anchor + 1), name, ...rest.slice(anchor + 1)]
  : [...rest, name]
const before = JSON.stringify(current)
const afterText = JSON.stringify(next)
if (before === afterText) {
  console.log(`[setup-node] [3/6] bundles 已就绪（${next.length} 项，${name} 位于 ${after} 之后）`)
  process.exit(0)
}
manifest.dsh = manifest.dsh || {}
manifest.dsh.profile = manifest.dsh.profile || {}
manifest.dsh.profile.bundles = next
fs.writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + '\n', { mode: 0o600 })
fs.chmodSync(manifestPath, 0o600)
console.log(`[setup-node] [3/6] 已写入 bundles：${before} -> ${afterText}`)
NODE

# 校验依赖确实以 link: 指向本仓库（幂等安装的兜底检查）
if ! RN_PROFILE_DIR="$PROFILE_DIR" RN_BUNDLE_NAME="$BUNDLE_NAME" "$NODE_BIN" <<'NODE' >/dev/null 2>&1
const fs = require('node:fs')
const path = require('node:path')
const dir = process.env.RN_PROFILE_DIR
const name = process.env.RN_BUNDLE_NAME
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
const spec = (manifest.dependencies || {})[name]
if (typeof spec !== 'string') process.exit(3)
if (!fs.existsSync(path.join(dir, 'node_modules', ...name.split('/'), 'package.json'))) process.exit(4)
process.exit(0)
NODE
then
  die "profile 中 ${BUNDLE_NAME} 依赖/链接不完整；请检查 ${PROFILE_MANIFEST} 与 ${PROFILE_DIR}/node_modules，或重跑 --force"
fi

# ---------- 4. 共享 secret（必须与大脑侧一致） ----------
secret=''
if [ -f "$BRAIN_SECRET_FILE" ]; then
  secret="$(tr -d '\r\n' < "$BRAIN_SECRET_FILE")"
  log "[4/6] 共享 secret 取自大脑侧：${BRAIN_SECRET_FILE}"
else
  secret="$(openssl rand -hex 32)"
  warn "大脑侧 secret 文件不存在：${BRAIN_SECRET_FILE}"
  warn "已用 openssl rand -hex 32 生成新 secret；必须把同一 secret 写入大脑侧 config.json，否则握手会 auth/invalid-proof 失败！"
fi
if [ "${#secret}" -lt 32 ]; then
  die "secret 长度不足 32 字节（当前 ${#secret}），拒绝写入配置"
fi
if [ ! -f "$RN_SECRET_FILE" ] || [ "$(tr -d '\r\n' < "$RN_SECRET_FILE" 2>/dev/null || true)" != "$secret" ]; then
  umask 077
  printf '%s\n' "$secret" > "$RN_SECRET_FILE"
  umask 022
  log "[4/6] 已写入节点侧 secret 文件：${RN_SECRET_FILE}（600，内容不打印）"
else
  log "[4/6] 节点侧 secret 文件已一致：${RN_SECRET_FILE}（600，内容不打印）"
fi
chmod 600 "$RN_SECRET_FILE"

# ---------- 5. 写 config.json（内容不变则不重写） ----------
RN_CONFIG="$RN_CONFIG" \
  RN_NODE_ID="$NODE_ID" RN_NODE_NAME="$NODE_NAME" \
  RN_LISTEN_HOST="$LISTEN_HOST" RN_LISTEN_PORT="$LISTEN_PORT" \
  RN_PEER_NODE_ID="$PEER_NODE_ID" RN_PEER_NODE_NAME="$PEER_NODE_NAME" \
  RN_PEER_HOST="$PEER_HOST" RN_PEER_PORT="$PEER_PORT" \
  RN_SECRET="$secret" RN_WORKSPACE="$RN_WORKSPACE" RN_DATA_DIR="$RN_DATA_DIR" \
  "$NODE_BIN" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')

const configPath = process.env.RN_CONFIG
const desired = {
  nodeId: process.env.RN_NODE_ID,
  nodeName: process.env.RN_NODE_NAME,
  listen: {
    enabled: true,
    host: process.env.RN_LISTEN_HOST,
    port: Number(process.env.RN_LISTEN_PORT),
  },
  peers: [
    {
      nodeId: process.env.RN_PEER_NODE_ID,
      nodeName: process.env.RN_PEER_NODE_NAME,
      host: process.env.RN_PEER_HOST,
      port: Number(process.env.RN_PEER_PORT),
      secret: process.env.RN_SECRET,
      dial: 'auto',
    },
  ],
  workspace: process.env.RN_WORKSPACE,
  dataDir: process.env.RN_DATA_DIR,
  autoFetchImages: true,
  maxAutoFetchBytes: 15728640,
}
const text = JSON.stringify(desired, undefined, 2) + '\n'
let existing = null
try { existing = fs.readFileSync(configPath, 'utf8') } catch { existing = null }
if (existing === text) {
  console.log(`[setup-node] [5/6] config.json 已就绪（内容一致）：${configPath}`)
  process.exit(0)
}
fs.mkdirSync(path.dirname(configPath), { recursive: true })
fs.writeFileSync(configPath, text, { mode: 0o600 })
fs.chmodSync(configPath, 0o600)
console.log(`[setup-node] [5/6] 已写入 config.json：${configPath}（600）`)
NODE
chmod 600 "$RN_CONFIG"

# ---------- 6. 模型凭据复制（保密，不打印内容） ----------
src_cred="${BRAIN_HOME}/.credentials.yaml"
dst_cred="${NODE_HOME}/.credentials.yaml"
if [ -f "$src_cred" ]; then
  if [ ! -f "$dst_cred" ] || ! cmp -s "$src_cred" "$dst_cred"; then
    cp -f "$src_cred" "$dst_cred"
    log "[6/6] 已复制模型凭据：${src_cred} -> ${dst_cred}（600）"
  else
    log "[6/6] 模型凭据已一致：${dst_cred}（600）"
  fi
  chmod 600 "$dst_cred"
else
  warn "大脑侧凭据文件不存在：${src_cred}（节点将无法调用模型；如只需 peer 链路可忽略）"
fi

src_llm="${BRAIN_HOME}/llm-deepseek"
dst_llm="${NODE_HOME}/llm-deepseek"
if [ -d "$src_llm" ]; then
  mkdir -p "$dst_llm"
  # 用 src/. 复制内容，避免对已存在的目标目录生出 llm-deepseek/llm-deepseek
  cp -a "${src_llm}/." "${dst_llm}/"
  find "$dst_llm" -type d -exec chmod 700 {} +
  find "$dst_llm" -type f -exec chmod 600 {} +
  log "[6/6] 已同步模型缓存目录：${src_llm} -> ${dst_llm}（目录 700 / 文件 600，不打印内容）"
else
  warn "大脑侧模型缓存目录不存在：${src_llm}"
fi

# workspace / data 最终确认（插件 start() 也会建，这里提前建好便于排查）
mkdir -p "$RN_WORKSPACE" "$RN_DATA_DIR"

# ---------- 7. 自检：--profile web --dump-config ----------
dump_out="$(mktemp)"
trap 'rm -f "$dump_out"' EXIT
if ! ( cd "$HARNESS_ROOT" && "$NODE_BIN" "$DSH_CLI" --profile web --dump-config ) >"$dump_out" 2>&1; then
  warn "dump-config 执行失败，输出末尾："
  tail -n 20 "$dump_out" >&2 || true
  die "profile 组合校验失败，请检查 ${PROFILE_DIR}"
fi
if grep -q "id: remotenode" "$dump_out" && grep -q "@dsh-design/remotenode" "$dump_out"; then
  log "[自检] dump-config 包含 remotenode 行与 ${BUNDLE_NAME} ✓"
else
  warn "dump-config 输出中未找到 remotenode 行，请检查 profile bundles 顺序"
  grep -n "remotenode" "$dump_out" | head -n 5 >&2 || true
  die "自检失败：remotenode 未被 profile 组合"
fi

# ---------- 汇总 ----------
cat <<EOF
[setup-node] 完成。第二 DSH 节点环境摘要：
  节点身份      : ${NODE_ID} / ${NODE_NAME}
  DSH_HOME      : ${NODE_HOME}
  profile       : ${PROFILE_DIR}（bundles 含 ${BUNDLE_NAME}，位于 @deepseek-ai/dsh-web-app 之后）
  插件配置      : ${RN_CONFIG}（600）
  secret 文件   : ${RN_SECRET_FILE}（600，取自 ${BRAIN_SECRET_FILE}；内容不打印）
  对端          : ${PEER_NODE_ID}（${PEER_NODE_NAME}）${PEER_HOST}:${PEER_PORT}，dial=auto
  本侧对等监听  : ${LISTEN_HOST}:${LISTEN_PORT}（enabled=true）
  workspace     : ${RN_WORKSPACE}
  dataDir       : ${RN_DATA_DIR}
  Web 端口      : 3081（下一步：bash plugins/remotenode/scripts/run-node.sh）
下一步：bash $(dirname "$0")/run-node.sh 启动节点，bash $(dirname "$0")/status-node.sh 查看状态。
EOF
