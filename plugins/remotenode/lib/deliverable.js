/**
 * Deliverable records, versions, tombstones and validation.
 * Mirrors 07-remotenode-m0-protocol.md §8.2–§8.5, §8.9.
 */

import { assertNodeId, isArtifactId, isSafeLogicalPath } from './ids.js'
import { ProtocolError } from './errors.js'

export const DELIVERABLE_KINDS = Object.freeze([
  'image', 'video', 'audio', 'text', 'model3d', 'archive', 'other',
])

export const DEFAULT_VERSION_RETENTION = 5

/** @typedef {{
 *   artifactId: string, size: number, mime: string, createdAt: number,
 *   originSeq: number, note?: string,
 * }} DeliverableVersion */

/** @typedef {{
 *   deliverableId: string, linkId: string, originNodeId: string,
 *   originSessionId: string, logicalPath: string, name: string,
 *   kind: string, createdAt: number, updatedAt: number, originSeq: number,
 *   current: DeliverableVersion, versions: DeliverableVersion[],
 *   deleted?: {at:number, originSeq:number}, description?: string,
 * }} DeliverableRecord */

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function isInt(value) {
  return Number.isInteger(value) && value >= 0
}

/** @param {DeliverableVersion} version @param {string[]} errors @param {string} label */
function validateVersion(version, errors, label) {
  if (!isPlainObject(version)) {
    errors.push(`${label}: not-object`)
    return
  }
  if (!isArtifactId(version.artifactId)) errors.push(`${label}.artifactId: invalid`)
  if (!isInt(version.size)) errors.push(`${label}.size: invalid`)
  if (!isNonEmptyString(version.mime)) errors.push(`${label}.mime: invalid`)
  if (!isInt(version.createdAt)) errors.push(`${label}.createdAt: invalid`)
  if (!Number.isInteger(version.originSeq) || version.originSeq < 1) errors.push(`${label}.originSeq: invalid`)
  if (version.note !== undefined && typeof version.note !== 'string') errors.push(`${label}.note: invalid`)
}

/**
 * Validate one DeliverableRecord.
 * @param {DeliverableRecord} record
 * @returns {string[]} structural errors (empty when valid)
 */
export function validateRecord(record) {
  /** @type {string[]} */
  const errors = []
  if (!isPlainObject(record)) return ['record: not-object']
  if (!isNonEmptyString(record.deliverableId)) errors.push('deliverableId: invalid')
  if (!isNonEmptyString(record.linkId)) errors.push('linkId: invalid')
  try {
    assertNodeId(record.originNodeId, 'originNodeId')
  } catch {
    errors.push('originNodeId: invalid')
  }
  if (!isNonEmptyString(record.originSessionId)) errors.push('originSessionId: invalid')
  if (!isSafeLogicalPath(record.logicalPath)) errors.push('logicalPath: unsafe')
  if (!isNonEmptyString(record.name)) errors.push('name: invalid')
  if (!DELIVERABLE_KINDS.includes(record.kind)) errors.push('kind: invalid')
  if (!isInt(record.createdAt)) errors.push('createdAt: invalid')
  if (!isInt(record.updatedAt)) errors.push('updatedAt: invalid')
  if (!Number.isInteger(record.originSeq) || record.originSeq < 1) errors.push('originSeq: invalid')
  validateVersion(record.current, errors, 'current')
  if (record.description !== undefined && typeof record.description !== 'string') errors.push('description: invalid')

  if (!Array.isArray(record.versions) || record.versions.length === 0) {
    errors.push('versions: empty')
  } else {
    let previous = 0
    let previousArtifact = ''
    record.versions.forEach((version, index) => {
      validateVersion(version, errors, `versions[${index}]`)
      if (!Number.isInteger(version?.originSeq) || version.originSeq <= previous) {
        errors.push(`versions[${index}].originSeq: not-increasing`)
      }
      if (version?.artifactId === previousArtifact) {
        errors.push(`versions[${index}].artifactId: duplicate`)
      }
      if (Number.isInteger(version?.originSeq)) previous = version.originSeq
      if (typeof version?.artifactId === 'string') previousArtifact = version.artifactId
    })
    const last = record.versions[record.versions.length - 1]
    if (last?.artifactId !== record.current?.artifactId || last?.originSeq !== record.current?.originSeq) {
      errors.push('versions: last must equal current')
    }
  }

  if (record.deleted !== undefined) {
    if (!isPlainObject(record.deleted)) {
      errors.push('deleted: not-object')
    } else {
      if (!isInt(record.deleted.at)) errors.push('deleted.at: invalid')
      if (!Number.isInteger(record.deleted.originSeq) || record.deleted.originSeq <= record.originSeq) {
        errors.push('deleted.originSeq: must exceed record.originSeq')
      }
    }
  }
  return errors
}

/** @param {DeliverableRecord} record */
export function assertRecord(record) {
  const errors = validateRecord(record)
  if (errors.length > 0) {
    throw new ProtocolError('deliverable/op-invalid', 'invalid deliverable record', { errors })
  }
  return record
}

