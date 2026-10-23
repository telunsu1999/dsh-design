# 03 · 大脑节点接入（本机 dsh web）

目标：在现有大脑（本机 `dsh web`，profile `web`）上新增一个 `subagent_worker` 工具，
让模型可以把任务委托给已部署好的台式机 worker。

> 本部署的路径：仓库 `/root/.openclaw/workspace/deepseek-harness`、`DSH_HOME=/root/.dsh`、
> profile `web`、Web 服务 `dsh-web.service`（`systemctl`）。

## 0. 前提

- 台式机 worker 已按 `docs/02-worker-windows.zh.md` 部署；
- 大脑能 `ssh dsh-desktop "cmd /c echo ok"`（先配好 `~/.ssh/config`，见 §3）；
- 有 Node（大脑已有），profile 目录可写。

## 1. 一键安装（推荐）

```bash
cd /root/AiWork/DSH_Design
DSH_HOME=/root/.dsh PROFILE=web \
DSH_CLI='node /root/.openclaw/workspace/deepseek-harness/apps/cli/lib/bin.js' \
./scripts/install-brain-worker.sh
```

脚本会：

1. 把 `@deepseek-ai/dsh-subagent-acp@0.2.1-rc.2` 安装进 web profile 的 node_modules；
2. 备份 `/root/.dsh/profiles/web/cordis.patch.yml`，追加带标记的 provider/tool 片段；
3. 安装 skill 到 `/root/.dsh/skills/remote-worker/`；
4. 用 `--dump-config` 校验组合是否可解析。

可用环境变量覆盖：`DSH_WORKER_SSH`（默认 `dsh-desktop`）、`DSH_WORKER_ACP_CMD`、
`DSH_WORKER_WORKSPACE`、`DSH_WORKER_VERSION`；`FORCE=1` 强制重写补丁片段。

## 2. 手动步骤（等价）

```bash
# 2.1 安装 ACP 客户端 backend
node /root/.openclaw/workspace/deepseek-harness/apps/cli/lib/bin.js \
  plugin --profile web add @deepseek-ai/dsh-subagent-acp@0.2.1-rc.2

# 2.2 备份并追加补丁（内容见 config/brain-worker.patch.yml）
cp /root/.dsh/profiles/web/cordis.patch.yml \
   /root/.dsh/profiles/web/cordis.patch.yml.bak-$(date +%F-%H%M)
cat config/brain-worker.patch.yml >> /root/.dsh/profiles/web/cordis.patch.yml

# 2.3 skill
mkdir -p /root/.dsh/skills/remote-worker/scripts
cp config/remote-worker.SKILL.md /root/.dsh/skills/remote-worker/SKILL.md
cp scripts/fetch-artifact.sh /root/.dsh/skills/remote-worker/scripts/
chmod +x /root/.dsh/skills/remote-worker/scripts/fetch-artifact.sh
```

补丁里的路径按你环境改：`command`（node 绝对路径）、`args[0]`（桥脚本路径）、
`args[2]`（SSH 别名）、`args[3]`（远端启动脚本）、`args[4]`（远端工作目录）。

## 3. 配置 SSH

`~/.ssh/config`（root 用户即 `/root/.ssh/config`）：

```
Host dsh-desktop
  HostName 100.x.y.z
  User dshworker
  IdentityFile ~/.ssh/dsh_worker
  IdentitiesOnly yes
  BatchMode yes
  StrictHostKeyChecking accept-new
  ServerAliveInterval 30
  ServerAliveCountMax 4
  ConnectTimeout 15
```

生成 key（若还没做）：

```bash
ssh-keygen -t ed25519 -f /root/.ssh/dsh_worker -N '' -C 'dsh-brain-worker'
cat /root/.ssh/dsh_worker.pub   # 粘贴到台式机 authorized_keys
chmod 600 /root/.ssh/dsh_worker
ssh -T dsh-desktop "cmd /c echo ok"
```

## 4. 验证

### 4.1 组合校验

```bash
DSH_HOME=/root/.dsh node /root/.openclaw/workspace/deepseek-harness/apps/cli/lib/bin.js \
  --profile web --dump-config | grep -A20 'subagent-acp-worker'
```

