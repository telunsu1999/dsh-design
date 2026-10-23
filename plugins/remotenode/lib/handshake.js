/**
 * Peer handshake with per-link shared secret (HMAC challenge/response).
 * Mirrors 07-remotenode-m0-protocol.md §3.
 *
 * Pure ESM, zero dependencies: only node: builtins.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { assertNodeId } from './ids.js'

export const PROTOCOL_VERSION = 1

export const DEFAULT_CAPS = Object.freeze({
  assistantStream: true,
  approvals: true,
  questions: true,
  deliverables: true,
  attachments: true,
  modelSelection: true,
  resumeAfterRestart: true,
  sessionVisibility: 'own-calls',
})

export const DEFAULT_LIMITS = Object.freeze({
  heartbeatMs: 10000,
  maxFrameBytes: 1024 * 1024,
  maxEventBatch: 200,
  maxSessions: 4,
  maxDeliverableBytes: 1024 * 1024 * 1024,
  maxArtifactBytes: 1024 * 1024 * 1024,
  chunkBytes: 1024 * 1024,
  windowBytes: 8 * 1024 * 1024,
  maxConcurrentTransfers: 1,
})

/** @param {Buffer | Uint8Array} bytes */
export function toBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

/**
 * Raw key material for the HMAC proof.
 *
 * Config secrets are arbitrary high-entropy strings (64-hex or similar), so a
 * string secret is used as its UTF-8 bytes. Pass a Buffer to supply raw bytes.
 * @param {string | Buffer | Uint8Array} secret
 * @returns {Buffer}
 */
export function secretBytes(secret) {
  if (typeof secret === 'string') {
    if (secret.length === 0) throw new TypeError('link secret must not be empty')
    return Buffer.from(secret, 'utf8')
  }
  if (secret instanceof Uint8Array) {
    if (secret.byteLength === 0) throw new TypeError('link secret must not be empty')
    return Buffer.from(secret)
  }
  throw new TypeError('link secret must be a string or Buffer')
}

/** @param {string | Buffer | Uint8Array} secret @param {string} message */
function hmac(secret, message) {
  return createHmac('sha256', secretBytes(secret))
    .update(message, 'utf8')
    .digest('base64url')
}

/**
 * Canonical hello transcript (07 §3.4). Order and punctuation are protocol.
 * @param {{nodeId:string, instanceEpoch:string, connectionId:string, protocol:number, ts:number, nonce:string}} hello
 * @param {string} listenerNodeId
 * @returns {string}
 */
export function helloTranscript(hello, listenerNodeId) {
  return [
    'dsh-remotenode/1/hello',
    `dialer=${hello.nodeId}`,
    `dialerEpoch=${hello.instanceEpoch}`,
    `listener=${listenerNodeId}`,
    `connectionId=${hello.connectionId}`,
    `protocol=${hello.protocol}`,
    `ts=${hello.ts}`,
    `nonce=${hello.nonce}`,
  ].join('\n')
}

/**
 * Canonical welcome transcript: hello transcript + listener nonce/ts.
 * @param {string} helloTranscriptValue
 * @param {{nonce:string, ts:number}} welcome
 * @returns {string}
 */
export function welcomeTranscript(helloTranscriptValue, welcome) {
  return [
    helloTranscriptValue,
    `welcomeNonce=${welcome.nonce}`,
    `welcomeTs=${welcome.ts}`,
  ].join('\n')
}

/**
 * Build `peer.hello`.
 * @param {object} options
 * @param {string} options.nodeId
 * @param {string} options.listenerNodeId
 * @param {string | Buffer} options.secret
 * @param {string} [options.nodeName]
 * @param {string} [options.instanceEpoch]
 * @param {string} [options.connectionId]
 * @param {number} [options.ts]
 * @param {string} [options.nonce] base64url 32B
 * @param {string} [options.platform]
 * @param {string} [options.dshVersion]
 * @param {object} [options.capabilities]
 * @param {'shared-secret'|'mtls'} [options.authMode]
 * @returns {{jsonrpc:'2.0', id:string, method:'peer.hello', params:object}}
 */
