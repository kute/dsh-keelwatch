import type { CostAttributionConfig, DriftRadarConfig, FailureBrakeConfig } from './config.js';
import type { CostLedger } from './cost-attribution.js';
import type { FailureBrake } from './failure-brake.js';
import type { HistoryEntry, HistoryLog } from './history.js';
import type { KeelwatchHost } from './host.js';
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
 * Register both routes.
 *
 * Returns false when the profile has no webserver — a headless profile simply
 * has no dashboard, which is not an error.
 */
export declare function registerDashboard(deps: DashboardDeps): boolean;
