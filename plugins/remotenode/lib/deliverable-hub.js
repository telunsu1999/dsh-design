/**
 * Deliverable hub for remotenode.
 *
 * One sync engine per link (protocol-lib/sync-engine.js). The host of a remote
 * session publishes files its agent presented; the initiator records them,
 * auto-fetches preview-sized images and fetches other bytes on demand through
 * the binary artifact channel. Bytes live in a content-addressed blob store.
 *
 * All failure paths are contained: a broken deliverable must never fail a turn
 * or a link.
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { createSyncEngine } from './sync-engine.js'
import { MAX_CHUNK_BYTES } from './frames.js'
import { logicalPath, sanitizeName } from './ids.js'

/** Extension -> deliverable kind (the protocol vocabulary). */
const KIND_BY_EXT = new Map([
  ['.png', 'image'], ['.jpg', 'image'], ['.jpeg', 'image'], ['.webp', 'image'], ['.gif', 'image'], ['.bmp', 'image'],
  ['.mp4', 'video'], ['.webm', 'video'], ['.mov', 'video'], ['.mkv', 'video'],
  ['.mp3', 'audio'], ['.wav', 'audio'], ['.flac', 'audio'], ['.ogg', 'audio'],
  ['.txt', 'text'], ['.md', 'text'], ['.json', 'text'], ['.yaml', 'text'], ['.yml', 'text'], ['.csv', 'text'],
  ['.glb', 'model3d'], ['.gltf', 'model3d'], ['.obj', 'model3d'], ['.fbx', 'model3d'], ['.stl', 'model3d'], ['.blend', 'model3d'],
  ['.zip', 'archive'], ['.7z', 'archive'], ['.tar', 'archive'], ['.gz', 'archive'],
])

/** Extension -> Content-Type used by the local download route. */
const MIME_BY_EXT = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
  ['.gif', 'image/gif'], ['.bmp', 'image/bmp'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
  ['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'], ['.glb', 'model/gltf-binary'], ['.gltf', 'model/gltf+json'],
  ['.txt', 'text/plain; charset=utf-8'], ['.md', 'text/markdown; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.zip', 'application/zip'],
  ['.pdf', 'application/pdf'], ['.svg', 'image/svg+xml'],
])

/** @param {string} name */
function kindFor(name) {
  return KIND_BY_EXT.get(extname(name).toLowerCase()) ?? 'other'
}

/** @param {string} name */
function mimeFor(name) {
  return MIME_BY_EXT.get(extname(name).toLowerCase()) ?? 'application/octet-stream'
}

/** UI-facing kind vocabulary: image / model / file. */
function uiKind(kind) {
  if (kind === 'image') return 'image'
  if (kind === 'model3d') return 'model'
  return 'file'
}

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Hash one host file without loading it into memory. */
function hashFile(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    let size = 0
    const stream = createReadStream(path)
    stream.on('data', chunk => {
      size += chunk.length
      hash.update(chunk)
    })
    stream.on('error', reject)
    stream.on('end', () => resolvePromise({ sha256: hash.digest('hex'), size }))
  })
}

/** Read a whole file (bounded by the caller). */
function readFileBounded(path) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let total = 0
    const stream = createReadStream(path)
    stream.on('data', chunk => {
      total += chunk.length
      chunks.push(chunk)
    })
    stream.on('error', reject)
    stream.on('end', () => resolvePromise(Buffer.concat(chunks, total)))
  })
}

/** Deterministic link id shared by both peers. */
export function linkIdFor(nodeA, nodeB) {
  return [String(nodeA), String(nodeB)].sort().join('~')
}

/** Safe file name for persisted per-link state. */
function linkFileStem(linkId) {
  return String(linkId).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160)
}

/**
 * Create the deliverable hub.
 * @param {{
 *   self: {nodeId:string, nodeName:string},
 *   config: Record<string, any>,
 *   store: ReturnType<import('./store.js').createStore>,
 *   logger: Console,
 *   getLink?: (peerNodeId: string) => any,
 *   onSessionDeliverables?: (linkId: string, linkSessionId: string, count: number) => void,
 * }} options
 */
