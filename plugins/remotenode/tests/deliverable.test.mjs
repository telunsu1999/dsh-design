import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_VERSION_RETENTION, DELIVERABLE_KINDS, createRecord, deriveSyncState, markDeleted,
  validateOp, validateRecord, withVersion,
} from '../lib/deliverable.js'
import { ProtocolError } from '../lib/errors.js'
import { logicalPath } from '../lib/ids.js'

const artifactA = `sha256:${'a'.repeat(64)}`
const artifactB = `sha256:${'b'.repeat(64)}`

function version(originSeq, artifactId = artifactA) {
  return { artifactId, size: 10, mime: 'image/png', createdAt: 1000 + originSeq, originSeq }
}

function record(overrides = {}) {
  return createRecord({
    deliverableId: 'del-1',
    linkId: 'link-1',
    originNodeId: 'node-a',
    originSessionId: 'session-a',
    logicalPath: logicalPath('node-a', 'session-a', 'cat.png'),
    name: 'cat.png',
    kind: 'image',
    version: version(1),
    createdAt: 1001,
    ...overrides,
  })
}

test('valid record passes validation', () => {
  const value = record()
  assert.deepEqual(validateRecord(value), [])
  assert.equal(DELIVERABLE_KINDS.includes('image'), true)
  assert.equal(DELIVERABLE_KINDS.includes('model3d'), true)
})

test('record validation catches structural problems', () => {
  const broken = record()
  broken.logicalPath = '../escape'
  broken.originSeq = 0
  broken.versions = []
  const errors = validateRecord(broken)
  assert.equal(errors.some(error => error.includes('logicalPath')), true)
  assert.equal(errors.some(error => error.includes('originSeq')), true)
  assert.equal(errors.some(error => error.includes('versions')), true)

  const wrongKind = record()
  wrongKind.kind = 'gif'
  assert.equal(validateRecord(wrongKind).some(error => error.includes('kind')), true)

  const badVersion = record()
  badVersion.current = { ...badVersion.current, artifactId: 'sha256:nope' }
  badVersion.versions = [badVersion.current]
  assert.equal(validateRecord(badVersion).some(error => error.includes('artifactId')), true)
})

test('withVersion appends versions and keeps current last', () => {
  let value = record()
  value = withVersion(value, version(2, artifactB))
  assert.equal(value.current.artifactId, artifactB)
  assert.equal(value.versions.length, 2)
  assert.equal(value.originSeq, 2)
  assert.equal(value.updatedAt, 1002)
  assert.equal(value.versions.at(-1).artifactId, value.current.artifactId)
  assert.equal(validateRecord(value).length, 0)
  assert.throws(() => withVersion(value, version(2, artifactA)), /duplicate version/)
})

test('withVersion enforces retention', () => {
  let value = record()
  for (let seq = 2; seq <= 8; seq += 1) {
    value = withVersion(value, version(seq, `sha256:${String(seq).repeat(64).slice(0, 64)}`), 3)
  }
  assert.equal(value.versions.length, 3)
  assert.equal(value.versions[0].originSeq, 6)
  assert.equal(value.versions.at(-1).originSeq, 8)
  assert.equal(value.current.originSeq, 8)
  assert.throws(() => withVersion(value, version(9), 0), /retention/)
})

test('markDeleted keeps versions and adds a higher tombstone sequence', () => {
  const value = markDeleted(record(), { at: 2000, originSeq: 2 })
  assert.equal(value.deleted.originSeq, 2)
  assert.equal(value.originSeq, 1)
  assert.equal(value.current.originSeq, 1)
  assert.equal(validateRecord(value).length, 0)
  assert.equal(deriveSyncState(value), 'removed')
  assert.throws(() => markDeleted(value, { at: 3000, originSeq: 3 }), /already deleted/)
})

test('deriveSyncState reflects local byte state', () => {
  const value = record()
  assert.equal(deriveSyncState(value, {}), 'metadata-only')
  assert.equal(deriveSyncState(value, { state: 'pending' }), 'pending')
  assert.equal(deriveSyncState(value, { state: 'partial' }), 'partial')
  assert.equal(deriveSyncState(value, { state: 'available', artifactId: artifactA }), 'synced')
  assert.equal(deriveSyncState(value, { state: 'available', artifactId: artifactB }), 'stale')
  assert.equal(deriveSyncState(value, { state: 'error' }), 'error')
})

test('validateOp checks upsert/remove shapes', () => {
  const value = record()
  const upsert = { op: 'upsert', linkId: 'link-1', originNodeId: 'node-a', originSeq: 1, record: value }
  assert.deepEqual(validateOp(upsert), [])
  const remove = { op: 'remove', linkId: 'link-1', originNodeId: 'node-a', originSeq: 2, deliverableId: 'del-1', at: 2000 }
  assert.deepEqual(validateOp(remove), [])
  assert.equal(validateOp({ op: 'remove', linkId: 'link-1', originNodeId: 'node-a', originSeq: 0 }).length > 0, true)
  assert.equal(validateOp({ ...upsert, originSeq: 2 }).length > 0, true)
  assert.equal(validateOp({ ...upsert, originNodeId: 'node-b' }).length > 0, true)
  assert.equal(validateOp(null).length > 0, true)
})

test('assert-style helpers throw ProtocolError', () => {
  assert.throws(() => createRecord({
    deliverableId: 'del-2',
    linkId: 'link-1',
    originNodeId: 'node-a',
    originSessionId: 'session-a',
    logicalPath: '../bad',
    name: 'x',
    kind: 'image',
    version: version(1),
    createdAt: 1,
  }), (error) => error instanceof ProtocolError && error.kind === 'deliverable/op-invalid')
})

test('default retention is five versions', () => {
  assert.equal(DEFAULT_VERSION_RETENTION, 5)
})
