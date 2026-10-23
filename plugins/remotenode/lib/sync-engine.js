/**
 * Deliverable sync engine: one side of one link.
 * Implements 07-remotenode-m0-protocol.md §8.3–§8.8.
 *
 * The engine owns two namespaces on a link: its own (publish) and the peer's
 * (apply). It never mutates the peer namespace except through received ops.
 *
 * Persistence (SPEC §5.6): `exportState()` returns a pure-JSON snapshot; pass it
 * back as `createSyncEngine({ ..., state })` to restore. The round-trip is exact.
 */

import { artifactIdForBytes, isArtifactId, logicalPath, sanitizeName, newId, assertNodeId } from './ids.js'
import {
  DEFAULT_VERSION_RETENTION, createRecord, withVersion, markDeleted,
  validateOp, validateRecord, assertRecord,
} from './deliverable.js'
import { OpLog } from './oplog.js'
import { ProtocolError } from './errors.js'

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep copy through JSON so exported/imported state can never alias engine state. */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * @param {object} options
 * @param {string} options.nodeId
 * @param {string} options.linkId
 * @param {string} [options.originSessionId]
 * @param {() => number} [options.now]
 * @param {() => string} [options.generateId]
 * @param {number} [options.versionRetention]
 * @param {number} [options.opLogMaxOps]
 * @param {number} [options.opLogMaxBytes]
 * @param {number} [options.maxBufferOps]
 * @param {object} [options.state] previous `exportState()` result; restores the engine
 */
