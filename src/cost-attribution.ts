/**
 * Cost Attribution (Phase 3 seed): per-tool call counts, error counts, and
 * latency, measured at the official `tools/execute` seam.
 *
 * The upstream docs describe that waterfall as "for timeout, retry, or
 * metrics", so timing here is the sanctioned use: the wrapper observes and
 * returns the unmodified result. Token attribution itself rides on
 * `ctx.tokenMeter.measure()` (surface nodes priced per event) and lands with
 * the report tool; this module owns only the accounting that has to happen on
 * the hot path, where an extra serialization would be felt.
 */
import type { CostAttributionConfig } from './config.js'
import type { KeelwatchHost, PostToolResultLike, ToolExecutionLike } from './host.js'

export interface ToolTiming {
  readonly tool: string
  readonly calls: number
  readonly errors: number
  readonly totalMs: number
  readonly maxMs: number
  readonly p95Ms: number
}

interface ToolAccumulator {
  calls: number
  errors: number
  totalMs: number
  maxMs: number
  samples: number[]
}

const MAX_SAMPLES = 200

/** Bounded in-memory ledger; the ring buffer keeps p95 honest without growth. */
export class CostLedger {
  private readonly tools = new Map<string, ToolAccumulator>()

  record(tool: string, durationMs: number, isError: boolean): void {
    let accumulator = this.tools.get(tool)
    if (accumulator === undefined) {
      accumulator = { calls: 0, errors: 0, totalMs: 0, maxMs: 0, samples: [] }
      this.tools.set(tool, accumulator)
    }
    accumulator.calls += 1
    if (isError) accumulator.errors += 1
    accumulator.totalMs += durationMs
    if (durationMs > accumulator.maxMs) accumulator.maxMs = durationMs
    accumulator.samples.push(durationMs)
    if (accumulator.samples.length > MAX_SAMPLES) accumulator.samples.shift()
  }

  /** Top tools by total time, descending. */
  top(limit: number): ToolTiming[] {
    return [...this.tools.entries()]
      .sort((left, right) => right[1].totalMs - left[1].totalMs)
      .slice(0, limit)
      .map(([tool, accumulator]) => ({
        tool,
        calls: accumulator.calls,
        errors: accumulator.errors,
        totalMs: Math.round(accumulator.totalMs),
        maxMs: Math.round(accumulator.maxMs),
        p95Ms: Math.round(percentile(accumulator.samples, 0.95)),
      }))
  }

  /** Plain object for the report tool and for persistence. */
  snapshot(): Record<string, Omit<ToolAccumulator, 'samples'>> {
    const result: Record<string, Omit<ToolAccumulator, 'samples'>> = {}
    for (const [tool, accumulator] of this.tools) {
      const { samples: _samples, ...rest } = accumulator
      result[tool] = rest
    }
    return result
  }
}

function percentile(samples: readonly number[], ratio: number): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))
  return sorted[index] ?? 0
}

/**
 * Install the timing wrapper.
 *
 * Errors inside the wrapper are swallowed on purpose: a monitor that can fail a
 * tool call is worse than no monitor.
 */
export function installCostAttribution(host: KeelwatchHost, config: CostAttributionConfig): CostLedger {
  const ledger = new CostLedger()

  host.on('tools/execute', async (exec: ToolExecutionLike, next: () => Promise<PostToolResultLike>) => {
    const started = performance.now()
    let isError = false
    try {
      const result = await next()
      isError = result?.isError === true
      return result
    } catch (error) {
      isError = true
      throw error
    } finally {
      try {
        ledger.record(exec.name, performance.now() - started, isError)
      } catch (error) {
        host.logger?.warn(`keelwatch: timing record failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })

  // `topN` is consumed by the report tool; read it here so an invalid value is
  // rejected at load time rather than at report time.
  void config.topN
  return ledger
}

/** Markdown-free plain-text report, used by the tool and by startup logging. */
export function formatTimingReport(ledger: CostLedger, limit: number): string {
  const rows = ledger.top(limit)
  if (rows.length === 0) return 'keelwatch: no tool calls recorded yet'
  const lines = rows.map(
    (row) => `  ${row.tool}: ${row.calls} call(s), ${row.errors} error(s), total ${row.totalMs}ms, p95 ${row.p95Ms}ms`,
  )
  return ['keelwatch: tool time (top %d)'.replace('%d', String(rows.length)), ...lines].join('\n')
}
