/**
 * tests/peer.test.mjs — remotenode 对等传输层集成测试（真实 127.0.0.1 TCP）。
 *
 * 覆盖：
 *  1. 两个 PeerManager 同时互拨 → 连接去重后每 peer 只保留 canonical 方向一条 ready link；
 *  2. 双向 JSON-RPC（含对端 error → 本地 ProtocolError、未知方法、请求超时）、
 *     通知送达、二进制帧回调（manager handlers + link.onBinary 追加处理器）；
 *  3. 断链后自动重连（1s 退避）并重新收敛到单链路；
 *  4. 错误 secret → 握手失败、无 ready link、state 记 error 且日志有记录；
 *  5. peer-link 心跳超时（对端握手后沉默）→ close('timeout')、onDown 只一次；
 *  6. peer-link 未知方法回 method/not-found、close 清理 pending、
 *     sendBinary 在关闭后安全返回 false。
 *
 * 测试不依赖外部网络，也不读写宿主的 ~/.dsh。
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createServer as createNetServer, connect as netConnect } from 'node:net'
import { test } from 'node:test'

import { ProtocolError } from '../lib/errors.js'
import { encodeJsonFrame } from '../lib/frames.js'
import { NonceCache, createWelcome, verifyHello } from '../lib/handshake.js'
import { createPeerLink } from '../lib/peer-link.js'
import { createPeerManager } from '../lib/peer-manager.js'

// =====================================================================
// 测试工具
// =====================================================================

/** @param {number} ms */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 静默 logger（测试只看显式捕获的日志）。 */
function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {} }
}

/** 记录日志行，便于断言“错误 secret 有 error 记录”。 */
function recordingLogger() {
  /** @type {Array<{level:string, text:string}>} */
  const lines = []
  const push = level => (...args) => {
    const text = args
      .map(value => {
        if (typeof value === 'string') return value
        if (value instanceof Error) return value.message
        try {
          return JSON.stringify(value)
        } catch {
          return String(value)
        }
      })
      .join(' ')
    lines.push({ level, text })
  }
  return { lines, debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') }
}

/**
 * 轮询等待条件成立。
 * @param {() => unknown} predicate
 * @param {{timeoutMs?:number, intervalMs?:number, label?:string}} [options]
 */
async function waitFor(predicate, options = {}) {
  const { timeoutMs = 8000, intervalMs = 25, label = 'condition' } = options
  const startedAt = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
    }
    await sleep(intervalMs)
  }
}

/** 向系统要一个空闲 TCP 端口（127.0.0.1），随后立即释放给 manager 监听。 */
async function freePort() {
  const server = createNetServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = address !== null && typeof address === 'object' ? address.port : 0
  await new Promise(resolve => server.close(resolve))
  return port
}

/** 按线格式写一帧：[4B BE 长度][payload]。 */
function writeFramed(socket, payload) {
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(payload.length, 0)
  socket.write(Buffer.concat([header, payload]))
}

/** 尝试 TCP 连接；成功 resolve socket，失败 reject（error.code 保留）。 */
function tcpConnect(port, options = {}) {
  const host = options.host ?? '127.0.0.1'
  const timeoutMs = options.timeoutMs ?? 1500
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      const error = new Error(`connect timeout to ${host}:${port}`)
      error.code = 'ETIMEDOUT'
      reject(error)
    }, timeoutMs)
    timer.unref?.()
    const onError = error => {
      clearTimeout(timer)
      reject(error)
    }
    socket.once('error', onError)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.off('error', onError)
      resolve(socket)
    })
  })
}

/** 断言端口当前不可连接（监听已关闭/已搬迁）。 */
async function assertPortClosed(port) {
  await assert.rejects(tcpConnect(port), error => {
    assert.ok(
      ['ECONNREFUSED', 'EHOSTUNREACH', 'ETIMEDOUT', 'ECONNRESET'].includes(error?.code),
      `unexpected connect error code: ${error?.code} (${error?.message})`,
    )
    return true
  })
}

/** 断言端口有监听（可建立 TCP 连接），随后关闭探测 socket。 */
async function assertPortOpen(port) {
  const socket = await tcpConnect(port)
  socket.destroy()
}

// 默认 manager 配置（测试用短心跳，避免慢测）。
const MANAGER_TUNING = Object.freeze({
  requestTimeoutMs: 2000,
  heartbeatIntervalMs: 100,
  heartbeatTimeoutMs: 1500,
  rttIntervalMs: 100,
})

/**
 * 起一对互相配置的 manager（监听在随机端口，默认 dial:'off' 便于手动拨号）。
 * @param {{dial?:'auto'|'off', nodeIds?:[string,string], buildHandlers?:(label:'a'|'b') => object}} [options]
 */
async function createPair(options = {}) {
  const dial = options.dial ?? 'off'
  const nodeIds = options.nodeIds ?? ['brain-test', 'desk-test']
  const buildHandlers = options.buildHandlers ?? (() => ({}))
  const secret = randomBytes(32).toString('hex')
  const [portA, portB] = [await freePort(), await freePort()]
  const loggerA = recordingLogger()
  const loggerB = recordingLogger()

  const make = (selfId, peerId, listenPort, peerPort, logger, handlers) => createPeerManager({
    config: {
      nodeId: selfId,
      nodeName: selfId,
      listen: { enabled: true, host: '127.0.0.1', port: listenPort },
      peers: [{ nodeId: peerId, nodeName: peerId, host: '127.0.0.1', port: peerPort, secret, dial }],
      ...MANAGER_TUNING,
    },
    instanceEpoch: `${selfId}-epoch`,
    logger,
    handlers,
  })

  const a = make(nodeIds[0], nodeIds[1], portA, portB, loggerA, buildHandlers('a'))
  const b = make(nodeIds[1], nodeIds[0], portB, portA, loggerB, buildHandlers('b'))
  const stop = async () => {
    await Promise.allSettled([a.stop(), b.stop()])
  }
  return { a, b, nodeIds, secret, ports: { a: portA, b: portB }, loggers: { a: loggerA, b: loggerB }, stop }
}

/**
 * createPair + start + 等双方都只有一条 ready link。
 * @param {Parameters<typeof createPair>[0]} options
 */
