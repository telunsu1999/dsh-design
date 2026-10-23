import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

import {
  DEFAULT_CAPS, DEFAULT_LIMITS, NonceCache, PROTOCOL_VERSION, createHello, createWelcome,
  helloTranscript, secretBytes, simulateHandshake, toBase64Url, verifyHello, verifyWelcome,
  welcomeTranscript,
} from '../lib/handshake.js'

const secret = randomBytes(32)
const dialerNodeId = 'brain-linux'
const listenerNodeId = 'desktop-01'

test('hello/welcome handshake verifies on both sides', () => {
  const { helloCheck, welcomeCheck } = simulateHandshake({ dialerNodeId, listenerNodeId, secret })
  assert.equal(helloCheck.ok, true)
  assert.equal(welcomeCheck.ok, true)
  assert.equal(helloCheck.hello.nodeId, dialerNodeId)
  assert.equal(welcomeCheck.welcome.nodeId, listenerNodeId)
})

test('string secrets are used as UTF-8 bytes (config secrets)', () => {
  const text = 'a'.repeat(64) // 64-hex style config secret
  assert.deepEqual(secretBytes(text), Buffer.from(text, 'utf8'))
  assert.throws(() => secretBytes(''), /must not be empty/)
  assert.throws(() => secretBytes(42), /string or Buffer/)
  const { helloCheck, welcomeCheck } = simulateHandshake({
    dialerNodeId, listenerNodeId, secret: text,
  })
  assert.equal(helloCheck.ok, true)
  assert.equal(welcomeCheck.ok, true)
})

test('transcripts are canonical and order-sensitive', () => {
  const hello = {
    nodeId: 'node-a', instanceEpoch: 'epoch-a', connectionId: 'conn-1',
    protocol: 1, ts: 1000, nonce: 'nonce-a',
  }
  assert.equal(
    helloTranscript(hello, 'node-b'),
    [
      'dsh-remotenode/1/hello',
      'dialer=node-a',
      'dialerEpoch=epoch-a',
      'listener=node-b',
      'connectionId=conn-1',
      'protocol=1',
      'ts=1000',
      'nonce=nonce-a',
    ].join('\n'),
  )
  assert.equal(
    welcomeTranscript('HELLO', { nonce: 'nonce-b', ts: 2000 }),
    'HELLO\nwelcomeNonce=nonce-b\nwelcomeTs=2000',
  )
})

test('hello carries the protocol fields', () => {
  const now = 1_700_000_000_000
  const hello = createHello({ nodeId: dialerNodeId, listenerNodeId, secret, ts: now, nodeName: '大脑' })
  assert.equal(hello.method, 'peer.hello')
  assert.equal(hello.params.protocol, PROTOCOL_VERSION)
  assert.equal(hello.params.nodeId, dialerNodeId)
  assert.equal(hello.params.nodeName, '大脑')
  assert.equal(typeof hello.params.instanceEpoch, 'string')
  assert.equal(typeof hello.params.connectionId, 'string')
  assert.equal(hello.params.platform, 'linux')
  assert.deepEqual(hello.params.capabilities, DEFAULT_CAPS)
  assert.equal(typeof hello.params.nonce, 'string')
  assert.equal(typeof hello.params.proof, 'string')
  assert.equal(hello.params.ts, now)
})

test('welcome carries limits and echoes the hello id', () => {
  const now = 1_700_000_000_000
  const hello = createHello({ nodeId: dialerNodeId, listenerNodeId, secret, ts: now })
  const welcome = createWelcome({ hello, listenerNodeId, secret, ts: now })
  assert.equal(welcome.id, hello.id)
  assert.equal(welcome.result.protocol, PROTOCOL_VERSION)
  assert.equal(welcome.result.nodeId, listenerNodeId)
  assert.deepEqual(welcome.result.limits, DEFAULT_LIMITS)
  assert.equal(typeof welcome.result.proof, 'string')
})

