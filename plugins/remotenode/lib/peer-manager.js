/**
 * peer-manager.js — remotenode 对等连接管理器（SPEC §5.9）。
 *
 * 职责：
 *  1. 按 config.listen 起 TCP 监听（enabled 时），接受对端拨入；
 *  2. 为 `dial:'auto'` 的 peer 维护拨号循环，失败/断链后指数退避重连
 *     （1s → 2s → 5s → 10s → 30s 上限）；
 *  3. 连接去重：同一 peer 只保留 `dialerNodeId === canonicalDialer(self, peer)`
 *     的那条链路，另一条 close('peer/duplicate')；去重关闭后 3s 内不重拨，
 *     避免两条链路互相踩踏造成拨号抖动；
 *  4. 给 UI 提供 `state()`（不含 secret）、给上层提供 request/notify/broadcast/
 *     dialNow/dialAllOffline/linkFor；
 *  5. 定期 `peer.ping` 测 rttMs（只记录，不因 ping 失败断链；链路存活由
 *     peer-link 心跳判定）。
 *
 * 纯 ESM、零第三方依赖，只用 node: 内置模块。所有监听回调都防御式：
 * remotenode 的故障不能拖垮 DSH 宿主进程。
 */

import { randomUUID } from 'node:crypto'
import { Socket, createServer } from 'node:net'

import { canonicalDialer } from './dedupe.js'
import { ProtocolError, asProtocolError } from './errors.js'
import { NonceCache } from './handshake.js'
import { isNodeId } from './ids.js'
import { createPeerLink } from './peer-link.js'

/** 重连退避序列（SPEC §5.9：1s → 2s → 5s → 10s → 30s 上限）。 */
const BACKOFF_MS = Object.freeze([1000, 2000, 5000, 10000, 30000])
/** 去重关闭后的静默期：期间不因 duplicate 重拨（SPEC §5.9 要求至少 3s）。 */
const DUPLICATE_QUIET_MS = 3000
/** rtt 主动 ping 默认间隔（SPEC 心跳 10s；ping 15s 已与 Lead 确认）。 */
const DEFAULT_RTT_INTERVAL_MS = 15000
const DEFAULT_REQUEST_TIMEOUT_MS = 30000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10000
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30000
const SERVER_CLOSE_GRACE_MS = 1000
/** canonical 方向补偿拨号延迟（给同时进行的 outbound 握手留落定窗口）。 */
const CANONICAL_UPGRADE_DELAY_MS = 250

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value @param {number} fallback */
function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

/** 保证字符串单行、非空。 @param {unknown} value @param {string} fallback */
function text(value, fallback = '') {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback
  const single = String(value).replace(/\s+/g, ' ').trim()
  return single === '' ? fallback : single
}

/** 空 logger 兜底。 */
function createLogger(logger) {
  const base = isRecord(logger) ? logger : {}
  const call = level => (...args) => {
    try {
      const fn = typeof base[level] === 'function' ? base[level] : base.log
      if (typeof fn === 'function') fn.apply(base, args)
    } catch {
      /* 宿主 logger 抛错也不能影响管理器 */
    }
  }
  return { debug: call('debug'), info: call('info'), warn: call('warn'), error: call('error') }
}

/** 本机平台名（协议枚举 'windows'|'linux'|'macos'|'unknown'）。 */
function platformName() {
  switch (process.platform) {
    case 'win32':
      return 'windows'
    case 'darwin':
      return 'macos'
    case 'linux':
      return 'linux'
    default:
      return 'unknown'
  }
}

/** 关闭原因是否属于认证/协议类失败（UI 标 error 而不是 offline）。 */
function isAuthFailureReason(reason) {
  return typeof reason === 'string'
    && (reason.startsWith('auth/')
      || reason === 'protocol/unsupported'
      || reason === 'handshake-timeout'
      || reason.startsWith('secret/')
      || reason === 'peer/internal')
}

/**
 * PeerManager：监听、拨号、重连、去重与链路路由。
 */
class PeerManager {
  #config
  #self
  #logger
  #handlers
  #requestTimeoutMs
  #heartbeatIntervalMs
  #heartbeatTimeoutMs
  #rttIntervalMs
  #nonceCache
  #capabilities
  #limits

  #listen
  #server = null
  #started = false
  #stopping = false
  #listenError = null

  /** @type {Set<any>} 当前持有的 link（listener 的 linkId 握手后才会落定为 canonical 值） */
  #links = new Set()
  /** @type {Map<string, any>} peerNodeId -> 当前 canonical ready link */
  #readyLinks = new Map()
  /** @type {Map<string, any>} peerNodeId -> 配置 */
  #peerConfigs = new Map()
  /** @type {string[]} 配置顺序 */
  #peerOrder = []
  /** @type {Map<string, any>} peerNodeId -> UI 状态 entry */
  #entries = new Map()
  /** @type {Map<string, number>} peerNodeId -> 退避档位 */
  #dialAttempts = new Map()
  /** @type {Map<string, NodeJS.Timeout>} peerNodeId -> 重连 timer */
  #dialTimers = new Map()
  /** @type {Map<string, Promise<any>>} peerNodeId -> 进行中的拨号 */
  #dialing = new Map()
  /** @type {Map<any, NodeJS.Timeout>} link 对象 -> rtt ping interval（linkId 是 pair key，不唯一） */
  #pingTimers = new Map()
  /** @type {Set<any>} 已经向上层转发过 onLinkUp 的 link 对象（保证 up/down 成对） */
  #announcedLinks = new Set()
  /** @type {Promise<void>} setListen 串行队列（并发调用按调用顺序生效） */
  #listenQueue = Promise.resolve()

  /**
   * @param {object} options
   * @param {Record<string, any>} options.config 合并后的运行时配置（SPEC §4）
   * @param {string} [options.instanceEpoch]
   * @param {object} [options.logger]
   * @param {object} [options.handlers]
   * @param {(link:any)=>void} [options.handlers.onLinkUp]
   * @param {(link:any, reason:string)=>void} [options.handlers.onLinkDown]
   * @param {(link:any, method:string, params:unknown, ctx:object)=>unknown} [options.handlers.onRequest]
   * @param {(link:any, method:string, params:unknown)=>void} [options.handlers.onNotification]
   * @param {(link:any, header:object, payload:Buffer)=>void} [options.handlers.onBinary]
   */
  constructor(options) {
    if (!isRecord(options)) throw new TypeError('createPeerManager requires an options object')
    const config = isRecord(options.config) ? options.config : {}
    this.#config = config
    const nodeId = config.nodeId
    if (!isNodeId(nodeId)) throw new TypeError('config.nodeId must be a valid remotenode node id')
    this.#self = {
      nodeId,
      nodeName: text(config.nodeName, nodeId),
      instanceEpoch: text(options.instanceEpoch, '') || randomUUID(),
      platform: platformName(),
      protocol: 1,
    }
    this.#logger = createLogger(options.logger)
    this.#handlers = isRecord(options.handlers) ? options.handlers : {}
    this.#requestTimeoutMs = positiveNumber(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS)
    this.#heartbeatIntervalMs = positiveNumber(config.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS)
    this.#heartbeatTimeoutMs = positiveNumber(config.heartbeatTimeoutMs, DEFAULT_HEARTBEAT_TIMEOUT_MS)
    this.#rttIntervalMs = positiveNumber(config.rttIntervalMs, DEFAULT_RTT_INTERVAL_MS)
    this.#nonceCache = options.nonceCache instanceof NonceCache ? options.nonceCache : new NonceCache()
    this.#capabilities = isRecord(config.capabilities) ? config.capabilities : undefined
    this.#limits = isRecord(config.limits) ? config.limits : undefined

