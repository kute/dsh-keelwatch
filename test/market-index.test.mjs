import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { marketInstallTarget, parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

const root = new URL('..', import.meta.url).pathname
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const raw = readFileSync(join(root, "docs/index.json"), "utf8")

test('the shipped market index passes the official format-1 validator', () => {
  const index = parseMarketIndex(JSON.parse(raw), 'https://kute.github.io/dsh-keelwatch/index.json')
  assert.equal(index.format, 1)
  assert.equal(index.plugins.length, 1)
  const plugin = index.plugins[0]
  assert.equal(plugin.name, manifest.name)
  assert.equal(plugin.versions[0].version, manifest.version)
})

test('the index agrees with package.json on the engine range the host re-checks', () => {
  const index = parseMarketIndex(JSON.parse(raw), 'https://kute.github.io/dsh-keelwatch/index.json')
  const version = index.plugins[0].versions[0]
  assert.equal(version.engines.dsh, manifest.engines.dsh)
  assert.equal(marketInstallTarget(index.plugins[0].name, version).spec, `${manifest.name}@${manifest.version}`)
})

test('the published tarball carries the bundle patch the profile launcher needs', () => {
  // A bundle without its patch installs as a plain dependency and activates
  // nothing, so the manifest declaration and the file must both be present.
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(manifest.files.includes('cordis.patch.yml'))
  assert.ok(readFileSync(join(root, 'cordis.patch.yml'), 'utf8').includes('dsh-keelwatch'))
})
