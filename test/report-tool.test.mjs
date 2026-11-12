import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS } from '../lib/config.js'
import { buildStatusReport, registerReportTool } from '../lib/report-tool.js'
import { apply } from '../lib/index.js'
import { FailureBrake } from '../lib/failure-brake.js'
import { CostLedger } from '../lib/cost-attribution.js'

function withTempHome(fn) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'keelwatch-report-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      await fn(home)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    }
  }
}

const baseHost = (extra = {}) => ({
  logger: { warn: () => {}, info: () => {} },
  on: () => () => {},
  ...extra,
})

test('the status report covers all four sections without throwing', withTempHome(async () => {
  const ledger = new CostLedger()
  ledger.record('bash', 12, false)
  const brake = new FailureBrake({ ...DEFAULTS.failureBrake, enabled: true, action: 'brake', maxConsecutiveErrors: 2 })
  brake.observe('bash', true)
  brake.observe('bash', true)

  const report = await buildStatusReport({
    host: baseHost({ reflect: { get: () => undefined } }),
    driftConfig: DEFAULTS.driftRadar,
    costConfig: DEFAULTS.costAttribution,
    brake,
    ledger,
  })

  // Every section carries both readings and the report ends with a conclusion.
  assert.match(report, /keelwatch status report · keelwatch 状态报告/)
  assert.match(report, /\[1\] Bundles 插件包/)
  assert.match(report, /EN: /)
  assert.match(report, /ZH: /)
  assert.match(report, /0 package\(s\) scanned, no findings/)
  assert.match(report, /braking: bash/)
  assert.match(report, /bash: 1 call\(s\), 0 error\(s\)/)
  assert.match(report, /\[6\] Conclusion 结论/)
}))

test('a disabled brake and ledger are reported as such, not omitted', withTempHome(async () => {
  const report = await buildStatusReport({
    host: baseHost({ reflect: { get: () => undefined } }),
    driftConfig: DEFAULTS.driftRadar,
    costConfig: DEFAULTS.costAttribution,
  })
  assert.match(report, /disabled in configuration · 配置中未启用/)
  assert.match(report, /not recorded \(cost attribution disabled\)/)
  assert.match(report, /No broken bundles, no drift, nothing braking/)
}))

test('the tool refuses a disable without a bundle name instead of guessing', withTempHome(async () => {
  const registered = []
  const host = baseHost({ tools: { register: (tool) => registered.push(tool) } })
  assert.equal(registerReportTool({ host, driftConfig: DEFAULTS.driftRadar, costConfig: DEFAULTS.costAttribution }), true)
  assert.equal(registered.length, 1)

  const tool = registered[0]
  assert.equal(tool.name, 'keelwatch_report')
  const reply = await tool.execute({ action: 'disable' })
  assert.match(reply, /needs a bundle name/)
}))

test('registerReportTool degrades when the profile exposes no tool registry', () => {
  assert.equal(registerReportTool({ host: baseHost(), driftConfig: DEFAULTS.driftRadar, costConfig: DEFAULTS.costAttribution }), false)
})

test('apply persists brake state through the host timer and flushes on unload', withTempHome(async (home) => {
  const listeners = new Map()
  const intervals = []
  const disposers = []
  const host = {
    logger: { warn: () => {}, info: () => {} },
    on: (event, listener) => {
      listeners.set(event, listener)
      return () => {}
    },
    timer: {
      interval: (callback) => {
        intervals.push(callback)
        return () => {}
      },
      timeout: () => () => {},
    },
    effect: (entry) => {
      disposers.push(entry())
      return () => {}
    },
  }

  apply(host, {
    ...DEFAULTS,
    driftRadar: { ...DEFAULTS.driftRadar, enabled: false },
    costAttribution: { ...DEFAULTS.costAttribution, enabled: false },
    failureBrake: { ...DEFAULTS.failureBrake, enabled: true, action: 'brake', maxConsecutiveErrors: 2 },
  })

  const post = listeners.get('tools/post-execute')
  await post({ name: 'bash' }, { isError: true }, async () => ({ isError: true }))
  await post({ name: 'bash' }, { isError: true }, async () => ({ isError: true }))

  // Nothing is written until the periodic saver runs.
  assert.equal(existsSync(join(home, 'keelwatch', 'brake.json')), false)
  assert.equal(intervals.length, 1)
  intervals[0]()
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(existsSync(join(home, 'keelwatch', 'brake.json')), true)

  // Unload flush must not throw.
  for (const dispose of disposers) dispose()
}))
