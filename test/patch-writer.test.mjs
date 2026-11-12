import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROW_ID, ROW_MARKER, readRowConfig, writeRowConfig } from '../lib/patch-writer.js'

function tempPatch(initial) {
  const dir = mkdtempSync(join(tmpdir(), 'keelwatch-patch-'))
  const path = join(dir, 'cordis.patch.yml')
  if (initial !== undefined) writeFileSync(path, initial)
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const CONFIG = {
  driftRadar: { enabled: true, checkIntervalHours: 6 },
  failureBrake: { enabled: true, action: 'brake' },
}

test('an empty profile patch becomes a managed block', async () => {
  const { path, cleanup } = tempPatch('[]\n')
  const result = await writeRowConfig(path, CONFIG)
  assert.equal(result.changed, true)
  assert.equal(result.createdRow, true)
  const text = readFileSync(path, 'utf8')
  assert.match(text, new RegExp(`^${ROW_MARKER}$`, 'm'))
  assert.match(text, /^- id: keelwatch$/m)
  const read = await readRowConfig(path)
  assert.deepEqual(read.config, CONFIG)
  cleanup()
})

test('a patch commented but empty also becomes a managed block', async () => {
  const { path, cleanup } = tempPatch('# comment only\n')
  await writeRowConfig(path, CONFIG)
  assert.deepEqual((await readRowConfig(path)).config, CONFIG)
  cleanup()
})

test('an unrelated patch keeps every other byte and gains one row', async () => {
  const original = '- id: ui-settings-general\n  name: "@deepseek-ai/dsh-client-ui-settings-general"\n  config:\n    welcomeNoticeVersion: 2026-09-28.1\n'
  const { path, cleanup } = tempPatch(original)
  const result = await writeRowConfig(path, CONFIG)
  assert.equal(result.createdRow, true)
  const text = readFileSync(path, 'utf8')
  assert.ok(text.startsWith(original.trimEnd()), 'existing content must stay first and intact')
  assert.match(text, /- id: keelwatch/)
  assert.deepEqual((await readRowConfig(path)).config, CONFIG)
  cleanup()
})

test('an existing row is updated in place and keeps its other keys', async () => {
  const original = [
    '- id: keelwatch',
    '  disabled: false',
    '  config: {"driftRadar":{"enabled":false}}',
    '- id: other',
    '  config: {"x":1}',
    '',
  ].join('\n')
  const { path, cleanup } = tempPatch(original)
  const result = await writeRowConfig(path, CONFIG)
  assert.equal(result.createdRow, false)
  assert.equal(result.changed, true)
  const text = readFileSync(path, 'utf8')
  assert.match(text, /- id: keelwatch\n {2}disabled: false\n {2}config: \{"driftRadar":/)
  assert.match(text, /- id: other\n {2}config: \{"x":1\}/)
  assert.deepEqual((await readRowConfig(path)).config, CONFIG)
  cleanup()
})

test('a row without a config key gets one inserted after the id', async () => {
  const { path, cleanup } = tempPatch('- id: keelwatch\n  disabled: false\n')
  await writeRowConfig(path, CONFIG)
  const text = readFileSync(path, 'utf8')
  assert.match(text, /- id: keelwatch\n {2}config: \{.*\}\n {2}disabled: false/)
  cleanup()
})

test('writing the same config twice reports no change', async () => {
  const { path, cleanup } = tempPatch('- id: keelwatch\n  config: {}\n')
  await writeRowConfig(path, CONFIG)
  const again = await writeRowConfig(path, CONFIG)
  assert.equal(again.changed, false)
  assert.equal(again.backupPath, null)
  cleanup()
})

test('a backup is written before the file is modified', async () => {
  const { path, cleanup } = tempPatch('- id: keelwatch\n  config: {}\n')
  const result = await writeRowConfig(path, CONFIG)
  assert.ok(result.backupPath !== null)
  assert.equal(readFileSync(result.backupPath, 'utf8'), '- id: keelwatch\n  config: {}\n')
  cleanup()
})

test('hand-written YAML is reported as unmanaged rather than rewritten', async () => {
  const { path, cleanup } = tempPatch('- id: keelwatch\n  config:\n    driftRadar:\n      enabled: true\n')
  const read = await readRowConfig(path)
  assert.equal(read.found, true)
  assert.equal(read.config, null)
  assert.equal(read.raw, null)
  cleanup()
})

test('a missing row reads as not found', async () => {
  const { path, cleanup } = tempPatch('- id: something-else\n  config: {}\n')
  const read = await readRowConfig(path)
  assert.equal(read.found, false)
  assert.equal(read.config, null)
  cleanup()
})

test('ROW_ID matches the bundle patch row id', () => {
  assert.equal(ROW_ID, 'keelwatch')
})