export function createSyncEngine(options) {
  const {
    nodeId, linkId, originSessionId = 'session-local',
    now = Date.now, generateId = newId,
    versionRetention = DEFAULT_VERSION_RETENTION,
    opLogMaxOps = 10000, opLogMaxBytes = 16 * 1024 * 1024,
    maxBufferOps = 64,
    state: persistenceState,
  } = options
  assertNodeId(nodeId, 'nodeId')
  if (typeof linkId !== 'string' || linkId.length === 0) throw new TypeError('linkId is required')

  const oplog = new OpLog({ maxOps: opLogMaxOps, maxBytes: opLogMaxBytes })
  let nextSeq = 1
  /** @type {Map<string, import('./deliverable.js').DeliverableRecord>} */
  const own = new Map()
  /** @type {Map<string, import('./deliverable.js').DeliverableRecord>} */
  const ownByPath = new Map()

  const peer = {
    nodeId: /** @type {string|null} */ (null),
    appliedSeq: 0,
    /** @type {Map<string, import('./deliverable.js').DeliverableRecord>} */
    records: new Map(),
    /** @type {Map<string, import('./deliverable.js').DeliverableRecord>} */
    byPath: new Map(),
    /** @type {Map<number, object>} */
    buffer: new Map(),
  }

  function requirePeer() {
    if (peer.nodeId === null) throw new ProtocolError('peer/internal', 'peer nodeId is not set')
    return peer.nodeId
  }

  /** @param {string} peerNodeId */
  function setPeerNodeId(peerNodeId) {
    assertNodeId(peerNodeId, 'peerNodeId')
    if (peerNodeId === nodeId) throw new TypeError('peerNodeId must differ from nodeId')
    if (peer.nodeId !== null && peer.nodeId !== peerNodeId) {
      throw new ProtocolError('peer/internal', 'peer nodeId is already bound')
    }
    peer.nodeId = peerNodeId
  }

  /**
   * Publish a deliverable version. Duplicate content on the same logical path
   * is a no-op (idempotent).
   *
   * Two ways to feed content:
   *  - `bytes`: the engine hashes it and derives `artifactId`/`size`;
   *  - `artifactId` + `size`: the caller already streamed/hashed the file
   *    (avoids reading the whole file into memory). Both are mandatory then.
   *
   * @param {object} input
   * @param {string} input.name
   * @param {string | Buffer | Uint8Array} [input.bytes]
   * @param {string} [input.artifactId] precomputed `sha256:<64hex>` (bytes omitted)
   * @param {number} [input.size] precomputed byte length (bytes omitted)
   * @param {string} [input.mime]
   * @param {string} [input.kind]
   * @param {string} [input.originSessionId]
   * @param {string} [input.note]
   * @param {string} [input.logicalPath] reserved for imports/fixtures
   */
  function publish(input) {
    const {
      name, bytes, mime = 'application/octet-stream', kind = 'other',
      originSessionId: sessionId = originSessionId, note, logicalPath: pathOverride,
      artifactId: providedArtifactId, size: providedSize,
    } = input
    const safeName = sanitizeName(name)
    const path = pathOverride ?? logicalPath(nodeId, sessionId, safeName)

    let artifactId
    let byteSize
    if (bytes !== undefined && bytes !== null) {
      const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
      artifactId = artifactIdForBytes(data)
      byteSize = data.byteLength
    } else {
      if (!isArtifactId(providedArtifactId)
        || !Number.isInteger(providedSize)
        || providedSize < 0) {
        throw new ProtocolError('deliverable/op-invalid', 'publish requires bytes or artifactId+size', {
          artifactId: providedArtifactId ?? null,
          size: providedSize ?? null,
        })
      }
      artifactId = providedArtifactId
      byteSize = providedSize
    }
    const existing = ownByPath.get(path)

    if (existing !== undefined && existing.deleted === undefined && existing.current.artifactId === artifactId) {
      return { duplicate: true, record: existing, op: null, artifactId }
    }

    const seq = nextSeq
    nextSeq += 1
    const version = {
      artifactId,
      size: byteSize,
      mime,
      createdAt: now(),
      originSeq: seq,
      ...(note === undefined ? {} : { note }),
    }
    /** @type {import('./deliverable.js').DeliverableRecord} */
    let record
    if (existing !== undefined && existing.deleted === undefined) {
      record = withVersion(existing, version, versionRetention)
    } else {
      record = createRecord({
        deliverableId: generateId(),
        linkId,
        originNodeId: nodeId,
        originSessionId: sessionId,
        logicalPath: path,
        name: safeName,
        kind,
        version,
        createdAt: version.createdAt,
      })
    }
    own.set(record.deliverableId, record)
    ownByPath.set(path, record)
    const op = { op: 'upsert', linkId, originNodeId: nodeId, originSeq: seq, record }
    oplog.append(op)
    return { duplicate: false, record, op, artifactId }
  }

  /**
   * Publish a tombstone for one of our deliverables.
   * @param {string} deliverableId
   */
  function remove(deliverableId) {
    const existing = own.get(deliverableId)
    if (existing === undefined) throw new ProtocolError('deliverable/unknown', 'unknown deliverable', { deliverableId })
    if (existing.deleted !== undefined) {
      return { duplicate: true, op: null, record: existing }
    }
    const seq = nextSeq
    nextSeq += 1
    const at = now()
    const record = markDeleted(existing, { at, originSeq: seq })
    own.set(deliverableId, record)
    const op = { op: 'remove', linkId, originNodeId: nodeId, originSeq: seq, deliverableId, at }
    oplog.append(op)
    return { duplicate: false, op, record }
  }

  /**
   * Apply one received op for the peer namespace.
   * @param {object} op
   * @returns {{applied:boolean, duplicate?:boolean, needSync?:boolean,
   *   appliedSeq?:number, error?:string, buffered?:boolean, flushed?:number}}
   */
  function handleOp(op) {
    const peerNodeId = requirePeer()
    if (!isPlainObject(op)) return { applied: false, error: 'deliverable/op-invalid' }
    if (op.originNodeId !== peerNodeId) return { applied: false, error: 'deliverable/unauthorized' }
    if (op.linkId !== linkId) return { applied: false, error: 'deliverable/unauthorized' }
    const errors = validateOp(op)
    if (errors.length > 0) return { applied: false, error: 'deliverable/op-invalid', buffered: false }

    if (op.originSeq <= peer.appliedSeq) return { applied: false, duplicate: true, appliedSeq: peer.appliedSeq }
    if (op.originSeq > peer.appliedSeq + 1) {
      if (peer.buffer.size >= maxBufferOps) return { applied: false, needSync: true, error: 'deliverable/revision-gap' }
      peer.buffer.set(op.originSeq, op)
      return { applied: false, needSync: true, buffered: true }
    }

    const result = applyOne(op)
    if (!result.ok) return { applied: false, needSync: result.needSync === true, error: result.error }
    peer.appliedSeq = op.originSeq
    const flushed = flushBuffer()
    return { applied: true, appliedSeq: peer.appliedSeq, flushed }
  }

  /**
   * @param {object} op
   * @returns {{ok:true}|{ok:false, error:string, needSync?:boolean}}
   */
  function applyOne(op) {
    const peerNodeId = requirePeer()
    if (op.op === 'upsert') {
      const record = /** @type {import('./deliverable.js').DeliverableRecord} */ (op.record)
      const errors = validateRecord(record)
      if (errors.length > 0) return { ok: false, error: 'deliverable/op-invalid' }
      if (record.originNodeId !== peerNodeId || record.linkId !== linkId) {
        return { ok: false, error: 'deliverable/unauthorized' }
      }
      const existing = peer.records.get(record.deliverableId)
      if (existing !== undefined) {
        if (existing.deleted !== undefined) {
          return { ok: false, error: 'deliverable/op-invalid' }
        }
        if (existing.originSeq > record.originSeq) return { ok: false, error: 'deliverable/op-invalid' }
        if (existing.originSeq === record.originSeq) return { ok: true }
      }
      peer.records.set(record.deliverableId, record)
      peer.byPath.set(record.logicalPath, record)
      return { ok: true }
    }

    const deliverableId = /** @type {string} */ (op.deliverableId)
    const existing = peer.records.get(deliverableId)
    if (existing === undefined) return { ok: false, error: 'deliverable/revision-gap', needSync: true }
    if (existing.deleted !== undefined) return { ok: true }
    const at = /** @type {number} */ (op.at)
    let record
    try {
      record = markDeleted(existing, { at, originSeq: op.originSeq })
    } catch {
      return { ok: false, error: 'deliverable/op-invalid' }
    }
    peer.records.set(deliverableId, record)
    peer.byPath.set(record.logicalPath, record)
    return { ok: true }
  }

  /** Apply consecutively buffered ops. */
  function flushBuffer() {
    let flushed = 0
    while (peer.buffer.has(peer.appliedSeq + 1)) {
      const next = peer.buffer.get(peer.appliedSeq + 1)
      peer.buffer.delete(peer.appliedSeq + 1)
      const result = applyOne(next)
      if (!result.ok) {
        // Put it back and stop; a sync/reconcile will resolve it.
        peer.buffer.set(peer.appliedSeq + 1, next)
        break
      }
      peer.appliedSeq = next.originSeq
      flushed += 1
    }
    return flushed
  }

  /**
   * Answer a peer's `deliverable.sync`.
   * @param {{applied?:Record<string, number>}} [request]
   */
  function handleSyncRequest(request = {}) {
    const peerNodeId = requirePeer()
    const requested = Number.isInteger(request.applied?.[nodeId]) ? request.applied[nodeId] : 0
    const lastSeq = nextSeq - 1
    if (!oplog.covers(requested)) {
      return {
        applied: { [nodeId]: lastSeq },
        snapshot: {
          linkId,
          originNodeId: nodeId,
          snapshotSeq: lastSeq,
          records: [...own.values()],
          generatedAt: now(),
        },
        complete: true,
      }
    }
    return { applied: { [nodeId]: lastSeq }, ops: oplog.since(requested), complete: true }
  }

  /**
   * Apply a `deliverable.syncResult` received from the peer.
   * @param {{ops?:object[], snapshot?:object, applied?:Record<string, number>, complete?:boolean}} result
   */
  function handleSyncResult(result) {
    const peerNodeId = requirePeer()
    if (!isPlainObject(result)) return { applied: false, error: 'deliverable/op-invalid' }

    if (result.snapshot !== undefined) {
      const snapshot = result.snapshot
      if (!isPlainObject(snapshot)
        || snapshot.linkId !== linkId
        || snapshot.originNodeId !== peerNodeId
        || !Number.isInteger(snapshot.snapshotSeq)
        || !Array.isArray(snapshot.records)) {
        return { applied: false, error: 'deliverable/op-invalid' }
      }
      /** @type {Map<string, import('./deliverable.js').DeliverableRecord>} */
      const records = new Map()
      /** @type {Map<string, import('./deliverable.js').DeliverableRecord>} */
      const byPath = new Map()
      for (const record of snapshot.records) {
        const errors = validateRecord(record)
        if (errors.length > 0 || record.originNodeId !== peerNodeId || record.linkId !== linkId) {
          return { applied: false, error: 'deliverable/op-invalid' }
        }
        if (record.originSeq > snapshot.snapshotSeq) return { applied: false, error: 'deliverable/op-invalid' }
        records.set(record.deliverableId, record)
        byPath.set(record.logicalPath, record)
      }
      peer.records = records
      peer.byPath = byPath
      peer.appliedSeq = snapshot.snapshotSeq
      for (const seq of [...peer.buffer.keys()]) {
        if (seq <= peer.appliedSeq) peer.buffer.delete(seq)
      }
      flushBuffer()
      return { applied: true, snapshot: true, appliedSeq: peer.appliedSeq }
    }

    const ops = Array.isArray(result.ops) ? [...result.ops].sort((a, b) => a.originSeq - b.originSeq) : []
    let appliedCount = 0
    for (const op of ops) {
      if (op.originNodeId !== peerNodeId || op.linkId !== linkId) {
        return { applied: false, error: 'deliverable/unauthorized' }
      }
      if (op.originSeq <= peer.appliedSeq) continue
      const outcome = handleOp(op)
      if (outcome.applied) appliedCount += 1
      if (outcome.needSync && !outcome.buffered) {
        return { applied: appliedCount > 0, error: 'deliverable/revision-gap', needSync: true }
      }
    }
    return { applied: true, appliedCount, appliedSeq: peer.appliedSeq }
  }

  /** Canonical ordered view (used for convergence assertions). */
  function view() {
    /** @type {object[]} */
    const rows = []
    for (const record of [...own.values(), ...peer.records.values()]) {
      rows.push({
        originNodeId: record.originNodeId,
        deliverableId: record.deliverableId,
        originSeq: record.originSeq,
        artifactId: record.current.artifactId,
        deletedSeq: record.deleted === undefined ? null : record.deleted.originSeq,
        versions: record.versions.map(version => version.artifactId),
        logicalPath: record.logicalPath,
      })
    }
    rows.sort((a, b) => `${a.originNodeId}:${a.deliverableId}`.localeCompare(`${b.originNodeId}:${b.deliverableId}`))
    return rows
  }

  /** @param {string} path */
  function ownRecordByPath(path) {
    return ownByPath.get(path) ?? null
  }

  /** @param {string} deliverableId */
  function peerRecord(deliverableId) {
    return peer.records.get(deliverableId) ?? null
  }

  /**
   * Rebuild outbound ops from persisted own records when a snapshot has no
   * `ownOps` (forward/backward compat). Lossy when version retention already
   * trimmed older versions: reconcile then falls back to a full snapshot.
   * @returns {object[]}
   */
  function deriveOwnOps() {
    /** @type {object[]} */
    const ops = []
    for (const record of own.values()) {
      for (const version of record.versions) {
        /** @type {Record<string, unknown>} */
        const snapshotRecord = {
          ...record,
          originSeq: version.originSeq,
          updatedAt: version.createdAt,
          current: version,
          versions: record.versions.filter(item => item.originSeq <= version.originSeq),
        }
        delete snapshotRecord.deleted
        ops.push({ op: 'upsert', linkId, originNodeId: nodeId, originSeq: version.originSeq, record: snapshotRecord })
      }
      if (record.deleted !== undefined) {
        ops.push({
          op: 'remove',
          linkId,
          originNodeId: nodeId,
          originSeq: record.deleted.originSeq,
          deliverableId: record.deliverableId,
          at: record.deleted.at,
        })
      }
    }
    ops.sort((a, b) => a.originSeq - b.originSeq)
    return ops
  }

  /**
   * Restore engine state produced by {@link exportState}. Validates everything
   * before mutating; corrupt state throws instead of partially applying.
   * @param {object} state
   */
  function restoreState(state) {
    /** @param {string} message @param {object} [details] */
    const invalid = (message, details) => new ProtocolError('deliverable/op-invalid', message, details)
    if (!isPlainObject(state)) throw new TypeError('state must be a plain object')

    // 1) peer binding
    const peerNodeId = state.peerNodeId ?? null
    if (peerNodeId !== null) setPeerNodeId(peerNodeId)

    // 2) sequence counter
    if (!Number.isInteger(state.nextSeq) || state.nextSeq < 1) {
      throw invalid('state.nextSeq must be a positive integer')
    }

    // 3) own records
    if (!Array.isArray(state.ownRecords)) throw invalid('state.ownRecords must be an array')
    let maxOwnSeq = 0
    for (const record of state.ownRecords) {
      const errors = validateRecord(record)
      if (errors.length > 0) throw invalid('state contains an invalid own record', { errors })
      if (record.originNodeId !== nodeId) throw invalid('own record originNodeId mismatch', { deliverableId: record.deliverableId })
      if (record.linkId !== linkId) throw invalid('own record linkId mismatch', { deliverableId: record.deliverableId })
      const latestSeq = record.deleted === undefined ? record.originSeq : record.deleted.originSeq
      if (latestSeq >= state.nextSeq) throw invalid('own record sequence is not below nextSeq', { deliverableId: record.deliverableId })
      if (own.has(record.deliverableId)) throw invalid('duplicate own deliverableId', { deliverableId: record.deliverableId })
      const copy = cloneJson(record)
      own.set(copy.deliverableId, copy)
      ownByPath.set(copy.logicalPath, copy)
      if (latestSeq > maxOwnSeq) maxOwnSeq = latestSeq
    }

    // 4) outbound op log: prefer the faithfully persisted ops, derive otherwise
    const hasOwnOps = state.ownOps !== undefined
    if (hasOwnOps && !Array.isArray(state.ownOps)) throw invalid('state.ownOps must be an array')
    const ownOps = hasOwnOps && state.ownOps.length > 0 ? state.ownOps : deriveOwnOps()
    for (const op of ownOps) {
      const errors = validateOp(op)
      if (errors.length > 0) throw invalid('state contains an invalid own op', { errors })
      if (op.originNodeId !== nodeId || op.linkId !== linkId) {
        throw invalid('own op origin/link mismatch', { originSeq: op.originSeq })
      }
      if (op.originSeq >= state.nextSeq) throw invalid('own op sequence is not below nextSeq', { originSeq: op.originSeq })
    }
    if (ownOps.length > 0) oplog.restore(ownOps)
    if (oplog.lastSeq !== state.nextSeq - 1 || (maxOwnSeq > 0 && maxOwnSeq !== state.nextSeq - 1)) {
      throw invalid('own state/op sequences are inconsistent with nextSeq', {
        lastOpSeq: oplog.lastSeq,
        maxOwnSeq,
        nextSeq: state.nextSeq,
      })
    }
    nextSeq = state.nextSeq

    // 5) peer namespace (received ops + watermark)
    const peerState = state.peer ?? { appliedSeq: 0, records: [] }
    if (!isPlainObject(peerState)) throw invalid('state.peer must be an object')
    if (!Number.isInteger(peerState.appliedSeq) || peerState.appliedSeq < 0) {
      throw invalid('state.peer.appliedSeq must be a non-negative integer')
    }
    if (!Array.isArray(peerState.records)) throw invalid('state.peer.records must be an array')
    if (peerNodeId === null && (peerState.appliedSeq !== 0 || peerState.records.length > 0)) {
      throw invalid('state.peer requires a peerNodeId when it has records or a watermark')
    }
    /** @type {Map<string, import('./deliverable.js').DeliverableRecord>} */
    const peerRecords = new Map()
    /** @type {Map<string, import('./deliverable.js').DeliverableRecord>} */
    const peerByPath = new Map()
    for (const record of peerState.records) {
      const errors = validateRecord(record)
      if (errors.length > 0) throw invalid('state contains an invalid peer record', { errors })
      if (record.originNodeId !== peerNodeId) throw invalid('peer record originNodeId mismatch', { deliverableId: record.deliverableId })
      if (record.linkId !== linkId) throw invalid('peer record linkId mismatch', { deliverableId: record.deliverableId })
      const latestSeq = record.deleted === undefined ? record.originSeq : record.deleted.originSeq
      if (latestSeq > peerState.appliedSeq) {
        throw invalid('peer record sequence exceeds peer.appliedSeq', { deliverableId: record.deliverableId })
      }
      if (peerRecords.has(record.deliverableId)) throw invalid('duplicate peer deliverableId', { deliverableId: record.deliverableId })
      const copy = cloneJson(record)
      peerRecords.set(copy.deliverableId, copy)
      peerByPath.set(copy.logicalPath, copy)
    }
    peer.appliedSeq = peerState.appliedSeq
    peer.records = peerRecords
    peer.byPath = peerByPath
    peer.buffer.clear()
  }

  /**
   * Pure-JSON persistable snapshot (SPEC §5.6). Deep-copied: mutating the
   * returned value never touches the engine. Round-trips exactly through
   * `createSyncEngine({ ..., state })`.
   * @returns {{peerNodeId:string|null, nextSeq:number, ownRecords:object[],
   *   peer:{appliedSeq:number, records:object[]}, ownOps:object[]}}
   */
  function exportState() {
    return {
      peerNodeId: peer.nodeId,
      nextSeq,
      ownRecords: [...own.values()].map(cloneJson),
      peer: {
        appliedSeq: peer.appliedSeq,
        records: [...peer.records.values()].map(cloneJson),
      },
      // Extra field (not required by the SPEC shape): faithful outbound replay.
      // Restore tolerates its absence and derives ops from ownRecords instead.
      ownOps: oplog.exportAll().map(cloneJson),
    }
  }

  /**
   * Artifact ids referenced by our records (all retained versions, including
   * tombstoned records — conservative on purpose: a peer may still be
   * fetching a version while a tombstone is in flight). CAS/GC helper.
   * @returns {Set<string>}
   */
  function ownArtifactIds() {
    const ids = new Set()
    for (const record of own.values()) {
      for (const version of record.versions) ids.add(version.artifactId)
    }
    return ids
  }

  /**
   * Artifact ids referenced by the peer's records (mirror of
   * {@link ownArtifactIds} for CAS/GC on received deliverables).
   * @returns {Set<string>}
   */
  function peerArtifactIds() {
    const ids = new Set()
    for (const record of peer.records.values()) {
      for (const version of record.versions) ids.add(version.artifactId)
    }
    return ids
  }

  if (persistenceState !== undefined) restoreState(persistenceState)

  return {
    nodeId,
    linkId,
    setPeerNodeId,
    publish,
    remove,
    handleOp,
    handleSyncRequest,
    handleSyncResult,
    view,
    ownRecordByPath,
    peerRecord,
    exportState,
    ownArtifactIds,
    peerArtifactIds,
    get peerNodeId() { return peer.nodeId },
    get ownSeq() { return nextSeq - 1 },
    get appliedSeq() { return peer.appliedSeq },
    get ownRecords() { return [...own.values()] },
    get peerRecords() { return [...peer.records.values()] },
    get oplog() { return oplog },
    get bufferedOps() { return [...peer.buffer.values()] },
  }
}
