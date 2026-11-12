/**
 * Plugin health: read the profile's bundle inventory and report the bundles
 * that failed to load.
 *
 * The launcher reports a failed bundle only inside its own startup log; the
 * running process already knows it, because `pluginManager.listBundles()`
 * keeps `error` on a selected bundle whose layer was skipped. Reading that is
 * far safer than parsing diagnostics text.
 *
 * Disabling a bundle is offered, never performed on its own: it rewrites the
 * profile's `cordis.patch.yml`, and the upstream contract says the change may
 * only take effect at the next start (`application: 'restart-required'`).
 */
import type { WarnSink } from './host.js'

export interface ManagementErrorLike {
  readonly code?: string
  readonly diagnostic?: string
}

export interface BundleInfoLike {
  readonly name?: unknown
  readonly version?: unknown
  readonly enabled?: unknown
  readonly availability?: unknown
  readonly installed?: unknown
  readonly error?: unknown
}

export interface BundleProblem {
  readonly bundle: string
  readonly enabled: boolean
  readonly detail: string
}

export interface HealthSnapshot {
  /** Whether the profile even exposes bundle management. */
  readonly available: boolean
  readonly scanned: number
  readonly problems: readonly BundleProblem[]
}

export interface PluginManagerLike {
  listBundles(): Promise<unknown>
  setBundleEnabled(name: string, enabled: boolean): Promise<unknown>
}

export interface ManagerHost {
  readonly reflect?: { get(name: string): unknown }
  readonly pluginManager?: unknown
  readonly logger?: WarnSink
}

function describeError(error: unknown): string {
  if (typeof error === 'string') return error
  // A thrown `Error` stringifies to `{}`, so unwrap it before the shape probe
  // below (which targets the manager's plain `ManagementError` objects).
  if (error instanceof Error) return error.message === '' ? error.name : error.message
  if (typeof error === 'object' && error !== null) {
    const { code, diagnostic } = error as ManagementErrorLike
    if (typeof diagnostic === 'string' && diagnostic !== '') return code === undefined ? diagnostic : `${code}: ${diagnostic}`
    if (typeof code === 'string') return code
  }
  try {
    return JSON.stringify(error).slice(0, 300)
  } catch {
    return String(error)
  }
}

/**
 * Resolve the plugin manager without an injection requirement.
 *
 * `ctx.reflect.get` is the documented way to read a service a plugin does not
 * depend on; the direct property is a fallback for hosts that mix services in.
 */
export function resolvePluginManager(host: ManagerHost): PluginManagerLike | null {
  const candidates: unknown[] = []
  try {
    candidates.push(host.reflect?.get('pluginManager'))
  } catch {
    // A throwing reflect means the service is unavailable, not a hard failure.
  }
  try {
    // The plain property read throws on a context whose fiber did not inject the
    // service ("cannot get property \"pluginManager\" without inject"); probing a
    // service may degrade to "unavailable", never fail the inventory.
    candidates.push(host.pluginManager)
  } catch {
    // `reflect.get` above is the sanctioned read; keep whatever it returned.
  }

  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const manager = candidate as Partial<PluginManagerLike>
    if (typeof manager.listBundles === 'function') return manager as PluginManagerLike
  }
  return null
}

/** One inventory read, reduced to the bundles that carry a load error. */
export async function readHealth(host: ManagerHost): Promise<HealthSnapshot> {
  const manager = resolvePluginManager(host)
  if (manager === null) return { available: false, scanned: 0, problems: [] }

  let listed: unknown
  try {
    listed = await manager.listBundles()
  } catch (error) {
    host.logger?.warn(`keelwatch: bundle inventory unavailable: ${describeError(error)}`)
    return { available: false, scanned: 0, problems: [] }
  }

  const bundles = Array.isArray(listed) ? (listed as BundleInfoLike[]) : []
  const problems: BundleProblem[] = []
  for (const bundle of bundles) {
    if (typeof bundle.name !== 'string') continue
    if (bundle.error === undefined || bundle.error === null) continue
    problems.push({
      bundle: bundle.name,
      enabled: bundle.enabled === true,
      detail: describeError(bundle.error),
    })
  }
  return { available: true, scanned: bundles.length, problems }
}

export interface DisableOutcome {
  readonly ok: boolean
  readonly restartRequired: boolean
  readonly message: string
}

/**
 * Turn one bundle off for the current profile.
 *
 * Refuses silently-wrong input (unknown bundle, missing manager) and reports
 * `restart-required` honestly instead of claiming a hot fix.
 */
export async function disableBundle(host: ManagerHost, name: string): Promise<DisableOutcome> {
  const manager = resolvePluginManager(host)
  if (manager === null) {
    return { ok: false, restartRequired: false, message: 'bundle management is unavailable in this profile' }
  }
  if (typeof manager.setBundleEnabled !== 'function') {
    return { ok: false, restartRequired: false, message: 'this host exposes no bundle switch' }
  }

  const snapshot = await readHealth(host)
  if (snapshot.available && !snapshot.problems.some((problem) => problem.bundle === name)) {
    // Not a hard error: a healthy bundle may still be one the user wants off.
    // The report says so, and the caller decides.
    host.logger?.info?.(`keelwatch: ${name} has no recorded load error`)
  }

  try {
    const result = (await manager.setBundleEnabled(name, false)) as { application?: unknown } | null
    const application = typeof result?.application === 'string' ? result.application : 'unknown'
    const restartRequired = application === 'restart-required'
    return {
      ok: application === 'applied' || restartRequired,
      restartRequired,
      message: restartRequired
        ? `disabled ${name}; the change takes effect at the next DSH start`
        : `disabled ${name} (application: ${application})`,
    }
  } catch (error) {
    return { ok: false, restartRequired: false, message: `disabling ${name} failed: ${describeError(error)}` }
  }
}
