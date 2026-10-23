/**
 * Session bridge for remotenode.
 *
 * Two roles on one link:
 *   - host side: a peer asked us to create a session here; we create a real DSH
 *     session through ctx.sessionController, drive it, and forward its durable
 *     events back as `event.session` notifications.
 *   - initiator side: we created the session on the peer; we record the
 *     transcript locally, forward prompts/cancel, and re-attach after reconnects.
 *
 * Everything here is defensive: a bridge bug must never break the local session
 * or the peer link.
 */

import { randomUUID } from 'node:crypto'

/** Max text kept from one event projection (bytes-safe enough for JSON frames). */
const TEXT_CLIP = 8000
/** Max projected events kept in memory per session. */
const MAX_EVENTS_IN_MEMORY = 400
/** Durable save debounce. */
const SAVE_DELAY_MS = 800

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value */
function oneLine(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

/** @param {unknown} message */
function messageText(message) {
  if (!isRecord(message)) return ''
  const content = Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (isRecord(block) && block.type === 'reasoning' && typeof block.text === 'string') parts.push(block.text)
    else if (isRecord(block) && block.type === 'image') parts.push('[image]')
    else if (isRecord(block) && block.type === 'file') parts.push('[file]')
  }
  return parts.join('\n')
}

/** @param {string} text @param {number} [limit] */
function clip(text, limit = TEXT_CLIP) {
  const value = typeof text === 'string' ? text : ''
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

/** Stable file stem for one session key. */
export function transcriptStem(key) {
  return String(key).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160)
}

/**
 * Project one durable SessionEvent into the compact wire shape the panel renders.
 * @param {{type:string, seq:number, time:number, data:any}} event
 * @returns {Record<string, unknown> | null}
 */
export function projectSessionEvent(event) {
  if (!isRecord(event) || typeof event.type !== 'string') return null
  const base = { seq: event.seq, time: event.time, type: event.type }
  const data = isRecord(event.data) ? event.data : {}
  switch (event.type) {
    case 'user/message':
      return { ...base, role: 'user', text: clip(messageText(data)) }
    case 'assistant/message': {
      const message = isRecord(data.message) ? data.message : {}
      return {
        ...base,
        role: 'assistant',
        text: clip(messageText(message)),
        ...(isRecord(data.usage) ? { usage: data.usage } : {}),
      }
    }
    case 'tool/call':
      return { ...base, role: 'tool-call', name: oneLine(data.name), args: clip(typeof data.arguments === 'string' ? data.arguments : '') }
    case 'tool/result': {
      const message = isRecord(data.message) ? data.message : {}
      return {
        ...base,
        role: 'tool-result',
        text: clip(messageText(message), 2000),
        isError: message.isError === true || data.error !== undefined,
      }
    }
    case 'deliverables/presented': {
      const files = Array.isArray(data.files) ? data.files : []
      return {
        ...base,
        role: 'deliverable',
        files: files.slice(0, 16).map(file => ({
          path: oneLine(isRecord(file) ? file.path : ''),
          ...(isRecord(file) && typeof file.description === 'string' ? { description: file.description } : {}),
        })),
      }
    }
    case 'turn/start':
      return { ...base, turn: Number(data.turn) || 0 }
    case 'turn/end':
      return { ...base, turn: Number(data.turn) || 0, reason: oneLine(data.reason?.kind) }
    case 'step/start':
      return { ...base, turn: Number(data.turn) || 0, step: Number(data.step) || 0 }
    case 'step/end':
      return { ...base, turn: Number(data.turn) || 0, step: Number(data.step) || 0 }
    default:
      return null
  }
}

/** Title from the first user text of a projection, else a generic label. */
function titleFor(events, fallback) {
  for (const event of events) {
    if (event && event.role === 'user' && typeof event.text === 'string' && event.text.trim() !== '') {
      const line = oneLine(event.text)
      if (line !== '') return line.length > 48 ? `${line.slice(0, 47)}…` : line
    }
  }
  return fallback
}

/**
 * Create the session bridge.
 * @param {{
 *   self: {nodeId:string, nodeName:string},
 *   config: Record<string, any>,
 *   store: ReturnType<import('./store.js').createStore>,
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   logger: Console,
 *   onPresented?: (record: any, event: any) => void,
 * }} options
 */
