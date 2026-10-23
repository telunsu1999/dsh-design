import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CHUNK_BYTES, MAX_CHUNK_BYTES, MAX_FRAME_BYTES, MAX_JSON_FRAME_BYTES, MAX_EVENT_BATCH,
  WINDOW_BYTES, METHODS,
  decodeArtifactChunk, decodeBinaryFrame, decodeJsonFrame, encodeArtifactChunk,
  encodeBinaryFrame, encodeJsonFrame, errorResponse, isBinaryFramePayload,
  notification, request, response, validateFrame, validateJsonRpcFrame,
} from '../lib/frames.js'
import {
  ERRORS, ProtocolError, asProtocolError, errorCodeOf, isRpcError,
  kindFromCode, protocolErrorFromRpc, rpcErrorFor,
} from '../lib/errors.js'

test('frame limits match the protocol contract', () => {
  assert.equal(MAX_JSON_FRAME_BYTES, 1024 * 1024)
  assert.equal(MAX_CHUNK_BYTES, 1024 * 1024)
  assert.equal(MAX_EVENT_BATCH, 200)
  assert.equal(MAX_FRAME_BYTES, MAX_CHUNK_BYTES + 64 * 1024)
  assert.equal(CHUNK_BYTES, MAX_CHUNK_BYTES)
  assert.equal(WINDOW_BYTES, 8 * 1024 * 1024)
  assert.equal(METHODS['peer.hello'].kind, 'request')
  assert.equal(METHODS['deliverable.op'].kind, 'notification')
  assert.equal(METHODS['artifact.chunk'].kind, 'binary')
})

test('frame constructors and validation', () => {
  const req = request('id-1', 'peer.ping', { at: 1 })
  assert.deepEqual(validateJsonRpcFrame(req), { ok: true, kind: 'request', method: 'peer.ping', id: 'id-1' })
  const note = notification('event.session', { records: [] })
  assert.deepEqual(validateJsonRpcFrame(note), { ok: true, kind: 'notification', method: 'event.session' })
  const res = response('id-1', { ok: true })
  assert.deepEqual(validateJsonRpcFrame(res), { ok: true, kind: 'response', id: 'id-1' })
  const failure = errorResponse('id-2', rpcErrorFor('peer/offline'))
  const validated = validateJsonRpcFrame(failure)
  assert.equal(validated.ok, true)
  assert.equal(validated.kind, 'response')
  assert.equal(failure.error.code, 4013)
  assert.equal(failure.error.data.kind, 'peer/offline')
  // prototype alias
  assert.equal(validateFrame, validateJsonRpcFrame)
})

test('malformed frames are rejected', () => {
  assert.equal(validateJsonRpcFrame(null).ok, false)
  assert.equal(validateJsonRpcFrame({ jsonrpc: '1.0', method: 'x' }).ok, false)
  assert.equal(validateJsonRpcFrame({ jsonrpc: '2.0', method: 'x', result: 1 }).ok, false)
  assert.equal(validateJsonRpcFrame({ jsonrpc: '2.0', id: 'x' }).ok, false)
  assert.equal(validateJsonRpcFrame({ jsonrpc: '2.0', id: 'x', result: 1, error: {} }).ok, false)
  assert.equal(validateJsonRpcFrame({ jsonrpc: '2.0', id: 'x', error: { code: 'nope', message: 'x' } }).ok, false)
  assert.equal(validateJsonRpcFrame({ jsonrpc: '2.0', result: 1 }).ok, false)
  assert.equal(validateJsonRpcFrame({ jsonrpc: '2.0', method: '' }).ok, false)
  assert.equal(validateJsonRpcFrame({ jsonrpc: '2.0', method: 'x', params: 42 }).ok, false)
  assert.equal(validateJsonRpcFrame({ jsonrpc: '2.0', method: 'x', id: 42 }).ok, false)
  // unknown methods are structurally valid (forward compatibility)
  assert.equal(validateJsonRpcFrame(request('id', 'future.method')).ok, true)
})

