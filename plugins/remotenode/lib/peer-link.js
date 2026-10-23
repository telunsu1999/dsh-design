/**
 * peer-link.js — remotenode peer 传输层的一条 TCP 链路（SPEC §5.8）。
 *
 * 职责：
 *  1. 把 socket 字节流切成 `[4B BE 长度][payload]` 帧；payload 首字节 `{` 为
 *     JSON-RPC 帧，否则为二进制帧 `[4B BE headerLen][JSON header][bytes]`；
 *  2. 共享密钥握手（dialer: peer.hello request / listener: peer.hello →
 *     peer.welcome），握手成功 state='ready' 并回调 onUp，失败 close 并回调
 *     onDown(reason)；
 *  3. 双向 JSON-RPC：request/response/notification，每请求超时，未知方法回
 *     `method/not-found`，未知通知忽略；对端 error 转成本地 ProtocolError；
 *  4. 二进制帧回调 onBinary(link, header, payload)（给 artifact.chunk 用）；
 *  5. 心跳：定时发 `peer.heartbeat` 通知，`heartbeatTimeoutMs` 内无任何入帧
 *     → close('timeout')；收到 `peer.ping` 请求回 `{time}`；
 *  6. close 幂等：pending 全部 reject ProtocolError('link/closed')，onDown 只
 *     回调一次。
 *
 * 纯 ESM、零第三方依赖，只用 node: 内置模块。所有 socket/回调错误都被捕获，
 * 不允许把宿主进程拖进 uncaughtException。
 */

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'

import {
  ERRORS,
  ProtocolError,
  asProtocolError,
  protocolErrorFromRpc,
  rpcErrorFor,
} from './errors.js'
import {
  MAX_FRAME_BYTES,
  MAX_JSON_FRAME_BYTES,
  decodeBinaryFrame,
  decodeJsonFrame,
  encodeBinaryFrame,
  encodeJsonFrame,
  errorResponse,
  isBinaryFramePayload,
  notification,
  request,
  response,
  validateJsonRpcFrame,
} from './frames.js'
import {
  NonceCache,
  createHello,
  createWelcome,
  verifyHello,
  verifyWelcome,
} from './handshake.js'
import { isNodeId } from './ids.js'

/** 默认值（SPEC §4 的 config 默认值同源）。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000
const HARD_CLOSE_DELAY_MS = 1_000

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value */
function isSecret(value) {
  return typeof value === 'string' || value instanceof Uint8Array
}

/** @param {unknown} value @param {number} fallback */
function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

/** 空 logger 兜底：链路库自己永远不 console 刷屏。 */
function createLogger(logger) {
  const base = isRecord(logger) ? logger : {}
  const call = level => (...args) => {
    try {
      const fn = typeof base[level] === 'function' ? base[level] : base.log
      if (typeof fn === 'function') fn.apply(base, args)
    } catch {
      /* logger 自己坏了也不能影响链路 */
    }
  }
  return { debug: call('debug'), info: call('info'), warn: call('warn'), error: call('error') }
}

/**
 * 构造一个协议错误；未知 kind 退化为 peer/internal（不允许因为错误码表缺项
 * 在清理路径上抛 TypeError）。
 * @param {string} kind
 * @param {string} [message]
 * @param {Record<string, unknown>} [details]
 * @returns {ProtocolError}
 */
function protocolError(kind, message, details) {
  try {
    return new ProtocolError(kind, message, details)
  } catch {
    return new ProtocolError('peer/internal', message ?? kind, details)
  }
}

/**
 * 链路关闭时用于 reject pending 请求的错误。
 *
 * SPEC §5.8 要求 `ProtocolError('link/closed')`；错误码表若尚未收录该 kind，
 * 退化为 peer/offline 构造后覆写 `.kind`，保证调用方仍能按 'link/closed' 分支。
 * @param {string | null} reason
 * @returns {ProtocolError}
 */
function linkClosedError(reason) {
  const message = reason ? `peer link closed: ${reason}` : 'peer link closed'
  if (Object.prototype.hasOwnProperty.call(ERRORS, 'link/closed')) {
    return new ProtocolError('link/closed', message, { reason: reason ?? null })
  }
  const error = new ProtocolError('peer/offline', message, { reason: reason ?? null })
  try {
    error.kind = 'link/closed'
  } catch {
    /* 只读实现下保持 peer/offline */
  }
  return error
}

/** 本地请求超时（对端无响应）。 */
function requestTimeoutError(method, timeoutMs) {
  return new ProtocolError('peer/internal', `request ${method} timed out after ${timeoutMs}ms`, {
    method,
    timeoutMs,
    local: true,
    reason: 'request-timeout',
  })
}

/** hello.params -> remote 视图（listener 视角没有对端 limits）。 */
function remoteFromHello(hello) {
  return {
    nodeId: typeof hello.nodeId === 'string' ? hello.nodeId : null,
    nodeName: typeof hello.nodeName === 'string' ? hello.nodeName : '',
    platform: typeof hello.platform === 'string' ? hello.platform : 'unknown',
    capabilities: isRecord(hello.capabilities) ? hello.capabilities : {},
    limits: null,
    dshVersion: typeof hello.dshVersion === 'string' ? hello.dshVersion : undefined,
    instanceEpoch: typeof hello.instanceEpoch === 'string' ? hello.instanceEpoch : undefined,
  }
}

