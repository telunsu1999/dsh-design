#!/usr/bin/env node
/**
 * acp-ssh-bridge.mjs — ACP 远程桥（brain 侧运行，无第三方依赖）
 *
 * 作用：
 *   把本地 ACP 客户端（DSH 的 @deepseek-ai/dsh-subagent-acp 子代理 backend）与
 *   另一台机器上的 ACP worker（`dsh --profile acp`）用 SSH 的 stdio 连接起来，
 *   并把 ACP `session/new` / `session/resume` 请求里的 cwd 改写成 worker 机器上
 *   真实存在的工作目录。
 *
 * 为什么需要改写 cwd：
 *   subagent-acp 会把 brain 本机的绝对路径作为子代理 workspace 发给 ACP 服务端；
 *   远程 worker（尤其是原生 Windows）上并不存在同一个路径。桥在协议层把它换成
 *   worker 的固定工作目录（例如 C:/dsh-worker/workspace），使 worker 的 shell、
 *   文件工具拥有一个稳定、可写、与 brain 无关的 cwd。
 *
 * 用法：
 *   node acp-ssh-bridge.mjs --ssh <ssh别名> <远程启动命令> <远程工作目录>
 *   node acp-ssh-bridge.mjs --local <本地启动命令> <远程工作目录>   # 本机自测
 *
 * 示例（brain 的 cordis.patch.yml 里）：
 *   command: node
 *   args:
 *     - /abs/path/acp-ssh-bridge.mjs
 *     - --ssh
 *     - dsh-desktop
 *     - C:/dsh-worker/run-acp.cmd
 *     - C:/dsh-worker/workspace
 *
 * 注意：
 *   - ssh 参数按空格拼接，远程启动命令里不要包含需要 shell 引号的空格（把复杂逻辑
 *     写进 worker 上的 .cmd / .sh 启动脚本）。
 *   - stdout 只允许 ACP 换行分隔 JSON；诊断信息一律走 stderr。
 *   - 本桥不做重连；SSH 断开时子代理运行以错误结束（与 subagent-acp 的语义一致）。
 */

import { spawn } from 'node:child_process'

const EXIT_USAGE = 2

function usage(message) {
  if (message) process.stderr.write(`[acp-ssh-bridge] ${message}\n`)
  process.stderr.write(
    'usage: acp-ssh-bridge.mjs --ssh <host> <remote-command> <remote-cwd>\n'
    + '       acp-ssh-bridge.mjs --local <local-command> <remote-cwd>\n',
  )
  process.exit(EXIT_USAGE)
}

const argv = process.argv.slice(2)
if (argv[0] !== '--ssh' && argv[0] !== '--local') usage('missing mode (--ssh or --local)')

const mode = argv[0]
let command
let remoteCwd
if (mode === '--ssh') {
  if (argv.length < 4) usage('--ssh needs <host> <remote-command> <remote-cwd>')
  command = { file: 'ssh', args: ['-T', '-o', 'BatchMode=yes', '-o', 'LogLevel=ERROR', argv[1], argv[2]] }
  remoteCwd = argv[3]
} else {
  if (argv.length < 3) usage('--local needs <local-command> <remote-cwd>')
  command = { file: 'sh', args: ['-c', argv[1]] }
  remoteCwd = argv[2]
}

if (!/^(?:\/|[A-Za-z]:[\\/])/.test(remoteCwd)) {
  usage(`remote cwd must be an absolute path (POSIX /... or Windows C:/...): ${remoteCwd}`)
}

process.stderr.write(`[acp-ssh-bridge] ${mode} mode, remote cwd -> ${remoteCwd}\n`)

const child = spawn(command.file, command.args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
})

child.on('error', (error) => {
  process.stderr.write(`[acp-ssh-bridge] spawn ${command.file} failed: ${error.message}\n`)
  process.exit(127)
})

// worker 的 stderr 原样转给上层（subagent-acp 会继承 stderr，仅用于诊断，不进入结果）。
child.stdin.on('error', () => { /* 对端已退出，忽略写入失败 */ })
child.stderr.setEncoding('utf8')
child.stderr.on('data', chunk => process.stderr.write(chunk))

/** 把一行 JSON-RPC 里 session/new、session/resume 的 cwd 改写为远程工作目录。 */
function rewriteSessionCwd(line) {
  if (line.length === 0) return line
  let message
  try {
    message = JSON.parse(line)
  } catch {
    // ACP 只应发送合法 JSON；不合法时原样透传，让对端按协议报错。
    return line
  }
  if (message === null || typeof message !== 'object') return line
  if (message.method !== 'session/new' && message.method !== 'session/resume') return line
  const params = message.params
  if (params === null || typeof params !== 'object') return line
  if (typeof params.cwd !== 'string') return line
  if (params.cwd === remoteCwd) return line
  params.cwd = remoteCwd
  return JSON.stringify(message)
}

/**
 * 按行转发一个流；brain→worker 方向对 session 相关请求做 cwd 改写。
 * @param source 可读流
 * @param destination 可写流（child.stdin 或 process.stdout）
 * @param transform 行变换
 */
function pumpLines(source, destination, transform) {
  let buffer = ''
  source.setEncoding('utf8')
  source.on('data', (chunk) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      destWrite(destination, transform(line))
      newline = buffer.indexOf('\n')
    }
  })
  source.on('end', () => {
    if (buffer.length > 0) {
      destWrite(destination, transform(buffer))
      buffer = ''
    }
    if (!destination.writableEnded) destination.end()
  })
  source.on('error', (error) => {
    process.stderr.write(`[acp-ssh-bridge] stream error: ${error.message}\n`)
  })
  destination.on('error', () => { /* 下游关闭由 close/end 事件统一处理 */ })
}

function destWrite(destination, line) {
  if (destination.writableEnded || destination.destroyed) return
  destination.write(`${line}\n`)
}

process.stdout.on('error', () => { /* 顶层已关闭 */ })

// brain（ACP 客户端）-> worker（ACP 服务端）
pumpLines(process.stdin, child.stdin, rewriteSessionCwd)
// worker -> brain
pumpLines(child.stdout, process.stdout, line => line)

child.on('close', (code, signal) => {
  // 等 stdout 队列冲刷完再退出，保证 ACP 客户端收到最后一个响应。
  const exitCode = code ?? (signal === null ? 0 : 1)
  process.stdout.write('', () => process.exit(exitCode))
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal)
  })
}
