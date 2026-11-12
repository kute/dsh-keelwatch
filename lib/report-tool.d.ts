import type { CostAttributionConfig, DriftRadarConfig } from './config.js';
import type { CostLedger } from './cost-attribution.js';
import type { FailureBrake } from './failure-brake.js';
import type { KeelwatchHost } from './host.js';
import { type TokenAttribution } from './token-attribution.js';
export interface ReportDeps {
    readonly host: KeelwatchHost;
    /** Tool registry handed over by the host; preferred over probing `host.tools`. */
    readonly registry?: unknown;
    readonly driftConfig: DriftRadarConfig;
    readonly costConfig: CostAttributionConfig;
    readonly brake?: FailureBrake;
    readonly ledger?: CostLedger;
    readonly tokens?: TokenAttribution;
}
/**
 * Build the status text.
 *
 * Every section is independently guarded: a failed registry lookup must not hide
 * the bundle inventory that explains why the session started broken.
 */
export declare function buildStatusReport(deps: ReportDeps): Promise<string>;
/** Register the tool when the profile exposes a tool registry. */
export declare function registerReportTool(deps: ReportDeps): boolean;