/** welcome.result -> remote 视图（dialer 视角带 limits）。 */
function remoteFromWelcome(welcome) {
  return {
    nodeId: typeof welcome.nodeId === 'string' ? welcome.nodeId : null,
    nodeName: typeof welcome.nodeName === 'string' ? welcome.nodeName : '',
    platform: typeof welcome.platform === 'string' ? welcome.platform : 'unknown',
    capabilities: isRecord(welcome.capabilities) ? welcome.capabilities : {},
    limits: isRecord(welcome.limits) ? welcome.limits : null,
    dshVersion: typeof welcome.dshVersion === 'string' ? welcome.dshVersion : undefined,
    instanceEpoch: typeof welcome.instanceEpoch === 'string' ? welcome.instanceEpoch : undefined,
  }
}

/**
 * PeerLink：一条 TCP 对等链路。
 *
 * 生命周期：`handshaking` → `ready` → `closed`。构造后立即开始握手
 * （dialer 发 hello / listener 等 hello），不提供重新打开能力。
 */
class PeerLink {
  // ---- 身份与配置 ----
  #socket
  #role
  #nodeId
  #linkId
  /** @type {((peerNodeId:string) => string) | null} */
  #linkIdFor = null
  #peerNodeId
  #secret
  #secretFor
  #peekPeerNodeId
  #nodeName
  #instanceEpoch
  #platform
  #dshVersion
  #capabilities
  #limits
  #logger
  #requestTimeoutMs
  #heartbeatIntervalMs
  #heartbeatTimeoutMs
  #handshakeTimeoutMs
  #nonceCache

  // ---- 状态 ----
  #state = 'handshaking'
  #remote = null
  #lastSeen = Date.now()
  #createdAt = Date.now()
  #closeReason = null
  #handshakeStarted = false
  #helloFrame = null
  #helloStartedAt = 0
  #rttMs = null
  #upFired = false
  #downFired = false

  // ---- 帧缓冲与定时器 ----
  #buffer = Buffer.alloc(0)
  #handshakeTimer = null
  #heartbeatTimer = null
  #hardCloseTimer = null

  // ---- RPC ----
  #pending = new Map()
  #requestCounter = 0
  #requestHandlers = []
  #notificationHandlers = []
  #binaryHandlers = []

  // ---- 回调 ----
  #onUp
  #onDown

