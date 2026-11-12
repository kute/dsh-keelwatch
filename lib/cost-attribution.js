const MAX_SAMPLES = 200;
/** Bounded in-memory ledger; the ring buffer keeps p95 honest without growth. */
export class CostLedger {
    tools = new Map();
    record(tool, durationMs, isError) {
        let accumulator = this.tools.get(tool);
        if (accumulator === undefined) {
            accumulator = { calls: 0, errors: 0, totalMs: 0, maxMs: 0, samples: [] };
            this.tools.set(tool, accumulator);
        }
        accumulator.calls += 1;
        if (isError)
            accumulator.errors += 1;
        accumulator.totalMs += durationMs;
        if (durationMs > accumulator.maxMs)
            accumulator.maxMs = durationMs;
        accumulator.samples.push(durationMs);
        if (accumulator.samples.length > MAX_SAMPLES)
            accumulator.samples.shift();
    }
    /** Top tools by total time, descending. */
    top(limit) {
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
        }));
    }
    /** Plain object for the report tool and for persistence. */
    snapshot() {
        const result = {};
        for (const [tool, accumulator] of this.tools) {
            const { samples: _samples, ...rest } = accumulator;
            result[tool] = rest;
        }
        return result;
    }
}
function percentile(samples, ratio) {
    if (samples.length === 0)
        return 0;
    const sorted = [...samples].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
    return sorted[index] ?? 0;
}
/**
 * Install the timing wrapper.
 *
 * Errors inside the wrapper are swallowed on purpose: a monitor that can fail a
 * tool call is worse than no monitor.
 */
export function installCostAttribution(host, config) {
    const ledger = new CostLedger();
    host.on('tools/execute', async (exec, next) => {
        const started = performance.now();
        let isError = false;
        try {
            const result = await next();
            isError = result?.isError === true;
            return result;
        }
        catch (error) {
            isError = true;
            throw error;
        }
        finally {
            try {
                ledger.record(exec.name, performance.now() - started, isError);
            }
            catch (error) {
                host.logger?.warn(`keelwatch: timing record failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    });
    // `topN` is consumed by the report tool; read it here so an invalid value is
    // rejected at load time rather than at report time.
    void config.topN;
    return ledger;
}
/** Markdown-free plain-text report, used by the tool and by startup logging. */
export function formatTimingReport(ledger, limit) {
    const rows = ledger.top(limit);
    if (rows.length === 0)
        return 'keelwatch: no tool calls recorded yet';
    const lines = rows.map((row) => `  ${row.tool}: ${row.calls} call(s), ${row.errors} error(s), total ${row.totalMs}ms, p95 ${row.p95Ms}ms`);
    return ['keelwatch: tool time (top %d)'.replace('%d', String(rows.length)), ...lines].join('\n');
}
