/**
 * Host surface, isolated in its own module.
 *
 * These interfaces are structural on purpose: the DSH release candidates move
 * the concrete package types between minors, while the *shapes* documented in
 * `docs/subsystems/tools.zh.md` are the contract a plugin may rely on.
 */

export interface WarnSink {
  warn(message: string): void
  info?(message: string): void
}

export interface ToolExecutionLike {
  readonly name: string
  readonly callId?: string
}

export interface PostToolResultLike {
  readonly isError?: boolean
}

/** The around-dispatch waterfall result; opaque to this plugin. */
export type ToolResultLike = unknown

/** A `PreToolDecision` the brake may return. */
export interface PreToolDeny {
  readonly kind: 'deny'
  readonly reason: string
  readonly info?: { readonly name: string; readonly code: string }
}

export type PreToolDecisionLike = PreToolDeny | { readonly kind: 'allow' } | { readonly kind: 'cancel' }

/**
 * Service lookup without an injection requirement.
 *
 * Cordis exposes `ctx.reflect.get(name)` for exactly this: reading a service
 * a plugin does not want to depend on. Every optional capability in this
 * plugin (timer, plugin manager, tool registry) is resolved through it so a
 * profile that lacks one still loads the rest.
 */
export interface HostReflect {
  get(name: string): unknown
}

export interface KeelwatchHost {
  readonly logger?: WarnSink
  /** Provided by `@deepseek-ai/cordis-plugin-timer`; dies with the fiber. */
  readonly timer?: { interval(callback: () => void, delay: number): unknown; timeout?(callback: () => void, delay: number): unknown }
  /** Register a waterfall listener; the host owns its disposal. */
  on(event: string, listener: (...args: any[]) => unknown): unknown
  /** Run a disposer-scoped effect; used for the final state flush. */
  effect?(execute: () => (() => unknown) | void): unknown
  /**
   * Service lookup that requires no injection (`ctx.get`).
   *
   * Reads through `reflect`/`get` are the ONLY safe way to reach an
   * un-injected service: touching the property instead (for example
   * `ctx.tools`) throws `cannot get property "tools" without inject`, which is
   * exactly how the report tool went missing once.
   */
  readonly reflect?: HostReflect
  readonly get?: (name: string) => unknown
  /**
   * Not safe to read on a Cordis context proxy unless `tools` is injected.
   * Kept optional for hosts that mix the service in; always access it through
   * {@link safeService} instead of directly.
   */
  readonly tools?: unknown
  /** Profile bundle management, when the profile provides it. */
  readonly pluginManager?: unknown
}

/**
 * The GUI's access token, or `null` when this profile has no Web app.
 *
 * `webApp.getAdvertisedUrl()` is the advertised entry URL and carries it as
 * `?token=`. Reading it is the only way for a plugin to know what the GUI
 * expects; the `/api` fence is not reusable from an arbitrary route.
 */
export function expectedGuiToken(host: KeelwatchHost): string | null {
  try {
    const app = host.reflect?.get('webApp') as { getAdvertisedUrl?: () => string } | undefined
    if (typeof app?.getAdvertisedUrl !== 'function') return null
    const advertised = app.getAdvertisedUrl()
    const token = new URL(advertised).searchParams.get('token')
    return token === null || token === '' ? null : token
  } catch {
    return null
  }
}

/**
 * Whether a request may touch a plugin route.
 *
 * Two tiers, because the host exposes no reusable check:
 *
 * - When a token can be discovered (`webApp.getAdvertisedUrl()` carrying
 *   `?token=`), it is required — query, `x-dsh-token`, or `dsh_token` cookie.
 * - Otherwise the route falls back to a **same-origin check**: a request with an
 *   `Origin` header whose host does not match the served host is refused. That
 *   is the practical threat (a page in the browser reaching localhost); a local
 *   process can read the token file anyway, so pretending otherwise would be
 *   security theatre.
 *
 * Note: `getAdvertisedUrl()` in this host returns the origin *without* a token,
 * so in practice the same-origin tier is what runs — this is stated plainly in
 * the README rather than claiming a token check that never happens.
 */
export function isAllowedRequest(
  req: { url?: string; headers: Record<string, unknown> },
  expected: string | null,
): boolean {
  if (expected !== null) return carriesGuiToken(req.url, req.headers, expected)
  const origin = req.headers['origin']
  if (typeof origin !== 'string' || origin === '') return true
  const host = req.headers['host']
  try {
    return typeof host === 'string' && new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Whether a request carries the GUI token.
 *
 * When the profile has no Web app (headless, SDK) there is nothing to compare
 * against and the route is local-only anyway, so the caller decides what to do
 * with a `null` expectation.
 */
export function carriesGuiToken(url: string | undefined, headers: Record<string, unknown>, expected: string): boolean {
  try {
    const parsed = new URL(url ?? '/', 'http://127.0.0.1')
    if (parsed.searchParams.get('token') === expected) return true
    const header = headers['x-dsh-token']
    if (typeof header === 'string' && header === expected) return true
    const cookie = headers['cookie']
    if (typeof cookie === 'string' && cookie.split(';').some((part) => part.trim() === `dsh_token=${expected}`)) return true
  } catch {
    // Malformed request target: treat as unauthorized.
  }
  return false
}
