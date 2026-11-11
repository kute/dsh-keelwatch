import { test } from 'node:test'
import assert from 'node:assert/strict'
import { disableBundle, readHealth, resolvePluginManager } from '../lib/plugin-health.js'

function hostWith(manager) {
  const warnings = []
  return {
    host: {
      logger: { warn: (message) => warnings.push(message), info: () => {} },
      reflect: { get: (name) => (name === 'pluginManager' ? manager : undefined) },
    },
    warnings,
  }
}

test('resolvePluginManager prefers ctx.reflect and tolerates absence', () => {
  const manager = { listBundles: async () => [] }
  assert.equal(resolvePluginManager({ reflect: { get: () => manager } }), manager)
  assert.equal(resolvePluginManager({}), null)
  assert.equal(resolvePluginManager({ reflect: { get: () => { throw new Error('no scope') } } }), null)
})

test('readHealth reduces the inventory to bundles carrying a load error', async () => {
  const manager = {
    listBundles: async () => [
      { name: 'healthy', enabled: true },
      { name: 'broken', enabled: true, error: { code: 'incompatible-version', diagnostic: 'engines.dsh rejects 0.2.1' } },
      { name: 'not-a-bundle', enabled: false, error: { code: 'not-bundle' } },
      'garbage',
    ],
  }
  const { host } = hostWith(manager)
  const snapshot = await readHealth(host)
  assert.equal(snapshot.available, true)
  assert.equal(snapshot.scanned, 4)
  assert.deepEqual(snapshot.problems.map((problem) => problem.bundle), ['broken', 'not-a-bundle'])
  assert.match(snapshot.problems[0].detail, /incompatible-version: engines\.dsh rejects/)
})

test('readHealth reports unavailability when the inventory throws', async () => {
  const { host, warnings } = hostWith({
    listBundles: async () => {
      throw new Error('profile locked')
    },
  })
  const snapshot = await readHealth(host)
  assert.equal(snapshot.available, false)
  assert.match(warnings[0], /inventory unavailable: profile locked/)
})

test('disableBundle reports restart-required honestly', async () => {
  const calls = []
  const manager = {
    listBundles: async () => [{ name: 'broken', enabled: true, error: { code: 'operation-error' } }],
    setBundleEnabled: async (name, enabled) => {
      calls.push([name, enabled])
      return { application: 'restart-required', changed: true, stage: 'enable' }
    },
  }
  const { host } = hostWith(manager)
  const outcome = await disableBundle(host, 'broken')
  assert.deepEqual(calls, [['broken', false]])
  assert.equal(outcome.ok, true)
  assert.equal(outcome.restartRequired, true)
  assert.match(outcome.message, /next DSH start/)
})

test('disableBundle refuses without a manager and reports failures', async () => {
  assert.equal((await disableBundle({}, 'x')).ok, false)

  const { host } = hostWith({
    listBundles: async () => [],
    setBundleEnabled: async () => {
      throw new Error('bundle-in-use')
    },
  })
  const outcome = await disableBundle(host, 'x')
  assert.equal(outcome.ok, false)
  assert.match(outcome.message, /bundle-in-use/)
})
