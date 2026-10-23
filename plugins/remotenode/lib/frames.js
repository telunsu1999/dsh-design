/**
 * JSON-RPC frames, method registry and artifact binary frames.
 * Mirrors 07-remotenode-m0-protocol.md §2.2–§2.3.
 *
 * Pure ESM, zero dependencies: only node: builtins.
 */

import { ProtocolError, isRpcError } from './errors.js'

/** Max byte length of one UTF-8 JSON frame. */
export const MAX_JSON_FRAME_BYTES = 1024 * 1024
/** Max number of events per `event.session` notification. */
export const MAX_EVENT_BATCH = 200
/** Max payload byte length of one binary frame (artifact chunk). */
export const MAX_CHUNK_BYTES = 1024 * 1024
/** Max byte length of one decoded carrier frame: chunk payload + header slack. */
export const MAX_FRAME_BYTES = MAX_CHUNK_BYTES + 64 * 1024
/** Max byte length of a binary frame's JSON header. */
export const MAX_BINARY_HEADER_BYTES = 16 * 1024

/** Prototype-compatible aliases. */
export const CHUNK_BYTES = MAX_CHUNK_BYTES
export const WINDOW_BYTES = 8 * 1024 * 1024

/**
 * Protocol v1 method registry. Direction is documented, not enforced by the
 * frame layer.
 */
export const METHODS = Object.freeze({
  'peer.hello': { layer: 'peer', kind: 'request', direction: 'dialer->listener' },
  'peer.welcome': { layer: 'peer', kind: 'response', direction: 'listener->dialer' },
  'peer.ping': { layer: 'peer', kind: 'request', direction: 'both' },
  'peer.heartbeat': { layer: 'peer', kind: 'notification', direction: 'both' },
  'peer.status': { layer: 'peer', kind: 'notification', direction: 'both' },
  'peer.catalog': { layer: 'peer', kind: 'request', direction: 'both' },
  'peer.sessions': { layer: 'peer', kind: 'request', direction: 'both' },
  'peer.configure': { layer: 'peer', kind: 'request', direction: 'both' },
  'peer.goodbye': { layer: 'peer', kind: 'notification', direction: 'both' },

  'session.create': { layer: 'session', kind: 'request', direction: 'initiator->host' },
  'session.prompt': { layer: 'session', kind: 'request', direction: 'initiator->host' },
  'session.cancel': { layer: 'session', kind: 'request', direction: 'initiator->host' },
  'session.queue.update': { layer: 'session', kind: 'request', direction: 'initiator->host' },
  'session.rename': { layer: 'session', kind: 'request', direction: 'initiator->host' },
  'session.setModel': { layer: 'session', kind: 'request', direction: 'initiator->host' },
  'session.attach': { layer: 'session', kind: 'request', direction: 'initiator->host' },
  'session.page': { layer: 'session', kind: 'request', direction: 'initiator->host' },
  'session.detach': { layer: 'session', kind: 'request', direction: 'initiator->host' },
  'session.close': { layer: 'session', kind: 'request', direction: 'initiator->host' },
  'session.state': { layer: 'session', kind: 'notification', direction: 'host->initiator' },
  'session.ack': { layer: 'session', kind: 'notification', direction: 'host->initiator' },

  'event.session': { layer: 'event', kind: 'notification', direction: 'host->initiator' },
  'event.assistant': { layer: 'event', kind: 'notification', direction: 'host->initiator' },

  'interaction.request': { layer: 'interaction', kind: 'request', direction: 'host->answerer' },
  'interaction.resolve': { layer: 'interaction', kind: 'request', direction: 'answerer->host' },
  'interaction.resolved': { layer: 'interaction', kind: 'notification', direction: 'both' },
  'interaction.cancel': { layer: 'interaction', kind: 'notification', direction: 'both' },

  'deliverable.op': { layer: 'deliverable', kind: 'notification', direction: 'origin->peer' },
  'deliverable.sync': { layer: 'deliverable', kind: 'request', direction: 'both' },
  'deliverable.syncResult': { layer: 'deliverable', kind: 'response', direction: 'both' },
  'deliverable.ack': { layer: 'deliverable', kind: 'notification', direction: 'both' },
  'deliverable.list': { layer: 'deliverable', kind: 'request', direction: 'both' },

  'artifact.fetch': { layer: 'artifact', kind: 'request', direction: 'requester->holder' },
  'artifact.end': { layer: 'artifact', kind: 'notification', direction: 'holder->requester' },
  'artifact.window': { layer: 'artifact', kind: 'notification', direction: 'requester->holder' },
  'artifact.cancel': { layer: 'artifact', kind: 'notification', direction: 'both' },
  'artifact.stale': { layer: 'artifact', kind: 'notification', direction: 'holder->requester' },
  'artifact.chunk': { layer: 'artifact', kind: 'binary', direction: 'holder->requester' },
})

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {Buffer | Uint8Array | ArrayBuffer} value @returns {Buffer} */
function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  throw new TypeError('expected Buffer / Uint8Array / ArrayBuffer')
}

