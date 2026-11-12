import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS } from '../lib/config.js'
import { effectiveConfig, registerConfigApi, validateSubmitted } from '../lib/config-api.js'
import { readRowConfig } from '../lib/patch-writer.js'

function tempPatch(initial = '[]\n') {
  const dir = mkdtempSync(join(tmpdir(), 'keelwatch-api-'))
  const path = join(dir, 'cordis.patch.yml')
  writeFileSync(path, initial)
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function makeHost({ documentPath, webServer } = {}) {
  const routes = []
  const warnings = []
  const services = {
    configEditor: documentPath === undefined ? undefined : { documentPath },
  }
  const resolvedWebServer =
    webServer === undefined
      ? {
          register(route) {
            routes.push(route)
            return () => {}
          },
        }
      : webServer
  services.webServer = resolvedWebServer
  return {
    host: {
      logger: { warn: (m) => warnings.push(m), info: (m) => warnings.push(m) },
      on: () => () => {},
      reflect: { get: (name) => services[name] },
    },
    routes,
    warnings,
  }
}

function makeRes() {
  return {
    status: null,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(payload) {
      this.body = payload ?? ''
    },
  }
}

function makeReq({ method = 'GET', headers = {}, body } = {}) {
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body, 'utf8')
    },
  }
}

test('validateSubmitted accepts a partial config and fills the gaps from defaults', () => {
  const result = validateSubmitted({ failureBrake: { enabled: true } })
  assert.equal(result.ok, true)
  assert.equal(result.config.failureBrake.enabled, true)
  assert.equal(result.config.failureBrake.action, 'log')
  assert.equal(result.config.driftRadar.enabled, true)
})

test('validateSubmitted rejects non-objects instead of writing a bad patch', () => {
  assert.equal(validateSubmitted('nope').ok, false)
  assert.equal(validateSubmitted(null).ok, false)
})

test('effectiveConfig prefers the explicit layer over inherited values', () => {
  const merged = effectiveConfig(
    { driftRadar: { checkIntervalHours: 24, alertLevel: 'major' } },
    { driftRadar: { checkIntervalHours: 6 } },
  )
  assert.equal(merged.driftRadar.checkIntervalHours, 6)
  assert.equal(merged.driftRadar.alertLevel, 'major')
  assert.equal(merged.failureBrake.enabled, false)
})

test('without a webserver the config page is simply unavailable', () => {
  const { host, warnings } = makeHost({ webServer: null })
  assert.equal(registerConfigApi({ host }), false)
  assert.match(warnings.at(-1) ?? '', /config page unavailable/)
})

test('GET reports defaults while the profile patch has no managed row', async () => {
  const { path, cleanup } = tempPatch()
  const { host, routes } = makeHost({ documentPath: path })
  assert.equal(registerConfigApi({ host }), true)
  assert.equal(routes[0].path, '/keelwatch/config')

  const res = makeRes()
  await routes[0].handler(makeReq(), res)
  const payload = JSON.parse(res.body)
  assert.equal(res.status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.managed, false)
  assert.equal(payload.documentPath, path)
  assert.equal(payload.config.failureBrake.enabled, DEFAULTS.failureBrake.enabled)
  cleanup()
})

test('POST writes the profile patch and GET reads it back', async () => {
  const { path, cleanup } = tempPatch()
  const { host, routes } = makeHost({ documentPath: path })
  registerConfigApi({ host })

  const body = JSON.stringify({ driftRadar: { checkIntervalHours: 2 }, failureBrake: { enabled: true, action: 'brake' } })
  const post = makeRes()
  await routes[0].handler(makeReq({ method: 'POST', headers: { 'x-keelwatch-config': '1' }, body }), post)
  const payload = JSON.parse(post.body)
  assert.equal(post.status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.changed, true)
  assert.ok(payload.backupPath === null || typeof payload.backupPath === 'string')

  const written = readFileSync(path, 'utf8')
  assert.match(written, /- id: keelwatch/)

  const get = makeRes()
  await routes[0].handler(makeReq(), get)
  const readBack = JSON.parse(get.body)
  assert.equal(readBack.managed, true)
  assert.equal(readBack.config.driftRadar.checkIntervalHours, 2)
  assert.equal(readBack.config.failureBrake.action, 'brake')
  cleanup()
})

test('POST without the same-origin header never touches the file', async () => {
  const { path, cleanup } = tempPatch('- id: untouched\n')
  const before = readFileSync(path, 'utf8')
  const { host, routes } = makeHost({ documentPath: path })
  registerConfigApi({ host })
  const res = makeRes()
  await routes[0].handler(makeReq({ method: 'POST', body: '{"driftRadar":{}}' }), res)
  assert.equal(res.status, 403)
  assert.equal(readFileSync(path, 'utf8'), before)
  cleanup()
})

test('POST with an invalid body writes nothing', async () => {
  const { path, cleanup } = tempPatch('[]\n')
  const { host, routes } = makeHost({ documentPath: path })
  registerConfigApi({ host })
  const res = makeRes()
  await routes[0].handler(makeReq({ method: 'POST', headers: { 'x-keelwatch-config': '1' }, body: 'not-json' }), res)
  assert.equal(res.status, 400)
  assert.equal(readFileSync(path, 'utf8'), '[]\n')
  cleanup()
})

test('a profile without a resolvable patch path degrades with 503', async () => {
  const { host, routes } = makeHost({})
  registerConfigApi({ host })
  const res = makeRes()
  await routes[0].handler(makeReq(), res)
  assert.equal(res.status, 503)
})

test('unsupported methods are answered, not ignored', async () => {
  const { path, cleanup } = tempPatch()
  const { host, routes } = makeHost({ documentPath: path })
  registerConfigApi({ host })
  const res = makeRes()
  await routes[0].handler(makeReq({ method: 'DELETE' }), res)
  assert.equal(res.status, 405)
  cleanup()
})

test('the managed row survives a round trip through the reader', async () => {
  const { path, cleanup } = tempPatch()
  await writeRowConfigForTest(path)
  const read = await readRowConfig(path)
  assert.equal(read.found, true)
  assert.ok(read.config !== null)
  cleanup()
})

async function writeRowConfigForTest(path) {
  const { writeRowConfig } = await import('../lib/patch-writer.js')
  await writeRowConfig(path, { driftRadar: { enabled: false } })
}
