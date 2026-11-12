/**
 * `keelwatch_report` — the one surface the model can drive.
 *
 * Reads are free; the single write (`action: 'disable'`) is explicit, requires
 * the exact bundle name, and reports `restart-required` truthfully. There is no
 * branch that disables something as a side effect of reporting.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CostAttributionConfig, DriftRadarConfig } from './config.js'
import type { CostLedger } from './cost-attribution.js'
import { formatTimingReport } from './cost-attribution.js'
import type { FailureBrake } from './failure-brake.js'
import type { KeelwatchHost } from './host.js'
import { disableBundle, readHealth } from './plugin-health.js'
import { scanDrift, summarize } from './drift-radar.js'
import { formatTokenUsage, type TokenAttribution, type TokenMeterLike } from './token-attribution.js'

export interface ReportDeps {
  readonly host: KeelwatchHost
  /** Tool registry handed over by the host; preferred over probing `host.tools`. */
  readonly registry?: unknown
  readonly driftConfig: DriftRadarConfig
  readonly costConfig: CostAttributionConfig
  readonly brake?: FailureBrake
  readonly ledger?: CostLedger
  readonly tokens?: TokenAttribution
}

function scheduleSection(deps: ReportDeps): string {
  if (deps.brake === undefined) return 'failure brake: disabled in configuration'
  const open = deps.brake.openTools()
  return open.length === 0 ? 'failure brake: enabled, nothing braking' : `failure brake: braking ${open.join(', ')}`
}

/**
 * Build the status text.
 *
 * Every section is independently guarded: a failed registry lookup must not
 * hide the bundle inventory that explains why the session started broken.
 */
export async function buildStatusReport(deps: ReportDeps): Promise<string> {
  const sections: string[] = []

  try {
    const health = await readHealth(deps.host)
    if (!health.available) {
      sections.push('bundles: management unavailable in this profile')
    } else if (health.problems.length === 0) {
      sections.push(`bundles: ${health.scanned} tracked, no load errors`)
    } else {
      const lines = health.problems.map((problem) => `  - ${problem.bundle}: ${problem.detail}`)
      sections.push([`bundles: ${health.problems.length} failing of ${health.scanned}`, ...lines].join('\n'))
    }
  } catch (error) {
    sections.push(`bundles: inventory failed (${error instanceof Error ? error.message : String(error)})`)
  }

  try {
    sections.push(summarize(await scanDrift(deps.driftConfig)))
  } catch (error) {
    sections.push(`drift: scan failed (${error instanceof Error ? error.message : String(error)})`)
  }

  sections.push(scheduleSection(deps))

  if (deps.ledger !== undefined) {
    sections.push(formatTimingReport(deps.ledger, deps.costConfig.topN))
  } else {
    sections.push('tool time: not recorded (cost attribution disabled)')
  }

  if (deps.tokens !== undefined) {
    let meter: TokenMeterLike | null = null
    try {
      const candidate = deps.host.reflect?.get('tokenMeter')
      if (typeof candidate === 'object' && candidate !== null && typeof (candidate as TokenMeterLike).measure === 'function') {
        meter = candidate as TokenMeterLike
      }
    } catch {
      meter = null
    }
    sections.push(
      meter === null
        ? 'tokens: host exposes no token meter'
        : formatTokenUsage(deps.tokens.measure(meter, deps.costConfig.topN), deps.costConfig.topN),
    )
  } else {
    sections.push('tokens: not recorded (cost attribution disabled)')
  }

  return sections.join('\n\n')
}

/**
 * Find a tool registry.
 *
 * `ctx.tools` only exists once the `tools` service is injected/mixed in, so a
 * plugin that merely listens to events cannot assume it. `ctx.reflect.get` reads
 * a service without the injection requirement, which is why it is tried too.
 */
function resolveRegistry(deps: ReportDeps): { register(tool: unknown): unknown } | null {
  const candidates: unknown[] = [deps.registry]
  // A plain `ctx.tools` read throws on a context whose fiber did not inject the
  // service ("cannot get property \"tools\" without inject"), so both property
  // reads are guarded: probing a service must never be able to fail the report.
  try {
    candidates.push(deps.host.tools)
  } catch {
    // Not injectable from this context; `reflect.get` below is the sanctioned read.
  }
  try {
    candidates.push(deps.host.reflect?.get('tools'))
  } catch {
    // No reflect on this host; the property candidates still apply.
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const registry = candidate as { register?: unknown }
    if (typeof registry.register === 'function') return registry as { register(tool: unknown): unknown }
  }
  return null
}

/** Register the tool when the profile exposes a tool registry. */
export function registerReportTool(deps: ReportDeps): boolean {
  const registry = resolveRegistry(deps)
  if (registry === null) {
    deps.host.logger?.warn('keelwatch: no tool registry available; keelwatch_report stays unregistered')
    return false
  }

  const tool = defineTool({
    name: 'keelwatch_report',
    description:
      'Report DSH plugin ecosystem health: bundles that failed to load, dependency drift, the failure brake state, ' +
      'and per-tool latency. Use action "disable" with an exact bundle name only when the user asks to turn a ' +
      'broken bundle off.',
    parameters: {
      // Omitted `required` means optional in the tool DSL.
      action: {
        type: 'string',
        description: 'Either "status" (default) or "disable".',
      },
      bundle: {
        type: 'string',
        description: 'Exact bundle name to disable; required when action is "disable".',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: unknown) {
      const input = (args ?? {}) as { action?: unknown; bundle?: unknown }
      const action = typeof input.action === 'string' && input.action !== '' ? input.action : 'status'

      if (action === 'disable') {
        if (typeof input.bundle !== 'string' || input.bundle.trim() === '') {
          return 'keelwatch: action "disable" needs a bundle name, for example { "action": "disable", "bundle": "@kute/dsh-keelwatch" }'
        }
        const outcome = await disableBundle(deps.host, input.bundle.trim())
        return `keelwatch: ${outcome.message}`
      }

      if (action !== 'status') {
        return `keelwatch: unknown action "${action}"; use "status" or "disable"`
      }
      return buildStatusReport(deps)
    },
  })

  try {
    registry.register(tool)
    return true
  } catch (error) {
    deps.host.logger?.warn(`keelwatch: report tool not registered: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}