async function startOnlinePair(options = {}) {
  const pair = await createPair(options)
  await Promise.all([pair.a.start(), pair.b.start()])
  if ((options.dial ?? 'off') === 'auto') {
    // 默认 nodeIds：brain-test < desk-test，canonical dialer 是 A；等两侧都收敛到
    // canonical 方向（竞态时可能先短暂落在非 canonical 方向，manager 会补偿拨号升级）。
    await waitFor(
      () => pair.a.activeLinkCount() === 1
        && pair.b.activeLinkCount() === 1
        && pair.a.linkFor(pair.nodeIds[1])?.direction === 'outbound'
        && pair.b.linkFor(pair.nodeIds[0])?.direction === 'inbound',
      { label: 'pair online (auto dial, canonical direction)', timeoutMs: 12000 },
    )
  }
  return pair
}

// =====================================================================
// 1. 连接去重（非 canonical 链路先建立，canonical 链路后到并替换它）
// =====================================================================

test('连接去重：非 canonical 链路被 canonical 链路替换，每个 peer 只剩一条 ready link', async () => {
  /** @type {Array<{label:string, reason:string}>} */
  const downs = []
  const pair = await createPair({
    dial: 'off',
    buildHandlers: label => ({
      onLinkDown: (link, reason) => downs.push({ label, reason }),
    }),
  })
  try {
    await Promise.all([pair.a.start(), pair.b.start()])

    // 第一步：让字典序较大的 B 先主动拨 A。因为 canonicalDialer('brain-test','desk-test')
    // = 'brain-test'，这条链路在两侧都是非 canonical 方向（A 侧 inbound、B 侧 outbound）。
    const firstLink = await pair.b.dialNow('brain-test')
    assert.ok(firstLink !== null, 'B should create the initial non-canonical link')
    await waitFor(
      () => pair.a.activeLinkCount() === 1 && pair.b.activeLinkCount() === 1,
      { label: 'non-canonical link online' },
    )
    assert.equal(pair.a.linkFor('desk-test').direction, 'inbound')
    assert.equal(pair.b.linkFor('brain-test').direction, 'outbound')
    const nonCanonicalLink = pair.a.linkFor('desk-test')

    // 第二步：canonical 一侧 A 拨 B，两侧都必须用 canonical 链路替换掉已建立的旧链路。
    const canonicalLink = await pair.a.dialNow('desk-test')
    assert.ok(canonicalLink !== null, 'A should create the canonical outbound link')
    await waitFor(
      () => pair.a.linkFor('desk-test')?.direction === 'outbound'
        && pair.b.linkFor('brain-test')?.direction === 'inbound',
      { label: 'canonical link replaces the non-canonical one' },
    )

    // 旧链路被 close('peer/duplicate')：manager 日志与（已 onLinkUp 的）down 事件都应留痕。
    const logLines = [...pair.loggers.a.lines, ...pair.loggers.b.lines].map(line => line.text)
    assert.ok(
      logLines.some(line => /dedupe/.test(line) && /peer\/duplicate/.test(line)),
      `expected a dedupe log mentioning peer/duplicate, got: ${JSON.stringify(logLines)}`,
    )
    await waitFor(() => downs.some(item => item.reason === 'peer/duplicate'), {
      label: 'peer/duplicate onLinkDown for the replaced link',
      timeoutMs: 4000,
    })

    // 稳定一段时间后仍然每个 peer 只有一条 ready link（去重后没有拨号抖动）。
    await sleep(1200)
    assert.equal(pair.a.activeLinkCount(), 1)
    assert.equal(pair.b.activeLinkCount(), 1)
    assert.equal(pair.a.links.filter(link => link.state === 'ready').length, 1)
    assert.equal(pair.b.links.filter(link => link.state === 'ready').length, 1)
    assert.equal(pair.a.linkFor('desk-test').direction, 'outbound')
    assert.equal(pair.b.linkFor('brain-test').direction, 'inbound')
    // 旧的非 canonical 物理链路被关闭（同一 pair 的两条链路共享同一个 canonical linkId）。
    assert.equal(nonCanonicalLink.state, 'closed')
    // SPEC §3：linkId = `<较小 nodeId>~<较大 nodeId>`，两侧一致。
    const canonicalLinkId = 'brain-test~desk-test'
    assert.equal(pair.a.linkFor('desk-test').linkId, canonicalLinkId)
    assert.equal(pair.b.linkFor('brain-test').linkId, canonicalLinkId)
    assert.equal(pair.a.state()[0].linkId, canonicalLinkId)
    assert.equal(pair.b.state()[0].linkId, canonicalLinkId)

    const [stateA] = pair.a.state()
    const [stateB] = pair.b.state()
    assert.equal(stateA.peerNodeId, 'desk-test')
    assert.equal(stateA.state, 'online')
    assert.equal(stateA.direction, 'out')
    assert.deepEqual(stateA.remote, { nodeId: 'desk-test', nodeName: 'desk-test', platform: 'linux' })
    assert.equal(stateB.state, 'online')
    assert.equal(stateB.direction, 'in')

    // rttMs：manager 主动 peer.ping 往返（rttIntervalMs=100 应很快有值）。
    await waitFor(() => typeof pair.a.state()[0].rttMs === 'number', { label: 'rttMs measured on a' })
    await waitFor(() => typeof pair.b.state()[0].rttMs === 'number', { label: 'rttMs measured on b' })
    assert.ok(pair.a.state()[0].rttMs >= 0)

    // state() 给 UI：绝不能泄漏 secret。
    assert.equal(JSON.stringify(pair.a.state()).includes(pair.secret), false)
    assert.equal(JSON.stringify(pair.b.state()).includes(pair.secret), false)
  } finally {
    await pair.stop()
  }
})

// =====================================================================
// 2. 双向 RPC / 通知 / 二进制帧
// =====================================================================

