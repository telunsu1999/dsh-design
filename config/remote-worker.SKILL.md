---
name: remote-worker
description: 把生图、Blender/3D 建模渲染、GPU 重型计算等任务委托给远程 Windows worker 节点（subagent_worker 工具），并把产物拉回本地展示；在任务需要用 ComfyUI 出图或 Blender 生成模型时使用
whenToUse: 用户要求生成图片/绘画、制作或修改 3D 模型、Blender 场景/渲染、或明确说“交给台式机/worker/远程节点”；或者任务明显需要台式机上的 GPU/ComfyUI/Blender
---

# 远程 worker 委托（subagent_worker）

本机（大脑）通过 `subagent_worker` 工具把**一次性任务**委托给远程 Windows 台式机上的独立 DSH 子代理。
worker 有它自己的模型上下文、ComfyUI 和 Blender，**看不到当前会话**，也不会追问。

## 何时使用

- 生成/编辑图片（ComfyUI）、3D 建模、Blender 渲染、批量 GPU 任务；
- 用户明确要求“用台式机/worker 节点做”；
- 任务可以打包成一段自包含说明，且产物是文件（图片/GLB/视频）。

不适合：需要多轮澄清、需要访问本仓库代码、或几秒就能在本机完成的小事。

## 怎么调用

调用 `subagent_worker`（若工具不存在，说明大脑 profile 还没接入，见 `docs/03-brain-setup.zh.md`）：

- `description`：短标题，例如 `生成柴犬宇航员图片`；
- `prompt`：**自包含**任务说明，建议模板：

```
任务：<一句话目标>
输入：<参考图路径/描述；没有就写无>
要求：
- 使用 ComfyUI（127.0.0.1:8188）与 C:\dsh-worker\workflows 下的 <workflow 名> 工作流；
  如果该目录没有合适 workflow，选择最接近的一个并在结果里说明。
- 尺寸/风格/seed 等：<参数>
- 产物保存到 C:\dsh-worker\workspace\out\，文件名前缀 <task-slug>
- 结束时按 AGENTS.md 约定输出 artifacts JSON（绝对路径，正斜杠）
约束：单次任务 20 分钟内完成；失败时说明原因，不要伪造。
```

模型会返回 worker 的最终文本；文本里应有 `artifacts` JSON 路径清单。

## 拉回产物并展示

用本 skill 自带脚本（大脑上执行）：

```bash
bash "$DSH_HOME/skills/remote-worker/scripts/fetch-artifact.sh" \
  'C:/dsh-worker/workspace/out/xxx.png' ./out
```

- 脚本最后一行输出本地绝对路径；
- 图片可用 `read_image` 查看、用 `present` 展示给用户；
- GLB/视频等文件用 `present`（先确认大小，必要时只提供下载路径）。

## 结果汇报

给用户的回复应包含：

1. worker 做了什么（模型/workflow/参数）；
2. 产物：本地路径 +（图片）内联展示；
3. 失败时的原因与下一步建议。

## 常见问题

| 现象 | 处理 |
|---|---|
| 工具调用返回 spawn/ssh 错误 | 大脑上跑 `scripts/check-worker.sh`，检查 SSH 别名、key、Tailscale |
| worker 说找不到 workflow | 让用户把 ComfyUI 工作流按 API 格式导出到 `C:\dsh-worker\workflows\`，或改用已有名称 |
| 任务超时 | 拆分任务/降低分辨率/减少帧数；worker 侧报告 timeout 后 GPU 任务可能仍在队列，必要时重启 ComfyUI |
| 产物拉回失败 | 检查远端路径是否含空格（避免）、是否在 `out\` 下；脚本会回退到 ssh base64 |
| 返回文本为空/协议错误 | 多半是远端插件写了 stdout 污染 ACP；查看大脑 `journalctl -u dsh-web` 里 worker stderr |
