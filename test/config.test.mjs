import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, Config, normalizeConfig } from '../lib/config.js'

test('every documented default is present after parsing an empty config', () => {
  const parsed = Config({})
  assert.equal(parsed.driftRadar.enabled, true)
  assert.equal(parsed.driftRadar.checkIntervalHours, 24)
  assert.equal(parsed.driftRadar.alertLevel, 'major')
  assert.deepEqual(parsed.driftRadar.whitelist, [])
  assert.equal(parsed.failureBrake.enabled, false)
  assert.equal(parsed.failureBrake.action, 'log')
  assert.equal(parsed.failureBrake.maxConsecutiveErrors, 5)
  assert.deepEqual(parsed.failureBrake.neverBrake, ['ask_user_question'])
  assert.equal(parsed.costAttribution.enabled, true)
  assert.equal(parsed.costAttribution.retentionDays, 7)
})

test('normalizeConfig clamps values that would make the brake unsafe', () => {
  const normalized = normalizeConfig({
    ...DEFAULTS,
    failureBrake: { ...DEFAULTS.failureBrake, maxConsecutiveErrors: 1, cooldownMinutes: 0 },
    driftRadar: { ...DEFAULTS.driftRadar, checkIntervalHours: -5, requestTimeoutMs: 1 },
    costAttribution: { ...DEFAULTS.costAttribution, retentionDays: 0, topN: 999 },
  })
  assert.equal(normalized.failureBrake.maxConsecutiveErrors, 2)
  assert.equal(normalized.failureBrake.cooldownMinutes, 1)
  assert.equal(normalized.driftRadar.checkIntervalHours, 0)
  assert.equal(normalized.driftRadar.requestTimeoutMs, 500)
  assert.equal(normalized.costAttribution.retentionDays, 1)
  assert.equal(normalized.costAttribution.topN, 100)
})

test('unknown keys are tolerated: parsed, kept, and never read', () => {
  // Schemastery keeps undeclared keys, so the assertion that matters is that the
  // plugin's known keys still resolve and the host is not asked to reject a
  // config written for a newer keelwatch.
  const parsed = Config({ driftRadar: { enabled: false, mystery: 1 } })
  assert.equal(parsed.driftRadar.enabled, false)
  assert.equal(parsed.driftRadar.checkIntervalHours, 24)
})
