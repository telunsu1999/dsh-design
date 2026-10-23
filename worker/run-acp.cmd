@echo off
rem ============================================================
rem  DSH worker 启动脚本（Windows）
rem  由大脑通过 SSH 调用：ssh -T dsh-desktop C:/dsh-worker/run-acp.cmd
rem  要求：stdout 只能输出 ACP 协议帧，任何调试信息请写 stderr 或日志文件。
rem ============================================================
setlocal

rem ---- 路径与凭据 -------------------------------------------------
set "DSH_HOME=C:\dsh-worker\.dsh"
set "PATH=%APPDATA%\npm;%PATH%"

rem 可选：给 worker 的脚本用
set "COMFYUI_URL=http://127.0.0.1:8188"
set "BLENDER_EXE=C:\Program Files\Blender Foundation\Blender 4.5\blender.exe"
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"

rem ---- 工作目录 ---------------------------------------------------
if not exist "C:\dsh-worker\workspace" mkdir "C:\dsh-worker\workspace"
if not exist "C:\dsh-worker\workspace\out" mkdir "C:\dsh-worker\workspace\out"
cd /d "C:\dsh-worker\workspace"

rem ---- 启动 ACP 服务（阻塞，直到 stdin EOF 或客户端断开） --------
rem 用绝对路径的 npm 全局 shim，避免 SSH 非交互会话 PATH 不完整。
call "%APPDATA%\npm\dsh.cmd" --profile acp
exit /b %ERRORLEVEL%
