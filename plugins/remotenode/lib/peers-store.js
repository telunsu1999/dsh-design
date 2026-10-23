/**
 * Runtime peer store for UI pairing.
 *
 * Static peers live in config.json (`source: 'config'`); peers added through the
 * panel live here (`source: 'paired'`) and survive restarts. The pairing token
 * also lives here unless config.json fixes it.
 *
 * File layout (<dataDir>/):
 *   peers.json   { version: 1, peers: [{ nodeId, nodeName, host, port, secret, dial, source, addedAt }] }
 *   pairing.json { version: 1, token, createdAt, rotatedAt? }
 */

import { randomBytes } from 'node:crypto'

const NODE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const HOST_RE = /^[A-Za-z0-9._:[\]-]{1,255}$/
const TOKEN_MIN_BYTES = 16

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

/** Generate a 32-byte hex token. */
export function generatePairingToken() {
  return randomBytes(32).toString('hex')
}

/** Validate one peer record coming from disk or pairing. */
export function normalizePeer(input, source = 'paired') {
  if (!isRecord(input)) return null
  const nodeId = oneLine(input.nodeId)
  if (!NODE_ID_RE.test(nodeId)) return null
  const host = oneLine(input.host)
  if (host === '' || !HOST_RE.test(host)) return null
  const port = Number(input.port)
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null
  const secret = typeof input.secret === 'string' ? input.secret : ''
  if (Buffer.byteLength(secret, 'utf8') < TOKEN_MIN_BYTES) return null
  return {
    nodeId,
    nodeName: oneLine(input.nodeName) || nodeId,
    host,
    port,
    secret,
    dial: input.dial === 'off' ? 'off' : 'auto',
    source: source === 'config' ? 'config' : 'paired',
    addedAt: Number.isFinite(Number(input.addedAt)) ? Number(input.addedAt) : Date.now(),
  }
}

/**
 * Create the runtime peer/token store.
 * @param {{ store: ReturnType<import('./store.js').createStore>, logger: Console,
 *           fixedToken?: string }} options
 */
export function createPeersStore(options) {
  const { store, logger } = options
  const fixedToken = typeof options.fixedToken === 'string' && options.fixedToken.trim() !== ''
    ? options.fixedToken.trim()
    : null

  /** @type {Map<string, any>} */
  const peers = new Map()
  let token = null
  let tokenCreatedAt = 0
  let tokenRotatedAt = 0

  function load() {
    peers.clear()
    try {
      const raw = store.readJson('peers.json', { version: 1, peers: [] })
      const list = isRecord(raw) && Array.isArray(raw.peers) ? raw.peers : []
      for (const entry of list) {
        const peer = normalizePeer(entry, 'paired')
        if (peer === null) {
          logger.warn?.('[remotenode] skip invalid paired peer', JSON.stringify(entry).slice(0, 120))
          continue
        }
        peers.set(peer.nodeId, peer)
      }
    } catch (error) {
      logger.warn?.('[remotenode] read peers.json failed', error)
    }

    if (fixedToken !== null) {
      token = fixedToken
      return
    }
    try {
      const raw = store.readJson('pairing.json', null)
      if (isRecord(raw) && typeof raw.token === 'string' && raw.token.trim().length >= TOKEN_MIN_BYTES) {
        token = raw.token.trim()
        tokenCreatedAt = Number(raw.createdAt) || 0
        tokenRotatedAt = Number(raw.rotatedAt) || 0
        return
      }
    } catch (error) {
      logger.warn?.('[remotenode] read pairing.json failed', error)
    }
    token = generatePairingToken()
    tokenCreatedAt = Date.now()
    persistToken()
  }

  function persistPeers() {
    try {
      store.writeJson('peers.json', {
        version: 1,
        peers: [...peers.values()].map(peer => ({
          nodeId: peer.nodeId,
          nodeName: peer.nodeName,
          host: peer.host,
          port: peer.port,
          secret: peer.secret,
          dial: peer.dial,
          source: 'paired',
          addedAt: peer.addedAt,
        })),
      })
    } catch (error) {
      logger.warn?.('[remotenode] persist peers.json failed', error)
    }
  }

  function persistToken() {
    if (fixedToken !== null) return
    try {
      store.writeJson('pairing.json', {
        version: 1,
        token,
        createdAt: tokenCreatedAt,
        ...(tokenRotatedAt === 0 ? {} : { rotatedAt: tokenRotatedAt }),
      })
    } catch (error) {
      logger.warn?.('[remotenode] persist pairing.json failed', error)
    }
  }

  return {
    load,
    list() {
      return [...peers.values()].map(peer => ({ ...peer }))
    },
    has(nodeId) {
      return peers.has(nodeId)
    },
    get(nodeId) {
      return peers.get(nodeId) ?? null
    },
    add(input) {
      const peer = normalizePeer(input, 'paired')
      if (peer === null) throw new Error('invalid peer record')
      peers.set(peer.nodeId, peer)
      persistPeers()
      return { ...peer }
    },
    remove(nodeId) {
      if (!peers.has(nodeId)) return false
      peers.delete(nodeId)
      persistPeers()
      return true
    },
    token() {
      return token
    },
    tokenInfo() {
      return {
        token,
        createdAt: tokenCreatedAt,
        rotatedAt: tokenRotatedAt,
        fixedByConfig: fixedToken !== null,
      }
    },
    rotateToken() {
      if (fixedToken !== null) throw new Error('pairing token is fixed by config')
      token = generatePairingToken()
      tokenRotatedAt = Date.now()
      persistToken()
      return this.tokenInfo()
    },
  }
}