export function createSessionBridge(options) {
  const { self, config, store, ctx, logger } = options
  const onPresented = typeof options.onPresented === 'function' ? options.onPresented : () => {}

  /** key = `${linkId}:${linkSessionId}` */
  const records = new Map()
  /** local session id -> inbound record */
  const inboundByLocal = new Map()
  /** `${linkId}:${linkSessionId}` -> outbound record (same map as records filtered) */
  let saveTimer = null

  function sessionController() {
    const service = typeof ctx.get === 'function' ? ctx.get('sessionController') : undefined
    return service
  }

  /**
   * Canonical link id: both sides must derive the same string from the two node
   * ids (smaller first), independent of which peer's link object this is.
   */
  function linkIdOf(link) {
    const peer = typeof link?.peerNodeId === 'string' ? link.peerNodeId : ''
    if (peer !== '') return [String(self.nodeId), String(peer)].sort().join('~')
    return typeof link?.linkId === 'string' ? link.linkId : ''
  }

  function linksFor(key) {
    return records.get(key) ?? null
  }

  function view(record) {
    return {
      id: record.key,
      linkId: record.linkId,
      linkSessionId: record.linkSessionId,
      peerNodeId: record.peerNodeId,
      direction: record.direction,
      state: record.state,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastSeq: record.lastSeq,
      error: record.error ?? null,
      deliverableCount: record.deliverableCount ?? 0,
    }
  }

  function scheduleSave() {
    if (saveTimer !== null) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveNow()
    }, SAVE_DELAY_MS)
    if (typeof saveTimer.unref === 'function') saveTimer.unref()
  }

  function outboundFile() {
    return 'outbound.json'
  }

  function inboundFile() {
    return 'inbound.json'
  }

  function persistRecord(record) {
    if (record.direction === 'outbound') {
      const list = [...records.values()].filter(item => item.direction === 'outbound').map(item => ({
        key: item.key,
        linkId: item.linkId,
        linkSessionId: item.linkSessionId,
        peerNodeId: item.peerNodeId,
        direction: 'outbound',
        state: item.state,
        title: item.title,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        lastSeq: item.lastSeq,
        error: item.error ?? null,
        deliverableCount: item.deliverableCount ?? 0,
      }))
      try { store.writeJson(outboundFile(), list) } catch (error) { logger.warn?.('[remotenode] persist outbound failed', error) }
      return
    }
    const list = [...records.values()].filter(item => item.direction === 'inbound').map(item => ({
      key: item.key,
      linkId: item.linkId,
      linkSessionId: item.linkSessionId,
      peerNodeId: item.peerNodeId,
      direction: 'inbound',
      localSessionId: item.localSessionId,
      state: item.state,
      title: item.title,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      lastSeq: item.lastSeq,
      error: item.error ?? null,
      deliverableCount: item.deliverableCount ?? 0,
    }))
    try { store.writeJson(inboundFile(), list) } catch (error) { logger.warn?.('[remotenode] persist inbound failed', error) }
  }

  function saveNow() {
    for (const record of records.values()) persistRecord(record)
  }

  /** Append one projected event to a record + its transcript file. */
  function appendEvent(record, projected) {
    if (!isRecord(projected)) return
    const seq = Number(projected.seq)
    if (Number.isInteger(seq) && seq <= (record.lastSeq ?? 0) && record.direction === 'outbound') {
      // Re-attach replay can overlap the tail already stored.
      if (record.events.some(event => Number(event.seq) === seq)) return
    }
    record.events.push(projected)
    if (record.events.length > MAX_EVENTS_IN_MEMORY) record.events.splice(0, record.events.length - MAX_EVENTS_IN_MEMORY)
    if (Number.isInteger(seq) && seq > (record.lastSeq ?? 0)) record.lastSeq = seq
    record.updatedAt = Date.now()
    if (record.title.startsWith('远程会话')) {
      const next = titleFor(record.events, record.title)
      if (next !== record.title) record.title = next
    }
    try {
      store.appendJsonl(`transcripts/${transcriptStem(record.key)}.jsonl`, projected)
    } catch (error) {
      logger.warn?.('[remotenode] append transcript failed', error)
    }
    scheduleSave()
  }

  /** Load persisted outbound/inbound records. */
  function load() {
    for (const raw of readList(outboundFile())) {
      if (!isRecord(raw) || typeof raw.key !== 'string') continue
      const record = {
        key: raw.key,
        linkId: String(raw.linkId ?? ''),
        linkSessionId: String(raw.linkSessionId ?? ''),
        peerNodeId: String(raw.peerNodeId ?? ''),
        direction: 'outbound',
        state: raw.state === 'running' ? 'offline' : (typeof raw.state === 'string' ? raw.state : 'offline'),
        title: typeof raw.title === 'string' ? raw.title : '远程会话',
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now(),
        lastSeq: Number(raw.lastSeq) || 0,
        error: null,
        events: [],
        link: null,
      }
      if (record.state === 'running' || record.state === 'idle') record.state = 'offline'
      record.events = readTranscript(record.key)
      records.set(record.key, record)
    }
    for (const raw of readList(inboundFile())) {
      if (!isRecord(raw) || typeof raw.key !== 'string') continue
      const localSessionId = String(raw.localSessionId ?? '')
      if (localSessionId === '') continue
      const record = {
        key: raw.key,
        linkId: String(raw.linkId ?? ''),
        linkSessionId: String(raw.linkSessionId ?? ''),
        peerNodeId: String(raw.peerNodeId ?? ''),
        direction: 'inbound',
        localSessionId,
        state: typeof raw.state === 'string' ? raw.state : 'offline',
        title: typeof raw.title === 'string' ? raw.title : '远程会话',
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now(),
        lastSeq: 0,
        error: null,
        events: [],
        link: null,
      }
      if (record.state === 'running' || record.state === 'idle') record.state = 'offline'
      records.set(record.key, record)
      inboundByLocal.set(localSessionId, record)
    }
    if (records.size > 0) logger.info?.(`[remotenode] loaded ${records.size} remote session record(s)`)
  }

  function readList(file) {
    try {
      const value = store.readJson(file, [])
      return Array.isArray(value) ? value : []
    } catch (error) {
      logger.warn?.(`[remotenode] read ${file} failed`, error)
      return []
    }
  }

  function readTranscript(key) {
    try {
      const rows = store.readJsonl(`transcripts/${transcriptStem(key)}.jsonl`)
      const events = []
      const seen = new Set()
      for (const row of rows) {
        if (!isRecord(row)) continue
        const seq = Number(row.seq)
        if (Number.isInteger(seq)) {
          if (seen.has(seq)) continue
          seen.add(seq)
        }
        events.push(row)
      }
      events.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))
      return events.length > MAX_EVENTS_IN_MEMORY ? events.slice(-MAX_EVENTS_IN_MEMORY) : events
    } catch (error) {
      logger.warn?.('[remotenode] read transcript failed', error)
      return []
    }
  }

  /** Re-attach one outbound session to its (current) link, with a small retry. */
  async function attachOutbound(record) {
    const link = record.link
    if (!isRecord(link) || typeof link.request !== 'function') return
    record.state = 'starting'
    try {
      const result = await link.request('session.attach', {
        linkSessionId: record.linkSessionId,
        fromSeq: record.lastSeq ?? 0,
      }, { timeoutMs: 20000 })
      if (isRecord(result) && result.ok !== false) {
        const events = Array.isArray(result.events) ? result.events : []
        for (const event of events) appendEvent(record, event)
        record.state = typeof result.state === 'string' ? result.state : 'idle'
        record.error = null
        record.attachAttempts = 0
      } else {
        throw new Error(typeof result?.error === 'string' ? result.error : 'attach failed')
      }
    } catch (error) {
      record.error = String(error?.message ?? error)
      record.attachAttempts = (record.attachAttempts ?? 0) + 1
      const stillCurrent = record.link === link && (typeof link.isReady !== 'function' || link.isReady())
      if (stillCurrent && record.attachAttempts <= 3) {
        const timer = setTimeout(() => { void attachOutbound(record) }, 1500)
        if (typeof timer.unref === 'function') timer.unref()
        return
      }
      record.state = 'error'
    }
    record.updatedAt = Date.now()
    persistRecord(record)
  }

  /** Peer link is ready: re-attach every outbound session it hosts. */
  async function onLinkUp(link) {
    if (!isRecord(link)) return
    for (const record of records.values()) {
      if (record.linkId !== linkIdOf(link)) continue
      if (record.direction === 'inbound') {
        record.link = link
        if (record.state === 'offline') record.state = 'idle'
        continue
      }
      record.link = link
      record.attachAttempts = 0
      void attachOutbound(record)
    }
    scheduleSave()
  }

  /** Peer link is gone: nothing is lost, sessions become offline until re-attach. */
  function onLinkDown(link, reason) {
    if (!isRecord(link)) return
    for (const record of records.values()) {
      if (record.linkId !== linkIdOf(link)) continue
      record.link = null
      if (record.state === 'offline') continue
      record.state = 'offline'
      record.error = reason === undefined ? null : String(reason)
      record.updatedAt = Date.now()
      persistRecord(record)
    }
  }

  /** Session events on the host side, forwarded to the initiator. */
  function onSessionEvent(session, event) {
    try {
      const localSessionId = session?.id
      if (typeof localSessionId !== 'string') return
      const record = inboundByLocal.get(localSessionId)
      if (record === undefined) return
      const projected = projectSessionEvent(event)
      if (projected === null) return
      appendEvent(record, projected)
      if (event.type === 'deliverables/presented') {
        try { onPresented(record, event) } catch (error) { logger.warn?.('[remotenode] publish presented failed', error) }
      }
      const link = record.link
      if (link !== null && link !== undefined && typeof link.isReady === 'function' && link.isReady()) {
        try { link.notify('event.session', { linkSessionId: record.linkSessionId, event: projected }) } catch (error) {
          logger.warn?.('[remotenode] forward event failed', error)
        }
      }
    } catch (error) {
      logger.warn?.('[remotenode] session event handler failed', error)
    }
  }

  /** Running state changes on the host side. */
  function onSessionStatus(sessionId, running) {
    try {
      const record = inboundByLocal.get(sessionId)
      if (record === undefined) return
      record.state = running ? 'running' : 'idle'
      record.updatedAt = Date.now()
      const link = record.link
      if (link !== null && link !== undefined && typeof link.isReady === 'function' && link.isReady()) {
        try { link.notify('session.state', { linkSessionId: record.linkSessionId, state: record.state }) } catch {}
      }
      persistRecord(record)
    } catch (error) {
      logger.warn?.('[remotenode] session status handler failed', error)
    }
  }

  // ---- initiator side ------------------------------------------------------

  /** Create a session on the peer and optionally send its first prompt. */
  async function startRemoteSession(link, input = {}) {
    if (!isRecord(link) || typeof link.request !== 'function') throw new Error('peer link is not ready')
    const promptText = typeof input.prompt === 'string' && input.prompt.trim() !== '' ? input.prompt : ''
    const linkSessionId = `${self.nodeId}:${randomUUID()}`
    const key = `${linkIdOf(link)}:${linkSessionId}`
    const now = Date.now()
    const record = {
      key,
      linkId: linkIdOf(link),
      linkSessionId,
      peerNodeId: link.peerNodeId,
      direction: 'outbound',
      state: 'starting',
      title: promptText === '' ? '远程会话' : titleFor([{ role: 'user', text: promptText }], '远程会话'),
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
      error: null,
      events: [],
      deliverableCount: 0,
      link,
    }
    records.set(key, record)
    persistRecord(record)
    let result
    try {
      result = await link.request('session.create', {
        linkSessionId,
        ...(typeof input.cwd === 'string' && input.cwd !== '' ? { cwd: input.cwd } : {}),
        ...(promptText === '' ? {} : {
          prompt: { requestId: `${linkSessionId}:p1`, text: promptText },
        }),
      }, { timeoutMs: 30000 })
    } catch (error) {
      record.state = 'error'
      record.error = String(error?.message ?? error)
      persistRecord(record)
      throw error
    }
    if (isRecord(result) && result.ok === false) {
      record.state = 'error'
      record.error = String(result.error ?? 'session.create failed')
      persistRecord(record)
      throw new Error(record.error)
    }
    record.state = promptText === '' ? 'idle' : 'running'
    record.updatedAt = Date.now()
    if (isRecord(result) && typeof result.title === 'string' && result.title !== '') record.title = result.title
    persistRecord(record)
    return view(record)
  }

  /** Send another prompt to a remote session. */
  async function promptRemote(sessionId, text, mode = 'queue') {
    const record = records.get(sessionId)
    if (record === undefined) throw new Error('unknown remote session')
    if (record.direction !== 'outbound') throw new Error('session is hosted here; prompt it through the local session')
    const value = typeof text === 'string' ? text.trim() : ''
    if (value === '') throw new Error('prompt text is empty')
    const link = record.link
    if (link === null || typeof link?.request !== 'function' || (typeof link.isReady === 'function' && !link.isReady())) {
      throw new Error('peer link is offline')
    }
    const requestId = `${record.linkSessionId}:p${Date.now().toString(36)}`
    await link.request('session.prompt', {
      linkSessionId: record.linkSessionId,
      requestId,
      text: value,
      mode: mode === 'steer' ? 'steer' : 'queue',
    }, { timeoutMs: 30000 })
    record.state = 'running'
    record.updatedAt = Date.now()
    persistRecord(record)
    return view(record)
  }

  /** Cancel the active turn of a remote session. */
  async function cancelRemote(sessionId) {
    const record = records.get(sessionId)
    if (record === undefined) throw new Error('unknown remote session')
    if (record.direction !== 'outbound') throw new Error('session is hosted here')
    const link = record.link
    if (link === null || typeof link?.request !== 'function') throw new Error('peer link is offline')
    await link.request('session.cancel', { linkSessionId: record.linkSessionId }, { timeoutMs: 20000 })
    record.state = 'idle'
    record.updatedAt = Date.now()
    persistRecord(record)
    return view(record)
  }

  // ---- host side requests --------------------------------------------------

  function requireSessionController() {
    const service = sessionController()
    if (service === undefined) throw new Error('sessionController is unavailable in this profile')
    return service
  }

  async function handleCreate(link, params) {
    const linkSessionId = typeof params.linkSessionId === 'string' ? params.linkSessionId : ''
    if (linkSessionId === '') throw new Error('session.create requires linkSessionId')
    const controller = requireSessionController()
    const cwd = typeof params.cwd === 'string' && params.cwd !== '' ? params.cwd : config.workspace
    const key = `${linkIdOf(link)}:${linkSessionId}`
    if (records.has(key)) {
      return { ok: true, linkSessionId, duplicate: true }
    }
    const created = await controller.create({ cwd })
    const localSessionId = String(created?.sessionId ?? '')
    if (localSessionId === '') throw new Error('session create returned no session id')
    const now = Date.now()
    const record = {
      key,
      linkId: linkIdOf(link),
      linkSessionId,
      peerNodeId: link.peerNodeId,
      direction: 'inbound',
      localSessionId,
      state: 'idle',
      title: '远程会话',
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
      error: null,
      events: [],
      deliverableCount: 0,
      link,
    }
    records.set(key, record)
    inboundByLocal.set(localSessionId, record)
    persistRecord(record)
    if (isRecord(params.prompt) && typeof params.prompt.text === 'string' && params.prompt.text.trim() !== '') {
      await controller.prompt({
        requestId: String(params.prompt.requestId ?? `${linkSessionId}:p1`),
        sessionId: localSessionId,
        mode: 'queue',
        content: [{ type: 'text', text: params.prompt.text }],
        clientTimeZone: 'Asia/Shanghai',
      }, new AbortController().signal)
      record.state = 'running'
      record.updatedAt = Date.now()
      persistRecord(record)
    }
    return { ok: true, linkSessionId, title: record.title }
  }

  function requireInbound(link, params) {
    const linkSessionId = typeof params.linkSessionId === 'string' ? params.linkSessionId : ''
    if (linkSessionId === '') throw new Error('missing linkSessionId')
    const key = `${linkIdOf(link)}:${linkSessionId}`
    const record = records.get(key)
    if (record === undefined || record.direction !== 'inbound') throw new Error('unknown hosted session')
    return record
  }

  async function handlePrompt(link, params) {
    const record = requireInbound(link, params)
    const text = typeof params.text === 'string' ? params.text : ''
    if (text.trim() === '') throw new Error('prompt text is empty')
    const controller = requireSessionController()
    await controller.prompt({
      requestId: String(params.requestId ?? `${record.linkSessionId}:p${Date.now().toString(36)}`),
      sessionId: record.localSessionId,
      mode: params.mode === 'steer' ? 'steer' : 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai',
    }, new AbortController().signal)
    record.state = 'running'
    record.updatedAt = Date.now()
    persistRecord(record)
    return { ok: true }
  }

  async function handleCancel(link, params) {
    const record = requireInbound(link, params)
    const controller = requireSessionController()
    await controller.cancel({ sessionId: record.localSessionId })
    record.state = 'idle'
    record.updatedAt = Date.now()
    persistRecord(record)
    return { ok: true }
  }

  async function handleAttach(link, params) {
    const record = requireInbound(link, params)
    const fromSeq = Number.isInteger(params.fromSeq) ? params.fromSeq : 0
    const events = await replayHostedEvents(record)
    return {
      ok: true,
      state: record.state,
      title: record.title,
      events: events.filter(event => Number(event.seq) > fromSeq),
    }
  }

  /** Read the hosted session's durable events and project them. */
  async function replayHostedEvents(record) {
    const live = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    const session = live?.get?.(record.localSessionId)
    if (session !== undefined && session !== null && typeof session.snapshotEvents === 'function') {
      const out = []
      for (const event of session.snapshotEvents()) {
        const projected = projectSessionEvent(event)
        if (projected !== null) out.push(projected)
      }
      return out
    }
    const controller = sessionController()
    if (controller === undefined) return []
    const inspection = await controller.inspect(record.localSessionId)
    const events = Array.isArray(inspection?.events) ? inspection.events : []
    const out = []
    for (const event of events) {
      const projected = projectSessionEvent(event)
      if (projected !== null) out.push(projected)
    }
    return out
  }

  async function handleList(link) {
    return {
      ok: true,
      sessions: [...records.values()]
        .filter(record => record.linkId === linkIdOf(link))
        .map(view),
    }
  }

  /** Route one incoming request; returns the JSON-RPC result. */
  async function handleRequest(link, method, params) {
    const input = isRecord(params) ? params : {}
    switch (method) {
      case 'session.create':
        return handleCreate(link, input)
      case 'session.prompt':
        return handlePrompt(link, input)
      case 'session.cancel':
        return handleCancel(link, input)
      case 'session.attach':
        return handleAttach(link, input)
      case 'session.list':
        return handleList(link)
      default:
        throw new Error(`unknown method ${method}`)
    }
  }

  /** Route one incoming notification. */
  function handleNotification(link, method, params) {
    if (!isRecord(params)) return
    if (method === 'event.session') {
      const linkSessionId = typeof params.linkSessionId === 'string' ? params.linkSessionId : ''
      const record = records.get(`${linkIdOf(link)}:${linkSessionId}`)
      if (record === undefined || record.direction !== 'outbound') return
      appendEvent(record, params.event)
      persistRecord(record)
      return
    }
    if (method === 'session.state') {
      const linkSessionId = typeof params.linkSessionId === 'string' ? params.linkSessionId : ''
      const record = records.get(`${linkIdOf(link)}:${linkSessionId}`)
      if (record === undefined || record.direction !== 'outbound') return
      record.state = typeof params.state === 'string' ? params.state : record.state
      record.updatedAt = Date.now()
      persistRecord(record)
    }
  }

  /** Transcript for the UI, newest last. */
  async function transcript(sessionId) {
    const record = records.get(sessionId)
    if (record === undefined) throw new Error('unknown remote session')
    if (record.direction === 'inbound') {
      try {
        const events = await replayHostedEvents(record)
        if (events.length >= record.events.length) record.events = events.slice(-MAX_EVENTS_IN_MEMORY)
      } catch (error) {
        logger.warn?.('[remotenode] replay hosted transcript failed', error)
      }
    }
    return { session: view(record), events: [...record.events] }
  }

  /** Projection of all known sessions for the panel. */
  function sessionViews() {
    return [...records.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(record => ({ ...view(record) }))
  }

  /** Update deliverable counters (called by the deliverable hub). */
  function noteDeliverables(linkId, linkSessionId, count) {
    const key = `${linkId}:${linkSessionId}`
    const record = records.get(key)
    if (record === undefined) return
    record.deliverableCount = count
    scheduleSave()
  }

  /** Find an outbound record (linkSessionId) for a delivered op's origin session. */
  function recordByLinkSession(linkId, linkSessionId) {
    return records.get(`${linkId}:${linkSessionId}`) ?? null
  }

  return {
    load,
    records,
    onLinkUp,
    onLinkDown,
    onSessionEvent,
    onSessionStatus,
    startRemoteSession,
    promptRemote,
    cancelRemote,
    handleRequest,
    handleNotification,
    transcript,
    sessionViews,
    noteDeliverables,
    recordByLinkSession,
    saveNow,
  }
}
