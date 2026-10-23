#!/usr/bin/env python3
"""在 Windows 台式机上无界面运行 Blender 脚本（仅依赖 Python 标准库）。

用法：
    python blender_job.py run --script C:\\dsh-worker\\tools\\example_scene.py \
        [--out DIR] [--engine CYCLES] [--render-frames 1] [--blend INPUT.blend] \
        [--blender "C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe"] \
        [--timeout 1200]

行为：
    - 以 `blender --background --factory-startup --python-exit-code 1 --python SCRIPT` 运行；
    - 通过环境变量把输出目录传给脚本：DSH_WORKER_OUT_DIR / DSH_WORKER_TMP_DIR；
    - 运行结束后扫描输出目录，把新产生的文件作为 artifacts 输出为 JSON；
    - 退出码非 0 时 JSON 里带 error，便于 worker agent 判断失败。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

DEFAULT_OUT_DIR = os.environ.get("DSH_WORKER_OUT_DIR", r"C:\dsh-worker\workspace\out")
COMMON_BLENDER_PATHS = [
    r"C:\Program Files\Blender Foundation\Blender 4.5\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 4.4\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 4.3\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 4.2\blender.exe",
]


def log(message: str) -> None:
    print(f"[blender] {message}", file=sys.stderr, flush=True)


def resolve_blender(explicit: str | None) -> str:
    if explicit:
        return explicit
    configured = os.environ.get("BLENDER_EXE")
    if configured:
        return configured
    found = shutil.which("blender")
    if found:
        return found
    for candidate in COMMON_BLENDER_PATHS:
        if Path(candidate).is_file():
            return candidate
    raise SystemExit("blender executable not found; set BLENDER_EXE or pass --blender")


def snapshot(directory: Path) -> dict[str, float]:
    files: dict[str, float] = {}
    if not directory.is_dir():
        return files
    for path in directory.rglob("*"):
        if path.is_file():
            try:
                files[str(path).replace("\\", "/")] = path.stat().st_mtime
            except OSError:
                pass
    return files


def command_run(args: argparse.Namespace) -> int:
    blender = resolve_blender(args.blender)
    script = Path(args.script)
    if not script.is_file():
        print(json.dumps({"error": "script_not_found", "detail": str(script)}, ensure_ascii=False))
        return 1

    out_dir = Path(args.out or DEFAULT_OUT_DIR)
    tmp_dir = Path(os.environ.get("DSH_WORKER_TMP_DIR", str(out_dir.parent / "tmp")))
    out_dir.mkdir(parents=True, exist_ok=True)
    tmp_dir.mkdir(parents=True, exist_ok=True)

    argv: list[str] = [blender, "--background"]
    if not args.keep_default_scene:
        argv.append("--factory-startup")
    if args.blend:
        argv.append(str(Path(args.blend)))
    argv.extend(["--python-exit-code", "1", "--python", str(script)])
    if args.render_frames:
        argv.extend(
            [
                "-E",
                args.engine,
                "-o",
                str(out_dir / "frame_####"),
                "-F",
                args.format,
                "-f",
                args.render_frames,
            ]
        )
    if args.extra:
        argv.extend(["--", *args.extra])

    env = dict(os.environ)
    env["DSH_WORKER_OUT_DIR"] = str(out_dir)
    env["DSH_WORKER_TMP_DIR"] = str(tmp_dir)
    env["PYTHONUTF8"] = "1"

    before = snapshot(out_dir)
    started = time.monotonic()
    log(f"run {blender} ({script.name})")
    try:
        completed = subprocess.run(
            argv,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=args.timeout,
        )
    except subprocess.TimeoutExpired as error:
        print(
            json.dumps(
                {
                    "error": "timeout",
                    "timeout_s": args.timeout,
                    "stdout_tail": (error.stdout or "")[-4000:],
                    "stderr_tail": (error.stderr or "")[-4000:],
                },
                ensure_ascii=False,
            )
        )
        return 1
    except OSError as error:
        print(json.dumps({"error": "spawn_failed", "detail": str(error)}, ensure_ascii=False))
        return 1

    after = snapshot(out_dir)
    artifacts: list[dict[str, Any]] = []
    for path, mtime in sorted(after.items()):
        if before.get(path) != mtime:
            artifacts.append({"path": path, "kind": Path(path).suffix.lstrip(".") or "file"})

    result = {
        "exit_code": completed.returncode,
        "elapsed_s": round(time.monotonic() - started, 1),
        "artifacts": artifacts,
        "stdout_tail": (completed.stdout or "")[-4000:],
        "stderr_tail": (completed.stderr or "")[-4000:],
    }
    if completed.returncode != 0:
        result["error"] = "blender_failed"
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if completed.returncode == 0 else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Blender background job helper")
    subparsers = parser.add_subparsers(dest="command", required=True)
    run_parser = subparsers.add_parser("run", help="运行一个 bpy 脚本")
    run_parser.add_argument("--script", required=True, help="bpy 脚本路径")
    run_parser.add_argument("--blend", default=None, help="可选：先打开的 .blend 文件")
    run_parser.add_argument("--out", default=DEFAULT_OUT_DIR)
    run_parser.add_argument("--blender", default=None)
    run_parser.add_argument("--engine", default="CYCLES")
    run_parser.add_argument("--format", default="PNG")
    run_parser.add_argument("--render-frames", default=None, help="例如 1 / 1-10 / 1,5,10-20")
    run_parser.add_argument("--keep-default-scene", action="store_true", help="不传 --factory-startup")
    run_parser.add_argument("--timeout", type=int, default=1800)
    run_parser.add_argument("--extra", nargs="*", default=[], help="附加到 '--' 之后的参数")
    run_parser.set_defaults(handler=command_run)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.handler(args))
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"error": "unexpected", "detail": repr(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
