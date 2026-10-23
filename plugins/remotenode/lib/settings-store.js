/**
 * Runtime settings store (SPEC §11): values changed from the panel that must
 * survive restarts while `config.json` stays the deployment-owned baseline.
 *
 * Currently only the peer listener: `<dataDir>/settings.json`
 *   { version: 1, listen: { enabled, host, port }, updatedAt }
 *
 * Effective listen order: settings.json -> config.json -> built-in defaults.
 */

const HOST_RE = /^[A-Za-z0-9._:[\]-]{1,255}$/

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value @param {string} fallback */
function oneLine(value, fallback = '') {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  return text === '' ? fallback : text
}

/** Validate + normalize one listen value; null when unusable. */
export function normalizeListen(input) {
  if (!isRecord(input)) return null
  const enabled = input.enabled !== false
  const host = oneLine(input.host)
  const port = Number(input.port)
  if (host === '' || !HOST_RE.test(host)) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { enabled, host, port }
}

/**
 * Create the runtime settings store.
 * @param {{ store: ReturnType<import('./store.js').createStore>, logger: Console }} options
 */
export function createSettingsStore(options) {
  const { store, logger } = options
  /** @type {{enabled:boolean,host:string,port:number} | null} */
  let listen = null

  function load() {
    try {
      const raw = store.readJson('settings.json', null)
      if (isRecord(raw) && isRecord(raw.listen)) {
        const normalized = normalizeListen(raw.listen)
        if (normalized !== null) {
          listen = normalized
          return
        }
        logger.warn?.('[remotenode] settings.json listen entry is invalid; ignoring it')
      }
    } catch (error) {
      logger.warn?.('[remotenode] read settings.json failed', error)
    }
    listen = null
  }

  function persist() {
    try {
      store.writeJson('settings.json', {
        version: 1,
        listen,
        updatedAt: Date.now(),
      })
    } catch (error) {
      logger.warn?.('[remotenode] persist settings.json failed', error)
    }
  }

  return {
    load,
    listen() {
      return listen === null ? null : { ...listen }
    },
    saveListen(input) {
      const normalized = normalizeListen(input)
      if (normalized === null) throw new Error('invalid listen settings')
      listen = normalized
      persist()
      return { ...listen }
    },
    resetListen() {
      listen = null
      persist()
    },
  }
}
