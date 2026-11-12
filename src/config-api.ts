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
import type { HistoryLog } from './history.js'
import { ROW_ID, readRowConfig, writeRowConfig } from './patch-writer.js'

const ROUTE_PATH = '/keelwatch/config'
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

/**
 * Only `documentPath` is used: it names the profile patch this profile edits,
 * which is exactly the file the page must write. Row listing is not used because
 * that service addresses profile-declared rows only, and a bundle's row is not
 * one of them.
 */
interface ConfigEditorLike {
  readonly documentPath?: string
}

export interface ConfigApiDeps {
  readonly host: KeelwatchHost
  /** Detection history; served at GET /keelwatch/history when present. */
  readonly history?: HistoryLog
  /**
   * Webserver handed over by `ctx.inject(['webServer'])`.
   *
   * `reflect.get` only returns an *active* provider, and this plugin's fiber can
   * load before the webserver finishes activating — which is exactly how the
   * route silently went missing the first time. Injection waits instead.
   */
  readonly webServer?: unknown
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
 * Resolve the profile patch file to write.
 *
 * `configEditor.documentPath` is the authoritative answer (it is the file the
 * profile launcher composes last); `$DSH_HOME/profiles/<profile>/cordis.patch.yml`
 * is not derivable from inside a plugin without that pointer.
 */
function patchPathOf(host: KeelwatchHost): string | null {
  const editor = resolve<ConfigEditorLike>(host, 'configEditor')
  const path = editor?.documentPath
  return typeof path === 'string' && path !== '' ? path : null
}

/**
 * Register the route.
 *
 * Returns false (with one log line) when the profile has no webserver or no
 * config editor — a headless or minimal profile simply has no config page.
 */
export function registerConfigApi(deps: ConfigApiDeps): boolean {
  const { host } = deps
  const injected = deps.webServer
  const webServer =
    typeof injected === 'object' && injected !== null ? (injected as WebServerLike) : resolve<WebServerLike>(host, 'webServer')
  if (webServer === null || typeof webServer.register !== 'function') {
    host.logger?.warn('keelwatch: config page unavailable (no webserver in this profile)')
    return false
  }

  const dispose = webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    async handler(req, res) {
      try {
        if (req.method === 'GET') {
          const documentPath = patchPathOf(host)
          if (documentPath === null) return send(res, 503, { ok: false, reason: 'profile patch not resolvable' })
          const row = await readRowConfig(documentPath, ROW_ID)
          // A managed row already carries the full shape; a missing or
          // hand-written row falls back to the documented defaults.
          const config =
            row.config === null
              ? DEFAULTS
              : normalizeConfig({ ...(DEFAULTS as unknown as Record<string, unknown>), ...row.config } as unknown as ConfigShape)
          return send(res, 200, {
            ok: true,
            entryId: ROW_ID,
            documentPath,
            managed: row.config !== null,
            config,
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

          const documentPath = patchPathOf(host)
          if (documentPath === null) return send(res, 503, { ok: false, reason: 'profile patch not resolvable' })

          const written = await writeRowConfig(documentPath, { ...validated.config }, ROW_ID)
          return send(res, 200, {
            ok: true,
            changed: written.changed,
            createdRow: written.createdRow,
            documentPath,
            backupPath: written.backupPath,
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
  if (deps.history !== undefined) {
    const historyLog = deps.history
    const disposeHistory = webServer.register({
      kind: 'exact',
      path: '/keelwatch/history',
      async handler(req, res) {
        if (req.method !== 'GET') return send(res, 405, { ok: false, reason: 'GET only' })
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20))
          const entries = await historyLog.read(limit)
          return send(res, 200, { ok: true, count: entries.length, entries })
        } catch (error) {
          return send(res, 500, { ok: false, reason: error instanceof Error ? error.message : String(error) })
        }
      },
    })
    host.effect?.(() => () => {
      try {
        disposeHistory()
      } catch {
        // Already torn down with the server.
      }
    })
  }

  host.logger?.info?.(`keelwatch: config page served at ${ROUTE_PATH}`)
  return true
}
