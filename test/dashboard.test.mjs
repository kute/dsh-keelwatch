import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS } from '../lib/config.js'
import { buildTrend, collectStatus, registerDashboard } from '../lib/dashboard.js'
import { FailureBrake } from '../lib/failure-brake.js'
import { CostLedger } from '../lib/cost-attribution.js'
import { HistoryLog, historyPath } from '../lib/history.js'

function baseDeps(extra = {}) {
  return {
    host: {
      logger: { warn: () => {}, info: () => {} },
      on: () => () => {},
      reflect: { get: () => undefined },
    },
    driftConfig: { ...DEFAULTS.driftRadar, enabled: false, checkIntervalHours: 0 },
    brakeConfig: DEFAULTS.failureBrake,
    costConfig: DEFAULTS.costAttribution,
    refreshSeconds: 30,
    ...extra,
  }
}

test('status collects every block even when no service is available', async () => {
  const status = await collectStatus(baseDeps())
  assert.equal(typeof status.generatedAt, 'number')
  assert.equal(status.bundles.available, false)
  assert.deepEqual(status.bundles.problems, [])
  assert.deepEqual(status.timing, [])
  assert.deepEqual(status.tokens, [])
  assert.deepEqual(status.history, [])
  assert.equal(status.brake.enabled, DEFAULTS.failureBrake.enabled)
  assert.equal(status.refreshSeconds, 30)
})

test('status reports a tripped brake and tool timings', async () => {
  const brake = new FailureBrake({ ...DEFAULTS.failureBrake, enabled: true, action: 'brake', maxConsecutiveErrors: 2 })
  brake.observe('bash', true, Date.now(), { code: 'ENOENT', message: 'no such file' })
  brake.observe('bash', true)
  const ledger = new CostLedger()
  ledger.record('bash', 12, true)

  const status = await collectStatus(baseDeps({ brake, ledger }))
  assert.deepEqual(status.brake.braking, ['bash'])
  assert.equal(status.timing.length, 1)
  assert.equal(status.timing[0].tool, 'bash')
  assert.equal(status.timing[0].calls, 1)
})

test('status reads history when a log is present', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keelwatch-dash-'))
  const log = new HistoryLog(historyPath(dir), 7)
  await log.append({ kind: 'bundle', level: 'ok', en: 'ok', zh: '正常' })
  const status = await collectStatus(baseDeps({ history: log }))
  assert.equal(status.history.length, 1)
  assert.equal(status.history[0].zh, '正常')
  rmSync(dir, { recursive: true, force: true })
})

test('the dashboard registers the page and the status route', () => {
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  const ok = registerDashboard(baseDeps({ webServer }))
  assert.equal(ok, true)
  assert.deepEqual(routes.map((route) => route.path).sort(), ['/keelwatch/dashboard', '/keelwatch/status'])
  assert.ok(routes.every((route) => route.kind === 'exact'))
})

test('the page is self-contained: no external scripts or styles', async () => {
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  registerDashboard(baseDeps({ webServer }))
  const page = routes.find((route) => route.path === '/keelwatch/dashboard')
  let body = ''
  const res = {
    writeHead: () => {},
    end: (payload) => {
      body = String(payload)
    },
  }
  await page.handler({ method: 'GET', headers: {}, url: '/' }, res)
  assert.match(body, /^<!doctype html>/)
  assert.doesNotMatch(body, /<script src=/)
  assert.doesNotMatch(body, /<link[^>]+stylesheet/)
  // The page must poll our own route, with the GUI token appended.
  assert.match(body, /\/keelwatch\/status/)
})

test('without a webserver the dashboard reports unavailability instead of throwing', () => {
  const warnings = []
  const deps = baseDeps({ webServer: null })
  deps.host.logger = { warn: (m) => warnings.push(m), info: () => {} }
  assert.equal(registerDashboard(deps), false)
  assert.match(warnings.at(-1), /dashboard unavailable/)
})

test('non-GET requests are refused', async () => {
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  registerDashboard(baseDeps({ webServer }))
  const status = routes.find((route) => route.path === '/keelwatch/status')
  let code = null
  await status.handler(
    { method: 'POST', headers: {}, url: '/' },
    {
      writeHead: (value) => {
        code = value
      },
      end: () => {},
    },
  )
  assert.equal(code, 405)
})

test('trend buckets the last seven days and keeps empty days as zeros', () => {
  const now = Date.UTC(2026, 10, 12, 12)
  const day = 86_400_000
  const trend = buildTrend(
    [
      { at: now, kind: 'bundle', level: 'ok', en: '', zh: '' },
      { at: now, kind: 'bundle', level: 'error', en: '', zh: '' },
      { at: now - day, kind: 'drift', level: 'warn', en: '', zh: '' },
      { at: now - 30 * day, kind: 'drift', level: 'warn', en: '', zh: '' },
    ],
    7,
    now,
  )
  assert.equal(trend.length, 7)
  assert.equal(trend.at(-1).date, '2026-11-12')
  assert.deepEqual({ ok: trend.at(-1).ok, error: trend.at(-1).error }, { ok: 1, error: 1 })
  assert.equal(trend.at(-2).warn, 1)
  // An older-than-window entry is dropped, and a silent day stays at zero.
  assert.equal(trend.at(1).warn, 0)
  assert.equal(trend.reduce((sum, d) => sum + d.warn, 0), 1)
})

test('with a Web app present, both routes require the GUI token', async () => {
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  const deps = baseDeps({ webServer })
  deps.host.reflect = {
    get: (name) => (name === 'webApp' ? { getAdvertisedUrl: () => 'http://127.0.0.1:3080/?token=secret-token' } : undefined),
  }
  registerDashboard(deps)

  const page = routes.find((route) => route.path === '/keelwatch/dashboard')
  const call = async (url) => {
    let code = null
    await page.handler(
      { method: 'GET', headers: {}, url },
      {
        writeHead: (value) => {
          code = value
        },
        end: () => {},
      },
    )
    return code
  }

  assert.equal(await call('/keelwatch/dashboard'), 401)
  assert.equal(await call('/keelwatch/dashboard?token=wrong'), 401)
  assert.equal(await call('/keelwatch/dashboard?token=secret-token'), 200)
  // The header form is accepted too, for callers that cannot put it in the URL.
  let code = null
  await page.handler(
    { method: 'GET', headers: { 'x-dsh-token': 'secret-token' }, url: '/keelwatch/dashboard' },
    {
      writeHead: (value) => {
        code = value
      },
      end: () => {},
    },
  )
  assert.equal(code, 200)
})