  #stats = {
    createdAt: 0,
    readyAt: null,
    closedAt: null,
    closeReason: null,
    framesIn: 0,
    framesOut: 0,
    bytesIn: 0,
    bytesOut: 0,
    jsonFramesIn: 0,
    binaryFramesIn: 0,
    requestsIn: 0,
    requestsOut: 0,
    notificationsIn: 0,
    notificationsOut: 0,
    responsesIn: 0,
    responsesOut: 0,
    lastError: null,
  }

  /**
   * @param {object} options createPeerLink options（SPEC §5.8）
   */
  constructor(options) {
    if (!isRecord(options)) throw new TypeError('createPeerLink requires an options object')
    const { socket } = options
    if (!isRecordLikeSocket(socket)) throw new TypeError('createPeerLink requires a net.Socket')
    const role = options.role === 'listener' ? 'listener' : options.role === 'dialer' ? 'dialer' : null
    if (role === null) throw new TypeError("role must be 'dialer' or 'listener'")
    if (!isNodeId(options.nodeId)) throw new TypeError('nodeId must be a valid remotenode node id')
    if (role === 'dialer' && !isNodeId(options.peerNodeId)) {
      throw new TypeError('dialer link requires a valid peerNodeId')
    }

    const handlers = isRecord(options.handlers) ? options.handlers : {}
    this.#socket = socket
    this.#role = role
    this.#nodeId = options.nodeId
    this.#peerNodeId = role === 'dialer' ? options.peerNodeId : (isNodeId(options.peerNodeId) ? options.peerNodeId : null)
    // linkId：SPEC §3 约定为 `<较小 nodeId>~<较大 nodeId>`。dialer 建链时已知
    // 对端，直接传 string；listener 在 hello 前不知道对端，可传一个
    // `(peerNodeId) => string` resolver，握手成功后再落定（listener 侧 linkId
    // 不上线，仅本地记账/日志用）。
    this.#linkIdFor = typeof options.linkId === 'function' ? options.linkId : null
    if (typeof options.linkId === 'string' && options.linkId !== '') {
      this.#linkId = options.linkId
    } else if (this.#linkIdFor !== null && isNodeId(this.#peerNodeId)) {
      this.#linkId = resolveLinkId(this.#linkIdFor, this.#peerNodeId) ?? randomUUID()
    } else {
      this.#linkId = randomUUID()
    }
    this.#secret = isSecret(options.secret) ? options.secret : undefined
    this.#secretFor = typeof options.secretFor === 'function' ? options.secretFor : null
    this.#peekPeerNodeId = typeof options.peekPeerNodeId === 'function' ? options.peekPeerNodeId : null
    this.#nodeName = typeof options.nodeName === 'string' ? options.nodeName : this.#nodeId
    this.#instanceEpoch = typeof options.instanceEpoch === 'string' && options.instanceEpoch !== ''
      ? options.instanceEpoch
      : randomUUID()
    this.#platform = typeof options.platform === 'string' ? options.platform : undefined
    this.#dshVersion = typeof options.dshVersion === 'string' ? options.dshVersion : undefined
    this.#capabilities = isRecord(options.capabilities) ? options.capabilities : undefined
    this.#limits = isRecord(options.limits) ? options.limits : undefined
    this.#logger = createLogger(options.logger)
    this.#requestTimeoutMs = positiveNumber(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS)
    this.#heartbeatIntervalMs = positiveNumber(options.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS)
    this.#heartbeatTimeoutMs = positiveNumber(options.heartbeatTimeoutMs, DEFAULT_HEARTBEAT_TIMEOUT_MS)
    this.#handshakeTimeoutMs = positiveNumber(options.handshakeTimeoutMs, this.#requestTimeoutMs)
    this.#nonceCache = options.nonceCache instanceof NonceCache ? options.nonceCache : new NonceCache()
    this.#onUp = typeof handlers.onUp === 'function' ? handlers.onUp : null
    this.#onDown = typeof handlers.onDown === 'function' ? handlers.onDown : null
    this.#stats.createdAt = this.#createdAt

    if (typeof handlers.onRequest === 'function') this.#requestHandlers.push(handlers.onRequest)
    if (typeof handlers.onNotification === 'function') this.#notificationHandlers.push(handlers.onNotification)
    if (typeof handlers.onBinary === 'function') this.#binaryHandlers.push(handlers.onBinary)

    this.#attachSocket()
    this.#beginHandshakeWhenConnected()
  }

  // =====================================================================
  // 公共只读视图
  // =====================================================================

  /** @returns {string} 本端 nodeId */
  get nodeId() {
    return this.#nodeId
  }

  /** @returns {string} UUID；两侧同一物理连接各自铸造，不要求一致 */
  get linkId() {
    return this.#linkId
  }

  /** @returns {'outbound'|'inbound'} */
  get direction() {
    return this.#role === 'dialer' ? 'outbound' : 'inbound'
  }

  /** @returns {'dialer'|'listener'} */
  get role() {
    return this.#role
  }

  /** listener 在 hello 之前为 null；dialer 构造时已知。 */
  get peerNodeId() {
    return this.#peerNodeId
  }

  /** @returns {'handshaking'|'ready'|'closed'} */
  get state() {
    return this.#state
  }

  /** @returns {{nodeId:string,nodeName:string,platform:string,capabilities:object,limits:object|null}|null} */
  get remote() {
    return this.#remote
  }

  /** 最后一次收到任何入帧的本地时间（ms）。 */
  get lastSeen() {
    return this.#lastSeen
  }

  /** 最近一次握手/心跳往返耗时（ms），未知为 null。 */
  get rttMs() {
    return this.#rttMs
  }

  /** 只读统计快照（实时对象，不要修改）。 */
  get stats() {
    return this.#stats
  }

  /** 底层 socket（测试/诊断用；业务代码请用 link API）。 */
  get socket() {
    return this.#socket
  }

  /** @returns {boolean} */
  isReady() {
    return this.#state === 'ready'
  }

  // =====================================================================
  // 处理器注册（可追加，先注册的先执行；返回取消函数）
  // =====================================================================

  /**
   * 追加一个入站 request 处理器：`fn(link, method, params, ctx)`。
   * 返回 undefined 表示“本处理器不认领”，继续下一个；全部不认领则回 result:null
   * （没有注册任何处理器时回 method/not-found）。
   * @param {(link:PeerLink, method:string, params:unknown, ctx:object) => unknown} fn
   * @returns {() => void}
   */
  onRequest(fn) {
    if (typeof fn !== 'function') throw new TypeError('onRequest handler must be a function')
    this.#requestHandlers.push(fn)
    return () => {
      const index = this.#requestHandlers.indexOf(fn)
      if (index >= 0) this.#requestHandlers.splice(index, 1)
    }
  }

  /**
   * 追加一个 notification 处理器：`fn(link, method, params)`。
   * @param {(link:PeerLink, method:string, params:unknown) => void} fn
   * @returns {() => void}
   */
  onNotification(fn) {
    if (typeof fn !== 'function') throw new TypeError('onNotification handler must be a function')
    this.#notificationHandlers.push(fn)
    return () => {
      const index = this.#notificationHandlers.indexOf(fn)
      if (index >= 0) this.#notificationHandlers.splice(index, 1)
    }
  }

  /**
   * 追加一个二进制帧处理器：`fn(link, header, payload)`。
   * @param {(link:PeerLink, header:object, payload:Buffer) => void} fn
   * @returns {() => void}
   */
  onBinary(fn) {
    if (typeof fn !== 'function') throw new TypeError('onBinary handler must be a function')
    this.#binaryHandlers.push(fn)
    return () => {
      const index = this.#binaryHandlers.indexOf(fn)
      if (index >= 0) this.#binaryHandlers.splice(index, 1)
    }
  }

  // =====================================================================
  // 出站 API
  // =====================================================================

  /**
   * 发一个 JSON-RPC 请求并等待响应（对端 error 转成本地 ProtocolError）。
   * @param {string} method
   * @param {unknown} [params]
   * @param {{timeoutMs?:number}} [options]
   * @returns {Promise<any>}
   */
  request(method, params, options = {}) {
    if (typeof method !== 'string' || method === '') {
      return Promise.reject(new TypeError('request method must be a non-empty string'))
    }
    if (this.#state === 'closed') {
      return Promise.reject(linkClosedError(this.#closeReason))
    }
    if (this.#state !== 'ready') {
      return Promise.reject(protocolError('peer/offline', 'peer link is still handshaking', {
        state: this.#state,
        peerNodeId: this.#peerNodeId,
      }))
    }
    const timeoutMs = positiveNumber(isRecord(options) ? options.timeoutMs : undefined, this.#requestTimeoutMs)
    const id = `r-${++this.#requestCounter}`
    let frame
    try {
      frame = request(id, method, params)
    } catch (error) {
      return Promise.reject(asProtocolError(error))
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.has(id)) return
        this.#pending.delete(id)
        const error = requestTimeoutError(method, timeoutMs)
        this.#stats.lastError = { message: error.message, kind: error.kind, at: Date.now() }
        reject(error)
      }, timeoutMs)
      timer.unref?.()
      this.#pending.set(id, { kind: 'request', method, resolve, reject, timer, startedAt: Date.now() })
      this.#stats.requestsOut += 1
      let buffer
      try {
        buffer = encodeJsonFrame(frame)
      } catch (error) {
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(asProtocolError(error))
        return
      }
      if (!this.#write(buffer)) {
        this.#pending.delete(id)
        clearTimeout(timer)
        reject(linkClosedError(this.#closeReason ?? 'write-failed'))
      }
    })
  }

  /**
   * 发一个通知（即发即忘；链路未 ready/已关闭时返回 false）。
   * @param {string} method
   * @param {unknown} [params]
   * @returns {boolean}
   */
  notify(method, params) {
    if (this.#state !== 'ready') return false
    let frame
    try {
      frame = notification(method, params)
    } catch {
      return false
    }
    const sent = this.#sendJsonFrame(frame)
    if (sent) this.#stats.notificationsOut += 1
    return sent
  }

  /**
   * 发一个二进制帧（artifact.chunk）；对端通过 onBinary 收到。
   * socket 已关闭 / 编码非法 / 超限时安全返回 false（不抛异常）。
   * @param {Record<string, unknown>} header 例如 {artifactId, offset, length, chunkId?}
   * @param {Buffer|Uint8Array} payload
   * @returns {boolean}
   */
  sendBinary(header, payload) {
    if (this.#state !== 'ready') return false
    let buffer
    try {
      buffer = encodeBinaryFrame(header, payload)
    } catch (error) {
      const protocol = asProtocolError(error)
      this.#stats.lastError = { message: protocol.message, kind: protocol.kind, at: Date.now() }
      this.#logger.warn(`[peer-link ${this.#linkId}] sendBinary rejected: ${protocol.message}`)
      // 帧级非法属于本地用法错误：不拖垮链路，但超限帧必须断链（SPEC §5.8-1）。
      if (protocol.kind === 'limit/frame-too-large') this.#close(protocol.kind)
      return false
    }
    return this.#write(buffer)
  }

  /**
   * 主动关闭链路（幂等；可多次调用）。pending 请求会立刻被
   * reject ProtocolError('link/closed')，onDown 只回调一次。
   * @param {string} [reason]
   */
  close(reason = 'closed') {
    this.#close(typeof reason === 'string' && reason !== '' ? reason : 'closed')
  }

  // =====================================================================
  // socket 装配与握手
  // =====================================================================

  #attachSocket() {
    const socket = this.#socket
    try {
      socket.setNoDelay?.(true)
    } catch {
      /* best effort */
    }
    socket.on('data', chunk => this.#onData(chunk))
    socket.on('error', error => this.#onSocketError(error))
    socket.on('close', () => {
      if (this.#state === 'closed') {
        this.#finalizeDown()
        return
      }
      this.#close('socket/close')
      this.#finalizeDown()
    })
    socket.on('end', () => this.#close('socket/end'))
  }

  #beginHandshakeWhenConnected() {
    const socket = this.#socket
    if (socket.destroyed) {
      this.#close('socket/close')
      return
    }
    if (socket.connecting === true) {
      socket.once('connect', () => this.#beginHandshake())
      return
    }
    this.#beginHandshake()
  }

  #beginHandshake() {
    if (this.#handshakeStarted || this.#state !== 'handshaking') return
    this.#handshakeStarted = true
    if (this.#role === 'dialer') {
      this.#sendHello()
      return
    }
    // listener：等待对端 hello；超时说明对端根本没按协议说话。
    this.#handshakeTimer = setTimeout(() => this.#close('handshake-timeout'), this.#handshakeTimeoutMs)
    this.#handshakeTimer.unref?.()
  }

  /** 解析一个 peer 的共享密钥（listener 在 hello 之后才知道 peerNodeId）。 */
  #resolveSecret(peerNodeId) {
    if (this.#secretFor !== null) {
      try {
        const found = this.#secretFor(peerNodeId)
        if (isSecret(found)) return found
      } catch (error) {
        this.#logger.warn(`[peer-link ${this.#linkId}] secretFor(${peerNodeId}) failed`, error)
      }
    }
    return this.#secret
  }

  #sendHello() {
    const listenerNodeId = this.#peerNodeId
    if (!isNodeId(listenerNodeId)) {
      this.#close('auth/unknown-peer')
      return
    }
    const secret = this.#resolveSecret(listenerNodeId)
    if (secret === undefined) {
      this.#logger.warn(`[peer-link ${this.#linkId}] no secret for peer ${listenerNodeId}`)
      this.#close('auth/unknown-peer')
      return
    }
    try {
      this.#helloFrame = createHello({
        nodeId: this.#nodeId,
        listenerNodeId,
        secret,
        nodeName: this.#nodeName,
        instanceEpoch: this.#instanceEpoch,
        connectionId: this.#linkId,
        ...(this.#platform === undefined ? {} : { platform: this.#platform }),
        ...(this.#dshVersion === undefined ? {} : { dshVersion: this.#dshVersion }),
        ...(this.#capabilities === undefined ? {} : { capabilities: this.#capabilities }),
      })
    } catch (error) {
      this.#logger.warn(`[peer-link ${this.#linkId}] createHello failed`, error)
      this.#close(asProtocolError(error).kind)
      return
    }
    this.#helloStartedAt = Date.now()
    this.#handshakeTimer = setTimeout(() => this.#close('handshake-timeout'), this.#handshakeTimeoutMs)
    this.#handshakeTimer.unref?.()
    this.#logger.debug(`[peer-link ${this.#linkId}] -> peer.hello (${this.#nodeId} -> ${listenerNodeId})`)
    if (!this.#sendJsonFrame(this.#helloFrame)) {
      this.#close(this.#closeReason ?? 'socket/error')
    }
  }

  /** dialer：校验 peer.welcome（response 帧）。 */
  #handleWelcome(welcomeFrame) {
    const helloFrame = this.#helloFrame
    const listenerNodeId = this.#peerNodeId
    const secret = isNodeId(listenerNodeId) ? this.#resolveSecret(listenerNodeId) : undefined
    if (helloFrame === null || secret === undefined) {
      this.#close('auth/unknown-peer')
      return
    }
    // 对端可能直接回 JSON-RPC error（例如 proof 不对）：转成本地 ProtocolError 后断链。
    if (welcomeFrame.error !== undefined) {
      let error
      try {
        error = protocolErrorFromRpc(welcomeFrame.error)
      } catch {
        error = protocolError('peer/internal', 'malformed peer.hello error response')
      }
      this.#logger.warn(
        `[peer-link ${this.#linkId}] handshake rejected by peer: ${error.kind} (${error.message})`,
      )
      this.#stats.lastError = { message: error.message, kind: error.kind, at: Date.now() }
      this.#close(error.kind)
      return
    }
    let check
    try {
      check = verifyWelcome({
        helloFrame,
        welcomeFrame,
        listenerNodeId,
        secret,
        nonceCache: this.#nonceCache,
      })
    } catch (error) {
      this.#logger.warn(`[peer-link ${this.#linkId}] verifyWelcome failed`, error)
      this.#close('auth/invalid-proof')
      return
    }
    if (!check.ok) {
      this.#logger.warn(`[peer-link ${this.#linkId}] welcome rejected: ${check.kind}`)
      this.#close(check.kind ?? 'auth/invalid-proof')
      return
    }
    this.#rttMs = Math.max(0, Date.now() - this.#helloStartedAt)
    this.#remote = remoteFromWelcome(check.welcome)
    this.#becomeReady()
  }

  /** listener：校验 peer.hello，回 peer.welcome 后进入 ready。 */
  #handleHello(helloFrame) {
    const requestId = typeof helloFrame.id === 'string' ? helloFrame.id : null
    const candidatePeerId = isRecord(helloFrame.params) ? helloFrame.params.nodeId : undefined
    if (requestId === null) {
      this.#close('peer/internal')
      return
    }
    if (!isNodeId(candidatePeerId)) {
      this.#rejectHello(requestId, 'auth/unknown-peer')
      return
    }
    const secret = this.#resolveSecret(candidatePeerId)
    if (secret === undefined) {
      this.#logger.warn(`[peer-link ${this.#linkId}] hello from unconfigured peer ${candidatePeerId}`)
      this.#rejectHello(requestId, 'auth/unknown-peer')
      return
    }
    /** @type {Record<string, unknown>} */
    const verifyOptions = {
      frame: helloFrame,
      listenerNodeId: this.#nodeId,
      secret,
      nonceCache: this.#nonceCache,
    }
    if (this.#peekPeerNodeId !== null) {
      try {
        const expected = this.#peekPeerNodeId()
        if (isNodeId(expected)) verifyOptions.expectedPeerNodeId = expected
      } catch (error) {
        this.#logger.warn(`[peer-link ${this.#linkId}] peekPeerNodeId failed`, error)
      }
    }
    let check
    try {
      check = verifyHello(verifyOptions)
    } catch (error) {
      this.#logger.warn(`[peer-link ${this.#linkId}] verifyHello failed`, error)
      this.#rejectHello(requestId, 'peer/internal')
      return
    }
    if (!check.ok) {
      this.#logger.warn(`[peer-link ${this.#linkId}] hello rejected: ${check.kind}`)
      this.#rejectHello(requestId, check.kind ?? 'auth/invalid-proof')
      return
    }
    let welcomeFrame
    try {
      welcomeFrame = createWelcome({
        hello: helloFrame,
        listenerNodeId: this.#nodeId,
        secret,
        nodeName: this.#nodeName,
        instanceEpoch: this.#instanceEpoch,
        ...(this.#platform === undefined ? {} : { platform: this.#platform }),
        ...(this.#dshVersion === undefined ? {} : { dshVersion: this.#dshVersion }),
        ...(this.#capabilities === undefined ? {} : { capabilities: this.#capabilities }),
        ...(this.#limits === undefined ? {} : { limits: this.#limits }),
      })
    } catch (error) {
      this.#logger.warn(`[peer-link ${this.#linkId}] createWelcome failed`, error)
      this.#rejectHello(requestId, 'peer/internal')
      return
    }
    this.#peerNodeId = candidatePeerId
    this.#remote = remoteFromHello(check.hello)
    if (this.#linkIdFor !== null) {
      const resolved = resolveLinkId(this.#linkIdFor, candidatePeerId)
      if (resolved !== null) this.#linkId = resolved
    }
    this.#logger.debug(`[peer-link ${this.#linkId}] <- peer.hello from ${candidatePeerId}; -> peer.welcome`)
    if (!this.#sendJsonFrame(welcomeFrame)) {
      this.#close(this.#closeReason ?? 'socket/error')
      return
    }
    this.#becomeReady()
  }

  #rejectHello(requestId, kind) {
    this.#respondError(requestId, protocolError(kind, `handshake rejected: ${kind}`))
    this.#close(kind)
  }

  #becomeReady() {
    if (this.#state !== 'handshaking') return
    this.#state = 'ready'
    this.#clearHandshakeTimer()
    this.#lastSeen = Date.now()
    this.#stats.readyAt = Date.now()
    this.#startHeartbeat()
    if (!this.#upFired) {
      this.#upFired = true
      if (this.#onUp !== null) {
        try {
          this.#onUp(this)
        } catch (error) {
          this.#logger.warn(`[peer-link ${this.#linkId}] onUp handler failed`, error)
        }
      }
    }
  }

  // =====================================================================
  // 入站帧解析
  // =====================================================================

  #onData(chunk) {
    if (this.#state === 'closed') return
    try {
      this.#lastSeen = Date.now()
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      this.#buffer = this.#buffer.length === 0 ? incoming : Buffer.concat([this.#buffer, incoming])
      while (this.#state !== 'closed') {
        const buffered = this.#buffer
        if (buffered.length < 4) break
        const length = buffered.readUInt32BE(0)
        if (length === 0) {
          this.#logger.warn(`[peer-link ${this.#linkId}] zero-length frame`)
          this.#close('frame/invalid')
          return
        }
        if (length > MAX_FRAME_BYTES) {
          this.#stats.lastError = { reason: 'frame-too-large', bytes: length, at: Date.now() }
          this.#close('limit/frame-too-large')
          return
        }
        if (buffered.length < 4 + length) break
        const payload = buffered.subarray(4, 4 + length)
        this.#buffer = buffered.subarray(4 + length)
        this.#onFramePayload(payload)
      }
    } catch (error) {
      const protocol = asProtocolError(error)
      this.#logger.warn(`[peer-link ${this.#linkId}] frame transport failed: ${protocol.message}`)
      this.#stats.lastError = { message: protocol.message, kind: protocol.kind, at: Date.now() }
      this.#close(protocol.kind)
    }
  }

  #onFramePayload(payload) {
    this.#stats.framesIn += 1
    this.#stats.bytesIn += payload.length
    if (isBinaryFramePayload(payload)) {
      this.#stats.binaryFramesIn += 1
      const decoded = decodeBinaryFrame(payload)
      if (decoded === null) {
        this.#logger.warn(`[peer-link ${this.#linkId}] malformed binary frame (${payload.length} bytes)`)
        this.#stats.lastError = { reason: 'binary-frame-invalid', bytes: payload.length, at: Date.now() }
        this.#close('frame/invalid')
        return
      }
      this.#dispatchBinary(decoded.header, decoded.payload)
      return
    }
    this.#stats.jsonFramesIn += 1
    if (payload.length > MAX_JSON_FRAME_BYTES) {
      this.#close('limit/frame-too-large')
      return
    }
    let frame
    try {
      frame = decodeJsonFrame(payload)
    } catch (error) {
      const protocol = asProtocolError(error)
      this.#close(protocol.kind)
      return
    }
    this.#onJsonFrame(frame)
  }

  #onJsonFrame(frame) {
    const validation = validateJsonRpcFrame(frame)
    if (!validation.ok) {
      this.#stats.lastError = { reason: validation.reason, at: Date.now() }
      this.#logger.warn(`[peer-link ${this.#linkId}] invalid json-rpc frame: ${validation.reason}`)
      this.#close('frame/invalid')
      return
    }
    if (validation.kind === 'response') {
      this.#stats.responsesIn += 1
      this.#onResponseFrame(frame, validation)
      return
    }
    if (validation.kind === 'notification') {
      this.#stats.notificationsIn += 1
      this.#onNotificationFrame(frame, validation)
      return
    }
    this.#stats.requestsIn += 1
    this.#onRequestFrame(frame, validation)
  }

  #onResponseFrame(frame, validation) {
    // dialer 握手：peer.welcome 是对 peer.hello 的 response。
    if (this.#role === 'dialer' && this.#state === 'handshaking') {
      if (this.#helloFrame === null || validation.id !== this.#helloFrame.id) {
        this.#logger.warn(`[peer-link ${this.#linkId}] unexpected response while handshaking`)
        this.#close('peer/internal')
        return
      }
      this.#handleWelcome(frame)
      return
    }
    const pending = this.#pending.get(validation.id)
    if (pending === undefined) {
      this.#logger.debug(`[peer-link ${this.#linkId}] response for unknown request ${validation.id}`)
      return
    }
    this.#pending.delete(validation.id)
    clearTimeout(pending.timer)
    if (frame.error !== undefined) {
      let error
      try {
        error = protocolErrorFromRpc(frame.error)
      } catch {
        error = protocolError('peer/internal', 'malformed remote rpc error')
      }
      this.#stats.lastError = { message: error.message, kind: error.kind, at: Date.now() }
      pending.reject(error)
      return
    }
    pending.resolve(frame.result)
  }

  #onNotificationFrame(frame, validation) {
    const method = validation.method
    if (method === 'peer.heartbeat') return // lastSeen 已在帧层更新
    if (method === 'peer.goodbye') {
      this.#close('goodbye')
      return
    }
    this.#dispatchNotification(method, frame.params)
  }

  #onRequestFrame(frame, validation) {
    const method = validation.method
    const id = validation.id
    if (method === 'peer.hello') {
      if (this.#role === 'listener' && this.#state === 'handshaking') {
        this.#handleHello(frame)
        return
      }
      this.#respondError(id, protocolError('peer/duplicate', 'peer.hello on an established link'))
      return
    }
    if (this.#state !== 'ready') {
      this.#respondError(id, protocolError('peer/offline', 'peer link is still handshaking'))
      return
    }
    if (method === 'peer.ping') {
      this.#respond(id, { time: Date.now() })
      return
    }
    this.#dispatchRequest(id, method, frame.params)
  }

  // =====================================================================
  // 入站 request / notification / binary 派发
  // =====================================================================

  #dispatchRequest(id, method, params) {
    const handlers = this.#requestHandlers.slice()
    if (handlers.length === 0) {
      this.#respondError(id, new ProtocolError('method/not-found', `unknown method: ${method}`, { method }))
      return
    }
    const ctx = { link: this, method, params, remote: this.#remote, requestId: id }
    // 处理器可能是 async；不阻塞后续帧解析。
    ;(async () => {
      let result
      let handled = false
      for (const handler of handlers) {
        let value
        try {
          value = await handler(this, method, params, ctx)
        } catch (error) {
          this.#respondError(id, error)
          return
        }
        if (value !== undefined) {
          result = value
          handled = true
          break
        }
      }
      this.#respond(id, handled ? result : null)
    })().catch(error => {
      this.#logger.warn(`[peer-link ${this.#linkId}] request dispatch for ${method} failed`, error)
      this.#respondError(id, error)
    })
  }

  #dispatchNotification(method, params) {
    for (const handler of this.#notificationHandlers.slice()) {
      try {
        handler(this, method, params)
      } catch (error) {
        this.#logger.warn(`[peer-link ${this.#linkId}] onNotification handler failed`, error)
      }
    }
  }

  #dispatchBinary(header, payload) {
    for (const handler of this.#binaryHandlers.slice()) {
      try {
        handler(this, header, payload)
      } catch (error) {
        this.#logger.warn(`[peer-link ${this.#linkId}] onBinary handler failed`, error)
      }
    }
  }

  // =====================================================================
  // 出站响应与写 socket
  // =====================================================================

  #respond(id, result) {
    let buffer
    try {
      buffer = encodeJsonFrame(response(id, result))
    } catch (error) {
      this.#respondError(id, error)
      return
    }
    if (!this.#write(buffer)) {
      this.#logger.debug(`[peer-link ${this.#linkId}] cannot send response ${id}: link closing`)
    }
  }

  #respondError(id, error) {
    let rpcError
    try {
      rpcError = rpcErrorFor(error)
    } catch {
      rpcError = rpcErrorFor('peer/internal', String(error?.message ?? error ?? 'internal error'))
    }
    let buffer
    try {
      buffer = encodeJsonFrame(errorResponse(id, rpcError))
    } catch (encodeError) {
      this.#logger.warn(`[peer-link ${this.#linkId}] cannot encode error response`, encodeError)
      this.#close(asProtocolError(encodeError).kind)
      return
    }
    this.#write(buffer)
  }

  #sendJsonFrame(frame) {
    let buffer
    try {
      buffer = encodeJsonFrame(frame)
    } catch (error) {
      this.#logger.warn(`[peer-link ${this.#linkId}] encodeJsonFrame failed`, error)
      this.#close(asProtocolError(error).kind)
      return false
    }
    return this.#write(buffer)
  }

  /**
   * 写一个完整帧：在 payload 前加 4B BE 长度前缀（SPEC §5.8-1 的线格式）。
   * @param {Buffer} payload 已编码的 JSON 帧或二进制帧
   * @returns {boolean}
   */
  #write(payload) {
    const socket = this.#socket
    if (socket.destroyed || socket.writableEnded || this.#state === 'closed') return false
    if (payload.length === 0 || payload.length > MAX_FRAME_BYTES) {
      this.#close('limit/frame-too-large')
      return false
    }
    try {
      const buffer = Buffer.allocUnsafe(4 + payload.length)
      buffer.writeUInt32BE(payload.length, 0)
      payload.copy(buffer, 4)
      this.#stats.framesOut += 1
      this.#stats.bytesOut += payload.length
      socket.write(buffer, error => {
        if (error) this.#onSocketError(error)
      })
      return true
    } catch (error) {
      this.#onSocketError(error)
      return false
    }
  }

  #onSocketError(error) {
    const message = error instanceof Error ? error.message : String(error ?? 'socket error')
    const code = error?.code
    this.#logger.warn(`[peer-link ${this.#linkId}] socket error${code ? ` (${code})` : ''}: ${message}`)
    this.#stats.lastError = { message, code: code ?? null, at: Date.now() }
    this.#close(code ? `socket/error:${code}` : 'socket/error')
  }

  // =====================================================================
  // 心跳
  // =====================================================================

  #startHeartbeat() {
    if (!(this.#heartbeatIntervalMs > 0)) return
    this.#heartbeatTimer = setInterval(() => this.#heartbeatTick(), this.#heartbeatIntervalMs)
    this.#heartbeatTimer.unref?.()
  }

  #heartbeatTick() {
    if (this.#state !== 'ready') return
    const now = Date.now()
    if (now - this.#lastSeen > this.#heartbeatTimeoutMs) {
      this.#logger.warn(`[peer-link ${this.#linkId}] heartbeat timeout (${now - this.#lastSeen}ms since last frame)`)
      this.#close('timeout')
      return
    }
    this.notify('peer.heartbeat', { status: 'ready', time: now })
  }

  // =====================================================================
  // 关闭与清理
  // =====================================================================

  #close(reason) {
    if (this.#state === 'closed') return
    this.#state = 'closed'
    this.#closeReason = typeof reason === 'string' && reason !== '' ? reason : 'closed'
    this.#stats.closedAt = Date.now()
    this.#stats.closeReason = this.#closeReason
    this.#clearHandshakeTimer()
    this.#clearHeartbeatTimer()
    this.#rejectPending(this.#closeReason)
    this.#logger.debug(`[peer-link ${this.#linkId}] closed: ${this.#closeReason}`)
    const socket = this.#socket
    if (socket.destroyed) {
      this.#finalizeDown()
      return
    }
    try {
      if (socket.writable && !socket.writableEnded) socket.end()
      else socket.destroy()
    } catch {
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    }
    this.#hardCloseTimer = setTimeout(() => {
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    }, HARD_CLOSE_DELAY_MS)
    this.#hardCloseTimer.unref?.()
  }

  #finalizeDown() {
    if (this.#downFired) return
    this.#downFired = true
    this.#clearHardCloseTimer()
    this.#clearHandshakeTimer()
    this.#clearHeartbeatTimer()
    try {
      this.#rejectPending(this.#closeReason ?? 'closed')
    } catch {
      /* ignore */
    }
    if (this.#onDown !== null) {
      try {
        this.#onDown(this, this.#closeReason ?? 'closed')
      } catch (error) {
        this.#logger.warn(`[peer-link ${this.#linkId}] onDown handler failed`, error)
      }
    }
  }

  #rejectPending(reason) {
    if (this.#pending.size === 0) return
    const error = linkClosedError(reason)
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      this.#stats.lastError = { message: error.message, kind: error.kind, at: Date.now() }
      try {
        pending.reject(error)
      } catch {
        /* ignore */
      }
      this.#pending.delete(id)
    }
  }

  #clearHandshakeTimer() {
    if (this.#handshakeTimer !== null) {
      clearTimeout(this.#handshakeTimer)
      this.#handshakeTimer = null
    }
  }

  #clearHeartbeatTimer() {
    if (this.#heartbeatTimer !== null) {
      clearInterval(this.#heartbeatTimer)
      this.#heartbeatTimer = null
    }
  }

  #clearHardCloseTimer() {
    if (this.#hardCloseTimer !== null) {
      clearTimeout(this.#hardCloseTimer)
      this.#hardCloseTimer = null
    }
  }
}

