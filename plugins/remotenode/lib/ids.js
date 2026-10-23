/**
 * IDs, hashing, names and logical paths.
 * Mirrors 07-remotenode-m0-protocol.md §2.1 / §8.2.
 *
 * Pure ESM, zero dependencies: only node: builtins.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

const NODE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const ARTIFACT_ID_RE = /^sha256:[0-9a-f]{64}$/
const HEX_RE = /^[0-9a-fA-F]*$/
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const CONTROL_RE = /[\u0000-\u001f\u007f]/

/**
 * Mint an id (UUID v4), optionally namespaced by `prefix`.
 * `newId()` keeps the prototype behavior (bare UUID); `newId('session')`
 * returns `<prefix>-<uuid>`.
 * @param {string} [prefix]
 * @returns {string}
 */
export function newId(prefix) {
  const id = randomUUID()
  if (prefix === undefined) return id
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError('prefix must be a non-empty string')
  }
  return `${prefix}-${id}`
}

/** @param {unknown} value */
export function isNodeId(value) {
  return typeof value === 'string' && NODE_ID_RE.test(value)
}

/**
 * Assert a DSL node id.
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string}
 */
export function assertNodeId(value, label = 'nodeId') {
  if (!isNodeId(value)) {
    throw new TypeError(`${label} must match ${NODE_ID_RE}`)
  }
  return value
}

/** @param {unknown} value */
export function isArtifactId(value) {
  return typeof value === 'string' && ARTIFACT_ID_RE.test(value)
}

/**
 * Assert a CAS artifact id (`sha256:<64 lowercase hex>`).
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string}
 */
export function assertArtifactId(value, label = 'artifactId') {
  if (!isArtifactId(value)) {
    throw new TypeError(`${label} must match ${ARTIFACT_ID_RE}`)
  }
  return value
}

/** @param {string | Buffer | Uint8Array} bytes */
function asBuffer(bytes) {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
}

/** @param {string | Buffer | Uint8Array} bytes */
export function sha256Hex(bytes) {
  return createHash('sha256').update(asBuffer(bytes)).digest('hex')
}

/** @param {string | Buffer | Uint8Array} bytes */
export function sha256Base64Url(bytes) {
  return createHash('sha256').update(asBuffer(bytes)).digest('base64url')
}

/** @param {string | Buffer | Uint8Array} bytes */
export function artifactIdForBytes(bytes) {
  return `sha256:${sha256Hex(bytes)}`
}

/** @param {string} text */
export function artifactIdForString(text) {
  return artifactIdForBytes(Buffer.from(text, 'utf8'))
}

/**
 * N random bytes as lowercase hex.
 * @param {number} [nBytes]
 * @returns {string}
 */
export function randomHex(nBytes = 32) {
  if (!Number.isInteger(nBytes) || nBytes < 1 || nBytes > 64 * 1024) {
    throw new TypeError('nBytes must be an integer in [1, 65536]')
  }
  return randomBytes(nBytes).toString('hex')
}

/**
 * Constant-time comparison of two hex strings (false for malformed input).
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length || a.length % 2 !== 0 || !HEX_RE.test(a)) return false
  const left = Buffer.from(a, 'hex')
  const right = Buffer.from(b, 'hex')
  if (left.byteLength !== right.byteLength) return false
  return timingSafeEqual(left, right)
}

/**
 * Strip a filesystem path to a safe display/landing file name.
 * Mirrors 07 §8.2/§7.5.9 (no traversal, no control chars, Windows reserved names).
 * @param {string} name
 * @returns {string}
 */
export function sanitizeName(name) {
  const base = String(name).split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .replace(CONTROL_RE, '_')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .replace(/^\.+/, '')
  if (cleaned.length === 0) return 'file'
  const safe = WINDOWS_RESERVED.test(cleaned) ? `_${cleaned}` : cleaned
  // Keep extensions intact when truncating.
  if (safe.length <= 180) return safe
  const dot = safe.lastIndexOf('.')
  if (dot <= 0) return safe.slice(0, 180)
  const ext = safe.slice(dot, Math.min(dot + 16, safe.length))
  return safe.slice(0, 180 - ext.length) + ext
}

/** Encode one path segment without allowing separators. */
function segment(value) {
  return encodeURIComponent(String(value)).replace(/%2F/gi, '_').replace(/%5C/gi, '_')
}

/**
 * Namespaced logical path: `<originNodeId>/<originSessionId>/<name>`.
 * Mirrors 07 §8.2. Safe to persist as a relative path after `isSafeLogicalPath`.
 * @param {string} originNodeId
 * @param {string} originSessionId
 * @param {string} name
 * @returns {string}
 */
export function logicalPath(originNodeId, originSessionId, name) {
  assertNodeId(originNodeId, 'originNodeId')
  if (typeof originSessionId !== 'string' || originSessionId.length === 0) {
    throw new TypeError('originSessionId must be a non-empty string')
  }
  if (typeof name !== 'string') throw new TypeError('name must be a string')
  return `${segment(originNodeId)}/${segment(originSessionId)}/${segment(sanitizeName(name))}`
}

/**
 * Whether a logical path is safe to land on disk (no traversal/control chars).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeLogicalPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return false
  if (CONTROL_RE.test(value) || value.includes('\\') || value.startsWith('/')) return false
  const parts = value.split('/')
  if (parts.length < 3) return false
  return parts.every(part => part.length > 0 && part !== '.' && part !== '..')
}

/** @param {number} ms */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
