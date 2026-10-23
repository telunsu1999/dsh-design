/**
 * Pairing protocol (SPEC §10.2): a one-shot line protocol that runs on the same
 * TCP port as the peer listener, *before* the normal peer handshake.
 *
 *   client -> server: 0x52 ('R') + one JSON line
 *   server -> client: one JSON line
 *
 * The token is the shared pairing secret: the request carries an HMAC proof and
 * both sides derive the real link secret from the token and the two node ids.
 * The server side waits for a human approval in the panel before answering.
 *
 * Dependency-free: node:crypto + node:net.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import net from 'node:net'

/** First byte of a pairing connection (not a framed JSON-RPC frame: those start with a 0x00 length byte). */
export const PAIR_MAGIC = 0x52
/** Protocol version carried in the JSON lines. */
export const PAIR_VERSION = 1

const MAX_LINE_BYTES = 64 * 1024
const SNIFF_TIMEOUT_MS = 5_000
const READ_TIMEOUT_MS = 15_000
const APPROVAL_TIMEOUT_MS = 120_000
const NODE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const HEX_RE = /^[0-9a-f]+$/

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value @param {string} fallback */
function oneLine(value, fallback = '') {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  return text === '' ? fallback : text
}

/** One 32-byte hex nonce. */
export function generateNonce() {
  return randomBytes(32).toString('hex')
}

/** HMAC-SHA256 hex. */
export function hmacHex(key, text) {
  return createHmac('sha256', key).update(String(text)).digest('hex')
}

/** Constant-time comparison for two hex strings. */
export function constantTimeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length || a.length % 2 !== 0 || !HEX_RE.test(a) || !HEX_RE.test(b)) return false
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** The per-link secret both sides derive after a successful pairing. */
export function deriveLinkSecret(token, nodeA, nodeB) {
  return hmacHex(token, `remotenode-link:v1:${[String(nodeA), String(nodeB)].sort().join('~')}`)
}

/** Short, non-reversible display fingerprint of the pairing token. */
export function tokenFingerprint(token) {
  const digest = createHash('sha256').update(String(token)).digest('hex')
  return digest.slice(0, 16)
}

/** Request proof transcript. */
export function requestTranscript(nodeId, nonce) {
  return `remotenode-pair-request:v1:${nodeId}:${nonce}`
}

/** Response proof transcript. */
export function responseTranscript(serverNodeId, clientNodeId, requestNonce, serverNonce) {
  return `remotenode-pair-response:v1:${serverNodeId}:${clientNodeId}:${requestNonce}:${serverNonce}`
}

/** Strip the IPv4-mapped prefix from a socket address. */
export function normalizeIp(address) {
  const value = typeof address === 'string' ? address : ''
  if (value.startsWith('::ffff:')) return value.slice('::ffff:'.length)
  return value
}

/**
 * Inspect a freshly accepted listener socket before the peer handshake.
 * Always takes ownership of the socket (returns true): reads the first byte,
 * then either starts pairing or hands the byte back and calls `onNormal`.
 *
 * @param {import('node:net').Socket} socket
 * @param {{ onPair: (socket: import('node:net').Socket) => void,
 *           onNormal: () => void, timeoutMs?: number }} handlers
 * @returns {true}
 */
