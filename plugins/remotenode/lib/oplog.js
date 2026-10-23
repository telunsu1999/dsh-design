/**
 * Per-origin op log with bounded retention.
 * Mirrors 07-remotenode-m0-protocol.md §8.7–§8.8, §11.5.
 */

import { assertOp } from './deliverable.js'

export class OpLog {
  /**
   * @param {{maxOps?:number, maxBytes?:number}} [options]
   */
  constructor(options = {}) {
    this.maxOps = options.maxOps ?? 10000
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024
    /** @type {object[]} */
    this.ops = []
    this.bytes = 0
    /** @type {number|null} smallest retained seq, null when empty */
    this.firstSeq = null
    /** @type {number} highest appended seq (0 when none) */
    this.lastSeq = 0
  }

  /**
   * Append one op. Ops must carry strictly increasing originSeq.
   * @param {object} op
   */
  append(op) {
    assertOp(op)
    if (op.originSeq <= this.lastSeq) {
      throw new Error(`op originSeq ${op.originSeq} must exceed ${this.lastSeq}`)
    }
    this.ops.push(op)
    this.lastSeq = op.originSeq
    this.bytes += Buffer.byteLength(JSON.stringify(op), 'utf8')
    this.#trim()
    return op
  }

  #trim() {
    while (this.ops.length > this.maxOps || (this.bytes > this.maxBytes && this.ops.length > 1)) {
      const removed = this.ops.shift()
      this.bytes -= Buffer.byteLength(JSON.stringify(removed), 'utf8')
    }
    this.firstSeq = this.ops.length === 0 ? null : this.ops[0].originSeq
  }

  /** Whether the log can fully answer "everything after `seq`". */
  covers(seq) {
    if (this.ops.length === 0) return true
    return seq >= this.ops[0].originSeq - 1
  }

  /**
   * Ops with originSeq > seq.
   * @param {number} seq
   */
  since(seq) {
    return this.ops.filter(op => op.originSeq > seq)
  }

  /**
   * Persistence/replay helper: every retained op with originSeq > seq.
   * Equivalent to {@link since}; kept as a separate export for the plugin's
   * store/reconcile code (SPEC §5.6).
   * @param {number} seq
   */
  exportSince(seq) {
    return this.since(seq)
  }

  /** Persistence helper: snapshot of every retained op (oldest first). */
  exportAll() {
    return [...this.ops]
  }

  /**
   * Restore a persisted op list (oldest first, strictly increasing originSeq).
   * All-or-nothing: builds a temporary log first, then adopts it.
   * @param {object[]} ops
   * @returns {number} number of restored ops
   */
  restore(ops) {
    if (!Array.isArray(ops)) throw new TypeError('ops must be an array')
    const temp = new OpLog({ maxOps: this.maxOps, maxBytes: this.maxBytes })
    for (const op of ops) temp.append(op)
    this.ops = temp.ops
    this.bytes = temp.bytes
    this.firstSeq = temp.firstSeq
    this.lastSeq = temp.lastSeq
    return this.ops.length
  }

  get size() {
    return this.ops.length
  }
}