test('双向 JSON-RPC、通知送达、二进制帧回调（含错误/超时/追加处理器）', async () => {
  /** @type {Array<{by:string, method:string, params:unknown}>} */
  const notifications = []
  /** @type {Array<{by:string, header:object, payload:Buffer}>} */
  const binaries = []
  const pair = await createPair({
    dial: 'off',
    buildHandlers: () => ({
      onRequest: (link, method, params) => {
        if (method === 'echo') return { by: link.nodeId, params }
        if (method === 'add') return { sum: Number(params?.a) + Number(params?.b) }
        if (method === 'boom') {
          throw new ProtocolError('session/unknown', 'no such session', { sessionId: 's-1' })
        }
        if (method === 'slow') {
          return new Promise(resolve => setTimeout(() => resolve({ slow: true }), 300))
        }
        // 有处理器但不认领：按 Lead 要求回 result:null（不是挂住）。
        return undefined
      },
      onNotification: (link, method, params) => notifications.push({ by: link.nodeId, method, params }),
      onBinary: (link, header, payload) => binaries.push({ by: link.nodeId, header, payload: Buffer.from(payload) }),
    }),
  })
  try {
    await Promise.all([pair.a.start(), pair.b.start()])
    await pair.a.dialNow('desk-test')
    await waitFor(
      () => pair.a.activeLinkCount() === 1 && pair.b.activeLinkCount() === 1,
      { label: 'pair online (single dial)' },
    )
    const ab = pair.a.linkFor('desk-test')
    const ba = pair.b.linkFor('brain-test')
    assert.ok(ab && ba, 'both sides must have a ready link')
    assert.equal(ab.linkId, 'brain-test~desk-test')
    assert.equal(ba.linkId, 'brain-test~desk-test')

    // A -> B
    assert.deepEqual(await ab.request('echo', { x: 1 }), { by: 'desk-test', params: { x: 1 } })
    // B -> A
    assert.deepEqual(await ba.request('add', { a: 2, b: 3 }), { sum: 5 })

    // 未知方法（handler 返回 undefined）→ result:null
    assert.equal(await ab.request('unknown.method', { a: 1 }), null)

    // 对端为未知方法回的错误（B 侧没有该 link 的 request handler? 有 handler → 返回 null，不是错误）
    // 对端抛 ProtocolError → 本地收到 ProtocolError（code/kind/message 保留）
    await assert.rejects(
      ab.request('boom', {}),
      error => {
        assert.ok(error instanceof ProtocolError, 'remote error must become ProtocolError')
        assert.equal(error.kind, 'session/unknown')
        assert.equal(error.code, 4020)
        assert.equal(error.message, 'no such session')
        return true
      },
    )

    // 本地请求超时 → reject（不拖垮链路）
    await assert.rejects(
      ab.request('slow', {}, { timeoutMs: 80 }),
      error => {
        assert.ok(error instanceof ProtocolError)
        assert.equal(error.kind, 'peer/internal')
        return true
      },
    )

    // 通知送达（A -> B）
    assert.equal(pair.a.notify('desk-test', 'note.session', { seq: 7 }), true)
    await waitFor(() => notifications.some(item => item.method === 'note.session'), {
      label: 'notification delivered',
    })
    const note = notifications.find(item => item.method === 'note.session')
    assert.deepEqual(note.params, { seq: 7 })

    // 二进制帧（A -> B，走 manager handlers.onBinary）
    const payload = Buffer.from('artifact-bytes')
    const header = {
      artifactId: `sha256:${'ab'.repeat(32)}`,
      offset: 128,
      length: payload.length,
      chunkId: 'c-1',
    }
    assert.equal(ab.sendBinary(header, payload), true)
    await waitFor(() => binaries.length === 1, { label: 'binary frame delivered' })
    assert.deepEqual(binaries[0].header, header)
    assert.equal(binaries[0].payload.equals(payload), true)

    // link.onBinary(fn) 追加处理器 + 取消函数
    const extra = []
    const unsubscribe = ab.onBinary((link, extraHeader, extraPayload) => {
      extra.push({ header: extraHeader, payload: Buffer.from(extraPayload) })
    })
    const header2 = { artifactId: `sha256:${'cd'.repeat(32)}`, offset: 0, length: 3, chunkId: 'c-2' }
    assert.equal(pair.b.linkFor('brain-test').sendBinary(header2, Buffer.from('xyz')), true)
    await waitFor(() => extra.length === 1, { label: 'appended onBinary handler' })
    assert.equal(extra[0].payload.toString(), 'xyz')

    unsubscribe()
    const header3 = { artifactId: `sha256:${'ef'.repeat(32)}`, offset: 0, length: 3, chunkId: 'c-3' }
    assert.equal(pair.b.linkFor('brain-test').sendBinary(header3, Buffer.from('123')), true)
    await waitFor(() => binaries.length === 3, { label: 'third binary frame delivered' })
    assert.equal(extra.length, 1, 'unsubscribed handler must not run again')
  } finally {
    await pair.stop()
  }
})

// =====================================================================
// 3. 断链自动重连
// =====================================================================

test('断链后自动重连（退避 1s）并收敛回单条 canonical 链路', async () => {
  /** @type {Array<{label:string, reason:string}>} */
  const downs = []
  const pair = await startOnlinePair({
    dial: 'auto',
    buildHandlers: label => ({ onLinkDown: (link, reason) => downs.push({ label, reason }) }),
  })
  try {
    assert.equal(pair.a.activeLinkCount(), 1)
    assert.equal(pair.b.activeLinkCount(), 1)
    const firstLink = pair.a.linkFor('desk-test')
    assert.equal(firstLink.linkId, 'brain-test~desk-test')
    assert.equal(firstLink.direction, 'outbound')

    // 模拟单侧断链（close 走 socket.end；对端看到 socket/end 后进入重连循环）。
    firstLink.close('test-disconnect')
    await waitFor(() => downs.length > 0, { label: 'link down recorded', timeoutMs: 3000 })

    // 重连时两侧可能又各自拨一次（先短暂出现非 canonical 链路，再由去重收敛），
    // 所以等待条件必须包含 canonical 方向，避免在中间态误判。
    await waitFor(
      () => pair.a.activeLinkCount() === 1
        && pair.b.activeLinkCount() === 1
        && pair.a.linkFor('desk-test') !== firstLink
        && pair.a.linkFor('desk-test')?.direction === 'outbound'
        && pair.b.linkFor('brain-test')?.direction === 'inbound',
      { label: 'automatic reconnect (canonical direction)', timeoutMs: 12000 },
    )
    // 重连后仍按 canonical 方向收敛，且只保留一条链路。
    await sleep(600)
    assert.equal(pair.a.activeLinkCount(), 1)
    assert.equal(pair.b.activeLinkCount(), 1)
    assert.equal(pair.a.linkFor('desk-test').direction, 'outbound')
    assert.equal(pair.b.linkFor('brain-test').direction, 'inbound')
    assert.equal(pair.a.linkFor('desk-test').linkId, 'brain-test~desk-test')
    assert.equal(pair.b.linkFor('brain-test').linkId, 'brain-test~desk-test')
    assert.equal(pair.a.state()[0].state, 'online')
    assert.equal(pair.b.state()[0].state, 'online')
  } finally {
    await pair.stop()
  }
})

