import test from 'node:test'
import assert from 'node:assert/strict'

import {
  artifactIdForBytes, artifactIdForString, assertArtifactId, assertNodeId, isArtifactId,
  isNodeId, isSafeLogicalPath, logicalPath, newId, randomHex, sanitizeName,
  sha256Base64Url, sha256Hex, timingSafeEqualHex,
} from '../lib/ids.js'

test('sha256 and artifactId are deterministic', () => {
  assert.equal(sha256Hex('hello'), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  const a = artifactIdForString('hello')
  const b = artifactIdForBytes(Buffer.from('hello'))
  assert.equal(a, b)
  assert.match(a, /^sha256:[0-9a-f]{64}$/)
  assert.equal(isArtifactId(a), true)
  assert.equal(isArtifactId('sha256:short'), false)
  assert.equal(isArtifactId('sha256:' + 'A'.repeat(64)), false)
  assert.throws(() => assertArtifactId('nope'), /artifactId must match/)
  assert.equal(assertArtifactId(a), a)
  assert.equal(sha256Base64Url('hello').length > 0, true)
})

test('nodeId validation', () => {
  assert.equal(isNodeId('desktop-01'), true)
  assert.equal(isNodeId('brain-linux'), true)
  assert.equal(isNodeId('a'.repeat(64)), true)
  assert.equal(isNodeId('Desktop'), false)
  assert.equal(isNodeId('a'.repeat(65)), false)
  assert.equal(isNodeId(''), false)
  assert.equal(assertNodeId('desktop-01', 'peer'), 'desktop-01')
  assert.throws(() => assertNodeId('Desktop', 'peerNodeId'), /peerNodeId must match/)
})

test('sanitizeName strips paths, control chars and reserved names', () => {
  assert.equal(sanitizeName('../../etc/passwd'), 'passwd')
  assert.equal(sanitizeName('C:\\tmp\\cat.glb'), 'cat.glb')
  assert.equal(sanitizeName('a\u0000b.txt'), 'a_b.txt')
  assert.equal(sanitizeName('CON'), '_CON')
  assert.equal(sanitizeName('...'), 'file')
  assert.equal(sanitizeName(''), 'file')
  assert.equal(sanitizeName('a<b>c:d.txt'), 'a_b_c_d.txt')
  const long = sanitizeName(`${'a'.repeat(400)}.glb`)
  assert.equal(long.length <= 180, true)
  assert.equal(long.endsWith('.glb'), true)
})

test('logicalPath namespaces by origin and sanitizes', () => {
  assert.equal(
    logicalPath('desktop-01', 'session-7', 'out/cat.glb'),
    'desktop-01/session-7/cat.glb',
  )
  assert.equal(logicalPath('node-a', 'session-1', '../../etc/passwd'), 'node-a/session-1/passwd')
  assert.equal(isSafeLogicalPath('desktop-01/session-7/cat.glb'), true)
  assert.equal(isSafeLogicalPath('desktop-01/../cat.glb'), false)
  assert.equal(isSafeLogicalPath('/abs/path'), false)
  assert.equal(isSafeLogicalPath('desktop-01\\session-7\\cat.glb'), false)
  assert.equal(isSafeLogicalPath('a/b'), false)
  assert.equal(isSafeLogicalPath(''), false)
  assert.throws(() => logicalPath('BAD NODE', 'session-1', 'x.txt'), /originNodeId/)
  assert.throws(() => logicalPath('node-a', '', 'x.txt'), /originSessionId/)
})

test('newId mints UUIDs and optional prefixes', () => {
  const uuid = newId()
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(newId(), uuid)
  const prefixed = newId('session')
  assert.match(prefixed, /^session-[0-9a-f-]{36}$/)
  const linkSessionId = newId('brain-linux')
  assert.equal(linkSessionId.startsWith('brain-linux-'), true)
  assert.throws(() => newId(''), /prefix/)
  assert.throws(() => newId(42), /prefix/)
})

test('randomHex returns nBytes of lowercase hex', () => {
  const hex = randomHex(32)
  assert.match(hex, /^[0-9a-f]{64}$/)
  assert.notEqual(randomHex(32), hex)
  assert.equal(randomHex(1).length, 2)
  assert.throws(() => randomHex(0), /nBytes/)
  assert.throws(() => randomHex(1.5), /nBytes/)
  assert.throws(() => randomHex(64 * 1024 + 1), /nBytes/)
})

test('timingSafeEqualHex compares hex strings safely', () => {
  const a = sha256Hex('a')
  const b = sha256Hex('b')
  assert.equal(timingSafeEqualHex(a, a), true)
  assert.equal(timingSafeEqualHex(a, b), false)
  assert.equal(timingSafeEqualHex(a, a.toUpperCase()), true)
  assert.equal(timingSafeEqualHex(a, a.slice(1)), false)
  assert.equal(timingSafeEqualHex(a, 'zz'), false)
  assert.equal(timingSafeEqualHex('abc', 'abd'), false)
  assert.equal(timingSafeEqualHex(null, a), false)
  assert.equal(timingSafeEqualHex(a, undefined), false)
})
