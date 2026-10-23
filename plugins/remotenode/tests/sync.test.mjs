import test from 'node:test'
import assert from 'node:assert/strict'

import { createSyncEngine } from '../lib/sync-engine.js'
import { OpLog } from '../lib/oplog.js'
import { ProtocolError } from '../lib/errors.js'
import { artifactIdForBytes } from '../lib/ids.js'

const LINK = 'link-1'

/**
 * @param {{a?: object, b?: object}} [options]
 */
function makePair(options = {}) {
  let clock = 1000
  const now = () => { clock += 1; return clock }
  const a = createSyncEngine({ nodeId: 'node-a', linkId: LINK, originSessionId: 'session-a', now, ...options.a })
  const b = createSyncEngine({ nodeId: 'node-b', linkId: LINK, originSessionId: 'session-b', now, ...options.b })
  a.setPeerNodeId('node-b')
  b.setPeerNodeId('node-a')
  return { a, b }
}

function publish(engine, name, content, kind = 'text', mime = 'text/plain') {
  return engine.publish({ name, bytes: Buffer.from(content), kind, mime })
}

function viewsEqual(a, b) {
  assert.equal(JSON.stringify(a.view()), JSON.stringify(b.view()))
}

function syncInto(from, to) {
  const result = from.handleSyncRequest({ applied: { [from.nodeId]: to.appliedSeq } })
  to.handleSyncResult(result)
  return result
}

test('V1/V2: upsert applies once and duplicate is ignored', () => {
  const { a, b } = makePair()
  const { op, record } = publish(a, 'cat.png', 'png-v1', 'image', 'image/png')
  b.handleOp(op)
  assert.equal(b.appliedSeq, 1)
  assert.equal(b.peerRecord(record.deliverableId).current.artifactId, record.current.artifactId)
  const again = b.handleOp(op)
  assert.equal(again.duplicate, true)
  assert.equal(b.appliedSeq, 1)
})

test('V3: out-of-order ops buffer until the gap is filled', () => {
  const { a, b } = makePair()
  const first = publish(a, 'a.txt', 'a')
  const second = publish(a, 'b.txt', 'b')
  const gap = b.handleOp(second.op)
  assert.equal(gap.needSync, true)
  assert.equal(gap.buffered, true)
  const filled = b.handleOp(first.op)
  assert.equal(filled.applied, true)
  assert.equal(filled.flushed, 1)
  assert.equal(b.appliedSeq, 2)
  assert.equal(b.peerRecords.length, 2)
})

test('V4: op-log rollover falls back to a snapshot', () => {
  const { a, b } = makePair({ a: { opLogMaxOps: 2 } })
  publish(a, 'a.txt', 'a')
  publish(a, 'b.txt', 'b')
  publish(a, 'c.txt', 'c')
  assert.equal(a.oplog.size, 2)
  assert.equal(a.oplog.exportSince(0).length, 2)
  const result = a.handleSyncRequest({ applied: { 'node-a': 0 } })
  assert.equal(result.snapshot.snapshotSeq, 3)
  b.handleSyncResult(result)
  assert.equal(b.appliedSeq, 3)
  assert.equal(b.peerRecords.length, 3)
})

test('V5: a new version updates current and history', () => {
  const { a, b } = makePair()
  const v1 = publish(a, 'cat.glb', 'glb-v1', 'model3d', 'model/gltf-binary')
  b.handleOp(v1.op)
  const v2 = publish(a, 'cat.glb', 'glb-v2', 'model3d', 'model/gltf-binary')
  b.handleOp(v2.op)
  const record = b.peerRecord(v1.record.deliverableId)
  assert.equal(record.versions.length, 2)
  assert.equal(record.current.artifactId, v2.artifactId)
  assert.equal(record.originSeq, 2)
})

test('V6: remove produces a tombstone', () => {
  const { a, b } = makePair()
  const { op, record } = publish(a, 'cat.glb', 'glb')
  b.handleOp(op)
  const removal = a.remove(record.deliverableId)
  b.handleOp(removal.op)
  const tomb = b.peerRecord(record.deliverableId)
  assert.equal(tomb.deleted.originSeq, 2)
  assert.equal(b.appliedSeq, 2)
  assert.equal(a.remove(record.deliverableId).duplicate, true)
})

