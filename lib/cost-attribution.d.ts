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
import type { CostAttributionConfig } from './config.js';
import type { KeelwatchHost } from './host.js';
export interface ToolTiming {
    readonly tool: string;
    readonly calls: number;
    readonly errors: number;
    readonly totalMs: number;
    readonly maxMs: number;
    readonly p95Ms: number;
}
interface ToolAccumulator {
    calls: number;
    errors: number;
    totalMs: number;
    maxMs: number;
    samples: number[];
}
/** Bounded in-memory ledger; the ring buffer keeps p95 honest without growth. */
export declare class CostLedger {
    private readonly tools;
    record(tool: string, durationMs: number, isError: boolean): void;
    /** Top tools by total time, descending. */
    top(limit: number): ToolTiming[];
    /** Plain object for the report tool and for persistence. */
    snapshot(): Record<string, Omit<ToolAccumulator, 'samples'>>;
}
/**
 * Install the timing wrapper.
 *
 * Errors inside the wrapper are swallowed on purpose: a monitor that can fail a
 * tool call is worse than no monitor.
 */
export declare function installCostAttribution(host: KeelwatchHost, config: CostAttributionConfig): CostLedger;
/** Markdown-free plain-text report, used by the tool and by startup logging. */
export declare function formatTimingReport(ledger: CostLedger, limit: number): string;
export {};
