/**
 * @dsh-design/remotenode — Host half.
 *
 * A DSH *plugin bundle* (not a patch, not a script): one row in the profile
 * composes this module on both ends of a peer link. It owns
 *
 *   - the runtime config ($DSH_HOME/remotenode/config.json + row config overrides);
 *   - PeerManager   (TCP carrier, shared-secret handshake, heartbeat, dedupe);
 *   - SessionBridge (create/prompt/cancel/attach remote sessions via ctx.sessionController);
 *   - DeliverableHub (deliverables/presented capture, per-link op sync, CAS blobs);
 *   - the browser HTTP API under /api/remotenode/* (lib/routes.js);
 *   - the model-facing `remotenode` tool and one short system-prompt section.
 *
 * Dependency-free: only node: builtins and this package's lib/*.js modules.
 * Every listener is defensive: a remotenode bug must never break a chat turn.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join, resolve } from 'node:path'

import { createDeliverableHub } from './lib/deliverable-hub.js'
import { ProtocolError } from './lib/errors.js'
import { connectAndPair, serveIncoming, sniffPairing, tokenFingerprint } from './lib/pairing.js'
import { createPeerManager } from './lib/peer-manager.js'
import { createPeersStore } from './lib/peers-store.js'
import { registerRoutes } from './lib/routes.js'
import { createSettingsStore } from './lib/settings-store.js'
import { createSessionBridge } from './lib/session-bridge.js'
import { createStore } from './lib/store.js'

const NODE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value @param {string} fallback */
function oneLine(value, fallback = '') {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text === '' ? fallback : text
}

/** @param {unknown} error */
function errorText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Resolve the DSH home the same way the launcher does (env first, then ~/.dsh). */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

/** Safe default node id derived from the hostname. */
function defaultNodeId() {
  const raw = hostname().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  const id = raw === '' ? 'node' : raw
  return id.length <= 64 ? id : id.slice(0, 64)
}

/** Default runtime configuration (config.json overrides field by field). */
export function defaultConfig() {
  const home = dshHome()
  return {
    nodeId: defaultNodeId(),
    nodeName: hostname(),
    listen: { enabled: false, host: '127.0.0.1', port: 47201 },
    peers: [],
    workspace: join(home, 'remotenode', 'workspace'),
    dataDir: join(home, 'remotenode', 'data'),
    configFile: join(home, 'remotenode', 'config.json'),
    autoFetchImages: true,
    maxAutoFetchBytes: 15 * 1024 * 1024,
    maxDeliverableBytes: 256 * 1024 * 1024,
    maxArtifactFetchBytes: 128 * 1024 * 1024,
    requestTimeoutMs: 30_000,
    heartbeatIntervalMs: 10_000,
    heartbeatTimeoutMs: 30_000,
    pairingToken: '',
    pairApprovalTimeoutMs: 120_000,
  }
}

/** Load the runtime config: defaults <- config file <- row config overrides. */
export function loadConfig(rowConfig) {
  const problems = []
  const config = defaultConfig()
  const overrides = isRecord(rowConfig) ? rowConfig : {}
  const configFile = oneLine(overrides.configFile) || String(config.configFile)
  config.configFile = configFile
  let fileConfig = {}
  try {
    if (existsSync(configFile)) {
      const parsed = JSON.parse(readFileSync(configFile, 'utf8'))
      if (isRecord(parsed)) fileConfig = parsed
      else problems.push(`config file is not a JSON object: ${configFile}`)
    }
  } catch (error) {
    problems.push(`cannot read config file ${configFile}: ${errorText(error)}`)
  }
  const merged = { ...config, ...fileConfig, ...overrides }
  const nodeId = oneLine(merged.nodeId)
  merged.nodeId = NODE_ID_RE.test(nodeId) ? nodeId : config.nodeId
  if (!NODE_ID_RE.test(nodeId)) problems.push(`invalid nodeId ${JSON.stringify(nodeId)}; using ${config.nodeId}`)
  merged.nodeName = oneLine(merged.nodeName) || merged.nodeId
  const listen = isRecord(merged.listen) ? merged.listen : {}
  const port = Number(listen.port)
  merged.listen = {
    enabled: listen.enabled === true,
    host: oneLine(listen.host) || '127.0.0.1',
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : config.listen.port,
  }
  const peers = []
  for (const raw of Array.isArray(merged.peers) ? merged.peers : []) {
    if (!isRecord(raw)) {
      problems.push(`invalid peer entry: ${JSON.stringify(raw).slice(0, 160)}`)
      continue
    }
    const peerId = oneLine(raw.nodeId)
    const peerPort = Number(raw.port)
    if (!NODE_ID_RE.test(peerId) || !Number.isInteger(peerPort) || peerPort < 1 || peerPort > 65535) {
      problems.push(`invalid peer entry: ${JSON.stringify(raw).slice(0, 160)}`)
      continue
    }
    if (peerId === merged.nodeId) {
      problems.push(`peer ${peerId} equals this node's id; skipped`)
      continue
    }
    const secret = typeof raw.secret === 'string' ? raw.secret : ''
    if (secret.length < 16) {
      problems.push(`peer ${peerId} has a weak/empty secret; link skipped`)
      continue
    }
    peers.push({
      nodeId: peerId,
      nodeName: oneLine(raw.nodeName) || peerId,
      host: oneLine(raw.host) || '127.0.0.1',
      port: peerPort,
      secret,
      dial: raw.dial === 'off' ? 'off' : 'auto',
    })
  }
  merged.peers = peers
  merged.listenSource = isRecord(fileConfig.listen) || isRecord(overrides.listen) ? 'config' : 'default'
  merged.workspace = oneLine(merged.workspace) || join(dshHome(), 'remotenode', 'workspace')
  merged.dataDir = oneLine(merged.dataDir) || join(dshHome(), 'remotenode', 'data')
  merged.autoFetchImages = merged.autoFetchImages !== false
  for (const key of [
    'maxAutoFetchBytes', 'maxDeliverableBytes', 'maxArtifactFetchBytes',
    'requestTimeoutMs', 'heartbeatIntervalMs', 'heartbeatTimeoutMs', 'pairApprovalTimeoutMs',
  ]) {
    const value = Number(merged[key])
    merged[key] = Number.isFinite(value) && value > 0 ? value : config[key]
  }
  merged.pairingToken = oneLine(merged.pairingToken)
  return { config: merged, problems }
}

