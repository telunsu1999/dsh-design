# 04 · 运维、排障与限制

## 1. 日常使用建议

- **任务要自包含**：worker 看不到当前会话，prompt 里写清目标、输入、参数、产物路径、失败处理。
- **一次一个重任务**：ComfyUI 单实例串行；并行提交会排队（`comfy.py` 超时会 cancel）。
- **产物路径用正斜杠**：`C:/dsh-worker/workspace/out/...`。
- **把“验收条件”写进 prompt**：例如“至少一张 1024x1024 PNG，返回 artifacts JSON”；worker 会照做。
- **大任务拆分**：先生成/预览，再放大/渲染；单次委托控制在 20 分钟内。
- **不要传密钥**：worker 的 key 在它自己的 `.env`。
- **失败先自检**：`scripts/check-worker.sh` 六项；再看 `journalctl -u dsh-web`。

## 2. 排障速查

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `subagent_worker` 工具不存在 | 新会话没开 / 补丁未生效 / 包未安装 | 确认 `--dump-config` 有行；开新会话；`journalctl` 看 HMR 警告 |
| 调用后很快返回 spawn 错误 | SSH 别名/网络/key 问题 | 手动 `ssh -vv dsh-desktop "cmd /c echo ok"` |
| `Permission denied (publickey)` | 公钥没加到正确账户 / ACL 错 | 确认 SSH 用户与 `authorized_keys` 路径一致；检查 icacls |
| `Connection timed out` | Tailscale 未连 / 防火墙 / NAT | `tailscale status`；`Test-NetConnection 台式机 22` |
| `Host key verification failed` | 台式机重装/换 IP | `ssh-keygen -R dsh-desktop` 后重连 |
| 远程命令找不到 `dsh` | SSH 非交互 PATH 不含 npm 全局目录 | 用 `run-acp.cmd`（内部 `call %APPDATA%\npm\dsh.cmd`），或写绝对路径 |
| SSH 执行 `C:/dsh-worker/run-acp.cmd` 报“不是内部或外部命令” | 个别 Windows 版本的 cmd 对正斜杠路径不友好 | 把远端启动命令改成 `cmd /c C:\dsh-worker\run-acp.cmd`（补丁 `args[3]`），其余不变 |
| `session/new` 报 cwd 错误 | 桥没生效/远端工作目录不存在 | 确认补丁 `args[0]` 指向桥、`args[4]` 目录存在；看 bridge stderr |
| worker 端 stdout 出现非协议内容 | 远端插件/`.cmd` 里有 echo/日志 | run-acp.cmd 里禁止 echo；插件日志写 stderr；`journalctl` 可见 |
| 任务卡住无返回 | worker 在跑长任务 / ComfyUI 队列卡住 | 看 worker 会话日志 `C:\dsh-worker\.dsh\sessions`；ComfyUI 控制台；必要时 `/queue` 清理 |
| ComfyUI 400（node_errors） | workflow 与已装模型不匹配 / 占位符未替换 | 在本机 UI 先跑通该 workflow；核对模型名；`comfy.py list` 看占位符数量 |
| ComfyUI 一直 `{}` history | 任务还在跑 / 队列在别处 | 查 `/queue`；提高 `--timeout`；降低分辨率 |
| GPU OOM | 分辨率/batch 太大 | 降低尺寸/batch；重启 ComfyUI 释放显存 |
| `read in worker` 超时 | `--timeout` 太小 | 调大 `--timeout`（默认 900s）；或拆任务 |
| Blender 找不到 | 不在 PATH | 在 `run-acp.cmd` 设 `BLENDER_EXE` 绝对路径 |
| Blender 脚本异常但 exit 0 | 未加 `--python-exit-code 1` | `blender_job.py` 已默认加；自定义命令请照抄 |
| 渲染黑图 | 无 GPU / 无显示环境用 Eevee | 用 Cycles；检查显卡驱动 |
| `fetch-artifact.sh` scp 失败 | 远端有强制命令 / 路径含空格 / 权限 | 去掉 `authorized_keys` 的 `command=`；避免空格；用 base64 回退 |
| 中文乱码 | Windows 控制台代码页 | `run-acp.cmd` 设 `PYTHONUTF8=1`；Python 脚本已用 UTF-8；必要时 `chcp 65001` |
| 返回文本被截断 | ACP 只回最终文本；过长 | 让 worker 把细节写进文件，正文只留摘要 + artifacts |
| 委托结果“成功”但产物不存在 | worker 路径写错 / 被清理 | 用 `artifacts` JSON 的绝对路径核对；检查 `out\` |

## 3. 日志与观测

| 位置 | 内容 |
|---|---|
| 大脑 `journalctl -u dsh-web -n 200` | provider 加载、HMR 警告、worker 的 stderr（桥会把它转发到父进程 stderr） |
| 大脑 `/root/.dsh/logs/` | 启动日志 |
| worker `C:\dsh-worker\.dsh\sessions\` | 每次委托的完整会话（可查 worker 到底执行了什么） |
| worker `C:\dsh-worker\workspace\` | 工作文件与 `out\` 产物 |
| ComfyUI 控制台 | 生成进度、OOM、模型加载错误 |
| Blender 输出 | `blender_job.py` 会把 stdout/stderr 尾部打进 JSON |

## 4. 限制清单（务必知悉）

1. **一次性任务**：一个任务一个 worker 进程；无追问、无 steer、不能续聊；每次委托都是全新上下文。
2. **只回文本**：图片/GLB/视频不会通过 ACP 回到大脑，必须落盘 + scp 拉回。
3. **cwd 固定**：worker 的会话工作目录固定为 `C:/dsh-worker/workspace`（桥改写），不是大脑的项目目录；跨机文件不共享。
4. **权限自动放行**：`permission: allow` 让 worker 的工具审批自动通过；信任边界是 SSH key。
5. **无重连**：SSH 断开 = 本次委托失败（结果可能未知）；重试要重新委托。
6. **启动开销**：每次委托要起 SSH + Node + DSH（数秒）并加载模型上下文。
7. **双倍 token**：worker 的模型调用独立计费。
8. **ComfyUI 串行**：并发提交只是排队；多 GPU 需多实例 + 多端口，本项目未实现路由。
9. **Windows 专用细节**：SSH 默认 shell 是 cmd；路径用正斜杠；避免路径含空格；`authorized_keys` ACL 严格。
10. **ACP 协议兼容**：大脑的 `dsh-subagent-acp` 与 worker 的 `dsh` 版本应尽量一致（本方案同为 `0.2.1-rc.2`）；升级时两端一起升。
11. **Agent Teams 不能远程**：teammate 仍只能在本机进程内；远程协作只有 `subagent_worker` 这一条路。
12. **SSH 执行世界不可用于本场景**：Windows 远端不支持、整 Session 粒度、Web 工作区不兼容。

## 5. 成本控制

- 简单任务留在大脑；只在“需要 GPU/ComfyUI/Blender/长流程”时委托。
- worker 端用 `deepseek-flash`（默认），不要用 pro 跑批量任务（可在 worker profile 里固定模型）。
- 让 worker “少读大文件、多写文件”：结果给路径，不要让它把二进制/大段日志塞进最终文本。
- 产物定期清理：`C:\dsh-worker\workspace\out`、`C:\dsh-worker\.dsh\sessions`。

## 6. 安全边界再强调

- 拿到大脑 SSH 私钥的人 = 台式机 `dshworker` 账户的远程执行者；
- 生产化建议：专用账户 + 非管理员 + 只读产物回传 key + 只在内网/Tailscale 暴露 + 定期轮换 key；
- 若 worker 会处理不可信内容（网上下载的模型/脚本），考虑单独的低权 Windows 账户 + 虚拟机隔离；
- 不要给 worker 传大脑的 API key / 云凭证；worker 只持有它自己的 DeepSeek key。