能看到 `subagent-acp-worker` 与 `tool-subagent-worker` 两行即说明补丁进入组合。

### 4.2 链路自检

```bash
./scripts/check-worker.sh
```

六项全 PASS 后，再在大脑开**新会话**测试（当前会话工具列表在创建时已固定，不会热加工具）：

> 用 subagent_worker 让台式机执行 `echo hello-from-worker`，把 worker 的最终回答原样报告。

预期：工具返回子代理 id，随后完成通知里带 worker 的最终文本。

### 4.3 热更新说明

- DSH 的 profile HMR 会监视 `cordis.patch.yml` 与 `$DSH_HOME/cordis.patch.yml`，通常**不需要重启**；
- **本部署实测**：执行 `install-brain-worker.sh` 后，运行中的 Web 会话在下一次模型步骤即收到
  `subagent_worker` 工具（工具 schema 热注入），`remote-worker` skill 也同时出现在技能目录；
- 若你的版本/会话没有热加载：**新开一个会话**即可；仍不行再重启
  `systemctl restart dsh-web`（会中断当前 Web 会话）；
- 检查日志：`journalctl -u dsh-web -n 100 --no-pager`。

## 5. 使用方式

### 5.1 模型自动触发（推荐）

`remote-worker` skill 已安装，模型在遇到“生图/3D/Blender/交给台式机”时会按 skill 的模板调用
`subagent_worker`，并用 `fetch-artifact.sh` 拉回产物。你只要自然语言提需求即可。

### 5.2 显式委托

```
用 subagent_worker 让台式机：
1. 用 workflows/imagegen.json 生成 2 张 1024x1024 的概念图，seed 固定 42；
2. 把文件放到 C:\dsh-worker\workspace\out\concept-*；
3. 结束按 AGENTS.md 输出 artifacts JSON。
```

### 5.3 拉回产物并展示

```bash
cd /root/AiWork/<项目>
/root/AiWork/DSH_Design/scripts/fetch-artifact.sh \
  'C:/dsh-worker/workspace/out/comfy-20261023-153000-demo.png' ./out
# 输出本地路径后：
#   图片：read_image（模型查看）/ present（展示给用户）
#   其他：present
```

> 提示：给 worker 的任务描述里，产物路径用**正斜杠**（`C:/...`），避免反斜杠在 scp/JSON 里转义。

## 6. 回滚

```bash
# 1) 删除补丁片段
cp /root/.dsh/profiles/web/cordis.patch.yml \
   /root/.dsh/profiles/web/cordis.patch.yml.bak-rollback
python3 - <<'PY'
path='/root/.dsh/profiles/web/cordis.patch.yml'
begin='# >>> dsh-remote-worker'; end='# <<< dsh-remote-worker'
lines=open(path,encoding='utf-8').read().splitlines(keepends=True)
out=[]; skip=False
for line in lines:
    if line.strip()==begin: skip=True; continue
    if line.strip()==end: skip=False; continue
    if not skip: out.append(line)
open(path,'w',encoding='utf-8').write(''.join(out))
PY

# 2) 可选：卸载包与 skill
node /root/.openclaw/workspace/deepseek-harness/apps/cli/lib/bin.js \
  plugin --profile web remove @deepseek-ai/dsh-subagent-acp
rm -rf /root/.dsh/skills/remote-worker

# 3) 新会话验证工具已消失（无需重启；必要时 systemctl restart dsh-web）
```

## 7. 常见修改

| 想改什么 | 怎么做 |
|---|---|
| SSH 别名 | `DSH_WORKER_SSH=my-alias FORCE=1 ./scripts/install-brain-worker.sh`，或手改补丁 `args[2]` |
| 远端工作目录 | 同理改 `args[4]`，并同步改台式机目录 |
| 工具名（多个 worker） | 复制 `subagent-acp-worker`/`tool-subagent-worker` 两组行，改 `providerName`、`toolName`、SSH 别名 |
| 更严格的审批 | 把 provider 的 `permission: allow` 改为 `reject`；worker 的高危操作会被拒，可用性下降 |
| 换 node 路径 | 已安装 Node 升级后更新补丁 `command` 字段 |
