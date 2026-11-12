/**
 * dsh-keelwatch — the operations layer for a DSH plugin ecosystem.
 *
 * Three jobs, all of them *after* installation: watch what installed bundles
 * declare against what upstream published (Drift Radar), stop a repeatedly
 * failing tool from being retried into a token fire (Failure Brake), and record
 * where tool time actually goes (Cost Attribution).
 *
 * Deliberately absent: timeouts (the host's `tool-call-timeout-policy` owns
 * them), repeat-call reminders (the host's `repeat-tool-reminder` owns them),
 * and any independent web UI.
 */
import type { Context } from '@deepseek-ai/cordis'
import { normalizeConfig, type Config as ConfigShape } from './config.js'
import { registerConfigApi } from './config-api.js'
import { installCostAttribution, type CostLedger } from './cost-attribution.js'
import { resolveDshHome, startDriftRadar } from './drift-radar.js'
import { installFailureBrake, type BrakeState, type FailureBrake } from './failure-brake.js'
import type { KeelwatchHost } from './host.js'
import { readHealth } from './plugin-health.js'
import { registerReportTool } from './report-tool.js'
import { TokenAttribution } from './token-attribution.js'
import { readJsonFile, stateFilePath, writeJsonAtomic } from './state-store.js'

/** Cordis row name; short because it prefixes every log line. */
export const name = 'keelwatch'

/** Only hard dependency: the host-owned timer that keeps the radar periodic. */
export const inject = ['timer']

export { Config } from './config.js'
export type { Config as KeelwatchConfig } from './config.js'

interface PersistedBrake {
  readonly version: 1
  readonly savedAt: number
  readonly tools: Record<string, BrakeState>
}

const SAVE_INTERVAL_MS = 30_000

/**
 * Restore and continuously persist the brake state.
 *
 * Persistence is best effort in both directions: an unreadable snapshot means
 * "start closed" (the safe direction — never brake on stale evidence), and a
 * failed write only costs continuity, never a tool call.
 */
function wirePersistence(host: KeelwatchHost, brake: FailureBrake, path: string): void {
  let savedRevision = 0

  const save = (): void => {
    const revision = brake.getRevision()
    if (revision === savedRevision) return
    savedRevision = revision
    const payload: PersistedBrake = { version: 1, savedAt: Date.now(), tools: brake.snapshot() }
    void writeJsonAtomic(path, payload)
  }

  void readJsonFile<PersistedBrake>(path).then((state) => {
    if (state === null || state.version !== 1) return
    try {
      brake.restore(state.tools)
      savedRevision = brake.getRevision()
      const open = brake.openTools()
      if (open.length > 0) host.logger?.warn(`keelwatch: restored brake state, still braking ${open.join(', ')}`)
    } catch (error) {
      host.logger?.warn(`keelwatch: brake snapshot ignored: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  host.timer?.interval?.(save, SAVE_INTERVAL_MS)
  // Final flush on unload; the disposer runs before the fiber's other resources
  // are released, so the timer and the disk write still work here.
  host.effect?.(() => () => save())
}

/**
 * Plugin entry point.
 *
 * Every branch is guarded and nothing here throws: a monitoring plugin that can
 * stop the host from booting is a net loss, so a broken configuration degrades
 * to "no monitoring" with one log line.
 */
export function apply(ctx: Context, config: ConfigShape): void {
  const host = ctx as unknown as KeelwatchHost
  const normalized = normalizeConfig(config)
  const dshHome = resolveDshHome()

  let brake: FailureBrake | undefined
  let ledger: CostLedger | undefined
  let tokens: TokenAttribution | undefined

  if (normalized.driftRadar.enabled) {
    try {
      startDriftRadar(host, normalized.driftRadar)
    } catch (error) {
      host.logger?.warn(`keelwatch: drift radar disabled after load error: ${describe(error)}`)
    }
  }

  if (normalized.failureBrake.enabled) {
    try {
      brake = installFailureBrake(host, normalized.failureBrake)
      wirePersistence(host, brake, stateFilePath(dshHome, 'brake.json'))
    } catch (error) {
      host.logger?.warn(`keelwatch: failure brake disabled after load error: ${describe(error)}`)
    }
  }

  if (normalized.costAttribution.enabled) {
    try {
      ledger = installCostAttribution(host, normalized.costAttribution)
    } catch (error) {
      host.logger?.warn(`keelwatch: cost attribution disabled after load error: ${describe(error)}`)
    }
  }

  if (normalized.costAttribution.enabled) {
    try {
      const attribution = new TokenAttribution(host.logger)
      // The append feed is fire-and-forget and observer failures are contained
      // by the host; the extra guard keeps a bug here from ever touching a turn.
      host.on('session/event', (session: unknown, event: unknown) => {
        try {
          attribution.observe(session, event as never)
        } catch (error) {
          host.logger?.warn(`keelwatch: token observation failed: ${describe(error)}`)
        }
      })
      tokens = attribution
    } catch (error) {
      host.logger?.warn(`keelwatch: token attribution disabled after load error: ${describe(error)}`)
    }
  }

  try {
    registerConfigApi({ host })
  } catch (error) {
    host.logger?.warn(`keelwatch: config page disabled after load error: ${describe(error)}`)
  }

  // Report one broken bundle early instead of waiting for the user to notice a
  // missing capability. Deferred: the manager lists bundles only after the
  // loader has settled.
  const announceBrokenBundles = (): void => {
    void readHealth(host)
      .then((health) => {
        if (!health.available || health.problems.length === 0) return
        const lines = health.problems.map((problem) => `  - ${problem.bundle}: ${problem.detail}`)
        host.logger?.warn(
          [`keelwatch: ${health.problems.length} bundle(s) failed to load`, ...lines, '  run keelwatch_report to inspect'].join('\n'),
        )
      })
      .catch(() => undefined)
  }
  if (typeof host.timer?.timeout === 'function') host.timer.timeout(announceBrokenBundles, 5_000)
  else announceBrokenBundles()

  const reportDeps = {
    host,
    driftConfig: normalized.driftRadar,
    costConfig: normalized.costAttribution,
    ...(brake === undefined ? {} : { brake }),
    ...(ledger === undefined ? {} : { ledger }),
    ...(tokens === undefined ? {} : { tokens }),
  }

  // `ctx.inject` starts a nested plugin once `tools` is active, which is the
  // supported way to consume a service this plugin does not make mandatory.
  const inject = (ctx as unknown as { inject?: (deps: string[], callback: (inner: unknown) => void) => unknown }).inject
  if (typeof inject === 'function') {
    try {
      inject.call(ctx, ['tools'], (inner: unknown) => {
        try {
          registerReportTool({ ...reportDeps, registry: (inner as { tools?: unknown }).tools })
        } catch (error) {
          host.logger?.warn(`keelwatch: report tool disabled after load error: ${describe(error)}`)
        }
      })
    } catch (error) {
      host.logger?.warn(`keelwatch: report tool injection failed: ${describe(error)}`)
    }
  }

  if (typeof inject !== 'function') {
    // Hosts without nested injection still get the tool if the registry is
    // already reachable; registering twice would collide, hence the `else`.
    try {
      registerReportTool(reportDeps)
    } catch (error) {
      host.logger?.warn(`keelwatch: report tool disabled after load error: ${describe(error)}`)
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