// =====================================================================
// 4. 错误 secret
// =====================================================================

test('错误 secret：握手失败、无 ready link、state 记 error 且日志留痕', async () => {
  const correctSecret = randomBytes(32).toString('hex')
  const wrongSecret = randomBytes(32).toString('hex')
  const portX = await freePort()
  const portY = await freePort()
  const loggerX = recordingLogger()
  const loggerY = recordingLogger()

  const x = createPeerManager({
    config: {
      nodeId: 'node-x-test',
      nodeName: 'node-x-test',
      listen: { enabled: true, host: '127.0.0.1', port: portX },
      // X 侧配置的是正确 secret；Y 用了错误 secret 拨入。
      peers: [{ nodeId: 'node-y-test', nodeName: 'node-y-test', host: '127.0.0.1', port: portY, secret: correctSecret, dial: 'off' }],
      ...MANAGER_TUNING,
    },
    instanceEpoch: 'node-x-test-epoch',
    logger: loggerX,
  })
  const y = createPeerManager({
    config: {
      nodeId: 'node-y-test',
      nodeName: 'node-y-test',
      listen: { enabled: true, host: '127.0.0.1', port: portY },
      peers: [{ nodeId: 'node-x-test', nodeName: 'node-x-test', host: '127.0.0.1', port: portX, secret: wrongSecret, dial: 'auto' }],
      ...MANAGER_TUNING,
    },
    instanceEpoch: 'node-y-test-epoch',
    logger: loggerY,
  })
  try {
    await x.start()
    await y.start()
    await waitFor(
      () => {
        const [entry] = y.state()
        return entry.state === 'error'
          && typeof entry.error === 'string'
          && /auth/.test(entry.error)
      },
      { label: "Y state.error to mention auth (wrong secret)", timeoutMs: 6000 },
    )
    assert.equal(y.activeLinkCount(), 0, 'no ready link with a wrong secret')
    assert.equal(x.activeLinkCount(), 0, 'listener must reject the bad proof')
    const logs = loggerY.lines.filter(line => line.level === 'warn' || line.level === 'error')
    assert.ok(
      logs.some(line => /invalid-proof|handshake rejected|hello rejected|welcome rejected/i.test(line.text)),
      `expected a handshake failure log, got: ${JSON.stringify(logs)}`,
    )
    // X 侧也记了拒绝日志（listener 的 verifyHello 失败）。
    assert.ok(
      loggerX.lines.some(line => /hello rejected|invalid-proof/i.test(line.text)),
      `expected listener-side rejection log, got: ${JSON.stringify(loggerX.lines)}`,
    )
  } finally {
    await Promise.allSettled([y.stop(), x.stop()])
  }
})

// =====================================================================
// 5. peer-link 心跳超时（对端握手后沉默）
// =====================================================================

test('peer-link 心跳超时：heartbeatTimeoutMs 内无入帧 → close("timeout")，onDown 只一次', async () => {
  const secret = randomBytes(32).toString('hex')
  const listenerNodeId = 'silent-test'
  const nonceCache = new NonceCache()
  const server = createNetServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = address !== null && typeof address === 'object' ? address.port : 0
  server.on('connection', socket => {
    socket.on('error', () => {})
    let buffer = Buffer.alloc(0)
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0)
        if (length === 0 || length > 2 * 1024 * 1024) {
          socket.destroy()
          return
        }
        if (buffer.length < 4 + length) return
        const payload = buffer.subarray(4, 4 + length)
        buffer = buffer.subarray(4 + length)
        if (payload[0] !== 0x7b) continue // 忽略二进制帧
        let frame
        try {
          frame = JSON.parse(payload.toString('utf8'))
        } catch {
          continue
        }
        if (frame.method === 'peer.hello') {
          const check = verifyHello({ frame, listenerNodeId, secret, nonceCache })
          if (!check.ok) {
            socket.destroy()
            return
          }
          const welcome = createWelcome({ hello: frame, listenerNodeId, secret, nodeName: listenerNodeId })
          writeFramed(socket, encodeJsonFrame(welcome))
          // 之后保持绝对沉默：不回 ping、不发 heartbeat。
        }
      }
    })
  })

  /** @type {string[]} */
  const downReasons = []
  let upCount = 0
  const dialerSocket = netConnect({ host: '127.0.0.1', port })
  const link = createPeerLink({
    socket: dialerSocket,
    role: 'dialer',
    nodeId: 'brain-test',
    peerNodeId: listenerNodeId,
    secret,
    nodeName: 'brain-test',
    logger: silentLogger(),
    requestTimeoutMs: 1000,
    heartbeatIntervalMs: 40,
    heartbeatTimeoutMs: 150,
    handlers: {
      onUp: () => {
        upCount += 1
      },
      onDown: (closedLink, reason) => downReasons.push(reason),
    },
  })
  try {
    await waitFor(() => link.isReady(), { label: 'handshake with silent peer', timeoutMs: 4000 })
    assert.equal(upCount, 1)
    await waitFor(() => downReasons.length > 0, { label: 'heartbeat timeout close', timeoutMs: 4000 })
    assert.equal(downReasons[0], 'timeout')
    assert.equal(link.state, 'closed')
    // close 幂等：再调两次不会重复 onDown、不会抛错。
    link.close('again')
    link.close('again')
    await sleep(150)
    assert.equal(downReasons.length, 1, 'onDown must fire exactly once')
    assert.equal(link.isReady(), false)
  } finally {
    try {
      link.close('cleanup')
    } catch {
      /* ignore */
    }
    await new Promise(resolve => server.close(resolve))
  }
})

