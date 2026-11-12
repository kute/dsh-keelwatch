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
import { registerDashboard } from './dashboard.js'
import { installCostAttribution, type CostLedger } from './cost-attribution.js'
import { resolveDshHome, startDriftRadar } from './drift-radar.js'
import { installFailureBrake, type BrakeState, type FailureBrake } from './failure-brake.js'
import type { KeelwatchHost } from './host.js'
import { HistoryLog, historyPath } from './history.js'
import { readHealth } from './plugin-health.js'
import { registerReportTool } from './report-tool.js'
import { TokenAttribution } from './token-attribution.js'
import { readJsonFile, stateFilePath, writeJsonAtomic } from './state-store.js'

/** Cordis row name; short because it prefixes every log line. */
export const name = 'keelwatch'

/**
 * Required services.
 *
 * `tools` is declared statically rather than reached through `ctx.inject` or
 * `ctx.get`: reading an un-injected service off a Cordis context throws
 * `cannot get property "tools" without inject`, and that throw silently cost
 * this plugin its only tool. Both services exist in every profile that can run
 * a tool at all.
 */
export const inject = ['timer', 'tools']

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
  const history = new HistoryLog(historyPath(dshHome), normalized.costAttribution.retentionDays)
  const injectService = (ctx as unknown as { inject?: (deps: string[], callback: (inner: unknown) => void) => unknown }).inject

  let brake: FailureBrake | undefined
  let ledger: CostLedger | undefined
  let tokens: TokenAttribution | undefined

  if (normalized.driftRadar.enabled) {
    try {
      startDriftRadar(host, normalized.driftRadar, (report) => {
        const findings = report.findings.length
        const major = report.findings.filter((finding) => finding.level === 'major').length
        void history.append({
          kind: 'drift',
          level: findings === 0 ? 'ok' : major > 0 ? 'warn' : 'info',
          en:
            findings === 0
              ? `Drift scan: ${report.bundlesScanned} packages scanned, nothing drifted past the "${normalized.driftRadar.alertLevel}" level.`
              : `Drift scan: ${findings} finding(s) across ${report.bundlesScanned} packages${major > 0 ? `, ${major} major` : ''}.`,
          zh:
            findings === 0
              ? `依赖漂移扫描：扫描 ${report.bundlesScanned} 个包，没有超出「${normalized.driftRadar.alertLevel}」级别的漂移。`
              : `依赖漂移扫描：${report.bundlesScanned} 个包中发现 ${findings} 处${major > 0 ? `，其中 ${major} 处为大版本` : ''}。`,
          detail: report.findings.map((finding) => `${finding.packageName}: ${finding.message}`).join('\n'),
        })
      })
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

  // Same pattern as the tool registry: wait for the service instead of probing
  // for it, because a missing provider at this instant is a load-order artefact,
  // not a profile without a webserver.
  const mountConfigPage = (webServer?: unknown): void => {
    try {
      registerConfigApi({ host, history, ...(webServer === undefined ? {} : { webServer }) })
    } catch (error) {
      host.logger?.warn(`keelwatch: config page disabled after load error: ${describe(error)}`)
    }

    // Opt-in: default off, so an install exposes no extra route until asked.
    if (normalized.dashboard.enabled) {
      try {
        registerDashboard({
          host,
          ...(webServer === undefined ? {} : { webServer }),
          ...(history === undefined ? {} : { history }),
          ...(brake === undefined ? {} : { brake }),
          ...(ledger === undefined ? {} : { ledger }),
          ...(tokens === undefined ? {} : { tokens }),
          driftConfig: normalized.driftRadar,
          brakeConfig: normalized.failureBrake,
          costConfig: normalized.costAttribution,
          refreshSeconds: normalized.dashboard.refreshSeconds,
        })
      } catch (error) {
        host.logger?.warn(`keelwatch: dashboard disabled after load error: ${describe(error)}`)
      }
    }
  }

  if (typeof injectService === 'function') {
    try {
      injectService.call(ctx, ['webServer'], (inner: unknown) => mountConfigPage((inner as { webServer?: unknown }).webServer))
    } catch (error) {
      host.logger?.warn(`keelwatch: config page injection failed: ${describe(error)}`)
    }
  } else {
    mountConfigPage()
  }

  // Report one broken bundle early instead of waiting for the user to notice a
  // missing capability. Deferred: the manager lists bundles only after the
  // loader has settled.
  // Bundle health: one check shortly after startup (the manager lists bundles
  // only once the loader settled) and then on the same period as the drift
  // scan, so "checkIntervalHours" is the single answer to "how often does this
  // look at my plugins?".
  const checkBundles = (): void => {
    void readHealth(host)
      .then((health) => {
        if (!health.available) return
        if (health.problems.length === 0) {
          void history.append({
            kind: 'bundle',
            level: 'ok',
            en: `Bundle check: ${health.scanned} bundles tracked, none failed to load.`,
            zh: `插件包检查：跟踪 ${health.scanned} 个包，没有加载失败。`,
          })
          return
        }
        const lines = health.problems.map((problem) => `  - ${problem.bundle}: ${problem.detail}`)
        host.logger?.warn(
          [`keelwatch: ${health.problems.length} bundle(s) failed to load`, ...lines, '  run keelwatch_report to inspect'].join('\n'),
        )
        // stderr too: a broken bundle must be visible in the launcher's log even
        // when nobody opens a session.
        console.error(
          [
            `[keelwatch] ${health.problems.length} bundle(s) failed to load`,
            ...lines,
            '  fix: keelwatch_report action=disable bundle=<name>, then restart',
          ].join('\n'),
        )
        void history.append({
          kind: 'bundle',
          level: 'error',
          en: `Bundle check: ${health.problems.length} of ${health.scanned} bundles failed to load (${health.problems
            .map((problem) => problem.bundle)
            .join(', ')}).`,
          zh: `插件包检查：${health.scanned} 个包里有 ${health.problems.length} 个加载失败（${health.problems
            .map((problem) => problem.bundle)
            .join('、')}）。`,
          detail: health.problems.map((problem) => `${problem.bundle}: ${problem.detail}`).join('\n'),
        })
      })
      .catch(() => undefined)
  }
  if (typeof host.timer?.timeout === 'function') host.timer.timeout(checkBundles, 5_000)
  else checkBundles()
  if (normalized.driftRadar.enabled && normalized.driftRadar.checkIntervalHours > 0) {
    host.timer?.interval?.(checkBundles, normalized.driftRadar.checkIntervalHours * 3_600_000)
  }

  const reportDeps = {
    host,
    driftConfig: normalized.driftRadar,
    costConfig: normalized.costAttribution,
    ...(brake === undefined ? {} : { brake }),
    ...(ledger === undefined ? {} : { ledger }),
    ...(tokens === undefined ? {} : { tokens }),
  }

  // `tools` is a static inject, so the service is guaranteed present here and
  // may be read as a property.
  try {
    const registry = (ctx as unknown as { tools?: unknown }).tools
    const registered = registerReportTool({ ...reportDeps, ...(registry === undefined ? {} : { registry }) })
    if (!registered) {
      console.error('[keelwatch] report tool not registered: no tool registry reachable')
    }
  } catch (error) {
    // stderr as well as the host logger: losing the tool must be visible in the
    // launcher's own log file, not only inside a session.
    console.error(`[keelwatch] report tool registration threw: ${describe(error)}`)
    host.logger?.warn(`keelwatch: report tool disabled after load error: ${describe(error)}`)
  }

}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
