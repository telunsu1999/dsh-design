import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ERRORS, ProtocolError, asProtocolError, errorCodeOf, isRpcError,
  kindFromCode, protocolErrorFromRpc, rpcErrorFor,
} from '../lib/errors.js'

test('error registry is frozen, unique and well-formed', () => {
  assert.equal(Object.isFrozen(ERRORS), true)
  const codes = new Set()
  for (const [kind, info] of Object.entries(ERRORS)) {
    assert.equal(typeof info.code, 'number', kind)
    assert.equal(Number.isInteger(info.code), true, kind)
    assert.equal(typeof info.retryable, 'boolean', kind)
    assert.equal(codes.has(info.code), false, `duplicate code ${info.code} (${kind})`)
    codes.add(info.code)
    // numeric-kind roundtrip used by protocolErrorFromRpc
    assert.equal(kindFromCode(info.code), kind)
  }
  assert.equal(ERRORS['link/closed'].code, 4014)
  assert.equal(ERRORS['link/closed'].retryable, false)
  assert.equal(ERRORS['frame/invalid-json'].code, 4062)
})

test('ProtocolError carries kind/code/retryable/details', () => {
  const error = new ProtocolError('auth/clock-skew', 'too far off', { skewMs: 5 })
  assert.equal(error instanceof Error, true)
  assert.equal(error instanceof ProtocolError, true)
  assert.equal(error.name, 'ProtocolError')
  assert.equal(error.kind, 'auth/clock-skew')
  assert.equal(error.code, 4003)
  assert.equal(error.retryable, true)
  assert.deepEqual(error.details, { skewMs: 5 })
  assert.equal(new ProtocolError('peer/offline').message, 'peer/offline')
  assert.equal(new ProtocolError('peer/offline').details, undefined)
  assert.throws(() => new ProtocolError('made/up-kind'), TypeError)
})

test('rpcErrorFor accepts a kind string (prototype form)', () => {
  assert.deepEqual(rpcErrorFor('auth/replay'), {
    code: 4004,
    message: 'auth/replay',
    data: { kind: 'auth/replay', retryable: false },
  })
  assert.deepEqual(rpcErrorFor('deliverable/unknown', 'gone', { deliverableId: 'd1' }), {
    code: 4040,
    message: 'gone',
    data: { kind: 'deliverable/unknown', retryable: false, details: { deliverableId: 'd1' } },
  })
  assert.throws(() => rpcErrorFor('nope/nope'), TypeError)
})

test('rpcErrorFor accepts thrown values (SPEC form)', () => {
  const protocol = new ProtocolError('deliverable/revision-gap', 'gap', { want: 3 })
  assert.deepEqual(rpcErrorFor(protocol), {
    code: 4041,
    message: 'gap',
    data: { kind: 'deliverable/revision-gap', retryable: true, details: { want: 3 } },
  })
  const generic = rpcErrorFor(new Error('kaboom'))
  assert.equal(generic.code, 4090)
  assert.equal(generic.message, 'kaboom')
  assert.deepEqual(generic.data, { kind: 'peer/internal', retryable: true })
  assert.equal(rpcErrorFor(undefined).data.kind, 'peer/internal')
})

test('isRpcError / protocolErrorFromRpc normalize wire errors', () => {
  assert.equal(isRpcError({ code: 1, message: 'x' }), true)
  assert.equal(isRpcError({ code: 1, message: 'x', data: { kind: 'peer/offline' } }), true)
  assert.equal(isRpcError({ code: 1 }), false)
  assert.equal(isRpcError({ code: '1', message: 'x' }), false)
  assert.equal(isRpcError(null), false)
  assert.equal(isRpcError('nope'), false)

  const rebuilt = protocolErrorFromRpc({
    code: 4013, message: 'peer offline', data: { kind: 'peer/offline', retryable: true, details: { peer: 'x' } },
  })
  assert.equal(rebuilt instanceof ProtocolError, true)
  assert.equal(rebuilt.kind, 'peer/offline')
  assert.equal(rebuilt.code, 4013)
  assert.deepEqual(rebuilt.details, { peer: 'x' })

  // unknown kinds/codes normalize to ERRORS['peer/internal'] (4090): the table
  // is the single source of truth, a remote code we do not know is not echoed.
  const unknownKind = protocolErrorFromRpc({ code: 4090, message: 'future', data: { kind: 'future/kind' } })
  assert.equal(unknownKind.kind, 'peer/internal')
  const unknownCode = protocolErrorFromRpc({ code: 4999, message: 'mystery' })
  assert.equal(unknownCode.kind, 'peer/internal')
  assert.equal(unknownCode.code, 4090)
  assert.equal(rpcErrorFor(unknownCode).code, 4090)
  // forwarding an already-formed wire error object keeps its wire code as-is
  assert.equal(rpcErrorFor({ code: 4999, message: 'mystery' }).code, 4999)
  // known code, missing kind -> recovered from the table
  assert.equal(protocolErrorFromRpc({ code: 4043, message: 'bad op' }).kind, 'deliverable/op-invalid')
  // not an rpc error at all
  assert.equal(protocolErrorFromRpc('nope').kind, 'peer/internal')
})

test('asProtocolError and errorCodeOf normalize arbitrary failures', () => {
  const protocol = new ProtocolError('limit/rate', 'slow down')
  assert.equal(asProtocolError(protocol), protocol)
  assert.equal(asProtocolError('auth/replay').kind, 'auth/replay')
  assert.equal(asProtocolError('just a message').message, 'just a message')
  const wrapped = asProtocolError(new Error('disk full'))
  assert.equal(wrapped.kind, 'peer/internal')
  assert.equal(wrapped.message, 'disk full')
  assert.equal(wrapped.cause instanceof Error, true)

  assert.equal(errorCodeOf(protocol), 4061)
  assert.equal(errorCodeOf({ code: 4013 }), 4013)
  assert.equal(errorCodeOf(new Error('x')), 0)
  assert.equal(errorCodeOf(null), 0)
  assert.equal(kindFromCode(4014), 'link/closed')
  assert.equal(kindFromCode(0), undefined)
  assert.equal(kindFromCode('4014'), undefined)
})
