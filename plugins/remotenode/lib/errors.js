/**
 * Protocol v1 error registry and helpers.
 * Mirrors 07-remotenode-m0-protocol.md Appendix A.
 *
 * Pure ESM, zero dependencies: only node: builtins (none needed here).
 */

/** @typedef {{code: number, retryable: boolean}} ErrorInfo */

/**
 * Kind -> { code, retryable }. Codes follow the protocol table (append-only:
 * never renumber an existing kind, add new ones at the end of their block).
 * @type {Readonly<Record<string, ErrorInfo>>}
 */
export const ERRORS = Object.freeze({
  'auth/invalid-proof': { code: 4001, retryable: false },
  'auth/unknown-peer': { code: 4002, retryable: false },
  'auth/clock-skew': { code: 4003, retryable: true },
  'auth/replay': { code: 4004, retryable: false },
  'auth/mode-mismatch': { code: 4005, retryable: false },
  'protocol/unsupported': { code: 4010, retryable: false },
  'method/not-found': { code: 4011, retryable: false },
  'peer/duplicate': { code: 4012, retryable: false },
  'peer/offline': { code: 4013, retryable: true },
  'link/closed': { code: 4014, retryable: false },
  'session/unknown': { code: 4020, retryable: false },
  'session/not-authorized': { code: 4021, retryable: false },
  'session/busy': { code: 4022, retryable: true },
  'session/not-resumable': { code: 4023, retryable: false },
  'session/depth-exceeded': { code: 4024, retryable: false },
  'interaction/expired': { code: 4030, retryable: false },
  'interaction/already-resolved': { code: 4031, retryable: false },
  'interaction/denied': { code: 4032, retryable: false },
  'deliverable/unknown': { code: 4040, retryable: false },
  'deliverable/revision-gap': { code: 4041, retryable: true },
  'deliverable/unauthorized': { code: 4042, retryable: false },
  'deliverable/op-invalid': { code: 4043, retryable: false },
  'artifact/not-found': { code: 4050, retryable: false },
  'artifact/unauthorized': { code: 4051, retryable: false },
  'artifact/bad-offset': { code: 4052, retryable: true },
  'artifact/stale': { code: 4053, retryable: true },
  'artifact/too-large': { code: 4054, retryable: false },
  'artifact/hash-mismatch': { code: 4055, retryable: true },
  'artifact/quota-exceeded': { code: 4056, retryable: false },
  'limit/frame-too-large': { code: 4060, retryable: false },
  'limit/rate': { code: 4061, retryable: true },
  'frame/invalid-json': { code: 4062, retryable: false },
  'peer/internal': { code: 4090, retryable: true },
})

/** @type {Readonly<Record<string, string>>} numeric code -> kind */
const KIND_BY_CODE = Object.freeze(
  Object.fromEntries(Object.entries(ERRORS).map(([kind, info]) => [String(info.code), kind])),
)

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Protocol error carrying a stable machine `kind`, numeric `.code`,
 * `.retryable` flag and optional `.details`.
 *
 * Unknown kinds are rejected: a typo must fail fast instead of silently
 * inventing an error code. Use {@link protocolErrorFromRpc} / {@link asProtocolError}
 * when normalizing arbitrary / remote failures.
 */
export class ProtocolError extends Error {
  /**
   * @param {string} kind
   * @param {string} [message]
   * @param {Record<string, unknown>} [details]
   */
  constructor(kind, message, details) {
    const info = ERRORS[kind]
    if (!info) throw new TypeError(`unknown protocol error kind: ${kind}`)
    super(message ?? kind)
    this.name = 'ProtocolError'
    this.kind = kind
    this.code = info.code
    this.retryable = info.retryable
    this.details = details
  }
}

/** @param {unknown} value */
export function isRpcError(value) {
  if (!isRecord(value)) return false
  return typeof value.code === 'number'
    && typeof value.message === 'string'
    && (value.data === undefined || isRecord(value.data))
}

