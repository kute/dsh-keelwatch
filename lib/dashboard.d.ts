import type { CostAttributionConfig, DriftRadarConfig, FailureBrakeConfig } from './config.js';
import type { CostLedger } from './cost-attribution.js';
import type { FailureBrake } from './failure-brake.js';
import type { HistoryEntry, HistoryLog } from './history.js';
import { type KeelwatchHost } from './host.js';
import type { TokenAttribution } from './token-attribution.js';
export interface DashboardDeps {
    readonly host: KeelwatchHost;
    /** Injected webserver; falls back to `ctx.reflect` when omitted. */
    readonly webServer?: unknown;
    readonly history?: HistoryLog;
    readonly brake?: FailureBrake;
    readonly ledger?: CostLedger;
    readonly tokens?: TokenAttribution;
    readonly driftConfig: DriftRadarConfig;
    readonly brakeConfig: FailureBrakeConfig;
    readonly costConfig: CostAttributionConfig;
    readonly refreshSeconds: number;
    readonly documentPath?: string;
}
export interface StatusPayload {
    readonly generatedAt: number;
    readonly bundles: {
        available: boolean;
        scanned: number;
        problems: readonly {
            bundle: string;
            detail: string;
        }[];
    };
    readonly drift: {
        scanned: number;
        alertLevel: string;
        findings: readonly {
            packageName: string;
            kind: string;
            level: string;
            message: string;
            suggestion?: string;
        }[];
        skipped: number;
    };
    readonly brake: {
        enabled: boolean;
        action: string;
        braking: readonly string[];
        configuredErrors: number;
        cooldownMinutes: number;
    };
    readonly timing: readonly {
        tool: string;
        calls: number;
        errors: number;
        totalMs: number;
        p95Ms: number;
    }[];
    readonly tokens: readonly {
        session: string;
        surfaceTokens: number;
        totalTokens: number;
        byKind: Readonly<Record<string, number>>;
        unknownTokens: number;
    }[];
    readonly expensive: readonly {
        kind: string;
        tokens: number;
        seq: number;
        preview: string;
    }[];
    readonly history: readonly HistoryEntry[];
    /** Entries per day for the last week, oldest first. */
    readonly trend: readonly {
        date: string;
        ok: number;
        info: number;
        warn: number;
        error: number;
    }[];
    readonly refreshSeconds: number;
    readonly documentPath: string | null;
}
/**
 * Collect everything the page shows.
 *
 * Each block degrades on its own: a registry outage must not blank the bundle
 * list that explains why a capability is missing.
 */
export declare function collectStatus(deps: DashboardDeps): Promise<StatusPayload>;
/**
 * Count entries per calendar day for the last seven days.
 *
 * Days with no detection are kept as zeros: a gap in a health chart is
 * information ("nothing ran") and dropping the row would hide it.
 */
export declare function buildTrend(entries: readonly HistoryEntry[], days?: number, now?: number): StatusPayload['trend'];
/**
 * Register both routes.
 *
 * Returns false when the profile has no webserver — a headless profile simply
 * has no dashboard, which is not an error.
 */
export declare function registerDashboard(deps: DashboardDeps): boolean;
