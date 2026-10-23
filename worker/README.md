# 台式机 worker 文件清单

把这些文件/目录复制到 Windows 台式机的 `C:\dsh-worker\`：

```
C:\dsh-worker\
├─ run-acp.cmd              # SSH 启动入口（由大脑调用）
├─ tools\
│  ├─ comfy.py              # ComfyUI 提交/等待/下载（仅标准库）
│  ├─ blender_job.py        # Blender 无界面任务包装器
│  └─ example_scene.py      # 示例 bpy 脚本：立方体 + 渲染 + GLB
├─ workflows\               # 放 ComfyUI API 格式 workflow（*.json）
│  └─ README.md
├─ workspace\
│  └─ out\                  # 产物目录（大脑通过 scp 拉取）
└─ .dsh\                    # DSH_HOME
   ├─ .env                  # DEEPSEEK_API_KEY=...
   ├─ AGENTS.md             # worker 行为约定（自动加载）
   └─ profiles\acp\cordis.patch.yml
```

准备步骤见 `docs/02-worker-windows.zh.md`；也可以用 `scripts/setup-worker-windows.ps1` 自动创建大部分文件。