export function createHello(options) {
  const {
    nodeId, listenerNodeId, secret, nodeName = '', instanceEpoch = randomUUID(),
    connectionId = randomUUID(), ts = Date.now(), nonce = toBase64Url(randomBytes(32)),
    platform = 'linux', dshVersion = '0.2.1-rc.2',
    capabilities = DEFAULT_CAPS, authMode = 'shared-secret',
  } = options
  assertNodeId(nodeId, 'dialer.nodeId')
  assertNodeId(listenerNodeId, 'listener.nodeId')
  const params = {
    protocol: PROTOCOL_VERSION,
    nodeId,
    nodeName,
    instanceEpoch,
    connectionId,
    platform,
    dshVersion,
    capabilities,
    ts,
    nonce,
    authMode,
  }
  if (authMode === 'shared-secret') {
    params.proof = hmac(secret, helloTranscript(params, listenerNodeId))
  }
  return { jsonrpc: '2.0', id: randomUUID(), method: 'peer.hello', params }
}

/**
 * Build `peer.welcome` for a received hello.
 * @param {object} options
 * @param {ReturnType<typeof createHello>} options.hello
 * @param {string} options.listenerNodeId
 * @param {string | Buffer} options.secret
 * @param {string} [options.nodeName]
 * @param {string} [options.instanceEpoch]
 * @param {number} [options.ts]
 * @param {string} [options.nonce]
 * @param {string} [options.platform]
 * @param {string} [options.dshVersion]
 * @param {object} [options.capabilities]
 * @param {object} [options.limits]
 * @returns {{jsonrpc:'2.0', id:string, result:object}}
 */
export function createWelcome(options) {
  const {
    hello, listenerNodeId, secret, nodeName = '', instanceEpoch = randomUUID(),
    ts = Date.now(), nonce = toBase64Url(randomBytes(32)), platform = 'linux',
    dshVersion = '0.2.1-rc.2', capabilities = DEFAULT_CAPS, limits = DEFAULT_LIMITS,
  } = options
  assertNodeId(listenerNodeId, 'listener.nodeId')
  const result = {
    protocol: PROTOCOL_VERSION,
    nodeId: listenerNodeId,
    nodeName,
    instanceEpoch,
    platform,
    dshVersion,
    capabilities,
    ts,
    nonce,
    limits,
    authMode: hello.params.authMode,
  }
  if (hello.params.authMode === 'shared-secret') {
    result.proof = hmac(secret, welcomeTranscript(helloTranscript(hello.params, listenerNodeId), result))
  }
  return { jsonrpc: '2.0', id: hello.id, result }
}

/** Replay cache bounded by capacity and TTL. */
export class NonceCache {
  /** @param {{capacity?:number, ttlMs?:number}} [options] */
  constructor(options = {}) {
    this.capacity = options.capacity ?? 256
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000
    /** @type {Map<string, number>} */
    this.entries = new Map()
  }

  /**
   * Record a nonce; false means replay.
   * @param {string} nodeId
   * @param {string} nonce
   * @param {number} [now]
   * @returns {boolean}
   */
  accept(nodeId, nonce, now = Date.now()) {
    this.#sweep(now)
    const key = `${nodeId}|${nonce}`
    if (this.entries.has(key)) return false
    this.entries.set(key, now + this.ttlMs)
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    return true
  }

  /** @param {number} now */
  #sweep(now) {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(key)
      else break
    }
  }
}

/** Constant-time proof compare. */
function proofEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

/**
 * Verify a received hello on the listener side.
 * @param {object} options
 * @param {ReturnType<typeof createHello>} options.frame
 * @param {string} options.listenerNodeId
 * @param {string | Buffer} options.secret
 * @param {number} [options.now]
 * @param {number} [options.skewMs]
 * @param {NonceCache} [options.nonceCache]
 * @param {string} [options.expectedPeerNodeId]
 * @returns {{ok:true, hello:object} | {ok:false, kind:string, reason?:string}}
 */
