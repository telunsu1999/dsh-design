/**
 * Browser HTTP carrier for remotenode: /api/remotenode/*
 *
 * The panel polls `state` every couple of seconds and calls one small POST per
 * action. Responses are `{ ok: true, ... }` or `{ ok: false, error }` with HTTP
 * 200 so a panel bug never becomes a fetch rejection; only the artifact byte
 * route answers with a non-JSON body (or 409 JSON when bytes are not local).
 *
 * The server is bound to loopback by the web app; this route adds no
 * authentication of its own and must stay a same-origin, local capability.
 */

import { extname } from 'node:path'

const API_PATH = '/api/remotenode'
const MAX_BODY_BYTES = 1024 * 1024
const DOWNLOAD_MIME = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
  ['.gif', 'image/gif'], ['.bmp', 'image/bmp'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
  ['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'], ['.glb', 'model/gltf-binary'],
  ['.gltf', 'model/gltf+json'], ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.zip', 'application/zip'], ['.pdf', 'application/pdf'], ['.svg', 'image/svg+xml'],
])

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value @param {string} fallback */
function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

/** Send one JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Read a bounded JSON body. */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return isRecord(parsed) ? parsed : {}
}

/** Content-Type for one download; the protocol mime wins. */
function downloadMime(record) {
  if (isRecord(record) && typeof record.mime === 'string' && record.mime !== '' && record.mime !== 'application/octet-stream') {
    return record.mime
  }
  const name = isRecord(record) && typeof record.name === 'string' ? record.name : ''
  return DOWNLOAD_MIME.get(extname(name).toLowerCase()) ?? 'application/octet-stream'
}

/** RFC 5987-ish filename for the Content-Disposition header. */
function contentDisposition(name) {
  const safe = String(name ?? 'deliverable').replace(/["\\\r\n]/g, '_')
  const encoded = encodeURIComponent(safe)
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`
}

/**
 * Register the /api/remotenode route prefix.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {ReturnType<import('../index.js').createRuntime>} runtime
 */
export function registerRoutes(ctx, runtime) {
  const handler = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      const path = url.pathname
      const method = req.method ?? 'GET'

      if (path === `${API_PATH}/ping`) {
        sendJson(res, 200, { ok: true, self: { nodeId: runtime.self.nodeId, nodeName: runtime.self.nodeName } })
        return
      }

      if (path === `${API_PATH}/state` && method === 'GET') {
        sendJson(res, 200, runtime.api.state())
        return
      }

      if (path === `${API_PATH}/refresh` && method === 'POST') {
        await readJsonBody(req).catch(() => ({}))
        await runtime.api.refresh()
        sendJson(res, 200, { ok: true })
        return
      }

      if (path === `${API_PATH}/session/start` && method === 'POST') {
        const body = await readJsonBody(req)
        sendJson(res, 200, await runtime.api.startSession({
          peerNodeId: text(body.peerNodeId),
          prompt: text(body.prompt),
          cwd: text(body.cwd),
        }))
        return
      }

      if (path === `${API_PATH}/session/prompt` && method === 'POST') {
        const body = await readJsonBody(req)
        sendJson(res, 200, await runtime.api.prompt({
          sessionId: text(body.sessionId),
          text: text(body.text),
          mode: text(body.mode),
        }))
        return
      }

      if (path === `${API_PATH}/session/cancel` && method === 'POST') {
        const body = await readJsonBody(req)
        sendJson(res, 200, await runtime.api.cancel({ sessionId: text(body.sessionId) }))
        return
      }

      if (path === `${API_PATH}/session/transcript` && method === 'GET') {
        const sessionId = text(url.searchParams.get('sessionId'))
        sendJson(res, 200, await runtime.api.transcript(sessionId))
        return
      }

      if (path === `${API_PATH}/artifact/fetch` && method === 'POST') {
        const body = await readJsonBody(req)
        sendJson(res, 200, await runtime.api.fetchArtifact({ key: text(body.key) }))
        return
      }

      if (path === `${API_PATH}/artifact` && method === 'GET') {
        const key = text(url.searchParams.get('key'))
        const record = runtime.api.deliverable(key)
        if (record === null) {
          sendJson(res, 404, { ok: false, error: 'unknown deliverable' })
          return
        }
        let content
        try {
          content = await runtime.api.artifactContent(key)
        } catch (error) {
          sendJson(res, 409, {
            ok: false,
            error: String(error?.message ?? error),
            syncState: record.syncState,
          })
          return
        }
        const body = Buffer.isBuffer(content.bytes) ? content.bytes : Buffer.from(content.bytes)
        res.writeHead(200, {
          'content-type': downloadMime({ ...record, mime: content.mime }),
          'content-length': body.length,
          'cache-control': 'no-store',
          'content-disposition': contentDisposition(content.name ?? record.name),
        })
        res.end(body)
        return
      }

      if (path === `${API_PATH}/publish` && method === 'POST') {
        const body = await readJsonBody(req)
        sendJson(res, 200, await runtime.api.publish({
          peerNodeId: text(body.peerNodeId),
          path: text(body.path),
          description: text(body.description),
        }))
        return
      }

      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
    }
  }
  return ctx.webServer.register({ kind: 'prefix', path: API_PATH, handler })
}
