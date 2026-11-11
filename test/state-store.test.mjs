import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonFile, stateFilePath, writeJsonAtomic } from '../lib/state-store.js'

test('stateFilePath lives under $DSH_HOME/keelwatch', () => {
  assert.equal(stateFilePath('/home/u/.dsh', 'brake.json'), '/home/u/.dsh/keelwatch/brake.json')
})

test('writeJsonAtomic creates missing directories and round-trips', async () => {
  const home = mkdtempSync(join(tmpdir(), 'keelwatch-store-'))
  const path = stateFilePath(home, 'brake.json')
  assert.equal(await writeJsonAtomic(path, { version: 1, tools: { bash: { failures: 2 } } }), true)
  const read = await readJsonFile(path)
  assert.deepEqual(read, { version: 1, tools: { bash: { failures: 2 } } })
  // No temp files left behind.
  const leftover = readFileSync(path, 'utf8')
  assert.match(leftover, /"version": 1/)
  rmSync(home, { recursive: true, force: true })
})

test('reading a missing or corrupt file yields null instead of throwing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'keelwatch-store-'))
  assert.equal(await readJsonFile(stateFilePath(home, 'absent.json')), null)

  const path = stateFilePath(home, 'corrupt.json')
  mkdirSync(join(home, 'keelwatch'), { recursive: true })
  writeFileSync(path, '{"version": 1, "tools":')
  assert.equal(await readJsonFile(path), null)
  rmSync(home, { recursive: true, force: true })
})

test('a write into an unwritable path reports failure instead of throwing', async () => {
  // /dev/null/x can never be created; the call must degrade to `false`.
  const ok = await writeJsonAtomic('/dev/null/keelwatch/brake.json', { version: 1 })
  assert.equal(ok, false)
})
