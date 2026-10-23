import test from 'node:test'
import assert from 'node:assert/strict'

import { canonicalDialer, decideConnection, isCanonicalOutbound } from '../lib/dedupe.js'

test('canonical dialer is the smaller nodeId', () => {
  assert.equal(canonicalDialer('brain-linux', 'desktop-01'), 'brain-linux')
  assert.equal(canonicalDialer('desktop-01', 'brain-linux'), 'brain-linux')
  assert.equal(isCanonicalOutbound('brain-linux', 'desktop-01'), true)
  assert.equal(isCanonicalOutbound('desktop-01', 'brain-linux'), false)
  assert.throws(() => canonicalDialer('same', 'same'), /differ/)
  assert.throws(() => canonicalDialer('BAD', 'desktop-01'), /nodeA/)
})

test('first connection is always accepted', () => {
  const decision = decideConnection({
    selfNodeId: 'brain-linux',
    existing: null,
    candidate: { connectionId: 'c1', direction: 'outbound', peerNodeId: 'desktop-01' },
  })
  assert.deepEqual(decision, { action: 'accept', reason: 'no-existing-connection' })
})

test('the connection dialed by the smaller node wins on both sides', () => {
  // brain-linux (smaller) dials desktop-01: brain keeps outbound, desktop replaces inbound.
  assert.equal(decideConnection({
    selfNodeId: 'brain-linux',
    existing: { connectionId: 'old', direction: 'inbound', peerNodeId: 'desktop-01' },
    candidate: { connectionId: 'new', direction: 'outbound', peerNodeId: 'desktop-01' },
  }).action, 'replace')

  assert.equal(decideConnection({
    selfNodeId: 'desktop-01',
    existing: { connectionId: 'old', direction: 'outbound', peerNodeId: 'brain-linux' },
    candidate: { connectionId: 'new', direction: 'inbound', peerNodeId: 'brain-linux' },
  }).action, 'replace')
})

test('non-canonical duplicate connections are rejected on both sides', () => {
  // desktop-01 dials brain-linux while the canonical outbound from brain exists.
  const inbound = decideConnection({
    selfNodeId: 'desktop-01',
    existing: { connectionId: 'canonical', direction: 'inbound', peerNodeId: 'brain-linux' },
    candidate: { connectionId: 'non-canonical', direction: 'outbound', peerNodeId: 'brain-linux' },
  })
  assert.equal(inbound.action, 'reject')
  assert.equal(inbound.reason, 'duplicate-non-canonical')

  const accepted = decideConnection({
    selfNodeId: 'brain-linux',
    existing: { connectionId: 'canonical', direction: 'outbound', peerNodeId: 'desktop-01' },
    candidate: { connectionId: 'non-canonical', direction: 'inbound', peerNodeId: 'desktop-01' },
  })
  assert.equal(accepted.action, 'reject')

  // the non-canonical side's own outbound is rejected too
  const nonCanonicalOutbound = decideConnection({
    selfNodeId: 'desktop-01',
    existing: { connectionId: 'old', direction: 'inbound', peerNodeId: 'brain-linux' },
    candidate: { connectionId: 'new', direction: 'outbound', peerNodeId: 'brain-linux' },
  })
  assert.equal(nonCanonicalOutbound.action, 'reject')
})

test('same connection id reconnect replaces instead of duplicating', () => {
  const decision = decideConnection({
    selfNodeId: 'brain-linux',
    existing: { connectionId: 'c1', direction: 'outbound', peerNodeId: 'desktop-01' },
    candidate: { connectionId: 'c1', direction: 'outbound', peerNodeId: 'desktop-01' },
  })
  assert.equal(decision.action, 'replace')
  assert.equal(decision.closeConnectionId, 'c1')
  assert.equal(decision.reason, 'same-connection-id-reconnect')
})

test('invalid decisions throw', () => {
  assert.throws(() => decideConnection({
    selfNodeId: 'brain-linux',
    existing: null,
    candidate: { connectionId: 'c1', direction: 'sideways', peerNodeId: 'desktop-01' },
  }), /direction/)
  assert.throws(() => decideConnection({
    selfNodeId: 'brain-linux',
    existing: null,
    candidate: { connectionId: 'c1', direction: 'outbound', peerNodeId: 'brain-linux' },
  }), /self connection/)
  assert.throws(() => decideConnection({
    selfNodeId: 'brain-linux',
    existing: null,
    candidate: { connectionId: '', direction: 'outbound', peerNodeId: 'desktop-01' },
  }), /connectionId/)
})
