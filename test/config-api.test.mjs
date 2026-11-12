import { test } from 'node:test'
import assert from 'node:assert/strict'
import { effectiveConfig, registerConfigApi, validateSubmitted } from '../lib/config-api.js'

function makeHost({ webServer, configEditor } = {}) {
  const routes = []
  const warnings = []
  // The default recorder IS the webserver the host reflects, so every test sees
  // the routes this plugin registered.
  // `webServer: null` models a profile with no webserver; omitting it installs
  // the recording stub.
  const resolvedWebServer =
    webServer === undefined
      ? {
          register(route) {
            routes.push(route)
            return () => {}
          },
        }
      : webServer
  const services = { webServer: resolvedWebServer, configEditor }
  return {
    host: {
      logger: { warn: (m) => warnings.push(m), info: (m) => warnings.push(m) },
      on: () => () => {},
      reflect: { get: (name) => services[name] },
    },
    routes,
    warnings,
    services,
    webServer: resolvedWebServer,
  }
}

function makeRes() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
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
  assert.equal(result.config.costAttribution.retentionDays, 7)
})

test('validateSubmitted rejects non-objects instead of writing a bad patch', () => {
  assert.equal(validateSubmitted('nope').ok, false)
  assert.equal(validateSubmitted(null).ok, false)
})

test('effectiveConfig prefers the profile override over bundle-layer values', () => {
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

test('GET reports the effective config and the file it is persisted to', async () => {
  const editor = {
    documentPath: '/Users/u/.dsh/profiles/web/cordis.patch.yml',
    entries: () => [{ id: 'keelwatch' }],
    configuration: () => [
      { entry: { id: 'keelwatch' }, inherited: {}, override: { failureBrake: { enabled: true } } },
    ],
    edit: async () => {},
  }
  const { host, routes } = makeHost({ configEditor: editor })
  assert.equal(registerConfigApi({ host }), true)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, '/keelwatch/config')

  const res = makeRes()
  await routes[0].handler(makeReq({ method: 'GET' }), res)
  const payload = JSON.parse(res.body)
  assert.equal(res.status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.config.failureBrake.enabled, true)
  assert.match(payload.documentPath, /cordis\.patch\.yml$/)
})

test('POST without the same-origin header is refused before touching the profile', async () => {
  const editor = {
    documentPath: '/x/cordis.patch.yml',
    entries: () => [{ id: 'keelwatch' }],
    configuration: () => [],
    edit: async () => {
      throw new Error('must not be called')
    },
  }
  const { host, routes } = makeHost({ configEditor: editor })
  registerConfigApi({ host })
  const res = makeRes()
  await routes[0].handler(makeReq({ method: 'POST', body: '{}' }), res)
  assert.equal(res.status, 403)
})

test('POST persists the whole config shape through the config editor', async () => {
  const edits = []
  const editor = {
    documentPath: '/x/cordis.patch.yml',
    entries: () => [{ id: 'keelwatch' }, { id: 'other' }],
    configuration: () => [],
    edit: async (entry, change) => {
      edits.push({ entry, config: change({}, {}) })
    },
  }
  const { host, routes } = makeHost({ configEditor: editor })
  registerConfigApi({ host })

  const res = makeRes()
  const body = JSON.stringify({ driftRadar: { checkIntervalHours: 2 }, failureBrake: { enabled: true, action: 'brake' } })
  await routes[0].handler(makeReq({ method: 'POST', headers: { 'x-keelwatch-config': '1' }, body }), res)

  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).ok, true)
  assert.deepEqual(edits[0].entry, { id: 'keelwatch' })
  // The patch replaces a row's whole config, so every group must be present.
  assert.deepEqual(Object.keys(edits[0].config).sort(), ['costAttribution', 'driftRadar', 'failureBrake'])
  assert.equal(edits[0].config.driftRadar.checkIntervalHours, 2)
  assert.equal(edits[0].config.failureBrake.action, 'brake')
})

test('POST with an invalid body fails loudly and writes nothing', async () => {
  let called = false
  const editor = {
    documentPath: '/x/cordis.patch.yml',
    entries: () => [{ id: 'keelwatch' }],
    configuration: () => [],
    edit: async () => {
      called = true
    },
  }
  const { host, routes } = makeHost({ configEditor: editor })
  registerConfigApi({ host })

  const res = makeRes()
  await routes[0].handler(makeReq({ method: 'POST', headers: { 'x-keelwatch-config': '1' }, body: 'not-json' }), res)
  assert.equal(res.status, 400)
  assert.equal(called, false)
})

test('unsupported methods are answered, not ignored', async () => {
  const editor = {
    documentPath: '/x/cordis.patch.yml',
    entries: () => [{ id: 'keelwatch' }],
    configuration: () => [],
    edit: async () => {},
  }
  const { host, routes } = makeHost({ configEditor: editor })
  registerConfigApi({ host })
  const res = makeRes()
  await routes[0].handler(makeReq({ method: 'DELETE' }), res)
  assert.equal(res.status, 405)
})
