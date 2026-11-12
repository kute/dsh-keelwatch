/**
 * Host half of the configuration page.
 *
 * The browser half cannot call a Cordis service, so the two halves meet on a
 * plain HTTP route served by the same webserver that serves the GUI:
 *
 *   GET  /keelwatch/config   current effective values + where they live
 *   POST /keelwatch/config   validate and persist, then let the Loader reload
 *
 * Writes go through `ctx.configEditor`, the host service whose whole job is
 * "persist through profile patches and reconcile", so this plugin never edits
 * `cordis.patch.yml` by hand and never invents a second config store.
 *
 * Scope is deliberately narrow: one exact path, own entry only, a fixed JSON
 * shape, and a custom header the browser only sends same-origin. A monitoring
 * plugin must not become a generic remote-config surface.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Config, DEFAULTS, normalizeConfig, type Config as ConfigShape } from './config.js'
import type { KeelwatchHost } from './host.js'

const ROUTE_PATH = '/keelwatch/config'
const ENTRY_ID = 'keelwatch'
const MAX_BODY_BYTES = 64 * 1024
/** Cross-site requests cannot set a custom header without a preflight we refuse. */
const REQUIRED_HEADER = 'x-keelwatch-config'

interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

interface ConfigEditorLike {
  readonly documentPath?: string
  entries(): Array<{ id?: unknown; name?: unknown }>
  configuration(): Array<{ entry: { id?: unknown }; inherited: Record<string, unknown>; override: Record<string, unknown> }>
  edit(
    entry: unknown,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

export interface ConfigApiDeps {
  readonly host: KeelwatchHost
}

function resolve<T>(host: KeelwatchHost, service: string): T | null {
  try {
    const found = host.reflect?.get(service)
    if (typeof found === 'object' && found !== null) return found as T
  } catch {
    // Absent services are a normal profile difference, not an error.
  }
  return null
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readBody(req: IncomingMessage): Promise<string> {
  let total = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    total += buffer.byteLength
    if (total > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Merge the bundle-layer defaults with the profile override for display. */
export function effectiveConfig(inherited: Record<string, unknown>, override: Record<string, unknown>): ConfigShape {
  const merged = { ...DEFAULTS } as Record<string, unknown>
  for (const group of ['driftRadar', 'failureBrake', 'costAttribution'] as const) {
    const blanket = (value: unknown): Record<string, unknown> =>
      typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
    const base = blanket(inherited[group])
    const own = blanket(override[group])
    merged[group] = { ...blanket(DEFAULTS[group]), ...base, ...own }
  }
  return normalizeConfig(merged as unknown as ConfigShape)
}

/**
 * Validate a submitted configuration.
 *
 * The same schema the host validates at load time runs here first, so an invalid
 * form submission fails in the page with a readable reason instead of writing a
 * patch that would make the next start fail.
 */
export function validateSubmitted(input: unknown): { ok: true; config: ConfigShape } | { ok: false; reason: string } {
  if (typeof input !== 'object' || input === null) return { ok: false, reason: 'expected a JSON object' }
  try {
    // Schemastery's call signature is typed against the full shape; a submitted
    // form is intentionally partial, so it is parsed through an untyped call and
    // the schema supplies defaults for the missing groups.
    const parse = Config as unknown as (value: unknown) => ConfigShape
    return { ok: true, config: normalizeConfig(parse(input)) }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Register the route.
 *
 * Returns false (with one log line) when the profile has no webserver or no
 * config editor — a headless or minimal profile simply has no config page.
 */
export function registerConfigApi(deps: ConfigApiDeps): boolean {
  const { host } = deps
  const webServer = resolve<WebServerLike>(host, 'webServer')
  if (webServer === null || typeof webServer.register !== 'function') {
    host.logger?.info?.('keelwatch: config page unavailable (no webserver in this profile)')
    return false
  }

  const dispose = webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    async handler(req, res) {
      try {
        if (req.method === 'GET') {
          const editor = resolve<ConfigEditorLike>(host, 'configEditor')
          if (editor === null) return send(res, 503, { ok: false, reason: 'config editor unavailable' })
          const rows = editor.configuration()
          const row = rows.find((candidate) => candidate.entry?.id === ENTRY_ID)
          if (row === undefined) return send(res, 404, { ok: false, reason: `row ${ENTRY_ID} not found` })
          return send(res, 200, {
            ok: true,
            entryId: ENTRY_ID,
            documentPath: editor.documentPath ?? null,
            config: effectiveConfig(row.inherited, row.override),
          })
        }

        if (req.method === 'POST') {
          if (req.headers[REQUIRED_HEADER] === undefined) {
            return send(res, 403, { ok: false, reason: 'missing same-origin header' })
          }
          const raw = await readBody(req)
          let parsed: unknown
          try {
            parsed = JSON.parse(raw)
          } catch {
            return send(res, 400, { ok: false, reason: 'body is not valid JSON' })
          }
          const validated = validateSubmitted(parsed)
          if (!validated.ok) return send(res, 400, { ok: false, reason: validated.reason })

          const editor = resolve<ConfigEditorLike>(host, 'configEditor')
          if (editor === null) return send(res, 503, { ok: false, reason: 'config editor unavailable' })
          const entry = editor.entries().find((candidate) => candidate.id === ENTRY_ID)
          if (entry === undefined) return send(res, 404, { ok: false, reason: `row ${ENTRY_ID} not found` })

          // A patch replaces the whole `config` value, so the full shape is
          // written rather than a delta that would silently drop siblings.
          await editor.edit(entry, () => ({ ...validated.config }))
          return send(res, 200, {
            ok: true,
            applied: 'reload',
            documentPath: editor.documentPath ?? null,
            config: validated.config,
          })
        }

        return send(res, 405, { ok: false, reason: `method ${req.method ?? 'unknown'} not allowed` })
      } catch (error) {
        host.logger?.warn(`keelwatch: config endpoint failed: ${error instanceof Error ? error.message : String(error)}`)
        return send(res, 500, { ok: false, reason: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  host.effect?.(() => () => {
    try {
      dispose()
    } catch {
      // The server may already be torn down during profile shutdown.
    }
  })
  return true
}
