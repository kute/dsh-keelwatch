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
import { installCostAttribution } from './cost-attribution.js'
import { startDriftRadar } from './drift-radar.js'
import { installFailureBrake } from './failure-brake.js'
import type { KeelwatchHost } from './host.js'

/** Cordis row name; short because it prefixes every log line. */
export const name = 'keelwatch'

/** Only hard dependency: the host-owned timer that keeps the radar periodic. */
export const inject = ['timer']

export { Config } from './config.js'
export type { Config as KeelwatchConfig } from './config.js'

/**
 * Plugin entry point.
 *
 * Every branch is guarded and nothing here throws: a monitoring plugin that can
 * stop the host from booting is a net loss, so a broken
 * configuration degrades to "no monitoring" with one log line.
 */
export function apply(ctx: Context, config: ConfigShape): void {
  const host = ctx as unknown as KeelwatchHost
  const normalized = normalizeConfig(config)

  if (normalized.driftRadar.enabled) {
    try {
      startDriftRadar(host, normalized.driftRadar)
    } catch (error) {
      host.logger?.warn(`keelwatch: drift radar disabled after load error: ${describe(error)}`)
    }
  }

  if (normalized.failureBrake.enabled) {
    try {
      installFailureBrake(host, normalized.failureBrake)
    } catch (error) {
      host.logger?.warn(`keelwatch: failure brake disabled after load error: ${describe(error)}`)
    }
  }

  if (normalized.costAttribution.enabled) {
    try {
      installCostAttribution(host, normalized.costAttribution)
    } catch (error) {
      host.logger?.warn(`keelwatch: cost attribution disabled after load error: ${describe(error)}`)
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
