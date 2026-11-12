import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, Config, inject, name } from '../lib/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Minimal host: records registrations, never calls them unless a test does. */
function makeHost() {
  const events = []
  const timers = []
  const warnings = []
  const listeners = new Map()
  const host = {
    logger: { warn: (message) => warnings.push(message), info: () => {} },
    timer: {
      interval: (callback, delay) => {
        timers.push(delay)
        return () => {}
      },
    },
    on: (event, listener) => {
      events.push(event)
      listeners.set(event, listener)
      return () => {}
    },
  }
  return { host, events, timers, warnings, listeners }
}

function baseConfig(overrides) {
  return {
    driftRadar: {
      enabled: false,
      checkIntervalHours: 24,
      alertLevel: 'major',
      whitelist: [],
      registryUrl: '',
      requestTimeoutMs: 500,
    },
    failureBrake: {
      enabled: false,
      action: 'log',
      maxConsecutiveErrors: 5,
      cooldownMinutes: 10,
      tools: [],
      exclude: [],
      neverBrake: ['ask_user_question'],
    },
    costAttribution: { enabled: false, retentionDays: 7, toolToBundle: {}, topN: 10 },
    ...overrides,
  }
}

test('the module exports exactly the three faces a Cordis bundle needs', () => {
  assert.equal(name, 'keelwatch')
  assert.deepEqual(inject, ['timer'])
  assert.equal(typeof Config, 'function')
  assert.equal(typeof apply, 'function')
})

test('with everything disabled nothing is registered and nothing throws', () => {
  const { host, events } = makeHost()
  apply(host, baseConfig({}))
  assert.deepEqual(events, [])
})

test('the brake registers both waterfalls and denies once tripped', async () => {
  const { host, events, listeners } = makeHost()
  apply(host, baseConfig({
    failureBrake: { ...baseConfig({}).failureBrake, enabled: true, action: 'brake', maxConsecutiveErrors: 2 },
  }))

  assert.ok(events.includes('tools/post-execute'))
  assert.ok(events.includes('tools/pre-execute'))

  const post = listeners.get('tools/post-execute')
  const pre = listeners.get('tools/pre-execute')
  const exec = { name: 'bash' }

  await post(exec, { isError: true }, async () => ({ isError: true }))
  await post(exec, { isError: true }, async () => ({ isError: true }))

  let dispatched = false
  const decision = await pre(exec, async () => {
    dispatched = true
    return { isError: false }
  })
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.info.code, 'TOOL_COOLED_DOWN')
  assert.equal(dispatched, false)

  // An unrelated tool is untouched.
  const other = await pre({ name: 'read' }, async () => ({ isError: false }))
  assert.deepEqual(other, { isError: false })
})

test('cost attribution wraps tools/execute and returns the unmodified result', async () => {
  const { host, events, listeners } = makeHost()
  apply(host, baseConfig({
    costAttribution: { ...baseConfig({}).costAttribution, enabled: true },
  }))
  assert.ok(events.includes('tools/execute'))

  const execute = listeners.get('tools/execute')
  const sentinel = { isError: false, content: [] }
  const result = await execute({ name: 'bash' }, async () => sentinel)
  assert.equal(result, sentinel)
})

test('a failing listener body never propagates as a tool error', async () => {
  const { host, listeners } = makeHost()
  apply(host, baseConfig({
    failureBrake: { ...baseConfig({}).failureBrake, enabled: true, action: 'brake' },
  }))
  const pre = listeners.get('tools/pre-execute')
  // exec without a name would throw inside the guard; the guard must swallow it.
  const decision = await pre({}, async () => ({ isError: false }))
  assert.deepEqual(decision, { isError: false })
})

test('the report tool is registered through ctx.inject, not by assuming ctx.tools', () => {
  const registered = []
  const injected = []
  const host = {
    logger: { warn: () => {}, info: () => {} },
    on: () => () => {},
    timer: { interval: () => {}, timeout: () => () => {} },
    inject: (deps, callback) => {
      injected.push(deps)
      if (deps.includes('tools')) callback({ tools: { register: (tool) => registered.push(tool.name) } })
      else callback({ webServer: { register: () => () => {} } })
      return {}
    },
  }
  apply(host, baseConfig({}))
  // Both optional services are consumed through injection, never by probing.
  assert.deepEqual(injected.map((deps) => deps[0]).sort(), ['tools', 'webServer'])
  assert.deepEqual(registered, ['keelwatch_report'])
})

test('the drift radar scans once at startup and schedules the configured period', () => {
  const home = mkdtempSync(join(tmpdir(), 'keelwatch-apply-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { host, timers } = makeHost()
    apply(host, baseConfig({
      driftRadar: { ...baseConfig({}).driftRadar, enabled: true, checkIntervalHours: 6 },
    }))
    assert.deepEqual(timers, [6 * 3_600_000])
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
})