/**
 * 调用 linkId resolver，异常/非法返回 null（不允许因为记账失败拖垮链路）。
 * @param {(peerNodeId:string) => string} resolver
 * @param {string} peerNodeId
 * @returns {string|null}
 */
function resolveLinkId(resolver, peerNodeId) {
  try {
    const value = resolver(peerNodeId)
    return typeof value === 'string' && value !== '' ? value : null
  } catch {
    return null
  }
}

/**
 * 判断对象是否像 net.Socket（避免 import net 造成循环/平台负担；duck typing）。
 * @param {unknown} value
 * @returns {boolean}
 */
function isRecordLikeSocket(value) {
  return isRecord(value)
    && typeof value.on === 'function'
    && typeof value.write === 'function'
    && typeof value.destroy === 'function'
}

/**
 * 创建一条对等链路（SPEC §5.8）。
 * @param {object} options
 * @param {import('node:net').Socket} options.socket 已连接的 TCP socket
 * @param {'dialer'|'listener'} options.role
 * @param {string} options.nodeId 本端 nodeId
 * @param {string} [options.peerNodeId] 对端 nodeId（dialer 必填，listener hello 后得到）
 * @param {string | ((peerNodeId:string) => string)} [options.linkId]
 *   连接 ID。缺省随机；listener 侧可传 resolver，在 hello 后按 nodeId 对生成
 *   canonical 值（`<较小 nodeId>~<较大 nodeId>`，SPEC §3）。
 * @param {string|Buffer} [options.secret] 共享密钥（与 secretFor 二选一）
 * @param {(peerNodeId:string) => string|Buffer|undefined} [options.secretFor]
 * @param {() => string|undefined} [options.peekPeerNodeId]
 * @param {string} [options.nodeName]
 * @param {string} [options.instanceEpoch]
 * @param {string} [options.platform]
 * @param {string} [options.dshVersion]
 * @param {object} [options.capabilities]
 * @param {object} [options.limits] listener welcome 里发布的 limits
 * @param {object} [options.logger]
 * @param {number} [options.requestTimeoutMs]
 * @param {number} [options.heartbeatIntervalMs]
 * @param {number} [options.heartbeatTimeoutMs]
 * @param {number} [options.handshakeTimeoutMs]
 * @param {import('./handshake.js').NonceCache} [options.nonceCache]
 * @param {object} [options.handlers]
 * @param {(link:PeerLink) => void} [options.handlers.onUp]
 * @param {(link:PeerLink, reason:string) => void} [options.handlers.onDown]
 * @param {(link:PeerLink, method:string, params:unknown, ctx:object) => unknown} [options.handlers.onRequest]
 * @param {(link:PeerLink, method:string, params:unknown) => void} [options.handlers.onNotification]
 * @param {(link:PeerLink, header:object, payload:Buffer) => void} [options.handlers.onBinary]
 * @returns {PeerLink}
 */
export function createPeerLink(options) {
  return new PeerLink(options)
}

export { PeerLink }

export default createPeerLink
