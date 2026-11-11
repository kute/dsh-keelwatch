import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FailureBrake } from '../lib/failure-brake.js'

const config = {
  enabled: true,
  action: 'brake',
  maxConsecutiveErrors: 3,
  cooldownMinutes: 10,
  tools: [],
  exclude: [],
  neverBrake: ['ask_user_question'],
}

const T0 = 1_000_000

function crash(brake, tool, times, start = T0) {
  for (let index = 0; index < times; index += 1) brake.observe(tool, true, start)
}

test('the brake stays closed below the threshold', () => {
  const brake = new FailureBrake(config)
  crash(brake, 'bash', 2)
  assert.equal(brake.check('bash', T0).deny, false)
})

test('reaching the threshold opens the brake for the cooldown window', () => {
  const brake = new FailureBrake(config)
  crash(brake, 'bash', 3)
  assert.equal(brake.check('bash', T0).deny, true)
  // One minute before the cooldown elapses: still denied.
  assert.equal(brake.check('bash', T0 + 9 * 60_000).deny, true)
})

test('after the cooldown exactly one probe is admitted', () => {
  const brake = new FailureBrake(config)
  crash(brake, 'bash', 3)
  const adultAt = T0 + 10 * 60_000
  assert.equal(brake.check('bash', adultAt).deny, false)
  // A second call while the first probe is outstanding is denied again.
  assert.equal(brake.check('bash', adultAt).deny, true)
})

test('a successful probe closes the brake and clears the count', () => {
  const brake = new FailureBrake(config)
  crash(brake, 'bash', 3)
  const adultAt = T0 + 10 * 60_000
  brake.check('bash', adultAt)
  brake.observe('bash', false, adultAt)
  assert.equal(brake.check('bash', adultAt).deny, false)
  assert.deepEqual(brake.snapshot()['bash'], { failures: 0, openedAt: null, probeInFlight: false })
})

test('a failed probe re-opens for a full cooldown', () => {
  const brake = new FailureBrake(config)
  crash(brake, 'bash', 3)
  const adultAt = T0 + 10 * 60_000
  brake.check('bash', adultAt)
  brake.observe('bash', true, adultAt)
  assert.equal(brake.check('bash', adultAt + 60_000).deny, true)
  assert.equal(brake.check('bash', adultAt + 10 * 60_000).deny, false)
})

test('`log` action never denies, but still counts', () => {
  const brake = new FailureBrake({ ...config, action: 'log' })
  crash(brake, 'bash', 10)
  assert.equal(brake.check('bash', T0).deny, false)
  assert.equal(brake.snapshot()['bash'].failures, 10)
})

test('neverBrake and exclude win over an eager configuration', () => {
  const brake = new FailureBrake({ ...config, exclude: ['web_*'] })
  crash(brake, 'ask_user_question', 10)
  crash(brake, 'web_search', 10)
  assert.equal(brake.check('ask_user_question', T0).deny, false)
  assert.equal(brake.check('web_search', T0).deny, false)
})

test('an allow-list limits braking to the named tools', () => {
  const brake = new FailureBrake({ ...config, tools: ['bash'] })
  crash(brake, 'bash', 5)
  crash(brake, 'read', 5)
  assert.equal(brake.check('bash', T0).deny, true)
  assert.equal(brake.check('read', T0).deny, false)
})

test('snapshot/restore round-trips the state machine', () => {
  const brake = new FailureBrake(config)
  crash(brake, 'bash', 3)
  const saved = brake.snapshot()
  const restored = new FailureBrake(config)
  restored.restore(saved)
  assert.equal(restored.check('bash', T0).deny, true)
  assert.deepEqual(restored.openTools(T0), ['bash'])
})
