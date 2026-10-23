/**
 * Connection dedupe: the connection dialed by the smaller nodeId wins.
 * Mirrors 07-remotenode-m0-protocol.md §3.5.
 *
 * Pure ESM, zero dependencies: only node: builtins.
 */

import { assertNodeId } from './ids.js'

/** @param {string} nodeA @param {string} nodeB */
export function canonicalDialer(nodeA, nodeB) {
  assertNodeId(nodeA, 'nodeA')
  assertNodeId(nodeB, 'nodeB')
  if (nodeA === nodeB) throw new TypeError('nodeA and nodeB must differ')
  return nodeA < nodeB ? nodeA : nodeB
}

/** @param {string} selfNodeId @param {string} peerNodeId */
export function isCanonicalOutbound(selfNodeId, peerNodeId) {
  return selfNodeId === canonicalDialer(selfNodeId, peerNodeId)
}

/**
 * Decide what to do with a newly established connection.
 * @param {object} options
 * @param {string} options.selfNodeId
 * @param {{connectionId:string, direction:'outbound'|'inbound', peerNodeId:string}|null} [options.existing]
 * @param {{connectionId:string, direction:'outbound'|'inbound', peerNodeId:string}} options.candidate
 * @returns {{action:'accept', reason:string}
 *   | {action:'replace', reason:string, closeConnectionId:string}
 *   | {action:'reject', reason:string}}
 */
export function decideConnection(options) {
  const { selfNodeId, existing = null, candidate } = options
  assertNodeId(selfNodeId, 'selfNodeId')
  assertNodeId(candidate.peerNodeId, 'candidate.peerNodeId')
  if (candidate.direction !== 'outbound' && candidate.direction !== 'inbound') {
    throw new TypeError('candidate.direction must be outbound|inbound')
  }
  if (candidate.peerNodeId === selfNodeId) throw new TypeError('self connection is not allowed')
  if (typeof candidate.connectionId !== 'string' || candidate.connectionId.length === 0) {
    throw new TypeError('candidate.connectionId must be a non-empty string')
  }

  if (existing === null) return { action: 'accept', reason: 'no-existing-connection' }
  if (existing.connectionId === candidate.connectionId) {
    return { action: 'replace', reason: 'same-connection-id-reconnect', closeConnectionId: existing.connectionId }
  }

  const canonical = canonicalDialer(selfNodeId, candidate.peerNodeId)
  const candidateIsCanonical = candidate.direction === 'outbound'
    ? selfNodeId === canonical
    : selfNodeId !== canonical

  return candidateIsCanonical
    ? { action: 'replace', reason: 'canonical-dialer', closeConnectionId: existing.connectionId }
    : { action: 'reject', reason: 'duplicate-non-canonical' }
}
