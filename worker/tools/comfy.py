#!/usr/bin/env python3
"""ComfyUI 任务脚本（worker 节点使用，仅依赖 Python 标准库）。

用法：
    python comfy.py list
    python comfy.py run --prompt "..." [--negative "..."] [--workflow NAME]
                         [--workflow-file PATH] [--seed N] [--width W --height H]
                         [--out DIR] [--timeout 900] [--comfy-url URL]

约定：
    - workflow 文件是 ComfyUI 的 **API 格式** JSON（WebUI 里 “Save (API Format)” 导出）；
    - 模板中可用占位符：{{prompt}}、{{negative}}、{{seed}}、{{width}}、{{height}}；
    - 输出为标准 JSON（供 worker agent 解析），日志写 stderr；
    - 结束时把生成图片下载到 --out 目录，并打印 JSON：{prompt_id, images:[...], elapsed_s}。
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

DEFAULT_COMFY_URL = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188")
DEFAULT_WORKFLOW_DIR = os.environ.get("COMFY_WORKFLOW_DIR", r"C:\dsh-worker\workflows")
DEFAULT_OUT_DIR = os.environ.get("DSH_WORKER_OUT_DIR", r"C:\dsh-worker\workspace\out")


def log(message: str) -> None:
    print(f"[comfy] {message}", file=sys.stderr, flush=True)


def http_json(url: str, payload: dict[str, Any] | None = None, timeout: float = 60) -> Any:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:4000]
        raise RuntimeError(f"HTTP {error.code} from {url}: {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"cannot reach {url}: {error.reason}") from error
    if not body:
        return None
    return json.loads(body.decode("utf-8"))


def http_bytes(url: str, timeout: float = 180) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read()


def workflow_files(directory: Path) -> list[Path]:
    if not directory.is_dir():
        return []
    return sorted(path for path in directory.glob("*.json") if path.is_file())


def resolve_workflow(args: argparse.Namespace) -> Path:
    if args.workflow_file:
        path = Path(args.workflow_file)
        if not path.is_file():
            raise SystemExit(f"workflow file not found: {path}")
        return path
    directory = Path(args.workflows_dir)
    files = workflow_files(directory)
    if not files:
        raise SystemExit(f"no workflow JSON under {directory}; export a ComfyUI API workflow there first")
    if args.workflow:
        for path in files:
            if path.stem == args.workflow:
                return path
        raise SystemExit(
            f"workflow '{args.workflow}' not found under {directory}; available: {[p.stem for p in files]}"
        )
    if len(files) == 1:
        return files[0]
    raise SystemExit(f"multiple workflows found, pass --workflow NAME; available: {[p.stem for p in files]}")


def substitute(value: Any, mapping: dict[str, Any]) -> Any:
    """递归替换模板中的 {{placeholder}}；只处理字符串，保持其余结构不变。"""
    if isinstance(value, dict):
        return {key: substitute(item, mapping) for key, item in value.items()}
    if isinstance(value, list):
        return [substitute(item, mapping) for item in value]
    if isinstance(value, str):
        for key, replacement in mapping.items():
            token = "{{" + key + "}}"
            if token in value:
                value = value.replace(token, str(replacement))
        return value
    return value


def count_placeholders(workflow: dict[str, Any], keys: tuple[str, ...]) -> int:
    text = json.dumps(workflow, ensure_ascii=False)
    return sum(text.count("{{" + key + "}}") for key in keys)


def collect_images(history_entry: dict[str, Any]) -> list[dict[str, str]]:
    images: list[dict[str, str]] = []
    outputs = history_entry.get("outputs") or {}
    for node_id, node_output in outputs.items():
        for image in node_output.get("images") or []:
            if not isinstance(image, dict):
                continue
            if not image.get("filename"):
                continue
            images.append(
                {
                    "filename": str(image["filename"]),
                    "subfolder": str(image.get("subfolder") or ""),
                    "type": str(image.get("type") or "output"),
                    "node": str(node_id),
                }
            )
    return images


def command_list(args: argparse.Namespace) -> int:
    directory = Path(args.workflows_dir)
    files = workflow_files(directory)
    entries = []
    for path in files:
        try:
            workflow = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            entries.append({"name": path.stem, "path": str(path), "error": str(error)})
            continue
        entries.append(
            {
                "name": path.stem,
                "path": str(path),
                "nodes": len(workflow),
                "prompt_tokens": count_placeholders(workflow, ("prompt",)),
                "seed_tokens": count_placeholders(workflow, ("seed",)),
            }
        )
    print(json.dumps({"workflows_dir": str(directory), "workflows": entries}, ensure_ascii=False, indent=2))
    return 0


def command_run(args: argparse.Namespace) -> int:
    comfy_url = (args.comfy_url or DEFAULT_COMFY_URL).rstrip("/")
    workflow_path = resolve_workflow(args)
    try:
        template = json.loads(workflow_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"cannot read workflow {workflow_path}: {error}")

    width = args.width
    height = args.height
    if width is None or height is None:
        # 未显式指定时，保留模板中的原尺寸占位符（若模板没有占位符则不影响）。
        mapping_width = "{{width}}" if width is None else width
        mapping_height = "{{height}}" if height is None else height
    else:
        mapping_width, mapping_height = width, height

    seed = args.seed if args.seed is not None else random.randint(0, 2**32 - 1)
    mapping = {
        "prompt": args.prompt,
        "negative": args.negative or "",
        "seed": seed,
        "width": mapping_width,
        "height": mapping_height,
    }
    workflow = substitute(template, mapping)

    out_dir = Path(args.out or DEFAULT_OUT_DIR)
    out_dir.mkdir(parents=True, exist_ok=True)

    client_id = str(uuid.uuid4())
    started = time.monotonic()
    log(f"submit {workflow_path.name} (seed={seed}) -> {comfy_url}")
    try:
        response = http_json(
            f"{comfy_url}/prompt",
            {"prompt": workflow, "client_id": client_id},
            timeout=120,
        )
    except RuntimeError as error:
        print(json.dumps({"error": "submit_failed", "detail": str(error)}, ensure_ascii=False))
        return 1

    prompt_id = (response or {}).get("prompt_id")
    if not prompt_id:
        print(json.dumps({"error": "no_prompt_id", "detail": response}, ensure_ascii=False))
        return 1
    log(f"prompt_id={prompt_id}; waiting up to {args.timeout}s")

    deadline = time.monotonic() + args.timeout
    history_entry: dict[str, Any] | None = None
    while time.monotonic() < deadline:
        try:
            history = http_json(f"{comfy_url}/history/{prompt_id}", timeout=60)
        except RuntimeError as error:
            log(f"history poll failed: {error}")
            time.sleep(2)
            continue
        if isinstance(history, dict) and prompt_id in history:
            history_entry = history[prompt_id]
            break
        time.sleep(1)

    if history_entry is None:
        # 超时：尽量取消该任务，避免继续占用 GPU。
        try:
            http_json(f"{comfy_url}/api/jobs/{prompt_id}/cancel", {}, timeout=15)
            log("cancelled by timeout via /api/jobs/{id}/cancel")
        except RuntimeError:
            try:
                http_json(f"{comfy_url}/interrupt", {"prompt_id": prompt_id}, timeout=15)
                log("interrupt requested by timeout")
            except RuntimeError:
                log("timeout cancel unavailable; job may still be running")
        print(
            json.dumps(
                {
                    "error": "timeout",
                    "prompt_id": prompt_id,
                    "elapsed_s": round(time.monotonic() - started, 1),
                    "hint": "ComfyUI may still be running; check /queue",
                },
                ensure_ascii=False,
            )
        )
        return 1

    status = history_entry.get("status") or {}
    if status.get("status_str") == "error":
        print(
            json.dumps(
                {"error": "execution_failed", "prompt_id": prompt_id, "status": status},
                ensure_ascii=False,
            )
        )
        return 1

    images = collect_images(history_entry)
    if not images:
        print(json.dumps({"error": "no_images", "prompt_id": prompt_id, "outputs": history_entry.get("outputs")}, ensure_ascii=False))
        return 1

    saved: list[dict[str, Any]] = []
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    for image in images:
        query = urllib.parse.urlencode(
            {"filename": image["filename"], "subfolder": image["subfolder"], "type": image["type"]}
        )
        try:
            payload = http_bytes(f"{comfy_url}/view?{query}")
        except RuntimeError as error:
            log(f"download failed for {image['filename']}: {error}")
            continue
        target = out_dir / f"comfy-{timestamp}-{image['filename']}"
        target.write_bytes(payload)
        saved.append(
            {
                "path": str(target).replace("\\", "/"),
                "kind": "image",
                "filename": image["filename"],
                "subfolder": image["subfolder"],
                "type": image["type"],
                "bytes": len(payload),
            }
        )

    result = {
        "prompt_id": prompt_id,
        "workflow": workflow_path.stem,
        "seed": seed,
        "images": saved,
        "elapsed_s": round(time.monotonic() - started, 1),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if saved else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="ComfyUI worker helper")
    parser.add_argument("--workflows-dir", default=DEFAULT_WORKFLOW_DIR, help="workflow 模板目录")
    subparsers = parser.add_subparsers(dest="command", required=True)

    list_parser = subparsers.add_parser("list", help="列出可用 workflow")
    list_parser.add_argument("--workflows-dir", default=argparse.SUPPRESS, help="workflow 模板目录")
    list_parser.set_defaults(handler=command_list)

    run_parser = subparsers.add_parser("run", help="提交并等待一次生成任务")
    run_parser.add_argument("--prompt", required=True)
    run_parser.add_argument("--negative", default="")
    run_parser.add_argument("--workflow", default=None, help="workflow 名称（不含 .json）")
    run_parser.add_argument("--workflow-file", default=None, help="直接指定 workflow JSON 路径")
    run_parser.add_argument("--seed", type=int, default=None)
    run_parser.add_argument("--width", type=int, default=None)
    run_parser.add_argument("--height", type=int, default=None)
    run_parser.add_argument("--out", default=DEFAULT_OUT_DIR)
    run_parser.add_argument("--timeout", type=int, default=900, help="等待生成的秒数")
    run_parser.add_argument("--comfy-url", default=DEFAULT_COMFY_URL)
    run_parser.add_argument("--workflows-dir", default=argparse.SUPPRESS)
    run_parser.set_defaults(handler=command_run)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.handler(args))
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 - 统一输出 JSON 错误，便于 agent 解析
        print(json.dumps({"error": "unexpected", "detail": repr(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