    const listen = isRecord(config.listen) ? config.listen : {}
    this.#listen = {
      enabled: listen.enabled === true,
      host: text(listen.host, '127.0.0.1'),
      port: Number.isInteger(Number(listen.port)) && Number(listen.port) >= 0 && Number(listen.port) <= 65535
        ? Number(listen.port)
        : 47201,
    }

    this.#loadPeers(Array.isArray(config.peers) ? config.peers : [])
  }

  // =====================================================================
  // 公共只读视图
  // =====================================================================

  /** @returns {{nodeId:string,nodeName:string,instanceEpoch:string,platform:string,protocol:number}} */
  get self() {
    return { ...this.#self }
  }

  /** 配置里的 peer 列表（去掉 secret）。 */
  get peers() {
    return this.#peerOrder.map(peerNodeId => {
      const peer = this.#peerConfigs.get(peerNodeId)
      return {
        nodeId: peer.nodeId,
        nodeName: peer.nodeName,
        host: peer.host,
        port: peer.port,
        dial: peer.dial,
        configured: true,
        source: peer.source ?? 'config',
        removable: (peer.source ?? 'config') === 'paired',
      }
    })
  }

  /** 当前持有的所有未关闭 link（含 handshaking 与 ready）。 */
  get links() {
    return [...this.#links].filter(link => link.state !== 'closed')
  }

  /** 实际监听端口（listen.port=0 时为系统分配端口；未监听为 null）。 */
  get listenPort() {
    const address = this.#server?.address?.()
    return address !== null && typeof address === 'object' ? address.port : null
  }

  /** 是否已 start()。 */
  get started() {
    return this.#started
  }

  /** 监听失败的错误信息（start() 会抛错；此处给 UI/诊断）。 */
  get listenError() {
    return this.#listenError
  }

  /** @returns {any} peerNodeId 对应的 ready link，未连通为 undefined */
  linkFor(nodeId) {
    return this.#readyLinks.get(nodeId)
  }

  /** @returns {number} ready link 数量（去重后每个 peer 至多 1 条） */
  activeLinkCount() {
    return this.#readyLinks.size
  }

  /**
   * UI 状态快照（不含 secret）。每项：
   * { peerNodeId, nodeName, configured, dial, state:'online'|'offline'|'dialing'|'error',
   *   direction:'in'|'out'|null, linkId?, lastSeen?, rttMs?, remote?, error? }
   * @returns {Array<Record<string, any>>}
   */
  state() {
    return this.#peerOrder.map(peerNodeId => {
      const entry = this.#entries.get(peerNodeId) ?? {}
      const link = this.#readyLinks.get(peerNodeId)
      const active = link !== undefined && link.state === 'ready' ? link : null
      return {
        peerNodeId,
        nodeName: entry.nodeName ?? peerNodeId,
        configured: true,
        dial: entry.dial ?? 'auto',
        // SPEC §10.4-3：source 透传 peerConfig.source（缺省 'config'）；
        // 只有 UI 配对来源（source:'paired'）的节点可删除。
        source: entry.source ?? 'config',
        removable: (entry.source ?? 'config') === 'paired',
        state: active !== null ? 'online' : (entry.state ?? 'offline'),
        direction: active !== null ? (active.direction === 'outbound' ? 'out' : 'in') : null,
        linkId: active !== null ? active.linkId : undefined,
        lastSeen: active !== null ? active.lastSeen : (entry.lastSeen ?? null),
        rttMs: active !== null ? (entry.rttMs ?? active.rttMs ?? null) : (entry.rttMs ?? null),
        remote: active !== null
          ? normalizeRemote(active.remote, peerNodeId, entry.nodeName)
          : (entry.remote ?? null),
        error: active !== null ? null : (entry.error ?? null),
      }
    })
  }

  // =====================================================================
  // 生命周期
  // =====================================================================

  /** 起监听 + 为 dial:'auto' 的 peer 拨号。幂等；监听失败时抛错。 */
  async start() {
    if (this.#started) return
    if (this.#stopping) throw new Error('peer manager is stopping')
    this.#started = true
    this.#listenError = null
    if (this.#listen.enabled) {
      try {
        await this.#startServer()
      } catch (error) {
        this.#started = false
        this.#listenError = error instanceof Error ? error.message : String(error)
        this.#logger.warn(`[peer-manager] listen ${this.#listen.host}:${this.#listen.port} failed: ${this.#listenError}`)
        throw error
      }
      this.#logger.info(`[peer-manager] ${this.#self.nodeId} listening on ${this.#listen.host}:${this.listenPort}`)
    } else {
      this.#logger.info(`[peer-manager] ${this.#self.nodeId} listen disabled; outbound only`)
    }
    for (const peerNodeId of this.#peerOrder) {
      const peer = this.#peerConfigs.get(peerNodeId)
      if (peer.dial !== 'auto') continue
      this.#dial(peer).catch(error => this.#logger.warn(`[peer-manager] dial ${peerNodeId} failed`, error))
    }
  }

  /** 停止：清 timer、关链路、关监听。幂等，不抛错。 */
  async stop() {
    if (this.#stopping) return
    this.#stopping = true
    this.#started = false
    for (const timer of this.#dialTimers.values()) clearTimeout(timer)
    this.#dialTimers.clear()
    for (const timer of this.#pingTimers.values()) clearInterval(timer)
    this.#pingTimers.clear()
    const links = [...this.#links]
    this.#links.clear()
    this.#readyLinks.clear()
    this.#announcedLinks.clear()
    for (const link of links) {
      try {
        link.close('stopped')
      } catch (error) {
        this.#logger.warn('[peer-manager] link close failed during stop', error)
      }
    }
    for (const entry of this.#entries.values()) {
      entry.state = 'offline'
      entry.direction = null
      entry.linkId = undefined
      entry.rttMs = null
    }
    const server = this.#server
    this.#server = null
    if (server !== null) {
      await new Promise(resolve => {
        let finished = false
        /** @type {NodeJS.Timeout|null} */
        let grace = null
        const finish = () => {
          if (finished) return
          finished = true
          if (grace !== null) clearTimeout(grace)
          resolve()
        }
        grace = setTimeout(finish, SERVER_CLOSE_GRACE_MS)
        grace.unref?.()
        try {
          server.close(finish)
        } catch {
          finish()
        }
      })
    }
    this.#stopping = false
    this.#logger.info(`[peer-manager] ${this.#self.nodeId} stopped`)
  }

  // =====================================================================
  // 监听重绑定（SPEC §11.3：对等监听端口可在 UI 即时修改）
  // =====================================================================

  /**
   * 当前监听信息（只读）。
   *
   * `enabled` 表示**此刻真的在监听**（不仅是配置值）；未监听时仍返回最后一次
   * 配置的 host/port 供 UI 展示与回填（此时用 listenInfo().enabled===false）。
   * @returns {{enabled:boolean, host:string, port:number} | null}
   */
  listenInfo() {
    if (this.#listen === undefined || this.#listen === null) return null
    const bound = this.#server !== null
    const address = bound ? this.#server.address?.() : null
    return {
      enabled: bound && this.#listen.enabled === true,
      host: this.#listen.host,
      port: bound && address !== null && typeof address === 'object' ? address.port : this.#listen.port,
    }
  }

  /**
   * 运行时修改监听（SPEC §11.3）。
   *
   * - 关闭旧监听 socket（不再 accept；**已建立链路和拨号循环完全不受影响**）；
   * - `enabled:false`：只关闭，端口释放；
   * - `enabled:true`：用新 host/port 重新 listen，成功后返回新监听信息；
   * - 新监听失败（EADDRINUSE / EACCES / 非法地址）：尝试恢复旧监听后再返回
   *   `{ok:false, error}`，恢复成功后旧监听仍可用于新连接；
   * - 配置未变的幂等调用直接返回成功；并发调用按调用顺序串行执行。
   *
   * @param {{enabled?:boolean, host?:string, port?:number}} input
   * @returns {Promise<{ok:true, listen:{enabled:boolean, host:string, port:number}}|{ok:false, error:string}>}
   */
  setListen(input) {
    const run = () => this.#applySetListen(input)
    const task = this.#listenQueue.then(run, run)
    // 队列只保证顺序，不把单次失败传给后续调用。
    this.#listenQueue = task.then(() => undefined, () => undefined)
    return task
  }

  /**
   * 校验 setListen 入参（缺省字段沿用当前配置；enabled=false 时允许省略 host/port）。
   * @param {unknown} input
   * @returns {{listen:{enabled:boolean,host:string,port:number}}|{error:string}}
   */
  #normalizeListen(input) {
    if (!isRecord(input)) return { error: 'listen config must be an object' }
    const current = this.#listen
    let enabled = current.enabled === true
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') return { error: 'enabled must be a boolean' }
      enabled = input.enabled
    }
    let host = current.host
    if (input.host !== undefined) {
      host = text(input.host, '')
      if (host === '') return { error: 'host must be a non-empty string' }
    }
    let port = current.port
    if (input.port !== undefined) {
      const parsed = Number(input.port)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        return { error: 'port must be an integer between 1 and 65535' }
      }
      port = parsed
    }
    if (enabled && (host === '' || !Number.isInteger(port))) {
      return { error: 'enabled listen requires host and port' }
    }
    return { listen: { enabled, host, port } }
  }

  /** @param {any} input */
  async #applySetListen(input) {
    const normalized = this.#normalizeListen(input)
    if (normalized.error !== undefined) return { ok: false, error: normalized.error }
    const next = normalized.listen
    const previous = { ...this.#listen }
    const unchanged = next.enabled === previous.enabled
      && next.host === previous.host
      && next.port === previous.port
    const consistent = next.enabled ? this.#server !== null : this.#server === null
    if (unchanged && consistent) {
      return { ok: true, listen: this.#listenView(next) }
    }
    if (!this.#started) {
      // 尚未 start：只更新配置，start() 时生效。
      this.#listen = next
      return { ok: true, listen: this.#listenView(next) }
    }

    this.#logger.info(
      `[peer-manager] setListen: ${previous.host}:${previous.port}(enabled=${previous.enabled}) -> ${next.host}:${next.port}(enabled=${next.enabled})`,
    )
    await this.#closeListenerSocket()

    if (!next.enabled) {
      this.#listen = next
      this.#listenError = null
      this.#logger.info('[peer-manager] peer listener disabled at runtime (existing links untouched)')
      return { ok: true, listen: this.#listenView(next) }
    }

    try {
      await this.#bindWithRetry(next)
      this.#listen = next
      this.#listenError = null
      this.#logger.info(`[peer-manager] peer listener rebound to ${next.host}:${this.listenPort}`)
      return { ok: true, listen: this.#listenView(next) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#listenError = message
      this.#logger.warn(
        `[peer-manager] setListen ${next.host}:${next.port} failed: ${message}; restoring ${previous.host}:${previous.port}`,
      )
      // 回滚：恢复旧监听（旧配置 enabled 时），旧监听必须仍能接受新连接。
      this.#listen = previous
      if (previous.enabled) {
        try {
          await this.#bindWithRetry({ ...previous })
          this.#logger.info(`[peer-manager] peer listener restored on ${previous.host}:${this.listenPort}`)
        } catch (restoreError) {
          this.#logger.warn(
            `[peer-manager] restore listen ${previous.host}:${previous.port} failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          )
        }
      }
      return { ok: false, error: message }
    }
  }

  /**
   * 关闭当前监听 socket（只停 accept，不等待已建立连接结束）。
   * server.close() 的 callback 要等所有连接关闭，不能用；这里等一个事件循环
   * 让监听 handle 真正释放（同端口/同 host 立即重绑时需要）。
   */
  async #closeListenerSocket() {
    const server = this.#server
    this.#server = null
    if (server === null) return
    try {
      server.close()
    } catch {
      /* ignore */
    }
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  /**
   * 绑定监听；EADDRINUSE 时短暂重试（关闭旧 socket 到 OS 释放端口有极短窗口）。
   * @param {{enabled:boolean, host:string, port:number}} listen
   */
  async #bindWithRetry(listen) {
    const maxAttempts = 8
    let lastError = null
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await this.#bindServer(listen)
      } catch (error) {
        lastError = error
        if (error?.code !== 'EADDRINUSE' || attempt === maxAttempts - 1) throw error
        await new Promise(resolve => setTimeout(resolve, 10 + attempt * 15))
      }
    }
    throw lastError
  }

  /** @param {{enabled:boolean, host:string, port:number}} listen */
  #listenView(listen) {
    const bound = this.#server !== null
    const address = bound ? this.#server.address?.() : null
    return {
      enabled: bound && listen.enabled === true,
      host: listen.host,
      port: bound && address !== null && typeof address === 'object' ? address.port : listen.port,
    }
  }

  // =====================================================================
  // 出站路由
  // =====================================================================

  /**
   * 向 peer 发请求（peer 离线时 reject ProtocolError('peer/offline')）。
   * @param {string} nodeId
   * @param {string} method
   * @param {unknown} [params]
   * @param {{timeoutMs?:number}} [options]
   * @returns {Promise<any>}
   */
  request(nodeId, method, params, options) {
    const link = this.#readyLinks.get(nodeId)
    if (link === undefined) {
      return Promise.reject(new ProtocolError('peer/offline', `peer ${nodeId} is offline`, { peerNodeId: nodeId }))
    }
    return link.request(method, params, options)
  }

  /**
   * 向 peer 发通知。
   * @param {string} nodeId
   * @param {string} method
   * @param {unknown} [params]
   * @returns {boolean}
   */
  notify(nodeId, method, params) {
    const link = this.#readyLinks.get(nodeId)
    return link === undefined ? false : link.notify(method, params)
  }

  /**
   * 向所有 ready link 广播通知。
   * @param {string} method
   * @param {unknown} [params]
   * @returns {number} 成功发出的链路数
   */
  broadcast(method, params) {
    let sent = 0
    for (const link of this.#readyLinks.values()) {
      try {
        if (link.notify(method, params)) sent += 1
      } catch (error) {
        this.#logger.warn(`[peer-manager] broadcast to ${link.peerNodeId} failed`, error)
      }
    }
    return sent
  }

  /**
   * 立即拨一个 peer（会取消该 peer 已排队的重连；等待 TCP 建连后返回 link）。
   * @param {string} nodeId
   * @returns {Promise<any|null>}
   */
  async dialNow(nodeId) {
    const peer = this.#peerConfigs.get(nodeId)
    if (peer === undefined) return null
    this.#clearDialTimer(nodeId)
    return this.#dial(peer)
  }

  /** 对每个没有 ready link 的 dial:'auto' peer 立即拨号（HTTP refresh 用）。 */
  async dialAllOffline() {
    const pending = []
    for (const peer of this.#peerConfigs.values()) {
      if (peer.dial !== 'auto') continue
      if (this.#readyLinks.has(peer.nodeId)) continue
      this.#clearDialTimer(peer.nodeId)
      pending.push(this.#dial(peer))
    }
    await Promise.allSettled(pending)
  }

  // =====================================================================
  // 运行时增删 peer（UI 配对 / 删除，SPEC §10.4-2）
  // =====================================================================

  /**
   * 运行时新增或更新一个 peer（同 nodeId 去重更新，不新增条目）。
   *
   * - 新增：注册配置；manager 已 start 且 dial:'auto' 时立即拨号；
   * - 更新：若 host/port/secret/dial 有变化，关闭该 peer 现有链路并按新配置
   *   重新拨号（dial:'off' 则只关链、停止拨号循环）；否则幂等无副作用；
   * - 不改动 manager 的监听端口，无需重启。
   *
   * @param {{nodeId:string, nodeName?:string, host?:string, port:number, secret:string,
   *   dial?:'auto'|'off', source?:string, addedAt?:number}} peerConfig
   * @returns {any|null} 归一化后的 peer（含 secret，便于调用方持久化）；非法/self 返回 null
   */
  addPeer(peerConfig) {
    const peer = this.#normalizePeer(peerConfig, { requireSecret: true })
    if (peer === null) return null
    const existing = this.#peerConfigs.get(peer.nodeId)
    if (existing === undefined) {
      this.#registerPeer(peer)
      this.#logger.info(
        `[peer-manager] peer added: ${peer.nodeId} (${peer.host}:${peer.port}, dial=${peer.dial}, source=${peer.source})`,
      )
      if (this.#started && peer.dial === 'auto') {
        this.#dial(peer).catch(error => this.#logger.warn(`[peer-manager] dial new peer ${peer.nodeId} failed`, error))
      }
      return { ...peer }
    }

    const connectionChanged = existing.host !== peer.host
      || existing.port !== peer.port
      || existing.secret !== peer.secret
    const dialChanged = existing.dial !== peer.dial
    // 原地更新（#dial 等异步任务持有的是同一个对象引用）。
    existing.nodeName = peer.nodeName
    existing.host = peer.host
    existing.port = peer.port
    existing.secret = peer.secret
    existing.dial = peer.dial
    existing.source = peer.source
    if (peer.addedAt !== undefined) existing.addedAt = peer.addedAt
    const entry = this.#entries.get(peer.nodeId)
    if (entry !== undefined) {
      entry.nodeName = peer.nodeName
      entry.dial = peer.dial
      entry.source = peer.source
      entry.removable = peer.source === 'paired'
    }
    if (!connectionChanged && !dialChanged) return { ...peer }

    this.#logger.info(
      `[peer-manager] peer updated: ${peer.nodeId} (${peer.host}:${peer.port}, dial=${peer.dial}, source=${peer.source})`,
    )
    if (dialChanged && peer.dial === 'off') this.#clearDialTimer(peer.nodeId)
    // 连接参数/拨号策略变了：关掉旧链路，让新配置重新建链（旧链路 close 后
    // 由 onLinkDown 负责重连，这里同时主动拨一次以缩短等待）。
    const existingLinks = [...this.#links].filter(link => link.peerNodeId === peer.nodeId)
    for (const link of existingLinks) {
      try {
        link.close('peer/updated')
      } catch (error) {
        this.#logger.warn(`[peer-manager] closing link of updated peer ${peer.nodeId} failed`, error)
      }
    }
    if (this.#started && peer.dial === 'auto') {
      this.#dialAttempts.set(peer.nodeId, 0)
      this.#dial(peer).catch(error => this.#logger.warn(`[peer-manager] re-dial updated peer ${peer.nodeId} failed`, error))
    }
    return { ...peer }
  }

  /**
   * 运行时移除一个 peer：停拨号循环、关闭该 peer 所有链路、删除配置与 state。
   * 幂等：不存在的 nodeId 返回 false。config 节点是否允许删除由 HTTP 层按
   * source 判断，manager 层不区分来源。
   * @param {string} nodeId
   * @returns {boolean} 是否确实移除了一个已注册 peer
   */
  removePeer(nodeId) {
    const peer = this.#peerConfigs.get(nodeId)
    if (peer === undefined) return false
    this.#clearDialTimer(nodeId)
    this.#dialAttempts.delete(nodeId)
    // 先删记账再关链：链路 onLinkDown 时 peer/entry 已不存在，不会触发重连。
    this.#unregisterPeer(nodeId)
    this.#readyLinks.delete(nodeId)
    const links = [...this.#links].filter(link => link.peerNodeId === nodeId)
    for (const link of links) {
      try {
        link.close('peer/removed')
      } catch (error) {
        this.#logger.warn(`[peer-manager] closing removed peer ${nodeId} link failed`, error)
      }
    }
    this.#logger.info(`[peer-manager] peer removed: ${nodeId}`)
    return true
  }

  // =====================================================================
  // 配置装载
  // =====================================================================

  /** @param {unknown[]} rawPeers */
  #loadPeers(rawPeers) {
    for (const raw of rawPeers) {
      const peer = this.#normalizePeer(raw, { requireSecret: false })
      if (peer === null) continue
      if (this.#peerConfigs.has(peer.nodeId)) {
        this.#logger.warn(`[peer-manager] duplicate peer ${peer.nodeId} in config; last one wins`)
        this.#unregisterPeer(peer.nodeId)
      }
      this.#registerPeer(peer)
    }
  }

  /**
   * 归一化一个 peer 配置（config.json / peers.json / UI 配对共用）。
   * @param {unknown} raw
   * @param {{requireSecret?:boolean}} [options]
   * @returns {any|null} 非法返回 null（并记 warn）
   */
  #normalizePeer(raw, options = {}) {
    const requireSecret = options.requireSecret === true
    if (!isRecord(raw)) {
      this.#logger.warn('[peer-manager] peer entry is not an object; skipped')
      return null
    }
    const nodeId = text(raw.nodeId, '')
    if (!isNodeId(nodeId)) {
      this.#logger.warn(`[peer-manager] invalid peer nodeId ${JSON.stringify(raw.nodeId)}; skipped`)
      return null
    }
    if (nodeId === this.#self.nodeId) {
      this.#logger.warn(`[peer-manager] peer ${nodeId} equals self; skipped`)
      return null
    }
    const port = Number(raw.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      this.#logger.warn(`[peer-manager] peer ${nodeId} has invalid port; skipped`)
      return null
    }
    const secret = typeof raw.secret === 'string' ? raw.secret : ''
    if (secret.length === 0) {
      if (requireSecret) {
        this.#logger.warn(`[peer-manager] peer ${nodeId} has empty secret; rejected`)
        return null
      }
      this.#logger.warn(`[peer-manager] peer ${nodeId} has empty secret; handshake will fail`)
    }
    const source = typeof raw.source === 'string' && raw.source !== '' ? raw.source : 'config'
    /** @type {Record<string, any>} */
    const peer = {
      nodeId,
      nodeName: text(raw.nodeName, nodeId),
      host: text(raw.host, '127.0.0.1'),
      port,
      secret,
      dial: raw.dial === 'off' ? 'off' : 'auto',
      source,
    }
    const addedAt = Number(raw.addedAt)
    if (Number.isFinite(addedAt)) peer.addedAt = addedAt
    return peer
  }

  /** @param {any} peer */
  #registerPeer(peer) {
    this.#peerConfigs.set(peer.nodeId, peer)
    if (!this.#peerOrder.includes(peer.nodeId)) this.#peerOrder.push(peer.nodeId)
    this.#entries.set(peer.nodeId, {
      nodeName: peer.nodeName,
      dial: peer.dial,
      source: peer.source ?? 'config',
      removable: (peer.source ?? 'config') === 'paired',
      state: 'offline',
      direction: null,
      linkId: undefined,
      lastSeen: null,
      rttMs: null,
      remote: null,
      error: null,
    })
  }

  /**
   * 仅移除 manager 内部记账（不动链路/不记日志），由 config 去重与 removePeer 复用。
   * @param {string} nodeId
   */
  #unregisterPeer(nodeId) {
    this.#peerConfigs.delete(nodeId)
    const index = this.#peerOrder.indexOf(nodeId)
    if (index >= 0) this.#peerOrder.splice(index, 1)
    this.#entries.delete(nodeId)
  }

  // =====================================================================
  // 监听
  // =====================================================================

  async #startServer() {
    await this.#bindServer(this.#listen)
  }

  /**
   * 在指定 listen 配置上创建监听 server。成功后写入 #server 并回填 port=0 的
   * 实际端口；失败时清理并抛出原始错误（EADDRINUSE / EACCES / ENOTFOUND 等）。
   * @param {{enabled:boolean, host:string, port:number}} listen
   */
  async #bindServer(listen) {
    const server = createServer(socket => this.#onInbound(socket))
    this.#server = server
    await new Promise((resolve, reject) => {
      const onError = error => {
        cleanup()
        this.#server = null
        try {
          server.close()
        } catch {
          /* ignore */
        }
        reject(error)
      }
      const onListening = () => {
        cleanup()
        resolve()
      }
      const cleanup = () => {
        server.off('error', onError)
        server.off('listening', onListening)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      try {
        server.listen(listen.port, listen.host)
      } catch (error) {
        cleanup()
        this.#server = null
        reject(error)
      }
    })
    const address = server.address()
    if (listen.port === 0 && address !== null && typeof address === 'object') listen.port = address.port
    server.on('error', error => {
      this.#logger.warn(`[peer-manager] listener error: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * 处理一个入站 TCP 连接。
   *
   * SPEC §10.4-1：创建 PeerLink 之前先调用 `handlers.onRawConnection(socket, proceed)`：
   *  - 返回 true：调用方接管 socket（**必须**自行关闭）。若调用方只想读字节判断、
   *    判定不是配对连接后再走正常握手，可在判定后 `socket.unshift(...)` 已读字节
   *    并调用 `proceed()`（同步/异步均可；proceed 幂等，重复调用无效）；
   *  - 返回 false / 未注册 hook / hook 抛错：立即走正常 PeerLink 监听握手。
   * @param {import('node:net').Socket} socket
   */
  #onInbound(socket) {
    try {
      if (!this.#started) {
        socket.destroy()
        return
      }
      socket.setNoDelay?.(true)
      // 防御：hook 接管期间 socket 出错也不能变成宿主进程的未捕获异常。
      socket.on('error', () => {})
      let proceeded = false
      /** @returns {any|null} 创建出来的 listener link（或 null） */
      const proceed = () => {
        if (proceeded) return null
        proceeded = true
        return this.#establishInboundLink(socket)
      }
      const hook = this.#handlers.onRawConnection
      if (typeof hook === 'function') {
        let handled = false
        try {
          handled = hook(socket, proceed) === true
        } catch (error) {
          this.#logger.warn('[peer-manager] onRawConnection hook failed; falling back to peer handshake', error)
          handled = false
        }
        if (handled) {
          this.#logger.debug(`[peer-manager] onRawConnection took over ${socket.remoteAddress ?? '?'}`)
          return
        }
      }
      proceed()
    } catch (error) {
      this.#logger.warn('[peer-manager] inbound connection setup failed', error)
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 为一个入站 socket 创建 listener 角色的 PeerLink（正常对等握手路径）。
   * @param {import('node:net').Socket} socket
   * @returns {any|null}
   */
  #establishInboundLink(socket) {
    try {
      if (!this.#started || socket.destroyed) {
        try {
          socket.destroy()
        } catch {
          /* ignore */
        }
        return null
      }
      const link = createPeerLink({
        socket,
        role: 'listener',
        nodeId: this.#self.nodeId,
        // listener 握手前不知道对端；hello 校验通过后由 resolver 落定 canonical linkId。
        linkId: peerNodeId => this.#canonicalLinkId(peerNodeId),
        secretFor: peerNodeId => this.#secretFor(peerNodeId),
        nodeName: this.#self.nodeName,
        instanceEpoch: this.#self.instanceEpoch,
        platform: this.#self.platform,
        ...(this.#capabilities === undefined ? {} : { capabilities: this.#capabilities }),
        ...(this.#limits === undefined ? {} : { limits: this.#limits }),
        logger: this.#logger,
        requestTimeoutMs: this.#requestTimeoutMs,
        heartbeatIntervalMs: this.#heartbeatIntervalMs,
        heartbeatTimeoutMs: this.#heartbeatTimeoutMs,
        nonceCache: this.#nonceCache,
        handlers: this.#linkHandlers(),
      })
      this.#links.add(link)
      this.#logger.debug(`[peer-manager] inbound connection from ${socket.remoteAddress ?? '?'} as ${link.linkId}`)
      return link
    } catch (error) {
      this.#logger.warn('[peer-manager] inbound link setup failed', error)
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      return null
    }
  }

  /** @param {string} peerNodeId */
  #secretFor(peerNodeId) {
    return this.#peerConfigs.get(peerNodeId)?.secret
  }

  /**
   * 链路 key：SPEC §3 约定 linkId = `<较小 nodeId>~<较大 nodeId>`，两侧一致。
   * @param {string} peerNodeId
   * @returns {string}
   */
  #canonicalLinkId(peerNodeId) {
    return [this.#self.nodeId, peerNodeId].sort().join('~')
  }

  /** 转发给每条 peer-link 的处理器；manager 的 handlers 原样转发（含 onBinary）。 */
  #linkHandlers() {
    const handlers = this.#handlers
    /** @type {Record<string, Function>} */
    const forwarded = {
      onUp: link => this.#handleLinkUp(link),
      onDown: (link, reason) => this.#handleLinkDown(link, reason),
    }
    if (typeof handlers.onRequest === 'function') {
      forwarded.onRequest = (link, method, params, ctx) => handlers.onRequest(link, method, params, ctx)
    }
    if (typeof handlers.onNotification === 'function') {
      forwarded.onNotification = (link, method, params) => {
        this.#invokeHandler('onNotification', link, method, params)
      }
    }
    if (typeof handlers.onBinary === 'function') {
      forwarded.onBinary = (link, header, payload) => {
        this.#invokeHandler('onBinary', link, header, payload)
      }
    }
    return forwarded
  }

  /** 调用一个上层 handler；同步异常与 async rejection 都吞掉并记日志。 */
  #invokeHandler(name, ...args) {
    const handler = this.#handlers[name]
    if (typeof handler !== 'function') return
    try {
      const result = handler(...args)
      if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
        result.then(undefined, error => {
          this.#logger.warn(`[peer-manager] ${name} handler rejected`, error)
        })
      }
    } catch (error) {
      this.#logger.warn(`[peer-manager] ${name} handler failed`, error)
    }
  }

  // =====================================================================
  // 链路 up / down：去重、状态、重连
  // =====================================================================

  /** @param {any} link */
  #handleLinkUp(link) {
    if (!this.#started) {
      link.close('stopped')
      return
    }
    const peerNodeId = link.peerNodeId
    if (!isNodeId(peerNodeId)) {
      link.close('auth/unknown-peer')
      return
    }
    const peer = this.#peerConfigs.get(peerNodeId)
    if (peer === undefined) {
      this.#logger.warn(`[peer-manager] link from unconfigured peer ${peerNodeId}; closing`)
      link.close('auth/unknown-peer')
      return
    }
    const entry = this.#entries.get(peerNodeId)

    // ---- 连接去重：只保留 dialerNodeId === canonicalDialer(self, peer) 的链路 ----
    const existing = this.#readyLinks.get(peerNodeId)
    /** @type {any} */
    let duplicateToClose = null
    if (existing !== undefined && existing !== link) {
      const dialerNodeId = link.direction === 'outbound' ? this.#self.nodeId : peerNodeId
      const canonical = canonicalDialer(this.#self.nodeId, peerNodeId)
      const candidateIsCanonical = dialerNodeId === canonical
      if (!candidateIsCanonical) {
        this.#logger.info(
          `[peer-manager] dedupe ${peerNodeId}: reject ${link.linkId} (${link.direction}) as peer/duplicate, keep ${existing.linkId}`,
        )
        try {
          link.close('peer/duplicate')
        } catch (error) {
          this.#logger.warn('[peer-manager] rejecting duplicate link failed', error)
        }
        return
      }
      // canonical 候选胜出：先注册候选、再关旧链路，保证旧链路的 onLinkDown
      // 到达上层时 linkFor(peer) 已经指向新链路（上层据此避免把会话标 offline）。
      duplicateToClose = existing
      this.#stopPing(existing)
      this.#logger.info(
        `[peer-manager] dedupe ${peerNodeId}: keep ${link.linkId} (${link.direction}), close ${existing.linkId} (${existing.direction}) as peer/duplicate`,
      )
    }

    this.#readyLinks.set(peerNodeId, link)
    this.#links.add(link)
    this.#clearDialTimer(peerNodeId)
    this.#dialAttempts.set(peerNodeId, 0)
    if (entry !== undefined) {
      entry.state = 'online'
      entry.direction = link.direction === 'outbound' ? 'out' : 'in'
      entry.linkId = link.linkId
      entry.lastSeen = link.lastSeen
      entry.rttMs = typeof link.rttMs === 'number' ? link.rttMs : null
      entry.remote = normalizeRemote(link.remote, peerNodeId, peer.nodeName)
      entry.error = null
    }
    this.#startPing(link)
    this.#announcedLinks.add(link)
    if (duplicateToClose !== null) {
      try {
        duplicateToClose.close('peer/duplicate')
      } catch (error) {
        this.#logger.warn('[peer-manager] closing duplicate link failed', error)
      }
    }
    this.#logger.info(
      `[peer-manager] link up: ${this.#self.nodeId} <-> ${peerNodeId} (${link.direction}, ${link.linkId})`,
    )
    this.#invokeHandler('onLinkUp', link)
    this.#maybeUpgradeCanonical(peer, link)
  }

  /**
   * 规范方向升级（SPEC §3.5：较小 nodeId 拨出的连接获胜）。
   *
   * 双方同时互拨时存在竞态：canonical 一侧可能先收到对端拨入的非 canonical 链路，
   * 而自己的 canonical outbound 尚未建立/已失败。若就此停留，双方都不会再重拨，
   * 会一直停留在 fallback 方向。这里在「本端是 canonical dialer 且当前链路是
   * inbound」时，主动补拨一次 canonical 方向；成功后由去重规则替换旧链路，
   * 失败则保留当前可用链路并继续按退避重试（不影响可用性）。
   * @param {any} peer
   * @param {any} link
   */
  #maybeUpgradeCanonical(peer, link) {
    if (!this.#started) return
    if (peer.dial !== 'auto') return
    if (link.direction !== 'inbound') return
    let canonical
    try {
      canonical = canonicalDialer(this.#self.nodeId, peer.nodeId)
    } catch {
      return
    }
    if (canonical !== this.#self.nodeId) return
    // 稍延迟，给同时进行的 outbound 握手一个落定窗口（若它已经在路上，
    // #dial 会直接复用它；若它最终失败，这里就是 canonical 方向的重试起点）。
    this.#logger.debug(`[peer-manager] schedule canonical upgrade dial for ${peer.nodeId} (current link is non-canonical inbound)`)
    this.#scheduleDial(peer, CANONICAL_UPGRADE_DELAY_MS)
  }

  /** @param {any} link @param {string} reason */
  #handleLinkDown(link, reason) {
    this.#links.delete(link)
    this.#stopPing(link)
    // 只有转发过 onLinkUp 的链路才转发 onLinkDown，保证上层看到的 up/down 成对；
    // 去重时被拒的候选连接从未 onLinkUp，它的关闭只体现在 manager 日志与 state 里。
    const wasAnnounced = this.#announcedLinks.delete(link)
    const peerNodeId = link.peerNodeId
    if (!isNodeId(peerNodeId)) return
    const peer = this.#peerConfigs.get(peerNodeId)
    const entry = this.#entries.get(peerNodeId)
    const wasActive = this.#readyLinks.get(peerNodeId) === link
    if (wasActive) {
      this.#readyLinks.delete(peerNodeId)
      if (entry !== undefined) {
        entry.state = isAuthFailureReason(reason) ? 'error' : 'offline'
        entry.direction = null
        entry.linkId = undefined
        entry.lastSeen = link.lastSeen
        entry.rttMs = null
        entry.remote = null
        entry.error = typeof reason === 'string' && reason !== '' ? reason : 'link/closed'
      }
      this.#logger.info(`[peer-manager] link down: ${peerNodeId} (${reason})`)
    } else if (entry !== undefined && link.direction === 'outbound' && !this.#readyLinks.has(peerNodeId)) {
      // 拨号出去但握手失败：记 error 供 UI 展示（随后自动重连）。
      entry.state = 'error'
      entry.direction = null
      entry.linkId = undefined
      entry.error = typeof reason === 'string' && reason !== '' ? reason : 'handshake failed'
    }
    if (wasAnnounced) this.#invokeHandler('onLinkDown', link, reason)
    if (peer !== undefined && peer.dial === 'auto' && this.#started && !this.#readyLinks.has(peerNodeId)) {
      this.#scheduleReconnect(peer, reason)
    } else if (peer !== undefined && link.direction === 'outbound') {
      // canonical 补偿拨号失败（仍有 inbound fallback 链路）→ 继续按退避重试。
      this.#maybeRetryCanonicalUpgrade(peer)
    }
  }

  /**
   * canonical 升级拨号失败后的重试：当前仍持有该 peer 的 inbound fallback
   * 链路时，本端（canonical dialer）继续按退避补拨 canonical 方向。
   * @param {any} peer
   */
  #maybeRetryCanonicalUpgrade(peer) {
    if (!this.#started || peer.dial !== 'auto') return
    const active = this.#readyLinks.get(peer.nodeId)
    if (active === undefined || active.direction !== 'inbound') return
    let canonical
    try {
      canonical = canonicalDialer(this.#self.nodeId, peer.nodeId)
    } catch {
      return
    }
    if (canonical !== this.#self.nodeId) return
    this.#scheduleDial(peer, this.#nextBackoff(peer.nodeId))
  }

  /**
   * 安排一次重连：正常断链按 1/2/5/10/30s 退避；因连接去重被关闭的链路
   * 至少静默 3s 再拨（SPEC §5.9：3s 内不因重复关闭立即重拨，避免抖动）。
   * @param {any} peer
   * @param {string} reason
   */
  #scheduleReconnect(peer, reason) {
    const duplicate = typeof reason === 'string' && reason.includes('duplicate')
    let delay = this.#nextBackoff(peer.nodeId)
    if (duplicate) delay = Math.max(delay, DUPLICATE_QUIET_MS)
    this.#scheduleDial(peer, delay)
    this.#logger.debug(`[peer-manager] reconnect ${peer.nodeId} in ${delay}ms (${reason})`)
  }

  /** @param {string} peerNodeId @returns {number} */
  #nextBackoff(peerNodeId) {
    const attempt = this.#dialAttempts.get(peerNodeId) ?? 0
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]
    this.#dialAttempts.set(peerNodeId, attempt + 1)
    return delay
  }

  /** @param {any} peer @param {number} delay */
  #scheduleDial(peer, delay) {
    if (!this.#started) return
    this.#clearDialTimer(peer.nodeId)
    const timer = setTimeout(() => {
      this.#dialTimers.delete(peer.nodeId)
      this.#dial(peer).catch(error => this.#logger.warn(`[peer-manager] reconnect dial ${peer.nodeId} failed`, error))
    }, Math.max(0, delay))
    timer.unref?.()
    this.#dialTimers.set(peer.nodeId, timer)
  }

  /** @param {string} peerNodeId */
  #clearDialTimer(peerNodeId) {
    const timer = this.#dialTimers.get(peerNodeId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.#dialTimers.delete(peerNodeId)
    }
  }

  /**
   * 找到一个自己发起的、尚未关闭的该 peer 链路（用于避免并发重复拨号）。
   * @param {string} peerNodeId
   * @returns {any|undefined}
   */
  #openOutboundLink(peerNodeId) {
    for (const link of this.#links) {
      if (link.state === 'closed') continue
      if (link.direction === 'outbound' && link.peerNodeId === peerNodeId) return link
    }
    return undefined
  }

  // =====================================================================
  // 拨号
  // =====================================================================

  /**
   * 拨号：同一 peer 同时只允许一个拨号任务；建立 TCP 后创建 dialer peer-link，
   * 握手在 link 内部继续（不等待 ready）。
   * @param {any} peer
   * @returns {Promise<any|null>}
   */
  #dial(peer) {
    if (!this.#started) return Promise.resolve(null)
    const existing = this.#openOutboundLink(peer.nodeId)
    if (existing !== undefined) return Promise.resolve(existing)
    const inFlight = this.#dialing.get(peer.nodeId)
    if (inFlight !== undefined) return inFlight
    const promise = this.#doDial(peer)
    this.#dialing.set(peer.nodeId, promise)
    return promise.finally(() => {
      this.#dialing.delete(peer.nodeId)
    })
  }

  /** @param {any} peer @returns {Promise<any|null>} */
  async #doDial(peer) {
    this.#clearDialTimer(peer.nodeId)
    const entry = this.#entries.get(peer.nodeId)
    if (entry !== undefined) {
      entry.state = 'dialing'
      entry.error = null
    }
    const socket = new Socket()
    try {
      socket.setNoDelay?.(true)
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          socket.off('error', onError)
          socket.off('connect', onConnect)
        }
        const onError = error => {
          cleanup()
          reject(error)
        }
        const onConnect = () => {
          cleanup()
          resolve(undefined)
        }
        socket.once('error', onError)
        socket.once('connect', onConnect)
        try {
          socket.connect({ host: peer.host, port: peer.port })
        } catch (error) {
          cleanup()
          reject(error)
        }
      })
    } catch (error) {
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      const message = error instanceof Error ? error.message : String(error)
      const code = error?.code !== undefined ? String(error.code) : ''
      if (entry !== undefined) {
        entry.state = 'error'
        entry.error = `connect failed${code ? ` (${code})` : ''}: ${message}`
      }
      this.#logger.warn(`[peer-manager] dial ${peer.nodeId} ${peer.host}:${peer.port} failed: ${message}`)
      if (this.#started && peer.dial === 'auto' && !this.#readyLinks.has(peer.nodeId)) {
        this.#scheduleDial(peer, this.#nextBackoff(peer.nodeId))
      } else {
        this.#maybeRetryCanonicalUpgrade(peer)
      }
      return null
    }
    if (!this.#started || !this.#peerConfigs.has(peer.nodeId)) {
      // manager 已 stop / peer 在拨号期间被 removePeer：丢弃这条连接。
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      return null
    }
    let link
    try {
      link = createPeerLink({
        socket,
        role: 'dialer',
        nodeId: this.#self.nodeId,
        peerNodeId: peer.nodeId,
        linkId: this.#canonicalLinkId(peer.nodeId),
        secret: peer.secret,
        secretFor: peerNodeId => this.#secretFor(peerNodeId),
        nodeName: this.#self.nodeName,
        instanceEpoch: this.#self.instanceEpoch,
        platform: this.#self.platform,
        ...(this.#capabilities === undefined ? {} : { capabilities: this.#capabilities }),
        logger: this.#logger,
        requestTimeoutMs: this.#requestTimeoutMs,
        heartbeatIntervalMs: this.#heartbeatIntervalMs,
        heartbeatTimeoutMs: this.#heartbeatTimeoutMs,
        nonceCache: this.#nonceCache,
        handlers: this.#linkHandlers(),
      })
    } catch (error) {
      const protocol = asProtocolError(error)
      this.#logger.warn(`[peer-manager] dial ${peer.nodeId} link setup failed: ${protocol.message}`)
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
      if (entry !== undefined) {
        entry.state = 'error'
        entry.error = protocol.message
      }
      if (this.#started && peer.dial === 'auto') this.#scheduleDial(peer, this.#nextBackoff(peer.nodeId))
      return null
    }
    this.#links.add(link)
    this.#logger.debug(`[peer-manager] dialed ${peer.nodeId} (${peer.host}:${peer.port}) as ${link.linkId}`)
    return link
  }

  // =====================================================================
  // rtt 测量
  // =====================================================================

  /** 链路 up 后立即 ping 一次，之后每 rttIntervalMs 一次；ping 失败只记日志。 */
  #startPing(link) {
    this.#stopPing(link)
    const peerNodeId = link.peerNodeId
    const tick = () => {
      if (!link.isReady() || this.#readyLinks.get(peerNodeId) !== link) return
      const startedAt = Date.now()
      link.request('peer.ping', {}, { timeoutMs: Math.min(this.#requestTimeoutMs, 5000) })
        .then(() => {
          if (!link.isReady() || this.#readyLinks.get(peerNodeId) !== link) return
          const entry = this.#entries.get(peerNodeId)
          if (entry !== undefined) {
            entry.rttMs = Math.max(0, Date.now() - startedAt)
            entry.lastSeen = link.lastSeen
          }
        })
        .catch(error => {
          // ping 超时/失败不代表链路已死：心跳负责判死，这里只记 debug。
          this.#logger.debug(
            `[peer-manager] peer.ping ${peerNodeId} failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
    }
    tick()
    const interval = Math.max(50, this.#rttIntervalMs)
    const timer = setInterval(tick, interval)
    timer.unref?.()
    this.#pingTimers.set(link, timer)
  }

  /** @param {any} link */
  #stopPing(link) {
    const timer = this.#pingTimers.get(link)
    if (timer !== undefined) {
      clearInterval(timer)
      this.#pingTimers.delete(link)
    }
  }

  // =====================================================================
  // 日志
  // =====================================================================

  /** @param {'debug'|'info'|'warn'|'error'} level */
  #log(level, ...args) {
    this.#logger[level](...args)
  }
}

/**
 * 归一化 remote 视图给 UI：{nodeId, nodeName, platform}。
 * @param {any} remote
 * @param {string} peerNodeId
 * @param {string} fallbackName
 */
function normalizeRemote(remote, peerNodeId, fallbackName) {
  if (!isRecord(remote)) return null
  return {
    nodeId: typeof remote.nodeId === 'string' ? remote.nodeId : peerNodeId,
    nodeName: typeof remote.nodeName === 'string' ? remote.nodeName : fallbackName,
    platform: typeof remote.platform === 'string' ? remote.platform : 'unknown',
  }
}

/**
 * 创建对等连接管理器（SPEC §5.9）。
 * @param {object} options
 * @param {Record<string, any>} options.config
 * @param {string} [options.instanceEpoch]
 * @param {object} [options.logger]
 * @param {object} [options.handlers] 见类 JSDoc；含 onRawConnection(socket, proceed)
 * @param {import('./handshake.js').NonceCache} [options.nonceCache]
 * @returns {PeerManager} 额外提供运行时 addPeer(peerConfig) / removePeer(nodeId)
 *   / setListen({enabled,host,port}) / listenInfo()
 */
export function createPeerManager(options) {
  return new PeerManager(options)
}

export { PeerManager }

export default createPeerManager