// =====================================================================
// 6. peer-link：method/not-found、close 清理 pending、sendBinary 安全返回
// =====================================================================

test('peer-link：未知方法 method/not-found、close 清理 pending、sendBinary 关闭后安全返回 false', async () => {
  const secret = randomBytes(32).toString('hex')
  const linkOptions = {
    requestTimeoutMs: 2000,
    heartbeatIntervalMs: 5000,
    heartbeatTimeoutMs: 20000,
    logger: silentLogger(),
  }
  const server = createNetServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = address !== null && typeof address === 'object' ? address.port : 0
  /** @type {any} */
  let listenerLink = null
  const accepted = new Promise(resolve => {
    server.once('connection', socket => {
      try {
        listenerLink = createPeerLink({
          socket,
          role: 'listener',
          nodeId: 'desk-test',
          secret,
          nodeName: 'desk-test',
          ...linkOptions,
        })
      } catch {
        socket.destroy()
      }
      resolve(undefined)
    })
  })
  /** @type {string[]} */
  const dialerDowns = []
  const dialerSocket = netConnect({ host: '127.0.0.1', port })
  const dialer = createPeerLink({
    socket: dialerSocket,
    role: 'dialer',
    nodeId: 'brain-test',
    peerNodeId: 'desk-test',
    secret,
    nodeName: 'brain-test',
    ...linkOptions,
    handlers: { onDown: (closedLink, reason) => dialerDowns.push(reason) },
  })
  try {
    await accepted
    assert.ok(listenerLink !== null, 'listener link must be created')
    await waitFor(() => dialer.isReady() && listenerLink.isReady(), { label: 'raw link pair ready' })

    // listener 没有注册任何 request 处理器 → 未知方法回 method/not-found。
    await assert.rejects(
      dialer.request('no.such.method', {}),
      error => {
        assert.ok(error instanceof ProtocolError)
        assert.equal(error.kind, 'method/not-found')
        assert.equal(error.code, 4011)
        return true
      },
    )

    // 注册一个只认领 'hang' 的处理器，制造一个永远 pending 的请求。
    listenerLink.onRequest((link, method) => {
      if (method === 'hang') return new Promise(() => {})
      return undefined
    })
    const pending = dialer.request('hang', {}, { timeoutMs: 10000 })
    let settled = false
    pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await sleep(100)
    assert.equal(settled, false, 'request should be pending before close')

    dialer.close('test-close')
    const rejection = await pending.then(
      value => ({ ok: true, value }),
      error => ({ ok: false, error }),
    )
    assert.equal(rejection.ok, false)
    assert.ok(rejection.error instanceof ProtocolError)
    assert.equal(rejection.error.kind, 'link/closed')

    // close 幂等：onDown 只一次。
    dialer.close('test-close-again')
    await sleep(100)
    assert.ok(dialerDowns.length === 1, `expected exactly one onDown, got ${JSON.stringify(dialerDowns)}`)

    // 关闭后 sendBinary / notify 安全返回 false，不抛异常。
    assert.equal(dialer.sendBinary({ artifactId: 'sha256:' + 'a'.repeat(64), offset: 0, length: 1 }, Buffer.from('x')), false)
    assert.equal(dialer.notify('anything', {}), false)
    await assert.rejects(dialer.request('anything', {}), error => {
      assert.equal(error.kind, 'link/closed')
      return true
    })
  } finally {
    try {
      dialer.close('cleanup')
    } catch {
      /* ignore */
    }
    try {
      listenerLink?.close('cleanup')
    } catch {
      /* ignore */
    }
    await new Promise(resolve => server.close(resolve))
  }
})

// =====================================================================
// 7. onRawConnection：配对连接接管 / 普通对等连接放行 / hook 抛错兜底
// =====================================================================

test('onRawConnection：hook 接管配对魔数连接、unshift+proceed 放行普通握手、hook 抛错按 false 兜底', async () => {
  /** @type {Array<{type:string, firstByte:number}>} */
  const hookEvents = []
  /** @param {string} label */
  const echoHandler = label => (link, method, params) => (method === 'echo' ? { by: link.nodeId, params } : undefined)

  const pair = await createPair({
    dial: 'off',
    buildHandlers: label => (label === 'b'
      ? {
          // listener 侧 raw connection hook：先读首字节判断「配对连接(R)」还是「普通对等帧」。
          onRawConnection: (socket, proceed) => {
            let decided = false
            const onData = chunk => {
              if (decided || chunk.length === 0) return
              decided = true
              socket.off('data', onData)
              hookEvents.push({ type: chunk[0] === 0x52 ? 'takeover' : 'proceed', firstByte: chunk[0] })
              if (chunk[0] === 0x52) {
                // 配对连接：本 hook 接管，自己关闭 socket（不进入 PeerLink 握手）。
                socket.destroy()
                return
              }
              // 普通对等连接：把读掉的字节 unshift 回去，再 proceed 继续正常握手。
              socket.unshift(chunk)
              proceed()
            }
            socket.on('data', onData)
            return true
          },
          onRequest: echoHandler('b'),
        }
      : { onRequest: echoHandler('a') }),
  })
  /** @type {Array<Awaited<ReturnType<typeof createPair>>>} */
  const pairs = [pair]
  try {
    await Promise.all([pair.a.start(), pair.b.start()])

    // (1) 普通对等连接：hook 返回 true → 读字节 → unshift + proceed → 正常握手完成。
    await pair.a.dialNow('desk-test')
    await waitFor(
      () => pair.a.activeLinkCount() === 1 && pair.b.activeLinkCount() === 1,
      { label: 'peer link established through raw hook' },
    )
    assert.ok(hookEvents.some(event => event.type === 'proceed'), 'hook must have called proceed for a peer connection')
    assert.notEqual(hookEvents.find(event => event.type === 'proceed').firstByte, 0x52)
    assert.deepEqual(
      await pair.a.linkFor('desk-test').request('echo', { x: 1 }),
      { by: 'desk-test', params: { x: 1 } },
    )

    // (2) 配对连接：客户端发 1B 魔数 'R' + 一行 JSON → hook 接管并关闭，不影响已有链路。
    const client = netConnect({ host: '127.0.0.1', port: pair.b.listenPort })
    client.on('error', () => {})
    const clientClosed = new Promise(resolve => client.once('close', resolve))
    client.write(Buffer.concat([Buffer.from([0x52]), Buffer.from('{"v":1,"type":"pair.request"}\n')]))
    await waitFor(() => hookEvents.some(event => event.type === 'takeover'), { label: 'pairing hook takeover' })
    await Promise.race([
      clientClosed,
      sleep(3000).then(() => {
        throw new Error('hook did not close the pairing socket')
      }),
    ])
    assert.equal(pair.a.activeLinkCount(), 1, 'pairing takeover must not disturb the existing peer link')
    assert.equal(pair.b.activeLinkCount(), 1)

    // (3) hook 抛异常 → 按 false 处理，正常对等握手仍应成功。
    const fallback = await createPair({
      dial: 'off',
      buildHandlers: label => ({
        onRawConnection: () => {
          throw new Error('hook boom')
        },
        onRequest: echoHandler(label),
      }),
    })
    pairs.push(fallback)
    await Promise.all([fallback.a.start(), fallback.b.start()])
    await fallback.a.dialNow('desk-test')
    await waitFor(
      () => fallback.a.activeLinkCount() === 1 && fallback.b.activeLinkCount() === 1,
      { label: 'handshake fallback after hook throws', timeoutMs: 6000 },
    )
    assert.deepEqual(
      await fallback.a.linkFor('desk-test').request('echo', { y: 2 }),
      { by: 'desk-test', params: { y: 2 } },
    )
  } finally {
    await Promise.allSettled(pairs.map(item => item.stop()))
  }
})