test('V7: republishing identical content is a no-op', () => {
  const { a } = makePair()
  const first = publish(a, 'same.txt', 'same')
  const second = publish(a, 'same.txt', 'same')
  assert.equal(second.duplicate, true)
  assert.equal(second.op, null)
  assert.equal(a.ownSeq, 1)
  assert.equal(first.record.deliverableId, second.record.deliverableId)
})

test('V8: offline ops are recovered by sync', () => {
  const { a, b } = makePair()
  publish(a, 'a.txt', 'a')
  publish(a, 'b.txt', 'b')
  assert.equal(b.appliedSeq, 0)
  syncInto(a, b)
  assert.equal(b.appliedSeq, 2)
  viewsEqual(a, b)
})

test('V9: shuffled delivery converges through buffering', () => {
  const { a, b } = makePair()
  const ops = [
    publish(a, 'a.txt', 'a').op,
    publish(a, 'b.txt', 'b').op,
    publish(a, 'c.txt', 'c').op,
  ]
  b.handleOp(ops[2])
  b.handleOp(ops[1])
  assert.equal(b.appliedSeq, 0)
  b.handleOp(ops[0])
  assert.equal(b.appliedSeq, 3)
  assert.equal(b.bufferedOps.length, 0)
  assert.equal(b.peerRecords.length, 3)
})

test('V10: both origins may publish the same logical name', () => {
  const { a, b } = makePair()
  const fromA = publish(a, 'shared.txt', 'from-a')
  const fromB = publish(b, 'shared.txt', 'from-b')
  b.handleOp(fromA.op)
  a.handleOp(fromB.op)
  assert.equal(a.ownRecords.length, 1)
  assert.equal(a.peerRecords.length, 1)
  assert.equal(b.ownRecords.length, 1)
  assert.equal(b.peerRecords.length, 1)
  viewsEqual(a, b)
})

test('V11: snapshot followed by a live op stays consistent', () => {
  const { a, b } = makePair({ a: { opLogMaxOps: 2 } })
  publish(a, 'a.txt', 'a')
  publish(a, 'b.txt', 'b')
  publish(a, 'c.txt', 'c')
  const snapshot = a.handleSyncRequest({ applied: { 'node-a': 0 } })
  b.handleSyncResult(snapshot)
  assert.equal(b.appliedSeq, 3)
  const live = publish(a, 'd.txt', 'd')
  b.handleOp(live.op)
  assert.equal(b.appliedSeq, 4)
  assert.equal(b.peerRecords.length, 4)
  // A stale replay of an op covered by the snapshot is ignored.
  assert.equal(b.handleOp(publish(a, 'e.txt', 'e').op).applied, true)
  viewsEqual(a, b)
})

test('V14: wrong origin, wrong link and malformed ops are rejected', () => {
  const { a, b } = makePair()
  const real = publish(a, 'a.txt', 'a')
  const wrongOrigin = { ...real.op, originNodeId: 'node-b' }
  assert.equal(b.handleOp(wrongOrigin).error, 'deliverable/unauthorized')
  const wrongLink = { ...real.op, linkId: 'other-link' }
  assert.equal(b.handleOp(wrongLink).error, 'deliverable/unauthorized')
  const malformed = { ...real.op, record: null }
  assert.equal(b.handleOp(malformed).error, 'deliverable/op-invalid')
  assert.equal(b.appliedSeq, 0)
})

test('remove for an unknown deliverable requests a resync', () => {
  const { a, b } = makePair()
  publish(a, 'a.txt', 'a')
  const removal = a.remove(a.ownRecords[0].deliverableId)
  const result = b.handleOp(removal.op)
  assert.equal(result.needSync, true)
  syncInto(a, b)
  assert.equal(b.appliedSeq, 2)
})