/**
 * Create a fresh record carrying its first version.
 * @param {object} options
 * @param {string} options.deliverableId
 * @param {string} options.linkId
 * @param {string} options.originNodeId
 * @param {string} options.originSessionId
 * @param {string} options.logicalPath
 * @param {string} options.name
 * @param {string} options.kind
 * @param {DeliverableVersion} options.version
 * @param {number} options.createdAt
 * @param {string} [options.description]
 * @returns {DeliverableRecord}
 */
export function createRecord(options) {
  const record = {
    deliverableId: options.deliverableId,
    linkId: options.linkId,
    originNodeId: options.originNodeId,
    originSessionId: options.originSessionId,
    logicalPath: options.logicalPath,
    name: options.name,
    kind: options.kind,
    createdAt: options.createdAt,
    updatedAt: options.version.createdAt,
    originSeq: options.version.originSeq,
    current: options.version,
    versions: [options.version],
    ...(options.description === undefined ? {} : { description: options.description }),
  }
  return assertRecord(record)
}

/**
 * Append a new version and enforce retention. The current version is always the last one.
 * @param {DeliverableRecord} record
 * @param {DeliverableVersion} version
 * @param {number} [retention]
 * @returns {DeliverableRecord}
 */
export function withVersion(record, version, retention = DEFAULT_VERSION_RETENTION) {
  if (retention < 1) throw new TypeError('retention must be >= 1')
  if (record.versions.some(v => v.originSeq === version.originSeq)) {
    throw new ProtocolError('deliverable/op-invalid', 'duplicate version originSeq', { originSeq: version.originSeq })
  }
  const versions = [...record.versions, version].slice(-retention)
  const next = {
    ...record,
    updatedAt: version.createdAt,
    originSeq: version.originSeq,
    current: versions[versions.length - 1],
    versions,
  }
  return assertRecord(next)
}

/**
 * Mark a record tombstoned. `record.originSeq` stays at the last version; the
 * tombstone carries its own higher sequence.
 * @param {DeliverableRecord} record
 * @param {{at:number, originSeq:number}} tombstone
 * @returns {DeliverableRecord}
 */
export function markDeleted(record, tombstone) {
  if (record.deleted !== undefined) {
    throw new ProtocolError('deliverable/op-invalid', 'record already deleted', { deliverableId: record.deliverableId })
  }
  return assertRecord({ ...record, deleted: { at: tombstone.at, originSeq: tombstone.originSeq } })
}

/**
 * Validate one sync op.
 * @param {object} op
 * @returns {string[]}
 */
export function validateOp(op) {
  /** @type {string[]} */
  const errors = []
  if (!isPlainObject(op)) return ['op: not-object']
  if (op.op !== 'upsert' && op.op !== 'remove') errors.push('op: invalid')
  if (!isNonEmptyString(op.linkId)) errors.push('linkId: invalid')
  try {
    assertNodeId(op.originNodeId, 'originNodeId')
  } catch {
    errors.push('originNodeId: invalid')
  }
  if (!Number.isInteger(op.originSeq) || op.originSeq < 1) errors.push('originSeq: invalid')

  if (op.op === 'upsert') {
    const recordErrors = validateRecord(op.record)
    for (const error of recordErrors) errors.push(`record.${error}`)
    if (op.record?.originSeq !== op.originSeq) errors.push('record.originSeq: mismatch')
    if (op.record?.originNodeId !== op.originNodeId) errors.push('record.originNodeId: mismatch')
    if (op.record?.linkId !== op.linkId) errors.push('record.linkId: mismatch')
  } else if (op.op === 'remove') {
    if (!isNonEmptyString(op.deliverableId)) errors.push('deliverableId: invalid')
    if (!isInt(op.at)) errors.push('at: invalid')
  }
  return errors
}

/** @param {object} op */
export function assertOp(op) {
  const errors = validateOp(op)
  if (errors.length > 0) {
    throw new ProtocolError('deliverable/op-invalid', 'invalid deliverable op', { errors })
  }
  return op
}

/**
 * Derive the local sync state for a record.
 * @param {DeliverableRecord} record
 * @param {{artifactId?:string, state?:'absent'|'pending'|'partial'|'available'|'error'}} local
 * @returns {'metadata-only'|'pending'|'partial'|'synced'|'stale'|'removed'|'error'}
 */
export function deriveSyncState(record, local = {}) {
  if (record.deleted !== undefined) return 'removed'
  if (local.state === 'error') return 'error'
  const currentAvailable = local.state === 'available' && local.artifactId === record.current.artifactId
  if (currentAvailable) return 'synced'
  if (local.state === 'partial') return 'partial'
  if (local.state === 'pending') return 'pending'
  if (local.artifactId !== undefined && local.artifactId !== record.current.artifactId) return 'stale'
  return 'metadata-only'
}