test('oversized JSON frames are rejected before dispatch', () => {
  const big = 'x'.repeat(MAX_JSON_FRAME_BYTES + 10)
  const frame = notification('event.session', { payload: big })
  assert.deepEqual(validateJsonRpcFrame(frame), { ok: false, reason: 'frame-too-large' })
})

test('json frame encoder/decoder enforce limits and json validity', () => {
  const frame = request('id-1', 'peer.ping', { text: '你好，节点' })
  const encoded = encodeJsonFrame(frame)
  assert.equal(Buffer.isBuffer(encoded), true)
  assert.deepEqual(decodeJsonFrame(encoded), frame)

  const big = notification('event.session', { payload: 'x'.repeat(MAX_JSON_FRAME_BYTES + 8) })
  assert.throws(
    () => encodeJsonFrame(big),
    /** @type {any} */ (error) => error instanceof ProtocolError
      && error.kind === 'limit/frame-too-large'
      && error.code === 4060,
  )
  assert.throws(
    () => decodeJsonFrame(Buffer.alloc(MAX_JSON_FRAME_BYTES + 1, 0x7b)),
    /** @type {any} */ (error) => error instanceof ProtocolError && error.kind === 'limit/frame-too-large',
  )
  assert.throws(
    () => decodeJsonFrame(Buffer.from('{not json', 'utf8')),
    /** @type {any} */ (error) => error instanceof ProtocolError
      && error.kind === 'frame/invalid-json'
      && error.code === 4062,
  )
  assert.throws(() => decodeJsonFrame(Buffer.from('[1,2]')), /not an object/)
  assert.throws(() => encodeJsonFrame('nope'), /plain object/)
})

test('binary chunk roundtrip', () => {
  const payload = Buffer.from('glb-chunk-'.repeat(100), 'utf8')
  const header = { artifactId: `sha256:${'a'.repeat(64)}`, offset: 0, length: payload.byteLength }
  const encoded = encodeBinaryFrame(header, payload)
  // binary frames never start with '{'
  assert.equal(encoded[0], 0)
  const decoded = decodeBinaryFrame(encoded)
  assert.notEqual(decoded, null)
  assert.deepEqual(decoded.header, header)
  assert.equal(decoded.payload.toString('utf8'), payload.toString('utf8'))

  // prototype-compatible strict artifact chunk helpers
  const strict = decodeArtifactChunk(encodeArtifactChunk(header, payload))
  assert.deepEqual(strict.header, header)
  assert.equal(strict.payload.toString('utf8'), payload.toString('utf8'))
})

test('binary frames report malformed input as null (carrier decides)', () => {
  assert.equal(decodeBinaryFrame(Buffer.from([0, 0, 0])), null)
  assert.equal(decodeBinaryFrame(Buffer.from([0, 0, 0, 10])), null)
  const badHeader = Buffer.alloc(4 + 4)
  badHeader.writeUInt32BE(4, 0)
  badHeader.write('nope', 4, 'utf8')
  assert.equal(decodeBinaryFrame(badHeader), null)
  const lengthMismatch = encodeBinaryFrame({ artifactId: 'x', offset: 0, length: 99 }, Buffer.from('abc'))
  assert.equal(decodeBinaryFrame(lengthMismatch), null)
  assert.equal(decodeBinaryFrame(Buffer.alloc(MAX_FRAME_BYTES + 1)), null)
  // strict decoder still throws like the prototype
  assert.throws(() => decodeArtifactChunk(Buffer.from([0, 0, 0])), /too short/)
  assert.throws(() => decodeArtifactChunk(Buffer.from([0, 0, 0, 10])), /out of bounds/)
  assert.throws(() => encodeArtifactChunk({ artifactId: 'x', offset: -1, length: 3 }, Buffer.from('abc')), /offset/)
  assert.throws(() => encodeArtifactChunk({ artifactId: 'x', offset: 0, length: 4 }, Buffer.from('abc')), /length/)
})

test('binary encoder rejects oversized payloads and headers', () => {
  assert.throws(
    () => encodeBinaryFrame({ artifactId: 'x' }, Buffer.alloc(MAX_CHUNK_BYTES + 1)),
    /** @type {any} */ (error) => error instanceof ProtocolError && error.kind === 'limit/frame-too-large',
  )
  assert.throws(
    () => encodeBinaryFrame({ huge: 'x'.repeat(17 * 1024) }, Buffer.alloc(1)),
    /** @type {any} */ (error) => error instanceof ProtocolError && error.kind === 'limit/frame-too-large',
  )
})