test('V15: applied=0 rebuild converges', () => {
  const { a, b } = makePair()
  publish(a, 'a.txt', 'a')
  publish(a, 'b.txt', 'b')
  publish(a, 'c.txt', 'c')
  const result = a.handleSyncRequest({ applied: {} })
  b.handleSyncResult(result)
  assert.equal(b.appliedSeq, 3)
  viewsEqual(a, b)
})

test('publish accepts a precomputed artifactId + size (no bytes in memory)', () => {
  const { a, b } = makePair()
  const bytes = Buffer.from('streamed-artifact-content')
  const artifactId = artifactIdForBytes(bytes)
  const result = a.publish({ name: 'big.bin', artifactId, size: bytes.byteLength, kind: 'archive' })
  assert.equal(result.duplicate, false)
  assert.equal(result.artifactId, artifactId)
  assert.equal(result.record.current.artifactId, artifactId)
  assert.equal(result.record.current.size, bytes.byteLength)
  assert.equal(result.record.originSeq, 1)
  b.handleOp(result.op)
  assert.equal(b.peerRecord(result.record.deliverableId).current.size, bytes.byteLength)

  // same content arriving later through the bytes path is still idempotent
  assert.equal(a.publish({ name: 'big.bin', bytes }).duplicate, true)

  // missing/invalid precomputed metadata is a protocol error
  const invalid = (input) => assert.throws(
    () => a.publish(input),
    (error) => error instanceof ProtocolError
      && error.kind === 'deliverable/op-invalid'
      && /publish requires bytes or artifactId\+size/.test(error.message),
  )
  invalid({ name: 'x.bin', size: 3 })
  invalid({ name: 'x.bin', artifactId })
  invalid({ name: 'x.bin', artifactId: 'sha256:short', size: 3 })
  invalid({ name: 'x.bin', artifactId, size: -1 })
  invalid({ name: 'x.bin', artifactId, size: 1.5 })
})

test('exportState/restore round-trips exactly', () => {
  const { a, b } = makePair()
  const p1 = publish(a, 'cat.png', 'png-v1', 'image', 'image/png')
  b.handleOp(p1.op)
  publish(a, 'cat.png', 'png-v2', 'image', 'image/png')
  const removed = a.remove(p1.record.deliverableId)
  b.handleOp(removed.op)
  publish(a, 'keep.txt', 'keep')

  // a is "offline" after the removal; restore from a JSON roundtrip state
  const state = a.exportState()
  const stateJson = JSON.stringify(state)
  const restored = createSyncEngine({
    nodeId: 'node-a', linkId: LINK, originSessionId: 'session-a', state: JSON.parse(stateJson),
  })
  assert.deepEqual(restored.exportState(), state)
  assert.equal(restored.ownSeq, a.ownSeq)
  assert.equal(restored.peerNodeId, 'node-b')
  assert.deepEqual(restored.view(), a.view())
  assert.deepEqual(restored.ownRecords, a.ownRecords)
  assert.equal(restored.oplog.size, a.oplog.size)

  // restored publish continues the persisted sequence
  const next = publish(restored, 'after-restart.txt', 'after')
  assert.equal(next.record.originSeq, state.nextSeq)
  assert.equal(restored.ownSeq, state.nextSeq)

  // restored op log can backfill a peer that lost everything
  const fresh = createSyncEngine({ nodeId: 'node-b', linkId: LINK, originSessionId: 'session-b' })
  fresh.setPeerNodeId('node-a')
  const result = restored.handleSyncRequest({ applied: { 'node-a': 0 } })
  const applied = fresh.handleSyncResult(result)
  assert.equal(applied.applied, true)
  assert.equal(fresh.appliedSeq, restored.ownSeq)
  assert.equal(fresh.peerRecords.length, restored.ownRecords.length)
  viewsEqual(restored, fresh)
})