export function sniffPairing(socket, handlers) {
  const timeoutMs = Number(handlers?.timeoutMs) > 0 ? Number(handlers.timeoutMs) : SNIFF_TIMEOUT_MS
  let done = false
  const cleanup = () => {
    clearTimeout(timer)
    socket.removeListener('readable', onReadable)
    socket.removeListener('error', onError)
    socket.removeListener('close', onClose)
  }
  const finish = fn => {
    if (done) return
    done = true
    cleanup()
    try { fn() } catch {}
  }
  const timer = setTimeout(() => finish(() => { try { socket.destroy() } catch {} }), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  const onError = () => finish(() => {})
  const onClose = () => finish(() => {})
  const onReadable = () => {
    let chunk
    try { chunk = socket.read(1) } catch { chunk = null }
    if (chunk === null) return
    if (chunk[0] === PAIR_MAGIC) {
      finish(() => {
        if (typeof handlers.onPair === 'function') handlers.onPair(socket)
      })
      return
    }
    finish(() => {
      try { socket.unshift(chunk) } catch {}
      if (typeof handlers.onNormal === 'function') handlers.onNormal()
    })
  }
  socket.on('readable', onReadable)
  socket.on('error', onError)
  socket.on('close', onClose)
  return true
}

/** Read one newline-terminated JSON value from a socket (magic byte already consumed). */
function readJsonLine(socket, options = {}) {
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_LINE_BYTES
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : READ_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    let buffer = ''
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      cleanup()
      fn(value)
    }
    const timer = setTimeout(() => finish(reject, new Error('pair/timeout')), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    const onError = error => finish(reject, error instanceof Error ? error : new Error(String(error)))
    const onClose = () => finish(reject, new Error('pair/closed'))
    const onData = chunk => {
      buffer += chunk.toString('utf8')
      if (buffer.length > maxBytes) {
        finish(reject, new Error('pair/frame-too-large'))
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const line = buffer.slice(0, newline).trim()
      try {
        const value = JSON.parse(line)
        finish(resolve, value)
      } catch {
        finish(reject, new Error('pair/invalid-json'))
      }
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    try { socket.resume() } catch {}
  })
}

/** Write one JSON line (best effort). */
function writeJsonLine(socket, value) {
  try {
    socket.write(`${JSON.stringify(value)}\n`)
    return true
  } catch {
    return false
  }
}

/**
 * Validate + authenticate an incoming `pair.request` object.
 * @returns {{ok:true, request:object} | {ok:false, error:string}}
 */
export function validatePairRequest(input, token) {
  if (!isRecord(input) || input.v !== PAIR_VERSION || input.type !== 'pair.request') return { ok: false, error: 'pair/invalid' }
  const nodeId = oneLine(input.nodeId)
  if (!NODE_ID_RE.test(nodeId)) return { ok: false, error: 'pair/invalid' }
  const nonce = oneLine(input.nonce)
  if (!HEX_RE.test(nonce) || nonce.length < 32) return { ok: false, error: 'pair/invalid' }
  const proof = oneLine(input.proof)
  if (!constantTimeEqualHex(proof, hmacHex(token, requestTranscript(nodeId, nonce)))) {
    return { ok: false, error: 'auth/invalid-token' }
  }
  const listenPort = Number(input.listenPort)
  return {
    ok: true,
    request: {
      nodeId,
      nodeName: oneLine(input.nodeName) || nodeId,
      instanceEpoch: oneLine(input.instanceEpoch),
      listenPort: Number.isInteger(listenPort) && listenPort > 0 && listenPort <= 65535 ? listenPort : 0,
      nonce,
    },
  }
}

/**
 * Serve one incoming pairing connection that the sniffer routed here.
 * @param {import('node:net').Socket} socket
 * @param {{
 *   token: string,
 *   self: {nodeId:string, nodeName:string, listenPort?:number},
 *   isKnownPeer: (nodeId: string) => boolean,
 *   requestApproval: (request: object) => Promise<{approved:boolean, reason?:string}>,
 *   onApproved: (peer: object, request: object) => void | Promise<void>,
 *   logger?: Console,
 *   approvalTimeoutMs?: number,
 * }} deps
 */
export async function serveIncoming(socket, deps) {
  const { token, self, isKnownPeer, requestApproval, onApproved } = deps
  const logger = deps.logger ?? console
  const respond = value => writeJsonLine(socket, value)
  try {
    let raw
    try {
      raw = await readJsonLine(socket)
    } catch (error) {
      logger.warn?.(`[remotenode] pairing read failed: ${error?.message ?? error}`)
      return
    }
    const checked = validatePairRequest(raw, token)
    if (checked.ok !== true) {
      respond({ v: PAIR_VERSION, type: 'pair.response', ok: false, error: checked.error })
      return
    }
    const request = checked.request
    if (request.nodeId === self.nodeId) {
      respond({ v: PAIR_VERSION, type: 'pair.response', ok: false, error: 'pair/self' })
      return
    }
    if (isKnownPeer(request.nodeId)) {
      respond({ v: PAIR_VERSION, type: 'pair.response', ok: false, error: 'pair/already-paired' })
      return
    }
    let decision
    try {
      decision = await requestApproval({
        nodeId: request.nodeId,
        nodeName: request.nodeName,
        remoteAddress: normalizeIp(socket.remoteAddress),
        remotePort: Number(socket.remotePort) || 0,
        listenPort: request.listenPort,
      })
    } catch (error) {
      logger.warn?.('[remotenode] pairing approval failed', error)
      respond({ v: PAIR_VERSION, type: 'pair.response', ok: false, error: 'pair/invalid' })
      return
    }
    if (decision?.approved !== true) {
      respond({ v: PAIR_VERSION, type: 'pair.response', ok: false, error: decision?.reason === 'timeout' ? 'pair/timeout' : 'pair/rejected' })
      return
    }
    const serverNonce = generateNonce()
    const peer = {
      nodeId: request.nodeId,
      nodeName: request.nodeName,
      host: normalizeIp(socket.remoteAddress),
      port: request.listenPort,
      secret: deriveLinkSecret(token, self.nodeId, request.nodeId),
      dial: request.listenPort > 0 ? 'auto' : 'off',
      source: 'paired',
      addedAt: Date.now(),
    }
    try {
      await onApproved(peer, request)
    } catch (error) {
      logger.warn?.('[remotenode] pairing persist failed', error)
      respond({ v: PAIR_VERSION, type: 'pair.response', ok: false, error: 'pair/invalid' })
      return
    }
    respond({
      v: PAIR_VERSION,
      type: 'pair.response',
      ok: true,
      nodeId: self.nodeId,
      nodeName: self.nodeName,
      listenPort: Number.isInteger(self.listenPort) && self.listenPort > 0 ? self.listenPort : 0,
      nonce: serverNonce,
      proof: hmacHex(token, responseTranscript(self.nodeId, request.nodeId, request.nonce, serverNonce)),
    })
  } catch (error) {
    logger.warn?.('[remotenode] pairing serve failed', error)
    respond({ v: PAIR_VERSION, type: 'pair.response', ok: false, error: 'pair/invalid' })
  } finally {
    try { socket.end() } catch {}
    const timer = setTimeout(() => { try { socket.destroy() } catch {} }, 500)
    if (typeof timer.unref === 'function') timer.unref()
  }
}

/**
 * Dial a peer and pair with it (client role).
 * @param {{
 *   host: string, port: number, token: string,
 *   self: {nodeId:string, nodeName:string, instanceEpoch?:string, listenPort?:number},
 *   timeoutMs?: number,
 * }} options
 * @returns {Promise<{ok:true, peer:object} | {ok:false, error:string}>}
 */
export function connectAndPair(options) {
  const { host, port, token, self } = options
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 25_000
  return new Promise(resolve => {
    let settled = false
    let socket
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket?.destroy() } catch {}
      resolve(value)
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'pair/timeout' }), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    try {
      socket = net.connect({ host, port })
    } catch (error) {
      finish({ ok: false, error: `connect failed: ${error?.message ?? error}` })
      return
    }
    socket.once('error', error => finish({ ok: false, error: `connect failed: ${error?.code ?? error?.message ?? error}` }))
    socket.once('close', () => { if (!settled) finish({ ok: false, error: 'pair/closed' }) })
    socket.once('connect', () => {
      const nonce = generateNonce()
      const request = {
        v: PAIR_VERSION,
        type: 'pair.request',
        nodeId: self.nodeId,
        nodeName: self.nodeName,
        instanceEpoch: self.instanceEpoch ?? '',
        listenPort: Number.isInteger(self.listenPort) && self.listenPort > 0 ? self.listenPort : 0,
        nonce,
        proof: hmacHex(token, requestTranscript(self.nodeId, nonce)),
      }
      try {
        socket.write(Buffer.concat([Buffer.from([PAIR_MAGIC]), Buffer.from(`${JSON.stringify(request)}\n`)]))
      } catch (error) {
        finish({ ok: false, error: `pair failed: ${error?.message ?? error}` })
        return
      }
      readJsonLine(socket).then(response => {
        if (!isRecord(response) || response.type !== 'pair.response') {
          finish({ ok: false, error: 'pair/invalid-response' })
          return
        }
        if (response.ok !== true) {
          finish({ ok: false, error: oneLine(response.error) || 'pair/failed' })
          return
        }
        const serverNodeId = oneLine(response.nodeId)
        if (!NODE_ID_RE.test(serverNodeId)) {
          finish({ ok: false, error: 'pair/invalid-response' })
          return
        }
        const expected = hmacHex(token, responseTranscript(serverNodeId, self.nodeId, nonce, oneLine(response.nonce)))
        if (!constantTimeEqualHex(expected, oneLine(response.proof))) {
          finish({ ok: false, error: 'auth/invalid-proof' })
          return
        }
        finish({
          ok: true,
          peer: {
            nodeId: serverNodeId,
            nodeName: oneLine(response.nodeName) || serverNodeId,
            host,
            port,
            secret: deriveLinkSecret(token, self.nodeId, serverNodeId),
            dial: 'auto',
            source: 'paired',
            addedAt: Date.now(),
          },
        })
      }).catch(error => finish({ ok: false, error: error?.message?.includes('timeout') ? 'pair/timeout' : `pair failed: ${error?.message ?? error}` }))
    })
  })
}
