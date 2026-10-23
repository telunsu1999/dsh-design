/**
 * Filesystem persistence helpers for the remotenode plugin (SPEC §5.7).
 *
 * Layout under `dataDir`:
 *   links.json / outbound.json / inbound.json / *.json   (atomic JSON writes)
 *   transcripts/<linkSessionKey>.jsonl                   (append-only JSONL)
 *   deliverables/<linkId>.json                           (atomic JSON writes)
 *   blobs/sha256-<hex>                                   (content-addressed bytes)
 *
 * All path arguments are relative to `dataDir` and traversal is rejected.
 * Pure ESM, zero dependencies: only node: builtins.
 */

import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { artifactIdForBytes, isArtifactId } from './ids.js'

const SUBDIRS = Object.freeze(['transcripts', 'deliverables', 'blobs'])
const WINDOWS_ABS_RE = /^[a-zA-Z]:[\\/]/
const CONTROL_RE = /[\u0000-\u001f\u007f]/

/** @param {unknown} error */
function isNotFound(error) {
  const code = /** @type {any} */ (error)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Wrap an IO failure with operation/path context (SPEC: all IO errors carry context).
 * @param {string} operation
 * @param {string} rel
 * @param {unknown} cause
 * @param {string} [hint]
 */
function ioError(operation, rel, cause, hint) {
  const message = cause instanceof Error ? cause.message : String(cause)
  const error = new Error(
    `[remotenode/store] ${operation} '${rel}' failed${hint === undefined ? '' : ` (${hint})`}: ${message}`,
    { cause },
  )
  if (cause !== null && typeof cause === 'object' && typeof (/** @type {any} */ (cause).code) === 'string') {
    /** @type {any} */ (error).code = /** @type {any} */ (cause).code
  }
  return error
}

/**
 * Atomically write one file: unique temp file in the same directory, fsync,
 * then rename over the target.
 * @param {string} target absolute path
 * @param {Buffer} data
 */
function writeFileAtomic(target, data) {
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${target.slice(dir.length + 1)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
  let fd
  try {
    fd = openSync(tmp, 'w')
    writeSync(fd, data)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, target)
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
    try { unlinkSync(tmp) } catch { /* best effort */ }
    throw error
  }
}

/**
 * Create the store rooted at `dataDir`.
 * @param {{ dataDir: string }} options
 */
export function createStore(options) {
  const dataDir = options?.dataDir
  if (typeof dataDir !== 'string' || dataDir.trim() === '') {
    throw new TypeError('createStore requires a non-empty dataDir')
  }
  if (CONTROL_RE.test(dataDir)) throw new TypeError('dataDir must not contain control characters')
  const root = resolve(dataDir)

  /**
   * Create the data root and all known subdirectories. Idempotent.
   * @returns {string} absolute dataDir
   */
  function ensure() {
    try {
      mkdirSync(root, { recursive: true })
      for (const subdir of SUBDIRS) mkdirSync(join(root, subdir), { recursive: true })
    } catch (error) {
      throw ioError('ensure', root, error)
    }
    return root
  }

  /**
   * Resolve a store-relative path against `dataDir`, rejecting absolute paths
   * and any `.` / `..` / empty segments (path traversal guard).
   * @param {unknown} rel
   * @returns {string} absolute path
   */
  function resolvePath(rel) {
    if (typeof rel !== 'string' || rel.length === 0) {
      throw new TypeError('path must be a non-empty string')
    }
    if (CONTROL_RE.test(rel)) throw new Error(`[remotenode/store] path '${rel}' contains control characters`)
    if (isAbsolute(rel) || WINDOWS_ABS_RE.test(rel)) {
      throw new Error(`[remotenode/store] path '${rel}' must be relative to dataDir`)
    }
    const segments = rel.split(/[\\/]/)
    for (const segment of segments) {
      if (segment === '' || segment === '.' || segment === '..') {
        throw new Error(`[remotenode/store] path '${rel}' escapes dataDir`)
      }
    }
    const resolved = resolve(root, rel)
    const relToRoot = relative(root, resolved)
    if (relToRoot === '' || relToRoot.startsWith('..') || isAbsolute(relToRoot)) {
      throw new Error(`[remotenode/store] path '${rel}' escapes dataDir`)
    }
    return resolved
  }

  /** @param {unknown} rel @param {string} operation */
  function absolutePath(rel, operation) {
    try {
      return resolvePath(rel)
    } catch (error) {
      if (error instanceof TypeError) throw ioError(operation, String(rel), error)
      throw error
    }
  }

  /**
   * Read + parse one JSON file. `fallback` is returned when the file is absent;
   * malformed JSON or other IO failures throw a contextual Error.
   * @param {string} rel
   * @param {unknown} [fallback]
   * @returns {any}
   */
  function readJson(rel, fallback) {
    const file = absolutePath(rel, 'readJson')
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return fallback
      throw ioError('readJson', rel, error)
    }
    try {
      return JSON.parse(text)
    } catch (error) {
      throw ioError('readJson', rel, error, 'invalid JSON')
    }
  }

  /**
   * Atomically write one JSON file (pretty-printed, trailing newline).
   * @param {string} rel
   * @param {unknown} value
   * @returns {string} absolute path written
   */
  function writeJson(rel, value) {
    const file = absolutePath(rel, 'writeJson')
    let text
    try {
      text = `${JSON.stringify(value, null, 2)}\n`
    } catch (error) {
      throw ioError('writeJson', rel, error, 'value is not JSON serializable')
    }
    try {
      writeFileAtomic(file, Buffer.from(text, 'utf8'))
    } catch (error) {
      throw ioError('writeJson', rel, error)
    }
    return file
  }

  /**
   * Append one JSON value as a single JSONL line.
   * @param {string} rel
   * @param {unknown} value
   * @returns {string} absolute path appended to
   */
  function appendJsonl(rel, value) {
    const file = absolutePath(rel, 'appendJsonl')
    let line
    try {
      line = `${JSON.stringify(value)}\n`
    } catch (error) {
      throw ioError('appendJsonl', rel, error, 'value is not JSON serializable')
    }
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, line, 'utf8')
    } catch (error) {
      throw ioError('appendJsonl', rel, error)
    }
    return file
  }

  /**
   * Read a JSONL file. Absent file -> []; malformed line throws with its line number.
   * @param {string} rel
   * @returns {any[]}
   */
  function readJsonl(rel) {
    const file = absolutePath(rel, 'readJsonl')
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return []
      throw ioError('readJsonl', rel, error)
    }
    if (text === '') return []
    const rows = []
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line === '') continue
      try {
        rows.push(JSON.parse(line))
      } catch (error) {
        throw ioError('readJsonl', rel, error, `invalid JSON on line ${index + 1}`)
      }
    }
    return rows
  }

  /** @param {unknown} artifactId @returns {string|null} store-relative blob path */
  function blobRel(artifactId) {
    if (!isArtifactId(artifactId)) return null
    return `blobs/sha256-${artifactId.slice('sha256:'.length)}`
  }

  /** @param {unknown} artifactId @param {string} operation */
  function blobPath(artifactId, operation) {
    const rel = blobRel(artifactId)
    if (rel === null) throw new TypeError(`${operation} requires artifactId of form sha256:<64 lowercase hex>`)
    return { rel, file: resolvePath(rel) }
  }

  /**
   * Write CAS bytes. Verifies the content hash against the artifact id; the
   * path is derived from the id, so traversal is impossible.
   * @param {string} artifactId
   * @param {Buffer | Uint8Array} bytes
   * @returns {{artifactId:string, bytes:number, sha256:string, file:string}}
   */
  function putBlob(artifactId, bytes) {
    const { rel, file } = blobPath(artifactId, 'putBlob')
    if (!(bytes instanceof Uint8Array)) throw new TypeError('putBlob requires a Buffer or Uint8Array')
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const actual = artifactIdForBytes(data)
    if (actual !== artifactId) {
      throw new Error(`[remotenode/store] putBlob '${artifactId}' failed: content sha256 mismatch (got ${actual})`)
    }
    try {
      writeFileAtomic(file, data)
    } catch (error) {
      throw ioError('putBlob', rel, error)
    }
    return { artifactId, bytes: data.byteLength, sha256: artifactId.slice('sha256:'.length), file: rel }
  }

  /**
   * @param {string} artifactId
   * @returns {boolean}
   */
  function hasBlob(artifactId) {
    const rel = blobRel(artifactId)
    if (rel === null) return false
    try {
      return existsSync(resolvePath(rel))
    } catch {
      return false
    }
  }

  /**
   * @param {string} artifactId
   * @returns {Buffer|null}
   */
  function readBlob(artifactId) {
    const rel = blobRel(artifactId)
    if (rel === null) return null
    let file
    try {
      file = resolvePath(rel)
    } catch {
      return null
    }
    try {
      return readFileSync(file)
    } catch (error) {
      if (isNotFound(error)) return null
      throw ioError('readBlob', rel, error)
    }
  }

  /**
   * @param {string} artifactId
   * @returns {{bytes:number}|null}
   */
  function statBlob(artifactId) {
    const rel = blobRel(artifactId)
    if (rel === null) return null
    let file
    try {
      file = resolvePath(rel)
    } catch {
      return null
    }
    try {
      const stat = statSync(file)
      return { bytes: stat.size }
    } catch (error) {
      if (isNotFound(error)) return null
      throw ioError('statBlob', rel, error)
    }
  }

  return {
    dataDir: root,
    ensure,
    resolvePath,
    readJson,
    writeJson,
    appendJsonl,
    readJsonl,
    putBlob,
    hasBlob,
    readBlob,
    statBlob,
  }
}
