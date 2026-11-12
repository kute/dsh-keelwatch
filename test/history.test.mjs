import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryLog, describeEntry, historyPath } from '../lib/history.js'

function tempLog({ retentionDays = 7, maxEntries = 500 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'keelwatch-history-'))
  const path = historyPath(dir)
  return { path, dir, log: new HistoryLog(path, retentionDays, maxEntries), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('historyPath lives under $DSH_HOME/keelwatch', () => {
  assert.equal(historyPath('/home/u/.dsh'), '/home/u/.dsh/keelwatch/history.jsonl')
})

test('appended entries read back newest first', async () => {
  const { log, cleanup } = tempLog()
  // Timestamps must stay inside the retention window, or the reader drops them.
  await log.append({ kind: 'bundle', level: 'ok', en: 'first', zh: '第一条', at: Date.now() - 2000 })
  await log.append({ kind: 'drift', level: 'warn', en: 'second', zh: '第二条', at: Date.now() - 1000 })
  const entries = await log.read(10)
  assert.deepEqual(entries.map((entry) => entry.en), ['second', 'first'])
  cleanup()
})

test('entries older than retentionDays are dropped on read', async () => {
  const { log, cleanup } = tempLog({ retentionDays: 1 })
  await log.append({ kind: 'bundle', level: 'ok', en: 'fresh', zh: '新', at: Date.now() })
  await log.append({ kind: 'bundle', level: 'ok', en: 'stale', zh: '旧', at: Date.now() - 3 * 86_400_000 })
  const entries = await log.read(10)
  assert.deepEqual(entries.map((entry) => entry.en), ['fresh'])
  cleanup()
})

test('the entry cap keeps the newest records', async () => {
  const { log, cleanup } = tempLog({ maxEntries: 3 })
  for (let index = 0; index < 6; index += 1) {
    await log.append({ kind: 'drift', level: 'info', en: `e${index}`, zh: `第${index}条`, at: Date.now() - 10_000 + index })
  }
  const entries = await log.read(10)
  assert.deepEqual(entries.map((entry) => entry.en), ['e5', 'e4', 'e3'])
  cleanup()
})

test('a truncated or hand-edited line is skipped, not fatal', async () => {
  const { path, dir, log, cleanup } = tempLog()
  mkdirSync(join(dir, 'keelwatch'), { recursive: true })
  writeFileSync(
    path,
    [
      JSON.stringify({ kind: 'bundle', level: 'ok', en: 'good', zh: '好', at: Date.now() }),
      '{"kind":"drift","level"',
      '',
    ].join('\n'),
  )
  const entries = await log.read(10)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].en, 'good')
  cleanup()
})

test('a missing file reads as empty and never throws', async () => {
  const { log, cleanup } = tempLog()
  assert.deepEqual(await log.read(5), [])
  cleanup()
})

test('an unwritable location degrades silently', async () => {
  const log = new HistoryLog('/dev/null/keelwatch/history.jsonl', 7)
  await assert.doesNotReject(() => log.append({ kind: 'bundle', level: 'ok', en: 'x', zh: 'x' }))
})

test('compaction rewrites the file to only live entries', async () => {
  const { path, log, cleanup } = tempLog({ retentionDays: 1 })
  await log.append({ kind: 'bundle', level: 'ok', en: 'live', zh: '留', at: Date.now() })
  await log.append({ kind: 'bundle', level: 'ok', en: 'dead', zh: '弃', at: Date.now() - 5 * 86_400_000 })
  await log.read(10)
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  assert.match(lines[0], /live/)
  cleanup()
})

test('describeEntry exposes a stable shape for the UI', async () => {
  const described = describeEntry({ at: Date.UTC(2026, 0, 2, 3, 4, 5), kind: 'bundle', level: 'error', en: 'x', zh: 'y' })
  assert.equal(described.zh, 'y')
  assert.equal(described.level, 'error')
  assert.match(described.time, /^2026-01-02T03:04:05/)
})