// =====================================================================
// 8. addPeer / removePeer 运行时增删 + state 的 source/removable
// =====================================================================

test('addPeer 自动拨号建链（source=paired）、removePeer 关链且不再重拨、state 透传 source/removable', async () => {
  const secret = randomBytes(32).toString('hex')
  const [portA, portB] = [await freePort(), await freePort()]
  const tuning = {
    requestTimeoutMs: 2000,
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 1500,
    rttIntervalMs: 100,
  }
  // B 是配置节点（source 缺省 config），只等 A 拨入；A 初始没有 peer，运行时 addPeer。
  const b = createPeerManager({
    config: {
      nodeId: 'desk-test',
      nodeName: 'desk-test',
      listen: { enabled: true, host: '127.0.0.1', port: portB },
      peers: [{ nodeId: 'brain-test', nodeName: 'brain-test', host: '127.0.0.1', port: portA, secret, dial: 'off' }],
      ...tuning,
    },
    instanceEpoch: 'desk-test-epoch',
    logger: silentLogger(),
  })
  const a = createPeerManager({
    config: {
      nodeId: 'brain-test',
      nodeName: 'brain-test',
      listen: { enabled: true, host: '127.0.0.1', port: portA },
      peers: [],
      ...tuning,
    },
    instanceEpoch: 'brain-test-epoch',
    logger: silentLogger(),
  })
  const pairedPeer = {
    nodeId: 'desk-test',
    nodeName: 'desk-paired',
    host: '127.0.0.1',
    port: portB,
    secret,
    dial: 'auto',
    source: 'paired',
    addedAt: Date.now(),
  }
  try {
    await Promise.all([a.start(), b.start()])
    assert.equal(a.state().length, 0)

    // 非法 addPeer：self / 非法端口 → null（不抛、不新增条目）。
    assert.equal(a.addPeer({ ...pairedPeer, nodeId: 'brain-test' }), null)
    assert.equal(a.addPeer({ ...pairedPeer, port: 0 }), null)
    assert.equal(a.state().length, 0)

    // (1) 运行时 addPeer(source:'paired') → 立即自动拨号建链。
    const added = a.addPeer(pairedPeer)
    assert.ok(added !== null, 'addPeer must return the normalized peer')
    assert.equal(added.nodeId, 'desk-test')
    assert.equal(added.source, 'paired')
    await waitFor(
      () => a.activeLinkCount() === 1 && b.activeLinkCount() === 1,
      { label: 'link established after addPeer' },
    )

    const [rowA] = a.state()
    assert.equal(rowA.peerNodeId, 'desk-test')
    assert.equal(rowA.nodeName, 'desk-paired')
    assert.equal(rowA.state, 'online')
    assert.equal(rowA.direction, 'out')
    assert.equal(rowA.source, 'paired')
    assert.equal(rowA.removable, true)
    const [rowB] = b.state()
    assert.equal(rowB.peerNodeId, 'brain-test')
    assert.equal(rowB.source, 'config')
    assert.equal(rowB.removable, false)
    assert.equal(rowB.state, 'online')

    // (2) 同 nodeId 再 addPeer（连接参数不变）→ 去重更新（只有一行）、链路不重建。
    const linkBeforeUpdate = a.linkFor('desk-test')
    const updated = a.addPeer({ ...pairedPeer, nodeName: 'desk-paired-2' })
    assert.ok(updated !== null)
    assert.equal(a.state().length, 1)
    assert.equal(a.state()[0].nodeName, 'desk-paired-2')
    await sleep(250)
    assert.equal(a.linkFor('desk-test'), linkBeforeUpdate, 'unchanged config must keep the existing link')

    // (3) removePeer → 链路关闭、state 清空、超过一次退避窗口后仍不重拨。
    assert.equal(a.removePeer('desk-test'), true)
    await waitFor(() => a.activeLinkCount() === 0, { label: 'link closed after removePeer' })
    assert.equal(a.state().length, 0)
    await waitFor(() => b.state()[0].state !== 'online', {
      label: 'peer side observes link down',
      timeoutMs: 3000,
    })
    await sleep(1800) // > 1s 首个退避档：确认 dial:'auto' 循环已停止
    assert.equal(a.activeLinkCount(), 0, 'removed peer must not be re-dialed')
    assert.equal(b.activeLinkCount(), 0)
    assert.equal(a.removePeer('desk-test'), false, 'removePeer must be idempotent')

    // (4) 重新 addPeer → 再次自动建链（不需要重启 manager）。
    assert.ok(a.addPeer(pairedPeer) !== null)
    await waitFor(
      () => a.activeLinkCount() === 1 && b.activeLinkCount() === 1,
      { label: 'link re-established after re-addPeer' },
    )
    assert.equal(a.state()[0].source, 'paired')
  } finally {
    await Promise.allSettled([a.stop(), b.stop()])
  }
})

