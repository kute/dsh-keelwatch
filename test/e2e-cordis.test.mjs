import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import * as keelwatch from '../lib/index.js'
import { DEFAULTS } from '../lib/config.js'

/**
 * End-to-end against a real Cordis context.
 *
 * The other suites drive `apply()` with a hand-written host; this one lets the
 * framework itself resolve `inject = ['timer','tools']`, mount the plugin and
 * dispatch the waterfalls. That is the part mocks cannot prove: a wrong inject
 * name or a throwing registration passes every mock and fails only here.
 */
function makeRuntime({ tools = true, timer = true } = {}) {
  const app = new Context()
  const timers = []
  const registered = []
  const provisioned = []

  if (timer) {
    const service = {
      interval: (callback, delay) => {
        timers.push({ delay, callback })
        return () => {}
      },
      timeout: (callback, delay) => {
        timers.push({ delay, callback, once: true })
        return () => {}
      },
    }
    app.provide('timer', service)
    provisioned.push('timer')
  }
  if (tools) {
    const service = {
      register: (tool) => {
        registered.push(tool)
        return () => {}
      },
      get: () => undefined,
    }
    app.provide('tools', service)
    provisioned.push('tools')
  }
  return { app, timers, registered, provisioned }
}

async function mount(runtime, overrides = {}) {
  const config = {
    ...DEFAULTS,
    driftRadar: { ...DEFAULTS.driftRadar, enabled: false },
    failureBrake: { ...DEFAULTS.failureBrake, enabled: true, action: 'brake', maxConsecutiveErrors: 2, cooldownMinutes: 10 },
    costAttribution: { ...DEFAULTS.costAttribution, enabled: true },
    ...overrides,
  }
  await runtime.app.plugin(keelwatch, config)
  return config
}

/** One settled tool call through the real waterfall chain. */
async function settled(app, name, result) {
  return app.waterfall('tools/post-execute', { name }, result, async () => result)
}

async function pre(app, name) {
  return app.waterfall('tools/pre-execute', { name }, async () => ({ kind: 'allow' }))
}

test('the framework mounts the plugin and hands it its injected services', async () => {
  const runtime = makeRuntime()
  await mount(runtime)
  // The report tool is registered through the injected registry, not a mock.
  assert.equal(runtime.registered.length, 1)
  assert.equal(runtime.registered[0].name, 'keelwatch_report')
  // The drift radar is disabled in this config, so no interval was armed for it.
  assert.deepEqual(runtime.timers.filter((entry) => entry.delay === 24 * 3_600_000), [])
})

test('repeated failures trip the brake inside a real waterfall', async () => {
  const runtime = makeRuntime()
  await mount(runtime)

  assert.deepEqual(await pre(runtime.app, 'crash'), { kind: 'allow' })
  await settled(runtime.app, 'crash', { isError: true, error: { info: { code: 'ENOENT' }, message: 'no such file' } })
  await settled(runtime.app, 'crash', { isError: true, error: { info: { code: 'ENOENT' } } })

  const decision = await pre(runtime.app, 'crash')
  assert.equal(decision.kind, 'deny')
  assert.equal(decision.info.code, 'TOOL_COOLED_DOWN')
  // The denial names the cause and a next step instead of only refusing.
  assert.match(decision.reason, /Do not retry the same call/)
  assert.match(decision.reason, /check that the path exists/)
  assert.match(decision.reason, /ENOENT/)
})

test('a cancelled call never counts, so a healthy tool stays available', async () => {
  const runtime = makeRuntime()
  await mount(runtime)
  for (let index = 0; index < 5; index += 1) {
    await settled(runtime.app, 'read', { isError: true, error: { info: { code: 'ABORTED' } } })
  }
  assert.deepEqual(await pre(runtime.app, 'read'), { kind: 'allow' })
})

test('timing is recorded through the execute wrapper', async () => {
  const runtime = makeRuntime()
  await mount(runtime)
  const result = await runtime.app.waterfall('tools/execute', { name: 'bash' }, async () => ({ isError: false }))
  assert.deepEqual(result, { isError: false })
  // A second call keeps accumulating rather than replacing the row.
  await runtime.app.waterfall('tools/execute', { name: 'bash' }, async () => ({ isError: true }))
})

test('without the tools service the plugin never activates', async () => {
  const runtime = makeRuntime({ tools: false })
  await mount(runtime)
  assert.deepEqual(runtime.registered, [])
})

test('a profile without a timer does not activate the plugin', async () => {
  // `timer` is a static inject, so the plugin waits for it. That is safe because
  // dsh-base mounts @deepseek-ai/cordis-plugin-timer itself (id `timer`), so
  // every profile built on base — web, headless, sdk — provides it. A profile
  // that removed it would simply not get keelwatch, which is the honest outcome
  // of declaring a dependency rather than silently degrading.
  const runtime = makeRuntime({ timer: false })
  await mount(runtime)
  assert.deepEqual(runtime.registered, [])
})