/** @param {unknown} frame */
function frameText(frame) {
  let text
  try {
    text = JSON.stringify(frame)
  } catch (error) {
    throw new ProtocolError('frame/invalid-json', 'frame is not JSON serializable', {
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  if (typeof text !== 'string') {
    throw new ProtocolError('frame/invalid-json', 'frame is not JSON serializable')
  }
  return text
}

/** @param {unknown} frame */
function frameByteLength(frame) {
  return Buffer.byteLength(frameText(frame), 'utf8')
}

/**
 * Validate one incoming JSON-RPC frame. Unknown methods are structurally valid
 * (forward compatibility); dispatch rejects them.
 * @param {unknown} value
 * @returns {{ok:true, kind:'request'|'notification'|'response', method?:string, id?:string}
 *   | {ok:false, reason:string, method?:string, id?:string}}
 */
export function validateJsonRpcFrame(value) {
  if (!isPlainObject(value)) return { ok: false, reason: 'frame-not-object' }
  const frame = /** @type {Record<string, unknown>} */ (value)
  if (frame.jsonrpc !== '2.0') return { ok: false, reason: 'jsonrpc-version' }
  const hasMethod = Object.prototype.hasOwnProperty.call(frame, 'method')
  const hasId = Object.prototype.hasOwnProperty.call(frame, 'id')
  const hasResult = Object.prototype.hasOwnProperty.call(frame, 'result')
  const hasError = Object.prototype.hasOwnProperty.call(frame, 'error')

  if (hasMethod) {
    if (hasResult || hasError) return { ok: false, reason: 'request-with-result' }
    if (typeof frame.method !== 'string' || frame.method.length === 0) {
      return { ok: false, reason: 'method-invalid' }
    }
    if ('params' in frame && frame.params !== undefined) {
      const params = frame.params
      if (typeof params !== 'object' || params === null) return { ok: false, reason: 'params-invalid' }
    }
    if (hasId && (typeof frame.id !== 'string' || frame.id.length === 0)) {
      return { ok: false, reason: 'id-invalid' }
    }
    let size
    try {
      size = frameByteLength(frame)
    } catch {
      return { ok: false, reason: 'not-json' }
    }
    if (size > MAX_JSON_FRAME_BYTES) return { ok: false, reason: 'frame-too-large' }
    return hasId
      ? { ok: true, kind: 'request', method: frame.method, id: /** @type {string} */ (frame.id) }
      : { ok: true, kind: 'notification', method: frame.method }
  }

  if (!hasId || typeof frame.id !== 'string' || frame.id.length === 0) {
    return { ok: false, reason: 'response-id-invalid' }
  }
  if (hasResult === hasError) return { ok: false, reason: 'response-shape' }
  if (hasError && !isRpcError(frame.error)) return { ok: false, reason: 'response-error-invalid' }
  let size
  try {
    size = frameByteLength(frame)
  } catch {
    return { ok: false, reason: 'not-json' }
  }
  if (size > MAX_JSON_FRAME_BYTES) return { ok: false, reason: 'frame-too-large' }
  return { ok: true, kind: 'response', id: /** @type {string} */ (frame.id) }
}

/** Prototype-compatible alias. */
export const validateFrame = validateJsonRpcFrame

/** @param {string} id @param {string} method @param {unknown} [params] */
export function request(id, method, params) {
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('request id must be a non-empty string')
  if (typeof method !== 'string' || method.length === 0) throw new TypeError('method must be a non-empty string')
  return params === undefined
    ? { jsonrpc: '2.0', id, method }
    : { jsonrpc: '2.0', id, method, params }
}

/** @param {string} id @param {unknown} result */
export function response(id, result) {
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('response id must be a non-empty string')
  return { jsonrpc: '2.0', id, result }
}

/** @param {string} id @param {{code:number, message:string, data?:unknown}} error */
export function errorResponse(id, error) {
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('response id must be a non-empty string')
  if (!isRpcError(error)) throw new TypeError('error must be a JSON-RPC error object')
  return { jsonrpc: '2.0', id, error }
}

/** @param {string} method @param {unknown} [params] */
export function notification(method, params) {
  if (typeof method !== 'string' || method.length === 0) throw new TypeError('method must be a non-empty string')
  return params === undefined
    ? { jsonrpc: '2.0', method }
    : { jsonrpc: '2.0', method, params }
}

/**
 * Encode one JSON-RPC frame as a UTF-8 Buffer.
 * Throws ProtocolError('limit/frame-too-large') above MAX_JSON_FRAME_BYTES and
 * ProtocolError('frame/invalid-json') when the frame is not serializable.
 * @param {unknown} frame
 * @returns {Buffer}
 */
export function encodeJsonFrame(frame) {
  if (!isPlainObject(frame)) throw new TypeError('frame must be a plain object')
  const buffer = Buffer.from(frameText(frame), 'utf8')
  if (buffer.byteLength > MAX_JSON_FRAME_BYTES) {
    throw new ProtocolError('limit/frame-too-large', 'json frame exceeds MAX_JSON_FRAME_BYTES', {
      bytes: buffer.byteLength,
      limit: MAX_JSON_FRAME_BYTES,
    })
  }
  return buffer
}

/**
 * Decode one JSON-RPC frame payload.
 * Throws ProtocolError('limit/frame-too-large') above MAX_JSON_FRAME_BYTES and
 * ProtocolError('frame/invalid-json') for malformed JSON / non-object payloads.
 * @param {Buffer | Uint8Array | ArrayBuffer} buffer
 * @returns {Record<string, unknown>}
 */
export function decodeJsonFrame(buffer) {
  const buf = asBuffer(buffer)
  if (buf.byteLength > MAX_JSON_FRAME_BYTES) {
    throw new ProtocolError('limit/frame-too-large', 'json frame exceeds MAX_JSON_FRAME_BYTES', {
      bytes: buf.byteLength,
      limit: MAX_JSON_FRAME_BYTES,
    })
  }
  let value
  try {
    value = JSON.parse(buf.toString('utf8'))
  } catch (error) {
    throw new ProtocolError('frame/invalid-json', 'malformed JSON frame', {
      reason: error instanceof Error ? error.message : String(error),
    })
  }
  if (!isPlainObject(value)) {
    throw new ProtocolError('frame/invalid-json', 'json frame is not an object')
  }
  return value
}

/**
 * Encode one binary frame: `[4B BE header length][UTF-8 JSON header][payload]`.
 * Payload is bounded by MAX_CHUNK_BYTES; header by MAX_BINARY_HEADER_BYTES.
 * @param {Record<string, unknown>} header
 * @param {Buffer | Uint8Array | ArrayBuffer} payload
 * @returns {Buffer}
 */
export function encodeBinaryFrame(header, payload) {
  if (!isPlainObject(header)) throw new TypeError('binary header must be a plain object')
  const body = asBuffer(payload)
  if (body.byteLength > MAX_CHUNK_BYTES) {
    throw new ProtocolError('limit/frame-too-large', 'binary payload exceeds MAX_CHUNK_BYTES', {
      bytes: body.byteLength,
      limit: MAX_CHUNK_BYTES,
    })
  }
  const headerText = JSON.stringify(header)
  const headerBytes = Buffer.from(headerText, 'utf8')
  if (headerBytes.byteLength > MAX_BINARY_HEADER_BYTES) {
    throw new ProtocolError('limit/frame-too-large', 'binary header exceeds MAX_BINARY_HEADER_BYTES', {
      bytes: headerBytes.byteLength,
      limit: MAX_BINARY_HEADER_BYTES,
    })
  }
  const out = Buffer.allocUnsafe(4 + headerBytes.byteLength + body.byteLength)
  out.writeUInt32BE(headerBytes.byteLength, 0)
  headerBytes.copy(out, 4)
  body.copy(out, 4 + headerBytes.byteLength)
  return out
}

/**
 * Decode one binary frame. Returns null for any malformed input (carrier safety:
 * the transport decides whether a bad frame is fatal).
 * @param {Buffer | Uint8Array | ArrayBuffer} buffer
 * @returns {{header:Record<string, unknown>, payload:Buffer} | null}
 */
export function decodeBinaryFrame(buffer) {
  let buf
  try {
    buf = asBuffer(buffer)
  } catch {
    return null
  }
  if (buf.byteLength < 4 || buf.byteLength > MAX_FRAME_BYTES) return null
  const headerLength = buf.readUInt32BE(0)
  if (headerLength > MAX_BINARY_HEADER_BYTES) return null
  if (4 + headerLength > buf.byteLength) return null
  let header
  try {
    header = JSON.parse(buf.subarray(4, 4 + headerLength).toString('utf8'))
  } catch {
    return null
  }
  if (!isPlainObject(header)) return null
  const payload = buf.subarray(4 + headerLength)
  if (payload.byteLength > MAX_CHUNK_BYTES) return null
  if (header.length !== undefined && header.length !== payload.byteLength) return null
  return { header, payload }
}

/**
 * Whether a carrier payload is a binary frame (first byte is not `{`, i.e. not
 * a JSON frame). Binary headers start with a 4-byte BE length whose top byte is
 * always 0, so `0x7b` can never begin one.
 * @param {Buffer | Uint8Array} buffer
 * @returns {boolean}
 */
export function isBinaryFramePayload(buffer) {
  if (buffer instanceof Uint8Array) return buffer.length > 0 && buffer[0] !== 0x7b
  return false
}

/**
 * Prototype-compatible strict artifact chunk encoder.
 * @param {{artifactId:string, offset:number, length:number, sha256Chunk?:string}} header
 * @param {Buffer | Uint8Array} payload
 * @returns {Buffer}
 */
export function encodeArtifactChunk(header, payload) {
  if (!isPlainObject(header)) throw new TypeError('chunk header must be an object')
  if (!Number.isInteger(header.offset) || header.offset < 0) throw new TypeError('offset invalid')
  if (!Number.isInteger(header.length) || header.length < 0) throw new TypeError('length invalid')
  if (typeof header.artifactId !== 'string' || header.artifactId.length === 0) {
    throw new TypeError('artifactId invalid')
  }
  const body = asBuffer(payload)
  if (header.length !== body.byteLength) throw new TypeError('length payload mismatch')
  if (body.byteLength > MAX_CHUNK_BYTES) throw new TypeError('chunk too large')
  if (typeof header.sha256Chunk !== 'undefined' && typeof header.sha256Chunk !== 'string') {
    throw new TypeError('sha256Chunk invalid')
  }
  return encodeBinaryFrame(header, body)
}

/**
 * Prototype-compatible strict artifact chunk decoder (throws on malformed input).
 * @param {Buffer | Uint8Array} frame
 * @returns {{header:{artifactId:string,offset:number,length:number,sha256Chunk?:string}, payload:Buffer}}
 */
export function decodeArtifactChunk(frame) {
  const buf = asBuffer(frame)
  const decoded = decodeBinaryFrame(buf)
  if (decoded === null) {
    if (buf.byteLength < 4) throw new TypeError('chunk frame too short')
    const headerLength = buf.byteLength >= 4 ? buf.readUInt32BE(0) : 0
    if (headerLength > MAX_BINARY_HEADER_BYTES) throw new TypeError('chunk header too large')
    if (4 + headerLength > buf.byteLength) throw new TypeError('chunk header out of bounds')
    throw new TypeError('chunk frame invalid')
  }
  const { header, payload } = decoded
  if (typeof header.artifactId !== 'string') throw new TypeError('chunk artifactId invalid')
  if (!Number.isInteger(header.offset) || header.offset < 0) throw new TypeError('chunk offset invalid')
  if (!Number.isInteger(header.length) || header.length < 0) throw new TypeError('chunk length invalid')
  if (header.length !== payload.byteLength) throw new TypeError('chunk length mismatch')
  return {
    header: /** @type {{artifactId:string,offset:number,length:number,sha256Chunk?:string}} */ (header),
    payload,
  }
}