// =====================================================================
// 9. setListen：运行时改监听端口（旧端口关闭 / 新 peer 可连 / 已有链路 RPC 仍通）
// =====================================================================

test('setListen：改到随机空闲端口即时生效、旧端口不再监听、已有链路 RPC 仍通、新 peer 可连新端口', async () => {
  const secret = randomBytes(32).toString('hex')
  const [oldPort, portB, portC, newPort] = [await freePort(), await freePort(), await freePort(), await freePort()]
  const echoHandler = (link, method, params) => (method === 'echo' ? { by: link.nodeId, params } : undefined)
  const tuning = { requestTimeoutMs: 2000, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1500, rttIntervalMs: 100 }
  const loggerA = recordingLogger()

  // A(brain) 监听 oldPort；B(desk) 主动拨 A → 先建立一条已有链路。
  const a = createPeerManager({
    config: {
      nodeId: 'brain-test',
      nodeName: 'brain-test',
      listen: { enabled: true, host: '127.0.0.1', port: oldPort },
      peers: [{ nodeId: 'desk-test', nodeName: 'desk-test', host: '127.0.0.1', port: portB, secret, dial: 'off' }],
      ...tuning,
    },
    instanceEpoch: 'brain-test-epoch',
    logger: loggerA,
    handlers: { onRequest: echoHandler },
  })
  const b = createPeerManager({
    config: {
      nodeId: 'desk-test',
      nodeName: 'desk-test',
      listen: { enabled: true, host: '127.0.0.1', port: portB },
      peers: [{ nodeId: 'brain-test', nodeName: 'brain-test', host: '127.0.0.1', port: oldPort, secret, dial: 'auto' }],
      ...tuning,
    },
    instanceEpoch: 'desk-test-epoch',
    logger: silentLogger(),
    handlers: { onRequest: echoHandler },
  })
  // C(laptop) 之后拨 A 的**新**端口，验证新监听真的可用。
  const c = createPeerManager({
    config: {
      nodeId: 'laptop-test',
      nodeName: 'laptop-test',
      listen: { enabled: true, host: '127.0.0.1', port: portC },
      peers: [{ nodeId: 'brain-test', nodeName: 'brain-test', host: '127.0.0.1', port: newPort, secret, dial: 'auto' }],
      ...tuning,
    },
    instanceEpoch: 'laptop-test-epoch',
    logger: silentLogger(),
    handlers: { onRequest: echoHandler },
  })
  try {
    await Promise.all([a.start(), b.start()])
    await waitFor(() => a.activeLinkCount() === 1 && b.activeLinkCount() === 1, { label: 'initial pair online' })
    assert.deepEqual(a.listenInfo(), { enabled: true, host: '127.0.0.1', port: oldPort })

    // (1) 改监听到随机空闲端口。
    const changed = await a.setListen({ enabled: true, host: '127.0.0.1', port: newPort })
    assert.deepEqual(changed, { ok: true, listen: { enabled: true, host: '127.0.0.1', port: newPort } })
    assert.deepEqual(a.listenInfo(), { enabled: true, host: '127.0.0.1', port: newPort })
    assert.equal(a.listenPort, newPort)

    // (2) 旧端口不再监听；新端口在监听。
    await assertPortClosed(oldPort)
    await assertPortOpen(newPort)

    // (3) 已有链路（A 侧是 listener 的 inbound link）在重绑后 RPC 仍通。
    assert.deepEqual(
      await a.linkFor('desk-test').request('echo', { n: 1 }),
      { by: 'desk-test', params: { n: 1 } },
    )

    // (4) 新 peer 能连上新端口：先让 A 认识 C（paired 来源），再启动 C 自动拨号。
    assert.ok(a.addPeer({ nodeId: 'laptop-test', nodeName: 'laptop-test', host: '127.0.0.1', port: portC, secret, dial: 'off', source: 'paired' }))
    await c.start()
    await waitFor(() => a.activeLinkCount() === 2 && c.activeLinkCount() === 1, {
      label: 'new peer connects to the rebound port',
    })
    assert.deepEqual(
      await c.linkFor('brain-test').request('echo', { p: 'c' }),
      { by: 'brain-test', params: { p: 'c' } },
    )

    // (5) 配置未变的幂等调用直接成功，监听与链路均不变。
    const listenBefore = a.listenPort
    const linkBefore = a.linkFor('desk-test')
    const again = await a.setListen({ enabled: true, host: '127.0.0.1', port: newPort })
    assert.equal(again.ok, true)
    assert.equal(a.listenPort, listenBefore)
    assert.equal(a.linkFor('desk-test'), linkBefore)
    assert.deepEqual(await b.linkFor('brain-test').request('echo', { n: 2 }), { by: 'brain-test', params: { n: 2 } })
  } finally {
    await Promise.allSettled([c.stop(), a.stop(), b.stop()])
  }
})

// =====================================================================
// 10. setListen：绑定失败回滚 / disabled 释放端口 / 重新 enabled 恢复
// =====================================================================