/** Pick a logger with the three methods the bridge/hub might use. */
function loggerOf(ctx) {
  const candidate = ctx?.logger
  if (isRecord(candidate) || typeof candidate === 'object') {
    return {
      info: typeof candidate.info === 'function' ? candidate.info.bind(candidate) : () => {},
      warn: typeof candidate.warn === 'function' ? candidate.warn.bind(candidate) : () => {},
      error: typeof candidate.error === 'function' ? candidate.error.bind(candidate) : () => {},
    }
  }
  return console
}

/**
 * Assemble the host runtime (no Cordis registrations here; apply() wires them).
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} rowConfig
 */
export function createRuntime(ctx, rowConfig) {
  const { config, problems } = loadConfig(rowConfig)
  /** The deployment-owned listener from config.json (panel/reset target). */
  const baseListen = {
    enabled: config.listen.enabled,
    host: config.listen.host,
    port: config.listen.port,
    source: config.listenSource ?? 'default',
  }
  const logger = loggerOf(ctx)
  const self = {
    nodeId: config.nodeId,
    nodeName: config.nodeName,
    instanceEpoch: `${Date.now().toString(36)}-${process.pid.toString(36)}`,
    protocol: 1,
  }

  let peerManager = null
  let hub = null
  const store = createStore({ dataDir: config.dataDir })
  const peersStore = createPeersStore({ store, logger, fixedToken: config.pairingToken || undefined })
  const settingsStore = createSettingsStore({ store, logger })

  /** Effective listener: runtime settings override -> config.json -> defaults (SPEC §11.1). */
  function effectiveListen() {
    const override = settingsStore.listen()
    if (override !== null) return { ...override, source: 'settings' }
    return { enabled: baseListen.enabled, host: baseListen.host, port: baseListen.port, source: baseListen.source }
  }

  /** Pending pairing approvals keyed by requestId; the pairing socket waits on `settle`. */
  const pendingPairs = new Map()

  /** Effective peers: static config.json peers first, then UI-paired peers from disk (config wins). */
  function effectivePeers() {
    const list = []
    const seen = new Set()
    for (const peer of config.peers) {
      if (seen.has(peer.nodeId)) continue
      seen.add(peer.nodeId)
      list.push({ ...peer, source: 'config' })
    }
    for (const peer of peersStore.list()) {
      if (seen.has(peer.nodeId)) continue
      seen.add(peer.nodeId)
      list.push(peer)
    }
    return list
  }

  /** Pairing token + fingerprint for the panel. */
  function pairingInfo() {
    const info = peersStore.tokenInfo()
    return {
      token: info.token,
      fingerprint: tokenFingerprint(info.token),
      createdAt: info.createdAt,
      rotatedAt: info.rotatedAt,
      fixedByConfig: info.fixedByConfig,
    }
  }

  /** Pending pairing requests, safe for JSON. */
  function pendingPairViews() {
    return [...pendingPairs.values()].map(item => ({
      requestId: item.requestId,
      nodeId: item.nodeId,
      nodeName: item.nodeName,
      remoteAddress: item.remoteAddress,
      remotePort: item.remotePort,
      listenPort: item.listenPort,
      createdAt: item.createdAt,
    }))
  }

  /**
   * Ask the panel to approve one incoming pairing request. Requests from the
   * same node id share one promise; the panel answers through decidePairApproval.
   */
  function requestPairApproval(request) {
    for (const item of pendingPairs.values()) {
      if (item.nodeId !== request.nodeId) continue
      item.remoteAddress = request.remoteAddress || item.remoteAddress
      item.remotePort = request.remotePort || item.remotePort
      item.listenPort = request.listenPort || item.listenPort
      return item.promise
    }
    if (pendingPairs.size >= 5) return Promise.resolve({ approved: false, reason: 'busy' })
    const requestId = randomUUID()
    let settle
    const promise = new Promise(resolveFn => { settle = resolveFn })
    const timeoutMs = config.pairApprovalTimeoutMs
    const timer = setTimeout(() => {
      if (!pendingPairs.has(requestId)) return
      pendingPairs.delete(requestId)
      settle({ approved: false, reason: 'timeout' })
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    pendingPairs.set(requestId, {
      requestId,
      nodeId: request.nodeId,
      nodeName: request.nodeName,
      remoteAddress: request.remoteAddress,
      remotePort: request.remotePort,
      listenPort: request.listenPort,
      createdAt: Date.now(),
      settle,
      timer,
      promise,
    })
    logger.info?.(`[remotenode] pairing request from ${request.nodeId} (${request.remoteAddress}) awaiting approval`)
    return promise
  }

  function decidePairApproval(requestId, approve) {
    const item = pendingPairs.get(requestId)
    if (item === undefined) return { ok: false, error: 'pair/unknown-request' }
    clearTimeout(item.timer)
    pendingPairs.delete(requestId)
    item.settle({ approved: approve === true, reason: approve === true ? 'approved' : 'rejected' })
    logger.info?.(`[remotenode] pairing request ${requestId} ${approve === true ? 'approved' : 'rejected'}`)
    return { ok: true }
  }

  /** One pairing socket that the listener sniffed out. */
  async function handlePairingSocket(socket) {
    await serveIncoming(socket, {
      token: peersStore.token(),
      self: { nodeId: self.nodeId, nodeName: self.nodeName, listenPort: effectiveListen().port },
      isKnownPeer: nodeId => effectivePeers().some(peer => peer.nodeId === nodeId),
      requestApproval: requestPairApproval,
      onApproved: async (peer) => {
        peersStore.add(peer)
        await peerManager?.addPeer?.(peer)
        logger.info?.(`[remotenode] paired with ${peer.nodeId} (${peer.host}:${peer.port}); persisted`)
      },
      logger,
    })
  }

  const bridge = createSessionBridge({
    self,
    config,
    store,
    ctx,
    logger,
    onPresented: (record, event) => {
      if (hub === null) return
      void hub.publishPresented(record, event).catch(error => {
        logger.warn?.('[remotenode] publish presented failed', errorText(error))
      })
    },
  })

  hub = createDeliverableHub({
    self,
    config,
    store,
    logger,
    getLink: peerNodeId => peerManager?.linkFor(peerNodeId) ?? null,
    onSessionDeliverables: (linkId, linkSessionId, count) => bridge.noteDeliverables(linkId, linkSessionId, count),
  })

  /** Peers for the panel: manager truth, padded with configured-but-offline rows. */
  function peerViews() {
    const effective = effectivePeers()
    const sourceByNode = new Map(effective.map(peer => [peer.nodeId, peer.source]))
    let managerRows = []
    try { managerRows = peerManager?.state?.() ?? [] } catch (error) { logger.warn?.('[remotenode] peer state failed', error) }
    const rows = (Array.isArray(managerRows) ? managerRows : []).map(row => {
      const source = row?.source ?? sourceByNode.get(row?.peerNodeId) ?? 'config'
      return { ...row, source, removable: source === 'paired' }
    })
    const seen = new Set(rows.map(row => row?.peerNodeId))
    for (const peer of effective) {
      if (seen.has(peer.nodeId)) continue
      seen.add(peer.nodeId)
      rows.push({
        peerNodeId: peer.nodeId, nodeName: peer.nodeName, state: 'offline',
        direction: null, linkId: null, lastSeen: null, rttMs: null, remote: null, error: null,
        source: peer.source, removable: peer.source === 'paired', configured: true, dial: peer.dial,
      })
    }
    return rows
  }

  function deliverableViews() {
    try { return hub.list() } catch (error) { logger.warn?.('[remotenode] list deliverables failed', error); return [] }
  }

  /** Tell connected peers that this node's listener moved (SPEC §11.2). */
  async function notifyListenChange(listen) {
    try {
      const rows = peerManager?.state?.() ?? []
      for (const row of Array.isArray(rows) ? rows : []) {
        if (row?.state !== 'online') continue
        const link = peerManager?.linkFor?.(row.peerNodeId)
        if (link === null || link === undefined || (typeof link.isReady === 'function' && !link.isReady())) continue
        try {
          link.notify('peer.listen', {
            nodeId: self.nodeId,
            listenPort: listen.enabled ? listen.port : 0,
            ...(listen.enabled && listen.host !== '0.0.0.0' && listen.host !== '::' ? { host: listen.host } : {}),
          })
        } catch (error) {
          logger.warn?.(`[remotenode] notify peer.listen to ${row.peerNodeId} failed`, error)
        }
      }
    } catch (error) {
      logger.warn?.('[remotenode] notifyListenChange failed', error)
    }
  }

  /** The single operation surface shared by the HTTP routes and the model tool. */
  const api = {
    state() {
      return {
        ok: true,
        self: {
          nodeId: self.nodeId,
          nodeName: self.nodeName,
          instanceEpoch: self.instanceEpoch,
          protocol: self.protocol,
          dataDir: config.dataDir,
          listen: (() => { const listen = effectiveListen(); return { enabled: listen.enabled, host: listen.host, port: listen.port } })(),
          listenSource: effectiveListen().source,
          listenOverride: settingsStore.listen() !== null,
        },
        peers: peerViews(),
        sessions: bridge.sessionViews(),
        deliverables: deliverableViews(),
        pairing: pairingInfo(),
        pendingPairs: pendingPairViews(),
        warnings: problems.slice(),
      }
    },

    async startSession({ peerNodeId, prompt, cwd }) {
      try {
        if (oneLine(peerNodeId) === '') throw new Error('peerNodeId is required')
        const link = peerManager?.linkFor(peerNodeId)
        if (link === null || link === undefined || (typeof link.isReady === 'function' && !link.isReady())) {
          throw new Error(`peer ${peerNodeId} is offline`)
        }
        const session = await bridge.startRemoteSession(link, { prompt: oneLine(prompt), cwd: oneLine(cwd) })
        return { ok: true, session }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    },

    async prompt({ sessionId, text, mode }) {
      try {
        if (oneLine(sessionId) === '') throw new Error('sessionId is required')
        const session = await bridge.promptRemote(sessionId, text, mode === 'steer' ? 'steer' : 'queue')
        return { ok: true, session }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    },

    async cancel({ sessionId }) {
      try {
        if (oneLine(sessionId) === '') throw new Error('sessionId is required')
        const session = await bridge.cancelRemote(sessionId)
        return { ok: true, session }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    },

    async transcript(sessionId, limit = 200) {
      try {
        const result = await bridge.transcript(sessionId)
        const events = Array.isArray(result.events) ? result.events : []
        const capped = Number.isInteger(limit) && limit > 0 ? events.slice(-limit) : events
        return { ok: true, session: result.session, events: capped }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    },

    async refresh() {
      try {
        await peerManager?.dialAllOffline?.()
        return { ok: true }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    },

    async fetchArtifact({ key }) {
      try {
        if (oneLine(key) === '') throw new Error('key is required')
        const result = await hub.fetchArtifact(key)
        const record = hub.list().find(item => item.key === key) ?? null
        return { ok: true, syncState: record?.syncState ?? 'synced', result }
      } catch (error) {
        const record = hub.list().find(item => item.key === key) ?? null
        return { ok: false, error: errorText(error), syncState: record?.syncState ?? 'metadata' }
      }
    },

    deliverable(key) {
      return hub.list().find(item => item.key === key) ?? null
    },

    artifactContent(key) {
      return hub.artifactContent(key)
    },

    async publish({ peerNodeId, path, description }) {
      try {
        if (oneLine(peerNodeId) === '' || oneLine(path) === '') throw new Error('peerNodeId and path are required')
        const deliverable = await hub.publishLocalFile(peerNodeId, path, description)
        return { ok: true, deliverable }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    },

    /** Pair with a new node from the panel (client role). */
    async pair({ host, port, token, nodeName }) {
      try {
        const targetHost = oneLine(host)
        const targetPort = Number(port)
        const pairToken = oneLine(token)
        if (targetHost === '' || !/^[A-Za-z0-9._:[\]-]{1,255}$/.test(targetHost)) throw new Error('invalid host')
        if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error('invalid port')
        if (Buffer.byteLength(pairToken, 'utf8') < 16) throw new Error('pairing token is too short')
        if (effectivePeers().some(peer => peer.host === targetHost && peer.port === targetPort)) {
          const existing = effectivePeers().find(peer => peer.host === targetHost && peer.port === targetPort)
          if (existing !== undefined) throw new Error(`already paired with ${existing.nodeId}`)
        }
        const result = await connectAndPair({
          host: targetHost,
          port: targetPort,
          token: pairToken,
          self: { nodeId: self.nodeId, nodeName: self.nodeName, instanceEpoch: self.instanceEpoch, listenPort: effectiveListen().port },
          timeoutMs: Math.max(config.requestTimeoutMs, 25_000),
        })
        if (result.ok !== true) return { ok: false, error: result.error }
        const peer = { ...result.peer }
        if (peer.nodeId === self.nodeId) return { ok: false, error: 'pair/self' }
        if (effectivePeers().some(item => item.nodeId === peer.nodeId)) {
          return { ok: false, error: `already paired with ${peer.nodeId}` }
        }
        try { peersStore.add(peer) } catch (error) { return { ok: false, error: `pair persist failed: ${errorText(error)}` } }
        await peerManager?.addPeer?.(peer)
        const view = peerViews().find(row => row.peerNodeId === peer.nodeId) ?? { peerNodeId: peer.nodeId, nodeName: peer.nodeName, state: 'offline', source: 'paired', removable: true }
        logger.info?.(`[remotenode] paired to ${peer.nodeId} at ${peer.host}:${peer.port}`)
        return { ok: true, peer: view, paired: true }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    },

    /** Change the peer listener (SPEC §11.2). */
    async setListen({ enabled, host, port, reset }) {
      try {
        if (typeof peerManager?.setListen !== 'function') throw new Error('listener rebind is unavailable')
        const current = effectiveListen()
        if (reset === true) {
          const target = { enabled: baseListen.enabled, host: baseListen.host, port: baseListen.port }
          const applied = await peerManager.setListen(target)
          if (isRecord(applied) && applied.ok === false) return { ok: false, error: errorText(applied.error) }
          settingsStore.resetListen()
          await notifyListenChange(effectiveListen())
          return { ok: true, listen: { enabled: target.enabled, host: target.host, port: target.port }, source: baseListen.source, reset: true }
        }
        const nextEnabled = enabled === undefined ? current.enabled : enabled === true
        const nextHost = oneLine(host) || current.host
        if (!/^[A-Za-z0-9._:[\]-]{1,255}$/.test(nextHost)) return { ok: false, error: 'invalid listen host' }
        const rawPort = port === undefined ? current.port : Number(port)
        if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) return { ok: false, error: 'invalid listen port (1-65535)' }
        const applied = await peerManager.setListen({ enabled: nextEnabled, host: nextHost, port: rawPort })
        if (!isRecord(applied) || applied.ok !== true) {
          return { ok: false, error: errorText(applied?.error ?? 'listener rebind failed') }
        }
        settingsStore.saveListen({ enabled: nextEnabled, host: nextHost, port: rawPort })
        const listen = { enabled: nextEnabled, host: nextHost, port: rawPort }
        config.listen = { ...listen }
        await notifyListenChange(listen)
        logger.info?.(`[remotenode] listener updated: ${listen.enabled ? `${listen.host}:${listen.port}` : 'disabled'}`)
        return { ok: true, listen, source: 'settings' }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    },

    /** Approve or reject one pending pairing request (server role). */
    approvePair({ requestId, approve }) {
      try {
        if (oneLine(requestId) === '') throw new Error('requestId is required')
        return decidePairApproval(oneLine(requestId), approve === true)
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    },

    /** Remove one UI-paired node (config peers stay). */
    async removePeer({ peerNodeId }) {
      try {
        const nodeId = oneLine(peerNodeId)
        if (nodeId === '') throw new Error('peerNodeId is required')
        if (config.peers.some(peer => peer.nodeId === nodeId)) {
          throw new Error('this peer comes from config.json; edit config.json to remove it')
        }
        const runtimePeer = peersStore.get(nodeId)
        if (runtimePeer === null) return { ok: true, removed: false }
        const link = peerManager?.linkFor?.(nodeId)
        if (link !== null && link !== undefined && typeof link.isReady === 'function' && link.isReady()) {
          try { link.notify('pair.revoke', { nodeId: self.nodeId }) } catch {}
        }
        peersStore.remove(nodeId)
        await peerManager?.removePeer?.(nodeId)
        logger.info?.(`[remotenode] removed paired node ${nodeId}`)
        return { ok: true, removed: true }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    },

    /** Rotate the pairing token (disabled when config.json fixes it). */
    rotatePairingToken() {
      try {
        peersStore.rotateToken()
        return { ok: true, pairing: pairingInfo() }
      } catch (error) {
        return { ok: false, error: errorText(error) }
      }
    },
  }

  const runtime = {
    config,
    problems,
    self,
    logger,
    store,
    peersStore,
    settingsStore,
    bridge,
    hub,
    api,
    get peerManager() { return peerManager },
    get state() { return api.state() },
    async start() {
      store.ensure()
      mkdirSync(config.workspace, { recursive: true })
      mkdirSync(config.dataDir, { recursive: true })
      peersStore.load()
      settingsStore.load()
      bridge.load()
      const peers = effectivePeers()
      hub.init(peers)
      const listen = effectiveListen()
      config.listen = { enabled: listen.enabled, host: listen.host, port: listen.port }
      peerManager = createPeerManager({
        config: { ...config, peers, listen: { enabled: listen.enabled, host: listen.host, port: listen.port } },
        instanceEpoch: self.instanceEpoch,
        logger,
        handlers: {
          onLinkUp: link => {
            logger.info?.(`[remotenode] link up: ${link.linkId} (${link.peerNodeId})`)
            try { bridge.onLinkUp(link) } catch (error) { logger.warn?.('[remotenode] bridge onLinkUp failed', error) }
            try { hub.onLinkUp(link) } catch (error) { logger.warn?.('[remotenode] hub onLinkUp failed', error) }
          },
          onLinkDown: (link, reason) => {
            // Two peers that both dial may briefly hold two links; the manager
            // closes the duplicate. Losing the duplicate must not mark sessions
            // offline while the canonical link is still up.
            const peerNodeId = isRecord(link) ? link.peerNodeId : undefined
            const remaining = typeof peerNodeId === 'string' ? peerManager?.linkFor?.(peerNodeId) : undefined
            if (remaining !== undefined && remaining !== null) {
              logger.info?.(`[remotenode] duplicate link down: ${link?.linkId ?? '?'} (${reason ?? 'closed'}); keeping ${remaining.linkId ?? 'canonical'}`)
              try { bridge.onLinkUp(remaining) } catch (error) { logger.warn?.('[remotenode] bridge onLinkUp(remaining) failed', error) }
              try { hub.onLinkUp(remaining) } catch (error) { logger.warn?.('[remotenode] hub onLinkUp(remaining) failed', error) }
              return
            }
            logger.info?.(`[remotenode] link down: ${link?.linkId ?? '?'} (${reason ?? 'closed'})`)
            try { bridge.onLinkDown(link, reason) } catch (error) { logger.warn?.('[remotenode] bridge onLinkDown failed', error) }
            try { hub.onLinkDown(link) } catch (error) { logger.warn?.('[remotenode] hub onLinkDown failed', error) }
          },
          onRequest: (link, method, params) => {
            if (typeof method === 'string' && method.startsWith('session.')) {
              return bridge.handleRequest(link, method, params)
            }
            if (method === 'deliverable.sync' || method === 'artifact.fetch') {
              return hub.handleRequest(link, method, params)
            }
            throw new ProtocolError('method/not-found', `unknown method ${method}`)
          },
          onNotification: (link, method, params) => {
            if (method === 'peer.listen') {
              // The peer moved its listener: update paired endpoints so future
              // reconnects dial the new port (SPEC §11.2).
              try {
                const nodeId = isRecord(params) ? oneLine(params.nodeId) : ''
                const listenPort = isRecord(params) ? Number(params.listenPort) : 0
                if (nodeId !== '' && config.peers.some(peer => peer.nodeId === nodeId)) {
                  logger.warn?.(`[remotenode] peer ${nodeId} changed listen port to ${listenPort}; update config.json peers to match`)
                } else if (nodeId !== '') {
                  const runtimePeer = peersStore.get(nodeId)
                  if (runtimePeer !== null && Number.isInteger(listenPort) && listenPort >= 0) {
                    const nextPort = listenPort > 0 ? listenPort : runtimePeer.port
                    const updated = peersStore.add({ ...runtimePeer, port: nextPort, ...(listenPort > 0 ? { dial: 'auto' } : { dial: 'off' }) })
                    void peerManager?.addPeer?.(updated)
                  }
                }
              } catch (error) {
                logger.warn?.('[remotenode] peer.listen handling failed', error)
              }
              return
            }
            if (method === 'pair.revoke') {
              // The other side removed us; drop the paired record locally too.
              try {
                const nodeId = isRecord(params) ? oneLine(params.nodeId) : ''
                if (nodeId !== '' && config.peers.every(peer => peer.nodeId !== nodeId) && peersStore.get(nodeId) !== null) {
                  peersStore.remove(nodeId)
                  void peerManager?.removePeer?.(nodeId)
                  logger.info?.(`[remotenode] peer ${nodeId} revoked pairing`)
                }
              } catch (error) {
                logger.warn?.('[remotenode] pair.revoke failed', error)
              }
              return
            }
            try { bridge.handleNotification(link, method, params) } catch (error) { logger.warn?.('[remotenode] bridge notification failed', error) }
            try { hub.handleNotification(link, method, params) } catch (error) { logger.warn?.('[remotenode] hub notification failed', error) }
          },
          onBinary: (link, header, payload) => {
            try { hub.onBinary(link, header, payload) } catch (error) { logger.warn?.('[remotenode] hub binary failed', error) }
          },
          onRawConnection: (socket, proceed) => {
            // A pairing connection starts with the 'R' magic byte instead of a
            // framed JSON-RPC length; sniff it before the normal handshake.
            try {
              sniffPairing(socket, {
                onPair: pairSocket => { void handlePairingSocket(pairSocket) },
                onNormal: () => {
                  try { proceed() } catch (error) { logger.warn?.('[remotenode] proceed handshake failed', error) }
                },
              })
              return true
            } catch (error) {
              logger.warn?.('[remotenode] pairing sniff failed', error)
              return false
            }
          },
        },
      })
      await peerManager.start()
      logger.info?.(`[remotenode] node ${self.nodeId} (${self.nodeName}); peers=${peers.length} (config ${config.peers.length}, paired ${peers.length - config.peers.length}); listen=${listen.enabled ? `${listen.host}:${listen.port} (${listen.source})` : 'off'}; data=${config.dataDir}`)
      logger.info?.(`[remotenode] pairing token fingerprint ${pairingInfo().fingerprint}${config.pairingToken ? ' (fixed by config)' : ''}`)
      for (const problem of problems) logger.warn?.(`[remotenode] config: ${problem}`)
    },
    async stop() {
      try { await peerManager?.stop?.() } catch (error) { logger.warn?.('[remotenode] peer manager stop failed', error) }
      try { bridge.saveNow() } catch {}
      try { hub.flush() } catch {}
    },
  }
  return runtime
}

/** JSON schema for the model tool arguments. */
const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list_peers', 'list_sessions', 'start_session', 'prompt', 'cancel', 'transcript', 'deliverables', 'publish'],
      description: 'list_peers=列出远程节点与链路状态; list_sessions=列出双向远程会话; start_session=在对端节点创建一个远程会话（可带首条 prompt）; prompt=给远程会话追加消息; cancel=取消远程会话当前轮次; transcript=读取远程会话转录; deliverables=列出已同步交付物; publish=把本机文件发布给对端节点。',
    },
    peerNodeId: { type: 'string', description: '目标远程节点 id（list_peers 结果里的 peerNodeId），start_session/publish 必填。' },
    sessionId: { type: 'string', description: '远程会话 id（list_sessions/start_session 结果里的 id），prompt/cancel/transcript 必填。' },
    text: { type: 'string', description: 'prompt/start_session 的提示词文本（自包含任务，对端看不到当前会话）。' },
    path: { type: 'string', description: 'publish 时本机文件绝对路径。' },
    description: { type: 'string', description: 'publish 时给对端看的文件说明。' },
    limit: { type: 'integer', description: 'transcript 最多返回的事件条数（默认 200）。' },
  },
  required: ['action'],
  additionalProperties: false,
}

const TOOL_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      detail: { type: 'object', additionalProperties: true },
    },
    required: ['summary'],
    additionalProperties: false,
  },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value?.summary === 'string' ? value.summary : 'remotenode: 无结果',
  }],
}

/** Short, tool-scoped prompt guidance (registered as its own section). */
const PROMPT_SECTION = {
  name: 'tool-remotenode',
  order: 2850,
  text:
    'Remote nodes: this deployment can link other DSH instances as peers. Use the `remotenode` tool when a task should run on a peer '
    + '(for example a GPU desktop for image generation, Blender modelling, or other heavy work). Call it with action "list_peers" first, '
    + 'then "start_session" with a self-contained prompt and tell the user that progress and deliverables appear in the 远程节点 panel. '
    + 'Files the remote agent presents sync back automatically; use action "deliverables" to list them. The remote agent cannot see this '
    + 'conversation, so every prompt must carry all needed context.',
}

/** Register the model-facing tool. */
export function registerTools(ctx, runtime) {
  if (typeof ctx.tools?.register !== 'function') return () => {}
  return ctx.tools.register({
    name: 'remotenode',
    description:
      'Drive a peered DSH remote node (远程节点): list peers and remote sessions, start a remote session on a peer with a self-contained prompt, '
      + 'send follow-up prompts, cancel, read the transcript, list synced deliverables, or publish a local file to a peer. '
      + 'Panels: the user sees links, bidirectional sessions and deliverables under the 远程节点 sidebar entry.',
    parameters: TOOL_PARAMETERS,
    output: TOOL_OUTPUT,
    async execute(args) {
      const input = isRecord(args) ? args : {}
      const action = oneLine(input.action)
      try {
        switch (action) {
          case 'list_peers': {
            const state = runtime.api.state()
            const rows = state.peers
            const pendingPairs = Array.isArray(state.pendingPairs) ? state.pendingPairs : []
            const online = rows.filter(row => row.state === 'online').length
            const lines = rows.map(row => `- ${row.peerNodeId} (${row.nodeName}): ${row.state}${row.direction ? `, ${row.direction}` : ''}${row.rttMs != null ? `, rtt ${row.rttMs}ms` : ''}`)
            const pendingNote = pendingPairs.length === 0
              ? ''
              : `\n注意：有 ${pendingPairs.length} 个配对请求等待用户在「远程节点」面板审批（${pendingPairs.map(item => `${item.nodeId} @ ${item.remoteAddress}`).join('; ')}）。`
            return {
              summary: (rows.length === 0
                ? '当前没有远程节点。可在「远程节点」面板用「添加节点」（IP/端口/配对令牌）发起配对，对端审批后自动建立连接；也可以在 $DSH_HOME/remotenode/config.json 配置静态 peers。'
                : `远程节点 ${online}/${rows.length} 在线：\n${lines.join('\n')}`) + pendingNote,
              detail: { peers: rows, pendingPairs },
            }
          }
          case 'list_sessions': {
            const sessions = runtime.api.state().sessions
            const lines = sessions.map(session => `- [${session.direction === 'outbound' ? '我发起' : '对端发起'}] ${session.id}  ${session.state}  ${session.title}`)
            return {
              summary: sessions.length === 0 ? '当前没有远程会话。' : `远程会话 ${sessions.length} 个：\n${lines.join('\n')}`,
              detail: { sessions },
            }
          }
          case 'start_session': {
            const result = await runtime.api.startSession({ peerNodeId: oneLine(input.peerNodeId), prompt: oneLine(input.text) })
            if (result.ok !== true) return { summary: `启动远程会话失败：${result.error}`, detail: { ok: false, error: result.error } }
            return {
              summary: `已在 ${result.session.peerNodeId} 创建远程会话 ${result.session.id}（状态 ${result.session.state}）。任务完成后会出现在 远程节点 面板，交付物会自动同步。`,
              detail: { ok: true, session: result.session },
            }
          }
          case 'prompt': {
            const result = await runtime.api.prompt({ sessionId: oneLine(input.sessionId), text: oneLine(input.text) })
            return result.ok === true
              ? { summary: `已向远程会话 ${result.session.id} 发送 prompt。`, detail: { ok: true, session: result.session } }
              : { summary: `发送失败：${result.error}`, detail: { ok: false, error: result.error } }
          }
          case 'cancel': {
            const result = await runtime.api.cancel({ sessionId: oneLine(input.sessionId) })
            return result.ok === true
              ? { summary: `已请求取消远程会话 ${result.session.id}。`, detail: { ok: true, session: result.session } }
              : { summary: `取消失败：${result.error}`, detail: { ok: false, error: result.error } }
          }
          case 'transcript': {
            const result = await runtime.api.transcript(oneLine(input.sessionId), Number(input.limit) || 200)
            if (result.ok !== true) return { summary: `读取转录失败：${result.error}`, detail: { ok: false, error: result.error } }
            const lines = result.events.map(event => `[${event.seq}] ${event.role ?? event.type}${event.name ? ` ${event.name}` : ''}: ${String(event.text ?? '').slice(0, 400)}`)
            return {
              summary: lines.length === 0 ? '该会话暂无转录事件。' : `会话 ${result.session.title} 最近事件：\n${lines.slice(-40).join('\n')}`,
              detail: { ok: true, session: result.session, events: result.events },
            }
          }
          case 'deliverables': {
            const records = runtime.api.state().deliverables
            const lines = records.map(record => `- ${record.name}  ${record.bytes}B  v${record.version}  ${record.syncState}  来自 ${record.originNodeId}  key=${record.key}`)
            return {
              summary: records.length === 0 ? '当前没有交付物。' : `交付物 ${records.length} 个：\n${lines.join('\n')}`,
              detail: { deliverables: records },
            }
          }
          case 'publish': {
            const result = await runtime.api.publish({
              peerNodeId: oneLine(input.peerNodeId),
              path: oneLine(input.path),
              description: oneLine(input.description),
            })
            return result.ok === true
              ? { summary: `已发布 ${result.deliverable?.name ?? input.path} 给 ${input.peerNodeId}。`, detail: { ok: true, deliverable: result.deliverable } }
              : { summary: `发布失败：${result.error}`, detail: { ok: false, error: result.error } }
          }
          default:
            return { summary: `未知 action ${JSON.stringify(action)}；可用：list_peers/list_sessions/start_session/prompt/cancel/transcript/deliverables/publish。`, detail: { ok: false } }
        }
      } catch (error) {
        return { summary: `remotenode 工具异常：${errorText(error)}`, detail: { ok: false, error: errorText(error) } }
      }
    },
  })
}

/** Host plugin export (object form). */
const plugin = {
  name: 'remotenode',
  inject: ['tools', 'webServer'],
  apply(ctx, config) {
    const runtime = createRuntime(ctx, config ?? {})
    ctx.effect(() => registerRoutes(ctx, runtime), 'remotenode: http routes')
    ctx.effect(() => registerTools(ctx, runtime), 'remotenode: model tool')
    ctx.effect(() => {
      const disposeEvent = ctx.on('session/event', (session, event) => {
        try { runtime.bridge.onSessionEvent(session, event) } catch (error) { runtime.logger.warn?.('[remotenode] session/event failed', error) }
      })
      const disposeStatus = ctx.on('api-session/status', (sessionId, running) => {
        try { runtime.bridge.onSessionStatus(sessionId, running) } catch (error) { runtime.logger.warn?.('[remotenode] api-session/status failed', error) }
      })
      return () => {
        disposeEvent()
        disposeStatus()
      }
    }, 'remotenode: session feeds')
    ctx.effect(() => {
      const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined
      if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return () => {}
      return systemPrompt.section(PROMPT_SECTION)
    }, 'remotenode: prompt section')
    ctx.effect(() => () => { void runtime.stop() }, 'remotenode: lifecycle')
    runtime.start().catch(error => {
      runtime.logger.warn?.('[remotenode] start failed', error)
    })
  },
}

export default plugin