export function verifyHello(options) {
  const {
    frame, listenerNodeId, secret, now = Date.now(), skewMs = 5 * 60 * 1000,
    nonceCache = new NonceCache(), expectedPeerNodeId,
  } = options
  if (!frame || frame.method !== 'peer.hello' || !frame.params) {
    return { ok: false, kind: 'peer/internal', reason: 'not-hello' }
  }
  const hello = frame.params
  if (hello.protocol !== PROTOCOL_VERSION) return { ok: false, kind: 'protocol/unsupported' }
  if (!hello.nodeId || typeof hello.nodeId !== 'string') return { ok: false, kind: 'peer/internal', reason: 'nodeId' }
  if (expectedPeerNodeId !== undefined && hello.nodeId !== expectedPeerNodeId) {
    return { ok: false, kind: 'auth/unknown-peer' }
  }
  if (hello.authMode !== 'shared-secret' && hello.authMode !== 'mtls') {
    return { ok: false, kind: 'auth/mode-mismatch' }
  }
  if (!Number.isFinite(hello.ts) || Math.abs(now - hello.ts) > skewMs) {
    return { ok: false, kind: 'auth/clock-skew' }
  }
  if (typeof hello.nonce !== 'string' || hello.nonce.length < 16) {
    return { ok: false, kind: 'peer/internal', reason: 'nonce' }
  }
  if (hello.authMode === 'shared-secret') {
    const expected = hmac(secret, helloTranscript(hello, listenerNodeId))
    if (!proofEquals(expected, hello.proof)) return { ok: false, kind: 'auth/invalid-proof' }
  }
  if (!nonceCache.accept(hello.nodeId, hello.nonce, now)) {
    return { ok: false, kind: 'auth/replay' }
  }
  return { ok: true, hello }
}

/**
 * Verify a received welcome on the dialer side.
 * @param {object} options
 * @param {ReturnType<typeof createHello>} options.helloFrame
 * @param {ReturnType<typeof createWelcome>} options.welcomeFrame
 * @param {string} options.listenerNodeId
 * @param {string | Buffer} options.secret
 * @param {number} [options.now]
 * @param {number} [options.skewMs]
 * @param {NonceCache} [options.nonceCache]
 * @returns {{ok:true, welcome:object} | {ok:false, kind:string, reason?:string}}
 */
export function verifyWelcome(options) {
  const {
    helloFrame, welcomeFrame, listenerNodeId, secret,
    now = Date.now(), skewMs = 5 * 60 * 1000, nonceCache = new NonceCache(),
  } = options
  if (!welcomeFrame || welcomeFrame.id !== helloFrame.id || !welcomeFrame.result) {
    return { ok: false, kind: 'peer/internal', reason: 'not-welcome' }
  }
  const welcome = welcomeFrame.result
  if (welcome.protocol !== PROTOCOL_VERSION) return { ok: false, kind: 'protocol/unsupported' }
  if (welcome.nodeId !== listenerNodeId) return { ok: false, kind: 'auth/unknown-peer' }
  if (!Number.isFinite(welcome.ts) || Math.abs(now - welcome.ts) > skewMs) {
    return { ok: false, kind: 'auth/clock-skew' }
  }
  if (welcome.authMode === 'shared-secret') {
    const expected = hmac(secret, welcomeTranscript(helloTranscript(helloFrame.params, listenerNodeId), welcome))
    if (!proofEquals(expected, welcome.proof)) return { ok: false, kind: 'auth/invalid-proof' }
  }
  if (!nonceCache.accept(welcome.nodeId, welcome.nonce, now)) {
    return { ok: false, kind: 'auth/replay' }
  }
  return { ok: true, welcome }
}

/**
 * Full handshake helper for tests/demo: returns both frames and verification results.
 * @param {{dialerNodeId:string, listenerNodeId:string, secret:string|Buffer,
 *   now?:number, dialerNonce?:string, listenerNonce?:string}} options
 */
export function simulateHandshake(options) {
  const { dialerNodeId, listenerNodeId, secret, now = Date.now(), dialerNonce, listenerNonce } = options
  const hello = createHello({ nodeId: dialerNodeId, listenerNodeId, secret, ts: now, ...(dialerNonce ? { nonce: dialerNonce } : {}) })
  const listenerCache = new NonceCache()
  const helloCheck = verifyHello({ frame: hello, listenerNodeId, secret, now, nonceCache: listenerCache })
  const welcome = helloCheck.ok ? createWelcome({ hello, listenerNodeId, secret, ts: now, ...(listenerNonce ? { nonce: listenerNonce } : {}) }) : null
  const dialerCache = new NonceCache()
  const welcomeCheck = welcome ? verifyWelcome({ helloFrame: hello, welcomeFrame: welcome, listenerNodeId, secret, now, nonceCache: dialerCache }) : { ok: false }
  return { hello, welcome, helloCheck, welcomeCheck, listenerCache, dialerCache }
}