test('restore keeps the peer namespace and watermark', () => {
  const { a, b } = makePair()
  publish(a, 'from-a.txt', 'a')
  publish(b, 'from-b.txt', 'b')
  syncInto(a, b)
  syncInto(b, a)
  assert.equal(a.appliedSeq, 1)

  const state = b.exportState()
  const restored = createSyncEngine({
    nodeId: 'node-b', linkId: LINK, originSessionId: 'session-b', state: JSON.parse(JSON.stringify(state)),
  })
  assert.deepEqual(restored.exportState(), state)
  assert.equal(restored.appliedSeq, 1)
  assert.equal(restored.peerRecords.length, 1)
  assert.equal(restored.peerRecords[0].originNodeId, 'node-a')
  assert.equal(restored.peerNodeId, 'node-a')
})

test('restore derives outbound ops when the snapshot has no ownOps', () => {
  const { a } = makePair()
  publish(a, 'one.txt', 'one')
  publish(a, 'two.txt', 'two')
  const state = a.exportState()
  delete state.ownOps
  const restored = createSyncEngine({ nodeId: 'node-a', linkId: LINK, state })
  assert.equal(restored.ownSeq, 2)
  assert.equal(restored.oplog.size, 2)
  const result = restored.handleSyncRequest({ applied: { 'node-a': 0 } })
  assert.equal(Array.isArray(result.ops), true)
  assert.equal(result.ops.length, 2)
})

test('corrupt state is rejected instead of partially applied', () => {
  const { a } = makePair()
  publish(a, 'x.txt', 'x')
  const state = a.exportState()
  const make = (patch) => () => createSyncEngine({ nodeId: 'node-a', linkId: LINK, state: { ...state, ...patch } })
  assert.throws(make({ nextSeq: 0 }), /nextSeq/)
  assert.throws(make({ nextSeq: 1 }), /nextSeq/)
  assert.throws(make({ ownRecords: [{}] }), /invalid own record/)
  assert.throws(make({ peer: { appliedSeq: -1, records: [] } }), /appliedSeq/)
  assert.throws(make({ peerNodeId: 'node-a' }), /differ/)
  assert.throws(() => createSyncEngine({ nodeId: 'node-a', linkId: LINK, state: { ...state, ownOps: [{ op: 'nope' }] } }), /invalid own op/)
  // a snapshot for another link is refused
  assert.throws(() => createSyncEngine({ nodeId: 'node-a', linkId: 'other-link', state }), /linkId mismatch|inconsistent/)
})

test('ownArtifactIds and peerArtifactIds list referenced versions', () => {
  const { a, b } = makePair()
  const v1 = publish(a, 'cat.png', 'png-v1', 'image', 'image/png')
  const v2 = publish(a, 'cat.png', 'png-v2', 'image', 'image/png')
  b.handleOp(v1.op)
  b.handleOp(v2.op)
  const ownIds = a.ownArtifactIds()
  assert.equal(ownIds instanceof Set, true)
  assert.equal(ownIds.has(v1.artifactId), true)
  assert.equal(ownIds.has(v2.artifactId), true)
  assert.equal(ownIds.size, 2)
  const peerIds = b.peerArtifactIds()
  assert.equal(peerIds.size, 2)
  assert.equal([...ownIds].sort().join(','), [...peerIds].sort().join(','))
})

test('OpLog keeps bounded retention and exposes export helpers', () => {
  const log = new OpLog({ maxOps: 3 })
  for (let seq = 1; seq <= 5; seq += 1) {
    log.append({ op: 'remove', linkId: LINK, originNodeId: 'node-a', originSeq: seq, deliverableId: 'd', at: seq })
  }
  assert.equal(log.size, 3)
  assert.equal(log.firstSeq, 3)
  assert.equal(log.lastSeq, 5)
  assert.deepEqual(log.exportSince(3).map(op => op.originSeq), [4, 5])
  assert.deepEqual(log.exportAll().map(op => op.originSeq), [3, 4, 5])
  assert.equal(log.covers(2), true)
  assert.equal(log.covers(1), false)
  assert.throws(() => log.append({ op: 'remove', linkId: LINK, originNodeId: 'node-a', originSeq: 5, deliverableId: 'd', at: 5 }), /must exceed/)
})
