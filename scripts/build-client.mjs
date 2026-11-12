#!/usr/bin/env node
/**
 * Copy the hand-written browser half into `lib/client.js` and prove it loads.
 *
 * The client module format is `window.__ModuleLoader__.load({ id, factory })`,
 * which no TypeScript compiler emits. Instead of adding a bundler for one form,
 * the source is plain JS and this script is the whole "client build": copy, then
 * execute it against a stub loader and assert the two exports the Web client
 * requires (`apply`, `inject`).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src/client/index.js')
const target = join(root, 'lib/client.js')

const code = await readFile(source, 'utf8')

/** Minimal stand-in for the browser loader plus the two externals we require. */
function loadWithStub(sourceText) {
  let registered = null
  const React = {
    createElement: (...args) => ({ args }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  }
  const sandbox = {
    window: {
      // The real client runtime provides a location; the page reads `?token=`
      // from it, so the stub must expose one too.
      location: { search: '' },
      __ModuleLoader__: {
        load(spec) {
          registered = spec
        },
      },
    },
    require: (name) => {
      if (name === 'react') return React
      throw new Error(`unexpected external: ${name}`)
    },
    fetch: async () => ({ status: 200, json: async () => ({ ok: true }) }),
    console,
  }
  vm.runInNewContext(sourceText, sandbox, { filename: source })
  if (registered === null) throw new Error('client module did not call __ModuleLoader__.load')
  if (typeof registered.id !== 'string' || registered.id === '') throw new Error('client module has no id')
  const exports = registered.factory(sandbox.require)
  return { id: registered.id, exports }
}

const { id, exports } = loadWithStub(code)
if (typeof exports.apply !== 'function') throw new Error('client module does not export apply()')
if (!Array.isArray(exports.inject) || exports.inject.length === 0) throw new Error('client module exports no inject list')

// `apply` must register exactly one slot when driven by a minimal context.
const registrations = []
const injections = []
const ctx = {
  slots: {
    inject(name, factory) {
      injections.push(name)
      factory()
    },
    register(meta, component) {
      registrations.push({ meta, component })
      return () => {}
    },
  },
}
exports.apply(ctx)
if (injections[0] !== 'plugins.bundle.config') {
  throw new Error(`client registered into ${injections[0] ?? 'nothing'} instead of plugins.bundle.config`)
}
if (registrations.length !== 1) throw new Error('client registered an unexpected number of slots')
if (registrations[0].meta.key !== '@kutebai/dsh-keelwatch') throw new Error('client slot key must be the package name')

await mkdir(dirname(target), { recursive: true })
await writeFile(target, code, 'utf8')
console.log(`client: wrote ${target} (id ${id}, inject ${exports.inject.join(', ')}, slot ${registrations[0].meta.name})`)