test('tampered hello proof is rejected', () => {
  const now = 1_700_000_000_000
  const hello = createHello({
    nodeId: dialerNodeId, listenerNodeId, secret, ts: now,
    nonce: randomBytes(32).toString('base64url'),
  })
  hello.params.instanceEpoch = 'tampered-epoch'
  const check = verifyHello({ frame: hello, listenerNodeId, secret, now })
  assert.equal(check.ok, false)
  assert.equal(check.kind, 'auth/invalid-proof')
})

test('welcome signed for another listener is rejected', () => {
  const now = 1_700_000_000_000
  const hello = createHello({ nodeId: dialerNodeId, listenerNodeId, secret, ts: now })
  const welcome = createWelcome({ hello, listenerNodeId, secret, ts: now })
  welcome.result.nonce = 'tampered-nonce'
  const check = verifyWelcome({
    helloFrame: hello, welcomeFrame: welcome, listenerNodeId, secret, now,
  })
  assert.equal(check.ok, false)
  assert.equal(check.kind, 'auth/invalid-proof')
})

test('welcomes for a different listener node id are rejected', () => {
  const now = 1_700_000_000_000
  const hello = createHello({ nodeId: dialerNodeId, listenerNodeId, secret, ts: now })
  const welcome = createWelcome({ hello, listenerNodeId, secret, ts: now })
  const check = verifyWelcome({
    helloFrame: hello, welcomeFrame: welcome, listenerNodeId: 'someone-else', secret, now,
  })
  assert.equal(check.ok, false)
  assert.equal(check.kind, 'auth/unknown-peer')
})

test('clock skew and unknown peer are rejected', () => {
  const now = 1_700_000_000_000
  const hello = createHello({ nodeId: dialerNodeId, listenerNodeId, secret, ts: now })
  assert.equal(
    verifyHello({ frame: hello, listenerNodeId, secret, now: now + 10 * 60 * 1000 }).kind,
    'auth/clock-skew',
  )
  const unknown = createHello({ nodeId: 'evil-node', listenerNodeId, secret, ts: now })
  assert.equal(
    verifyHello({ frame: unknown, listenerNodeId, secret, now, expectedPeerNodeId: dialerNodeId }).kind,
    'auth/unknown-peer',
  )
})

test('nonce replay is rejected with a shared cache', () => {
  const now = 1_700_000_000_000
  const nonce = randomBytes(32).toString('base64url')
  const hello = createHello({ nodeId: dialerNodeId, listenerNodeId, secret, ts: now, nonce })
  const cache = new NonceCache()
  assert.equal(verifyHello({ frame: hello, listenerNodeId, secret, now, nonceCache: cache }).ok, true)
  assert.equal(
    verifyHello({ frame: hello, listenerNodeId, secret, now, nonceCache: cache }).kind,
    'auth/replay',
  )
})

test('protocol version mismatch and malformed auth mode are rejected', () => {
  const now = 1_700_000_000_000
  const hello = createHello({ nodeId: dialerNodeId, listenerNodeId, secret, ts: now })
  hello.params.protocol = 2
  assert.equal(verifyHello({ frame: hello, listenerNodeId, secret, now }).kind, 'protocol/unsupported')

  const mode = createHello({ nodeId: dialerNodeId, listenerNodeId, secret, ts: now })
  mode.params.authMode = 'magic'
  assert.equal(verifyHello({ frame: mode, listenerNodeId, secret, now }).kind, 'auth/mode-mismatch')
})

test('wrong secret cannot verify', () => {
  const now = 1_700_000_000_000
  const hello = createHello({ nodeId: dialerNodeId, listenerNodeId, secret, ts: now })
  const other = randomBytes(32)
  assert.equal(verifyHello({ frame: hello, listenerNodeId, secret: other, now }).kind, 'auth/invalid-proof')
  assert.equal(toBase64Url(Buffer.alloc(3)) !== '', true)
})