/** @param {unknown} code */
export function kindFromCode(code) {
  if (typeof code !== 'number' || !Number.isFinite(code)) return undefined
  return KIND_BY_CODE[String(code)]
}

/**
 * Normalize anything thrown into a ProtocolError (keeps the original as `.cause`).
 * Strings are treated as protocol kinds when known, otherwise as messages.
 * @param {unknown} error
 * @returns {ProtocolError}
 */
export function asProtocolError(error) {
  if (error instanceof ProtocolError) return error
  if (typeof error === 'string') {
    return ERRORS[error]
      ? new ProtocolError(error)
      : new ProtocolError('peer/internal', error)
  }
  if (isRpcError(error)) return protocolErrorFromRpc(error)
  const message = error instanceof Error ? error.message : String(error ?? 'internal error')
  const normalized = new ProtocolError('peer/internal', message)
  if (error instanceof Error) normalized.cause = error
  return normalized
}

/**
 * Rebuild a ProtocolError from a received JSON-RPC error object.
 * Unknown kinds/codes fall back to `peer/internal` while keeping the message.
 * @param {unknown} rpcError
 * @returns {ProtocolError}
 */
export function protocolErrorFromRpc(rpcError) {
  if (!isRpcError(rpcError)) {
    return new ProtocolError('peer/internal', 'malformed rpc error')
  }
  const data = isRecord(rpcError.data) ? rpcError.data : {}
  const maybeKind = typeof data.kind === 'string' && ERRORS[data.kind] ? data.kind : undefined
  const kind = maybeKind ?? kindFromCode(rpcError.code) ?? 'peer/internal'
  const details = isRecord(data.details) ? data.details : undefined
  const error = new ProtocolError(kind, typeof rpcError.message === 'string' && rpcError.message !== ''
    ? rpcError.message
    : kind, details)
  return error
}

/**
 * Numeric protocol code of an error, or `0` when it is not a protocol/RPC error.
 * @param {unknown} error
 * @returns {number}
 */
export function errorCodeOf(error) {
  if (error instanceof ProtocolError) return error.code
  if (isRecord(error) && typeof error.code === 'number') return error.code
  return 0
}

/**
 * Build a JSON-RPC error payload.
 *
 * Accepts either a protocol kind string (prototype form:
 * `rpcErrorFor('peer/offline', 'message', details)`) or any thrown value
 * (`rpcErrorFor(error)`; unknown errors become `peer/internal`).
 *
 * @param {string | Error | Record<string, unknown>} error
 * @param {string} [message]
 * @param {Record<string, unknown>} [details]
 * @returns {{code:number, message:string, data:{kind:string, retryable:boolean, details?:Record<string, unknown>}}}
 */
export function rpcErrorFor(error, message, details) {
  let protocol
  if (typeof error === 'string') {
    protocol = new ProtocolError(error, message, details)
    return buildRpcError(protocol, undefined, undefined)
  }
  if (error instanceof ProtocolError) return buildRpcError(error, message, details)
  if (isRpcError(error)) {
    const normalized = protocolErrorFromRpc(error)
    // Preserve the wire code when the remote used a code we do not know.
    const remoteCode = typeof error.code === 'number' ? error.code : normalized.code
    return buildRpcError(normalized, message, details, remoteCode)
  }
  protocol = asProtocolError(error)
  return buildRpcError(protocol, message, details)
}

/**
 * @param {ProtocolError} protocol
 * @param {string} [message]
 * @param {Record<string, unknown>} [details]
 * @param {number} [codeOverride]
 */
function buildRpcError(protocol, message, details, codeOverride) {
  const resolvedDetails = details !== undefined ? details : protocol.details
  /** @type {{kind:string, retryable:boolean, details?:Record<string, unknown>}} */
  const data = { kind: protocol.kind, retryable: protocol.retryable }
  if (resolvedDetails !== undefined) data.details = resolvedDetails
  return {
    code: codeOverride ?? protocol.code,
    message: message ?? protocol.message,
    data,
  }
}
