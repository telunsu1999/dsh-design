/**
 * Test-entry shim so that `node --test tests/` works on Node builds whose test
 * runner treats a directory positional argument as ONE entry file instead of
 * recursively discovering `*.test.mjs` inside it (verified on v22.22.1: passing
 * `tests/` without this file fails with ERR_MODULE_NOT_FOUND / "Cannot find
 * module .../tests").
 *
 * This file is not itself named `*.test.mjs`, so `node --test` discovery and
 * `node --test tests/*.test.mjs` never pick it up; it is only loaded when the
 * directory itself is passed. It imports every sibling `*.test.mjs` at runtime,
 * including test files owned by other teammates.
 */

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const testFiles = readdirSync(here)
  .filter(name => name.endsWith('.test.mjs'))
  .sort()

for (const name of testFiles) {
  await import(pathToFileURL(join(here, name)).href)
}
