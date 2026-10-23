# ComfyUI workflow 目录

把 ComfyUI 的工作流按 **API 格式** 导出成 JSON 放在这里，例如从 ComfyUI 界面：

1. 打开你的工作流；
2. 菜单 → Workflow → **Export (API)**（不同版本菜单名略有差异）；
3. 保存为 `C:\dsh-worker\workflows\<名字>.json`。

脚本 `..\tools\comfy.py` 会：

- 读取 JSON 并递归替换占位符：`{{prompt}}`、`{{negative}}`、`{{seed}}`、`{{width}}`、`{{height}}`；
- 提交到 `http://127.0.0.1:8188/prompt`，轮询 `/history/<prompt_id>`；
- 把输出图片下载到 `C:\dsh-worker\workspace\out\`。

最小占位示例（记得保留你自己的节点结构和模型文件名）：

```json
{
  "3": {"class_type": "KSampler", "inputs": {"seed": "{{seed}}", "steps": 25}},
  "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{prompt}}"}},
  "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "{{negative}}"}}
}
```

注意：
- JSON 里不要有注释，不要用 UI 格式（含 `nodes`/`links` 顶层结构的那种）；
- 模型名必须与 worker 上已安装的 checkpoint/LoRA 一致；
- 多个 workflow 时用 `--workflow <文件名>` 选择，只有一个时自动使用。