test('setListen：绑定占用端口返回 ok:false 且旧监听仍工作；enabled=false 释放端口；重新 enabled 恢复', async () => {
  const secret = randomBytes(32).toString('hex')
  const portA = await freePort()
  const echoHandler = (link, method, params) => (method === 'echo' ? { by: link.nodeId, params } : undefined)
  const tuning = { requestTimeoutMs: 2000, heartbeatIntervalMs: 100, heartbeatTimeoutMs: 1500, rttIntervalMs: 100 }

  // 占位 server：模拟「端口已被其他进程占用」。
  const occupied = createNetServer()
  await new Promise((resolve, reject) => {
    occupied.once('error', reject)
    occupied.listen(0, '127.0.0.1', resolve)
  })
  const occupiedAddress = occupied.address()
  const occupiedPort = occupiedAddress !== null && typeof occupiedAddress === 'object' ? occupiedAddress.port : 0

  const a = createPeerManager({
    config: {
      nodeId: 'brain-test',
      nodeName: 'brain-test',
      listen: { enabled: true, host: '127.0.0.1', port: portA },
      peers: [{ nodeId: 'laptop-test', nodeName: 'laptop-test', host: '127.0.0.1', port: 9, secret, dial: 'off' }],
      ...tuning,
    },
    instanceEpoch: 'brain-test-epoch',
    logger: recordingLogger(),
    handlers: { onRequest: echoHandler },
  })
  /** @type {any[]} */
  const extraManagers = []
  try {
    await a.start()
    // C 主动拨 A，建立一条已有链路（用于验证 disable/重绑后链路不受影响）。
    const c = createPeerManager({
      config: {
        nodeId: 'laptop-test',
        nodeName: 'laptop-test',
        listen: { enabled: true, host: '127.0.0.1', port: 0 },
        peers: [{ nodeId: 'brain-test', nodeName: 'brain-test', host: '127.0.0.1', port: portA, secret, dial: 'auto' }],
        ...tuning,
      },
      instanceEpoch: 'laptop-test-epoch',
      logger: silentLogger(),
      handlers: { onRequest: echoHandler },
    })
    extraManagers.push(c)
    await c.start()
    await waitFor(() => a.activeLinkCount() === 1 && c.activeLinkCount() === 1, { label: 'pair online' })
    const originalInfo = a.listenInfo()
    assert.deepEqual(originalInfo, { enabled: true, host: '127.0.0.1', port: portA })

    // (1) 绑定被占用端口 → ok:false，旧监听恢复且仍能接受新连接。
    const failed = await a.setListen({ enabled: true, host: '127.0.0.1', port: occupiedPort })
    assert.equal(failed.ok, false)
    assert.match(String(failed.error), /EADDRINUSE/)
    assert.deepEqual(a.listenInfo(), originalInfo)
    await assertPortOpen(portA)
    // 已有链路不受影响。
    assert.deepEqual(
      await c.linkFor('brain-test').request('echo', { after: 'rollback' }),
      { by: 'brain-test', params: { after: 'rollback' } },
    )
    // 旧监听确实还能完成新的对等握手：起一个新 node D 拨过来。
    assert.ok(a.addPeer({ nodeId: 'tablet-test', nodeName: 'tablet-test', host: '127.0.0.1', port: 9, secret, dial: 'off', source: 'paired' }))
    const d = createPeerManager({
      config: {
        nodeId: 'tablet-test',
        nodeName: 'tablet-test',
        listen: { enabled: true, host: '127.0.0.1', port: 0 },
        peers: [{ nodeId: 'brain-test', nodeName: 'brain-test', host: '127.0.0.1', port: portA, secret, dial: 'auto' }],
        ...tuning,
      },
      instanceEpoch: 'tablet-test-epoch',
      logger: silentLogger(),
      handlers: { onRequest: echoHandler },
    })
    extraManagers.push(d)
    await d.start()
    await waitFor(() => d.activeLinkCount() === 1 && a.activeLinkCount() === 2, {
      label: 'new peer connects to restored listener',
    })

    // (2) enabled=false：只关闭监听，端口释放，已有链路仍可用。
    const disabled = await a.setListen({ enabled: false })
    assert.deepEqual(disabled, { ok: true, listen: { enabled: false, host: '127.0.0.1', port: portA } })
    assert.deepEqual(a.listenInfo(), { enabled: false, host: '127.0.0.1', port: portA })
    assert.equal(a.listenPort, null)
    await assertPortClosed(portA)
    assert.deepEqual(
      await c.linkFor('brain-test').request('echo', { after: 'disable' }),
      { by: 'brain-test', params: { after: 'disable' } },
    )
    // 幂等 disable。
    assert.deepEqual(await a.setListen({ enabled: false }), { ok: true, listen: { enabled: false, host: '127.0.0.1', port: portA } })

    // (3) 重新 enabled（同 host/port）→ 恢复监听，新 peer 能连。
    const reenabled = await a.setListen({ enabled: true, host: '127.0.0.1', port: portA })
    assert.deepEqual(reenabled, { ok: true, listen: { enabled: true, host: '127.0.0.1', port: portA } })
    assert.equal(a.listenPort, portA)
    await assertPortOpen(portA)
    assert.ok(a.addPeer({ nodeId: 'phone-test', nodeName: 'phone-test', host: '127.0.0.1', port: 9, secret, dial: 'off', source: 'paired' }))
    const e = createPeerManager({
      config: {
        nodeId: 'phone-test',
        nodeName: 'phone-test',
        listen: { enabled: true, host: '127.0.0.1', port: 0 },
        peers: [{ nodeId: 'brain-test', nodeName: 'brain-test', host: '127.0.0.1', port: portA, secret, dial: 'auto' }],
        ...tuning,
      },
      instanceEpoch: 'phone-test-epoch',
      logger: silentLogger(),
      handlers: { onRequest: echoHandler },
    })
    extraManagers.push(e)
    await e.start()
    await waitFor(() => e.activeLinkCount() === 1 && a.activeLinkCount() === 3, {
      label: 'new peer connects after re-enable',
    })
    // 已有两条旧链路仍在线且可 RPC。
    assert.equal(c.activeLinkCount(), 1)
    assert.equal(d.activeLinkCount(), 1)
    assert.deepEqual(await e.linkFor('brain-test').request('echo', { final: true }), { by: 'brain-test', params: { final: true } })
  } finally {
    await Promise.allSettled([...extraManagers.map(manager => manager.stop()), a.stop()])
    await new Promise(resolve => {
      try {
        occupied.close(resolve)
      } catch {
        resolve(undefined)
      }
    })
  }
})
