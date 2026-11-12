import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS } from '../lib/config.js'
import { collectInstalledBundles, scanDrift, summarize } from '../lib/drift-radar.js'
import { matchesPattern } from '../lib/patterns.js'

function makeDshHome(packages) {
  const home = mkdtempSync(join(tmpdir(), 'keelwatch-'))
  for (const [profile, pkg] of Object.entries(packages)) {
    const dir = join(home, 'profiles', profile, 'node_modules', ...pkg.name.split('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
  }
  return home
}

const driftConfig = { ...DEFAULTS.driftRadar, requestTimeoutMs: 100 }

test('collectInstalledBundles reads scoped and unscoped packages once per name', async () => {
  const home = makeDshHome({
    demo: { name: '@deepseek-ai/dsh-tools', version: '0.2.1-rc.5', dependencies: {} },
  })
  const nested = join(home, 'profiles', 'demo', 'node_modules', 'plain-plugin')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'plain-plugin', version: '1.0.0' }))

  const bundles = await collectInstalledBundles(home)
  assert.deepEqual(
    bundles.map((bundle) => bundle.name),
    ['@deepseek-ai/dsh-tools', 'plain-plugin'],
  )
  rmSync(home, { recursive: true, force: true })
})

test('an engines.dsh mismatch is reported before any registry lookup', async () => {
  const home = makeDshHome({
    demo: {
      name: 'drift-plugin',
      version: '1.0.0',
      engines: { dsh: '>=9.0.0' },
      dependencies: {},
    },
  })
  let lookups = 0
  const report = await scanDrift(driftConfig, {
    dshHome: home,
    dshVersion: '0.2.1-rc.5',
    lookup: async () => {
      lookups += 1
      throw new Error('registry must not be consulted for an incompatible bundle')
    },
  })

  assert.equal(report.findings.length, 1)
  assert.equal(report.findings[0].kind, 'engine-incompatible')
  assert.equal(lookups, 0)
  assert.match(summarize(report), /drift-plugin@1\.0\.0 declares engines\.dsh/)
  rmSync(home, { recursive: true, force: true })
})

test('dependency drift is reported only at or above the configured alert level', async () => {
  const home = makeDshHome({
    demo: {
      name: 'bundle-a',
      version: '1.0.0',
      dependencies: { '@deepseek-ai/cordis': '~4.0.5' },
    },
  })
  const lookup = async () => ({ name: '@deepseek-ai/cordis', status: 'ok', latest: '4.1.0', fetchedAt: Date.now() })

  const minorSilent = await scanDrift({ ...driftConfig, alertLevel: 'major' }, {
    dshHome: home,
    dshVersion: '0.2.1',
    lookup,
  })
  assert.equal(minorSilent.findings.length, 0)

  const allReported = await scanDrift({ ...driftConfig, alertLevel: 'all' }, {
    dshHome: home,
    dshVersion: '0.2.1',
    lookup,
  })
  assert.equal(allReported.findings.length, 1)
  assert.equal(allReported.findings[0].kind, 'dependency-drift')
  assert.equal(allReported.findings[0].level, 'minor')
  rmSync(home, { recursive: true, force: true })
})

test('a whitelisted package is skipped with a reason, not silently dropped', async () => {
  const home = makeDshHome({
    demo: { name: 'noisy-plugin', version: '1.0.0', engines: { dsh: '>=9.0.0' } },
  })
  const report = await scanDrift({ ...driftConfig, whitelist: ['noisy-*'] }, {
    dshHome: home,
    dshVersion: '0.2.1',
  })
  assert.equal(report.findings.length, 0)
  assert.deepEqual(report.skipped, [{ packageName: 'noisy-plugin', reason: 'whitelisted' }])
  rmSync(home, { recursive: true, force: true })
})

test('an unreachable registry degrades to skipped, never to a finding', async () => {
  const home = makeDshHome({
    demo: { name: 'bundle-b', version: '1.0.0', dependencies: { '@deepseek-ai/cordis': '^4.0.0' } },
  })
  const report = await scanDrift(driftConfig, {
    dshHome: home,
    dshVersion: '0.2.1',
    lookup: async (name) => ({ name, status: 'unreachable', detail: 'offline', fetchedAt: Date.now() }),
  })
  assert.equal(report.findings.length, 0)
  assert.equal(report.skipped.length, 1)
  assert.match(report.skipped[0].reason, /offline/)
  rmSync(home, { recursive: true, force: true })
})

test('matchesPattern supports the documented wildcard form only', () => {
  assert.equal(matchesPattern('dsh-*', 'dsh-keelwatch'), true)
  assert.equal(matchesPattern('dsh-*', 'keelwatch'), false)
  assert.equal(matchesPattern('web_search', 'web_search'), true)
  assert.equal(matchesPattern('a.c', 'abc'), false)
})

test('one unreachable registry stops the rest of the scan instead of timing out per package', async () => {
  const home = makeDshHome({
    demo: {
      name: 'bundle-c',
      version: '1.0.0',
      dependencies: {
        '@deepseek-ai/cordis': '^4.0.0',
        '@deepseek-ai/schemastery': '^3.18.0',
        '@deepseek-ai/dsh-llm': '^0.2.1',
      },
    },
  })
  let calls = 0
  const report = await scanDrift(driftConfig, {
    dshHome: home,
    dshVersion: '0.2.1',
    lookup: async (name) => {
      calls += 1
      return { name, status: 'unreachable', detail: 'ENOTFOUND registry.npmjs.org', fetchedAt: Date.now() }
    },
  })
  // Only the first dependency pays the failure; the rest are skipped with a reason.
  assert.equal(calls, 1)
  assert.equal(report.findings.length, 0)
  assert.equal(report.skipped.length, 3)
  assert.match(report.skipped[1].reason, /registry unreachable earlier in this scan/)
  rmSync(home, { recursive: true, force: true })
})