test('isBinaryFramePayload distinguishes JSON and binary carrier payloads', () => {
  assert.equal(isBinaryFramePayload(Buffer.from('{"jsonrpc":"2.0"}')), false)
  assert.equal(isBinaryFramePayload(encodeBinaryFrame({ artifactId: 'x' }, Buffer.from('abc'))), true)
  assert.equal(isBinaryFramePayload(new Uint8Array([0, 0, 0, 2, 1, 2])), true)
  assert.equal(isBinaryFramePayload(new Uint8Array([0x7b])), false)
  assert.equal(isBinaryFramePayload(new Uint8Array(0)), false)
  assert.equal(isBinaryFramePayload('not a buffer'), false)
})

test('error registry numbers are stable', () => {
  assert.equal(ERRORS['auth/invalid-proof'].code, 4001)
  assert.equal(ERRORS['peer/offline'].code, 4013)
  assert.equal(ERRORS['link/closed'].code, 4014)
  assert.equal(ERRORS['deliverable/op-invalid'].code, 4043)
  assert.equal(ERRORS['artifact/hash-mismatch'].code, 4055)
  assert.equal(ERRORS['artifact/hash-mismatch'].retryable, true)
  assert.equal(ERRORS['limit/frame-too-large'].code, 4060)
  assert.equal(ERRORS['frame/invalid-json'].code, 4062)
  assert.equal(ERRORS['peer/internal'].code, 4090)
})

test('ProtocolError and rpcErrorFor helpers', () => {
  const error = new ProtocolError('deliverable/revision-gap', 'gap', { originSeq: 3 })
  assert.equal(error.kind, 'deliverable/revision-gap')
  assert.equal(error.code, 4041)
  assert.equal(error.retryable, true)
  assert.deepEqual(error.details, { originSeq: 3 })
  assert.equal(error instanceof Error, true)
  assert.throws(() => new ProtocolError('nope/nope'), /unknown protocol error kind/)

  // prototype form: kind string
  const payload = rpcErrorFor('peer/offline')
  assert.deepEqual(payload, {
    code: 4013,
    message: 'peer/offline',
    data: { kind: 'peer/offline', retryable: true },
  })
  // SPEC form: thrown value
  assert.deepEqual(rpcErrorFor(error), {
    code: 4041,
    message: 'gap',
    data: { kind: 'deliverable/revision-gap', retryable: true, details: { originSeq: 3 } },
  })
  const generic = rpcErrorFor(new Error('boom'))
  assert.equal(generic.code, 4090)
  assert.equal(generic.data.kind, 'peer/internal')
  assert.equal(generic.data.retryable, true)
  assert.equal(generic.message, 'boom')
  // rpc error objects survive a roundtrip
  assert.equal(isRpcError(payload), true)
  assert.equal(isRpcError({ code: 'x', message: 'y' }), false)
  const rebuilt = protocolErrorFromRpc(payload)
  assert.equal(rebuilt.kind, 'peer/offline')
  assert.equal(rebuilt.code, 4013)
  assert.deepEqual(rpcErrorFor(rebuilt), payload)
  // unknown remote codes fall back to peer/internal but keep the wire code
  const unknown = protocolErrorFromRpc({ code: 4999, message: 'mystery', data: { kind: 'future/thing' } })
  assert.equal(unknown.kind, 'peer/internal')
  assert.equal(errorCodeOf(unknown), 4090)
  assert.equal(errorCodeOf(error), 4041)
  assert.equal(errorCodeOf(new Error('x')), 0)
  assert.equal(kindFromCode(4043), 'deliverable/op-invalid')
  assert.equal(kindFromCode(1), undefined)
  assert.equal(asProtocolError(error), error)
  assert.equal(asProtocolError('peer/offline').kind, 'peer/offline')
  assert.equal(asProtocolError(new Error('x')).kind, 'peer/internal')
})