export function createDeliverableHub(options) {
  const { self, config, store, logger } = options
  const getLink = typeof options.getLink === 'function' ? options.getLink : () => null
  const onSessionDeliverables = typeof options.onSessionDeliverables === 'function' ? options.onSessionDeliverables : () => {}

  /** linkId -> { linkId, peerNodeId, engine, sources:Map, records:Map, link, saveTimer } */
  const entries = new Map()
  /** key -> UI record (all links) */
  const allRecords = new Map()
  /** artifactId -> { chunks: Map<offset,Buffer>, bytes, expectedBytes, waiters:Set, sha256, startedAt } */
  const assemblies = new Map()
  /** artifactId -> { resolve, reject, timer } */
  const fetchWaiters = new Map()

  const maxDeliverableBytes = Number(config.maxDeliverableBytes) || 256 * 1024 * 1024
  const maxArtifactFetchBytes = Math.min(maxDeliverableBytes, Number(config.maxArtifactFetchBytes) || 128 * 1024 * 1024)
  const maxAutoFetchBytes = Number(config.maxAutoFetchBytes) || 15 * 1024 * 1024

  // ---- persistence ---------------------------------------------------------

  function stateFile(linkId) {
    return `deliverables/${linkFileStem(linkId)}.json`
  }

  function saveEntry(entry) {
    try {
      const state = {
        engine: entry.engine.exportState(),
        sources: Object.fromEntries(entry.sources),
      }
      store.writeJson(stateFile(entry.linkId), state)
    } catch (error) {
      logger.warn?.('[remotenode] persist deliverables failed', error)
    }
  }

  /** Schedule one debounced save (per entry). */
  function scheduleSave(entry) {
    if (entry.saveTimer !== null) return
    entry.saveTimer = setTimeout(() => {
      entry.saveTimer = null
      saveEntry(entry)
    }, 500)
    if (typeof entry.saveTimer.unref === 'function') entry.saveTimer.unref()
  }

  function loadEntry(linkId, peerNodeId) {
    let saved = null
    try {
      const raw = store.readJson(stateFile(linkId), null)
      if (isRecord(raw) && isRecord(raw.engine)) saved = raw
    } catch (error) {
      logger.warn?.('[remotenode] read deliverable state failed', error)
    }
    let engine
    try {
      engine = saved === null
        ? createSyncEngine({ nodeId: self.nodeId, linkId })
        : createSyncEngine({ nodeId: self.nodeId, linkId, state: saved.engine })
    } catch (error) {
      logger.warn?.('[remotenode] restore deliverable engine failed; starting empty', error)
      engine = createSyncEngine({ nodeId: self.nodeId, linkId })
    }
    try { engine.setPeerNodeId(peerNodeId) } catch {}
    const sources = new Map()
    if (isRecord(saved?.sources)) {
      for (const [artifactId, source] of Object.entries(saved.sources)) {
        if (isRecord(source)) sources.set(artifactId, source)
      }
    }
    const entry = { linkId, peerNodeId, engine, sources, records: new Map(), link: null, saveTimer: null }
    entries.set(linkId, entry)
    rebuild(entry)
    return entry
  }

  /** Ensure one engine per configured peer at startup. */
  function init(peers) {
    for (const peer of Array.isArray(peers) ? peers : []) {
      if (!isRecord(peer) || typeof peer.nodeId !== 'string') continue
      const linkId = linkIdFor(self.nodeId, peer.nodeId)
      if (!entries.has(linkId)) loadEntry(linkId, peer.nodeId)
    }
  }

  // ---- record projection ---------------------------------------------------

  function artifactSource(entry, originNodeId, artifactId) {
    if (entry.engine.nodeId === originNodeId) return entry.sources.get(artifactId) ?? null
    return store.hasBlob(artifactId) ? { kind: 'blob', artifactId, bytes: 0 } : null
  }

  function rebuild(entry) {
    const next = new Map()
    const records = [...entry.engine.ownRecords, ...entry.engine.peerRecords]
    for (const record of records) {
      if (!isRecord(record) || typeof record.deliverableId !== 'string') continue
      const artifactId = record.current?.artifactId
      const key = `${entry.linkId}|${record.originNodeId}|${record.deliverableId}`
      if (artifactId === undefined) continue
      const source = artifactSource(entry, record.originNodeId, artifactId)
      const previous = allRecords.get(key)
      const fetching = previous?.syncState === 'fetching'
      const bytes = Number(record.current?.size) || 0
      next.set(key, {
        key,
        linkId: entry.linkId,
        peerNodeId: entry.peerNodeId,
        originNodeId: record.originNodeId,
        deliverableId: record.deliverableId,
        sessionId: record.originSessionId,
        logicalPath: record.logicalPath,
        name: record.name,
        kind: uiKind(record.kind),
        protocolKind: record.kind,
        mime: record.current?.mime ?? 'application/octet-stream',
        bytes,
        sha256: typeof artifactId === 'string' ? artifactId.slice('sha256:'.length) : '',
        version: Array.isArray(record.versions) ? record.versions.length : 1,
        deleted: record.deleted !== undefined,
        syncState: source !== null ? 'synced' : fetching ? 'fetching' : 'metadata',
        localAvailable: source !== null,
        error: null,
        createdAt: Number(record.createdAt) || 0,
        updatedAt: Number(record.updatedAt) || 0,
      })
    }
    entry.records = next
    for (const key of [...allRecords.keys()]) {
      if (key.startsWith(`${entry.linkId}|`)) allRecords.delete(key)
    }
    for (const [key, value] of next) allRecords.set(key, value)
  }

  /** Count deliverables attached to one session (both namespaces). */
  function noteSessionCounts(entry) {
    const counts = new Map()
    for (const record of [...entry.engine.ownRecords, ...entry.engine.peerRecords]) {
      const sessionId = record?.originSessionId
      if (typeof sessionId === 'string' && sessionId !== 'local-publish') {
        counts.set(sessionId, (counts.get(sessionId) ?? 0) + 1)
      }
    }
    for (const [linkSessionId, count] of counts) onSessionDeliverables(entry.linkId, linkSessionId, count)
  }

  // ---- link lifecycle ------------------------------------------------------

  function ensureLink(link) {
    if (!isRecord(link) || typeof link.peerNodeId !== 'string' || link.peerNodeId === '') return null
    const linkId = linkIdFor(self.nodeId, link.peerNodeId)
    let entry = entries.get(linkId)
    if (entry === undefined) {
      entry = loadEntry(linkId, link.peerNodeId)
    }
    entry.link = link
    try { entry.engine.setPeerNodeId(link.peerNodeId) } catch {}
    return entry
  }

  function onLinkUp(link) {
    const entry = ensureLink(link)
    if (entry === null) return
    // Reconcile both namespaces; failures leave the link usable.
    void requestSync(entry).catch(error => {
      logger.warn?.('[remotenode] deliverable sync failed', error)
    })
    scheduleSave(entry)
  }

  function onLinkDown(link) {
    if (!isRecord(link) || typeof link.peerNodeId !== 'string') return
    const entry = entries.get(linkIdFor(self.nodeId, link.peerNodeId))
    if (entry !== undefined) {
      entry.link = null
      scheduleSave(entry)
    }
  }

  // ---- sync ----------------------------------------------------------------

  async function requestSync(entry) {
    const link = entry.link
    if (link === null || typeof link?.request !== 'function') return
    const result = await link.request('deliverable.sync', {
      applied: { [entry.peerNodeId]: entry.engine.appliedSeq },
    }, { timeoutMs: 20000 })
    if (!isRecord(result) || result.ok === false) throw new Error(result?.error ?? 'deliverable sync failed')
    const outcome = entry.engine.handleSyncResult(result)
    if (outcome?.needSync) logger.warn?.('[remotenode] deliverable revision gap after sync')
    rebuild(entry)
    scheduleSave(entry)
    noteSessionCounts(entry)
    autoFetchEligible(entry)
  }

  /** Fetch preview-sized images automatically after a manifest change. */
  function autoFetchEligible(entry) {
    if (config.autoFetchImages !== true) return
    for (const record of entry.records.values()) {
      if (record.originNodeId === entry.peerNodeId
        && record.kind === 'image'
        && record.localAvailable !== true
        && record.bytes > 0
        && record.bytes <= maxAutoFetchBytes) {
        void fetchArtifact(record.key).catch(error => {
          logger.warn?.('[remotenode] auto fetch failed', error)
        })
      }
    }
  }

  async function handleSyncRequest(link, params) {
    const entry = ensureLink(link)
    if (entry === null) throw new Error('unknown link')
    return entry.engine.handleSyncRequest(isRecord(params) ? params : {})
  }

  // ---- publish -------------------------------------------------------------

  /** Publish one presented file of a hosted remote session. */
  async function publishPresented(sessionRecord, event) {
    const linkId = sessionRecord.linkId
    const entry = entries.get(linkId)
    if (entry === undefined) return
    const link = entry.link
    if (link === null || typeof link?.notify !== 'function') {
      logger.warn?.('[remotenode] skip publish: link offline')
      return
    }
    const files = Array.isArray(event?.data?.files) ? event.data.files : []
    let published = 0
    for (const file of files) {
      const path = isRecord(file) && typeof file.path === 'string' ? file.path : ''
      if (path === '' || !isAbsolute(path)) continue
      try {
        const stat = statSync(path)
        if (!stat.isFile() || stat.size <= 0 || stat.size > maxDeliverableBytes) {
          logger.warn?.(`[remotenode] skip deliverable ${path}: size ${stat.size}`)
          continue
        }
        const { sha256, size } = await hashFile(path)
        const artifactId = `sha256:${sha256}`
        const name = sanitizeName(basename(path))
        const record = {
          name,
          artifactId,
          size,
          mime: mimeFor(name),
          kind: kindFor(name),
          originSessionId: sessionRecord.linkSessionId,
          logicalPath: logicalPath(self.nodeId, sessionRecord.linkSessionId, name),
          ...(isRecord(file) && typeof file.description === 'string' && file.description !== ''
            ? { description: file.description }
            : {}),
        }
        const outcome = entry.engine.publish(record)
        if (outcome?.op == null) continue
        entry.sources.set(artifactId, { kind: 'host-file', path, bytes: size, mime: record.mime, name })
        link.notify('deliverable.op', { op: outcome.op })
        published += 1
      } catch (error) {
        logger.warn?.(`[remotenode] publish ${path} failed`, error)
      }
    }
    if (published > 0) {
      rebuild(entry)
      scheduleSave(entry)
      noteSessionCounts(entry)
      autoFetchEligible(entry)
    }
    return published
  }

  /** Publish an arbitrary local file to a peer (tool/UI action). */
  async function publishLocalFile(peerNodeId, path, description) {
    const absolute = isAbsolute(path) ? path : resolve(path)
    if (!existsSync(absolute)) throw new Error(`file not found: ${path}`)
    const stat = statSync(absolute)
    if (!stat.isFile()) throw new Error('not a regular file')
    if (stat.size > maxDeliverableBytes) throw new Error('file exceeds maxDeliverableBytes')
    const link = getLink(peerNodeId)
    if (link === null || link === undefined || !link.isReady?.()) throw new Error(`peer ${peerNodeId} is offline`)
    const entry = ensureLink(link)
    if (entry === null) throw new Error('link is not initialized')
    const { sha256, size } = await hashFile(absolute)
    const artifactId = `sha256:${sha256}`
    const name = sanitizeName(basename(absolute))
    const outcome = entry.engine.publish({
      name,
      artifactId,
      size,
      mime: mimeFor(name),
      kind: kindFor(name),
      originSessionId: 'local-publish',
      logicalPath: logicalPath(self.nodeId, 'local-publish', name),
      ...(typeof description === 'string' && description !== '' ? { description } : {}),
    })
    if (outcome?.op != null) {
      entry.sources.set(artifactId, { kind: 'host-file', path: absolute, bytes: size, mime: mimeFor(name), name })
      link.notify('deliverable.op', { op: outcome.op })
    }
    rebuild(entry)
    scheduleSave(entry)
    return [...entry.records.values()].find(record => record.sha256 === sha256) ?? null
  }

  // ---- artifact byte channel ----------------------------------------------

  /** Holder side: answer `artifact.fetch` and stream chunks as binary frames. */
  async function handleArtifactFetchRequest(link, params) {
    const artifactId = isRecord(params) && typeof params.artifactId === 'string' ? params.artifactId : ''
    if (!artifactId.startsWith('sha256:')) throw new Error('artifact.fetch requires artifactId')
    let bytes
    const entry = [...entries.values()].find(candidate => candidate.sources.has(artifactId))
    if (entry !== undefined) {
      const source = entry.sources.get(artifactId)
      if (!isRecord(source) || source.kind !== 'host-file' || typeof source.path !== 'string') throw new Error('artifact source unavailable')
      const stat = statSync(source.path)
      if (stat.size > maxArtifactFetchBytes) throw new Error('artifact exceeds maxArtifactFetchBytes')
      bytes = await readFileBounded(source.path)
    } else {
      const blob = store.readBlob(artifactId)
      if (blob === null) throw new Error('artifact not found')
      bytes = blob
    }
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (`sha256:${hash}` !== artifactId) throw new Error('artifact checksum mismatch')
    // Send after the response settles so the requester has its waiter registered.
    setTimeout(() => {
      try {
        for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK_BYTES) {
          const chunk = bytes.subarray(offset, Math.min(offset + MAX_CHUNK_BYTES, bytes.length))
          link.sendBinary({ artifactId, offset, length: chunk.length }, chunk)
        }
        link.notify('artifact.end', { artifactId, bytes: bytes.length, sha256: hash })
      } catch (error) {
        logger.warn?.('[remotenode] artifact streaming failed', error)
      }
    }, 0)
    return { ok: true, artifactId, bytes: bytes.length, sha256: hash }
  }

  /** Requester side: assemble one binary chunk. */
  function onBinary(link, header, payload) {
    try {
      if (!isRecord(header) || typeof header.artifactId !== 'string') return
      const artifactId = header.artifactId
      let assembly = assemblies.get(artifactId)
      if (assembly === undefined) {
        assembly = { chunks: new Map(), bytes: 0, waiters: new Set(), startedAt: Date.now() }
        assemblies.set(artifactId, assembly)
      }
      const offset = Number(header.offset)
      if (!Number.isInteger(offset) || offset < 0) return
      if (!Buffer.isBuffer(payload)) return
      if (!assembly.chunks.has(offset)) {
        assembly.chunks.set(offset, payload)
        assembly.bytes += payload.length
      }
      if (assembly.bytes > maxArtifactFetchBytes + MAX_CHUNK_BYTES) {
        assemblies.delete(artifactId)
        rejectWaiters(artifactId, new Error('artifact exceeds maxArtifactFetchBytes'))
      }
    } catch (error) {
      logger.warn?.('[remotenode] artifact chunk failed', error)
    }
  }

  /** Requester side: finalize one artifact from its chunks. */
  function onArtifactEnd(link, params) {
    try {
      const artifactId = isRecord(params) && typeof params.artifactId === 'string' ? params.artifactId : ''
      if (artifactId === '') return
      const assembly = assemblies.get(artifactId)
      if (assembly === undefined) return
      const offsets = [...assembly.chunks.keys()].sort((a, b) => a - b)
      const buffers = offsets.map(offset => assembly.chunks.get(offset))
      const buffer = Buffer.concat(buffers)
      const expectedBytes = Number(params.bytes)
      if (Number.isInteger(expectedBytes) && buffer.length !== expectedBytes) {
        throw new Error(`artifact size mismatch: got ${buffer.length} want ${expectedBytes}`)
      }
      const hash = createHash('sha256').update(buffer).digest('hex')
      if (`sha256:${hash}` !== artifactId) throw new Error('artifact checksum mismatch')
      store.putBlob(artifactId, buffer)
      assemblies.delete(artifactId)
      resolveWaiters(artifactId, { ok: true, bytes: buffer.length })
      // The blob is now present, so a rebuild flips every matching record to synced.
      for (const entry of entries.values()) {
        const matching = [...entry.records.values()].some(record => record.sha256 === hash)
        if (!matching) continue
        rebuild(entry)
        scheduleSave(entry)
      }
    } catch (error) {
      const artifactId = isRecord(params) && typeof params.artifactId === 'string' ? params.artifactId : ''
      if (artifactId !== '') {
        assemblies.delete(artifactId)
        rejectWaiters(artifactId, error instanceof Error ? error : new Error(String(error)))
      }
      logger.warn?.('[remotenode] artifact assembly failed', error)
    }
  }

  function resolveWaiters(artifactId, value) {
    const waiter = fetchWaiters.get(artifactId)
    if (waiter === undefined) return
    fetchWaiters.delete(artifactId)
    clearTimeout(waiter.timer)
    waiter.resolve(value)
  }

  function rejectWaiters(artifactId, error) {
    const waiter = fetchWaiters.get(artifactId)
    if (waiter === undefined) return
    fetchWaiters.delete(artifactId)
    clearTimeout(waiter.timer)
    waiter.reject(error)
  }

  /** Fetch one deliverable's bytes now and wait for completion. */
  async function fetchArtifact(key) {
    const record = allRecords.get(key)
    if (record === undefined) throw new Error('unknown deliverable')
    if (record.localAvailable) return { ok: true, syncState: 'synced' }
    if (record.originNodeId === self.nodeId) throw new Error('local artifact source is missing')
    const link = getLink(record.peerNodeId)
    if (link === null || link === undefined || !link.isReady?.()) throw new Error(`peer ${record.peerNodeId} is offline`)
    const artifactId = `sha256:${record.sha256}`
    if (fetchWaiters.has(artifactId)) {
      return fetchWaiters.get(artifactId).promise
    }
    let resolveFn, rejectFn
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolveFn = resolvePromise
      rejectFn = rejectPromise
    })
    // A failed request path rejects through the waiter; keep that rejection observed.
    promise.catch(() => {})
    const timer = setTimeout(() => {
      assemblies.delete(artifactId)
      rejectWaiters(artifactId, new Error('artifact fetch timed out'))
    }, 30000)
    fetchWaiters.set(artifactId, { resolve: resolveFn, reject: rejectFn, timer, promise })
    for (const entry of entries.values()) {
      for (const candidate of entry.records.values()) {
        if (candidate.key === key) {
          candidate.syncState = 'fetching'
          scheduleSave(entry)
        }
      }
    }
    try {
      const result = await link.request('artifact.fetch', { artifactId, linkId: record.linkId }, { timeoutMs: 20000 })
      if (isRecord(result) && result.ok === false) throw new Error(result.error ?? 'artifact.fetch failed')
    } catch (error) {
      rejectWaiters(artifactId, error instanceof Error ? error : new Error(String(error)))
      throw error
    }
    return promise
  }

  /** Bytes + mime for the HTTP download route. */
  async function artifactContent(key) {
    const record = allRecords.get(key)
    if (record === undefined) throw new Error('unknown deliverable')
    if (!record.localAvailable) {
      const error = new Error('artifact not synced')
      error.syncState = record.syncState
      throw error
    }
    const entry = entries.get(record.linkId)
    const artifactId = `sha256:${record.sha256}`
    const source = entry?.sources.get(artifactId)
    if (isRecord(source) && source.kind === 'host-file' && typeof source.path === 'string') {
      const bytes = await readFileBounded(source.path)
      return { bytes, mime: record.mime, name: record.name }
    }
    const blob = store.readBlob(artifactId)
    if (blob === null) throw new Error('artifact bytes unavailable')
    return { bytes: blob, mime: record.mime, name: record.name }
  }

  /** All UI records, newest first. */
  function list() {
    return [...allRecords.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  /** Route one incoming notification. */
  function handleNotification(link, method, params) {
    if (method === 'deliverable.op') {
      try {
        const entry = ensureLink(link)
        if (entry === null || !isRecord(params) || !isRecord(params.op)) return
        const outcome = entry.engine.handleOp(params.op)
        if (outcome?.needSync === true) {
          void requestSync(entry).catch(error => logger.warn?.('[remotenode] resync failed', error))
        }
        rebuild(entry)
        scheduleSave(entry)
        noteSessionCounts(entry)
        autoFetchEligible(entry)
      } catch (error) {
        logger.warn?.('[remotenode] deliverable op failed', error)
      }
      return
    }
    if (method === 'artifact.end') {
      onArtifactEnd(link, params)
    }
  }

  return {
    init,
    linkIdFor,
    onLinkUp,
    onLinkDown,
    onBinary,
    handleNotification,
    handleRequest: async (link, method, params) => {
      if (method === 'deliverable.sync') return handleSyncRequest(link, params)
      if (method === 'artifact.fetch') return handleArtifactFetchRequest(link, params)
      throw new Error(`unknown method ${method}`)
    },
    publishPresented,
    publishLocalFile,
    fetchArtifact,
    artifactContent,
    list,
    entries,
    flush() {
      for (const entry of entries.values()) {
        if (entry.saveTimer !== null) {
          clearTimeout(entry.saveTimer)
          entry.saveTimer = null
        }
        saveEntry(entry)
      }
    },
  }
}
