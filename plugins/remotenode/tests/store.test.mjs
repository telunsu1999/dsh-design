import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createStore } from '../lib/store.js'
import { artifactIdForBytes, sha256Hex } from '../lib/ids.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'remotenode-store-test-'))
after(() => rmSync(tmpRoot, { recursive: true, force: true }))

let counter = 0
/** Fresh store under a unique subdirectory of the temp root. */
function freshStore() {
  counter += 1
  return createStore({ dataDir: join(tmpRoot, `data-${counter}`) })
}

test('createStore validates dataDir', () => {
  assert.throws(() => createStore({}), /non-empty dataDir/)
  assert.throws(() => createStore({ dataDir: '   ' }), /non-empty dataDir/)
  assert.throws(() => createStore({ dataDir: '/tmp/\u0000bad' }), /control characters/)
})

test('ensure creates the data root and known subdirectories', () => {
  const store = freshStore()
  const root = store.ensure()
  assert.equal(store.dataDir, root)
  assert.equal(statSync(root).isDirectory(), true)
  for (const subdir of ['transcripts', 'deliverables', 'blobs']) {
    assert.equal(statSync(join(root, subdir)).isDirectory(), true)
  }
  // idempotent
  assert.equal(store.ensure(), root)
})

test('resolvePath rejects absolute paths, traversal and control characters', () => {
  const store = freshStore()
  const ok = store.resolvePath('transcripts/a.jsonl')
  assert.equal(ok.startsWith(store.dataDir + '/'), true)
  assert.equal(store.resolvePath('nested/deeper/file.json').endsWith('/nested/deeper/file.json'), true)

  for (const bad of ['../escape.json', 'a/../../b', '/etc/passwd', 'C:\\Windows\\x', '', 'a//b', './a', 'a/./b']) {
    assert.throws(() => store.resolvePath(bad), /must be relative|escapes dataDir|non-empty/, bad)
  }
  assert.throws(() => store.resolvePath('a\u0000b'), /control characters/)
  assert.throws(() => store.resolvePath(42), /non-empty string/)
})

test('writeJson/readJson roundtrip with atomic writes', () => {
  const store = freshStore()
  const value = { ok: true, text: '你好', nested: { list: [1, 2, 3] } }
  const file = store.writeJson('deliverables/link-1.json', value)
  assert.equal(existsSync(file), true)
  assert.deepEqual(store.readJson('deliverables/link-1.json'), value)
  // no temp files left behind
  const names = readdirSync(join(store.dataDir, 'deliverables'))
  assert.deepEqual(names, ['link-1.json'])
  // overwrite is atomic from a reader's point of view
  store.writeJson('deliverables/link-1.json', { ok: false })
  assert.deepEqual(store.readJson('deliverables/link-1.json'), { ok: false })
  // missing file -> fallback; malformed file -> contextual error
  assert.equal(store.readJson('deliverables/missing.json', 'fallback'), 'fallback')
  writeFileSync(join(store.dataDir, 'deliverables', 'broken.json'), '{not json', 'utf8')
  assert.throws(() => store.readJson('deliverables/broken.json', null), /readJson.*broken\.json.*invalid JSON/)
})

test('writeJson rejects non-serializable values', () => {
  const store = freshStore()
  const cyclic = {}
  cyclic.self = cyclic
  assert.throws(() => store.writeJson('x.json', cyclic), /not JSON serializable/)
})

test('appendJsonl/readJsonl roundtrip', () => {
  const store = freshStore()
  store.appendJsonl('transcripts/key.jsonl', { seq: 1, type: 'user/message', text: 'hi' })
  store.appendJsonl('transcripts/key.jsonl', { seq: 2, type: 'assistant/message', text: 'hello' })
  assert.deepEqual(store.readJsonl('transcripts/key.jsonl'), [
    { seq: 1, type: 'user/message', text: 'hi' },
    { seq: 2, type: 'assistant/message', text: 'hello' },
  ])
  assert.deepEqual(store.readJsonl('transcripts/missing.jsonl'), [])
  writeFileSync(join(store.dataDir, 'transcripts', 'bad.jsonl'), '{"ok":1}\nnot-json\n', 'utf8')
  assert.throws(() => store.readJsonl('transcripts/bad.jsonl'), /invalid JSON on line 2/)
})

test('blob CAS stores bytes and reads them back with a matching sha256', () => {
  const store = freshStore()
  const bytes = Buffer.from('some artifact bytes — 图片数据', 'utf8')
  const artifactId = artifactIdForBytes(bytes)
  assert.equal(store.hasBlob(artifactId), false)
  assert.equal(store.readBlob(artifactId), null)
  assert.equal(store.statBlob(artifactId), null)

  const put = store.putBlob(artifactId, bytes)
  assert.equal(put.artifactId, artifactId)
  assert.equal(put.bytes, bytes.byteLength)
  assert.equal(put.sha256, artifactId.slice('sha256:'.length))
  assert.equal(put.file.startsWith('blobs/'), true)
  assert.equal(store.hasBlob(artifactId), true)
  assert.deepEqual(store.statBlob(artifactId), { bytes: bytes.byteLength })

  const back = store.readBlob(artifactId)
  assert.ok(Buffer.isBuffer(back))
  assert.equal(sha256Hex(back), artifactId.slice('sha256:'.length))
  assert.deepEqual(back, bytes)

  // overwriting the same content is idempotent
  store.putBlob(artifactId, Buffer.from(bytes))
  assert.deepEqual(store.readBlob(artifactId), bytes)
})

test('blob CAS rejects invalid ids and content mismatches', () => {
  const store = freshStore()
  const bytes = Buffer.from('abc')
  const artifactId = artifactIdForBytes(bytes)
  for (const bad of ['not-an-id', 'sha256:short', 'sha256:' + 'A'.repeat(64), '../escape', '']) {
    assert.equal(store.hasBlob(bad), false, bad)
    assert.equal(store.readBlob(bad), null, bad)
    assert.equal(store.statBlob(bad), null, bad)
    assert.throws(() => store.putBlob(bad, bytes), /artifactId of form sha256/)
  }
  assert.throws(() => store.putBlob(artifactId, Buffer.from('tampered')), /sha256 mismatch/)
  assert.throws(() => store.putBlob(artifactId, 'not bytes'), /Buffer or Uint8Array/)
  assert.equal(store.hasBlob(artifactId), false)
})

test('store operations create parent directories on demand', () => {
  const store = freshStore()
  // no ensure() call: writes must still create the directory tree
  const file = store.writeJson('deliverables/deep/path/data.json', { ok: true })
  assert.equal(existsSync(file), true)
  store.appendJsonl('transcripts/deep/session.jsonl', { seq: 1 })
  assert.deepEqual(store.readJsonl('transcripts/deep/session.jsonl'), [{ seq: 1 }])
})
