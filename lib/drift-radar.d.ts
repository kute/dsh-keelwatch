import type { DriftRadarConfig } from './config.js';
import type { KeelwatchHost } from './host.js';
import { lookupPackage } from './registry.js';
import { type DriftLevel } from './semver.js';
export type FindingKind = 'engine-incompatible' | 'dependency-drift' | 'peer-mismatch';
export interface DriftFinding {
    readonly packageName: string;
    readonly kind: FindingKind;
    readonly level: DriftLevel;
    readonly declared: string;
    readonly latest?: string;
    readonly message: string;
    /**
     * What to do about it, in one line.
     *
     * Text only, on purpose: writing a pin into a user's manifest is a change
     * this plugin has no business making on its own. The suggestion names the
     * exact version or the exact file so the fix is a copy-paste away.
     */
    readonly suggestion?: string;
}
export interface DriftReport {
    readonly scannedAt: number;
    readonly dshVersion: string | null;
    readonly bundlesScanned: number;
    readonly findings: readonly DriftFinding[];
    /** Packages the scanner deliberately did not judge, with the reason. */
    readonly skipped: readonly {
        packageName: string;
        reason: string;
    }[];
}
export interface BundleManifest {
    readonly name: string;
    readonly version: string;
    readonly directory: string;
    readonly enginesDsh?: string;
    readonly peerDependencies: Readonly<Record<string, string>>;
    readonly dependencies: Readonly<Record<string, string>>;
    readonly isBundle: boolean;
}
export type { KeelwatchHost } from './host.js';
/** `$DSH_HOME`, defaulting to the documented platform location. */
export declare function resolveDshHome(env?: NodeJS.ProcessEnv): string;
/**
 * The running DSH version.
 *
 * Every official `@deepseek-ai/dsh*` package is versioned in lockstep with the
 * launcher, so a resolvable sibling is a sound fallback when the launcher
 * package itself is not reachable from the profile.
 */
export declare function runningDshVersion(): string | null;
/**
 * Every package installed into any profile, deduplicated by name.
 *
 * Scanning all profiles rather than the "current" one is deliberate: the
 * launcher does not expose the active profile name to plugins, and a stale
 * profile still predicts the next broken startup.
 */
export declare function collectInstalledBundles(dshHome: string): Promise<BundleManifest[]>;
/**
 * One-line remedy for a finding.
 *
 * For a drifted dependency the safe target is the lowest version the bundle's own
 * declaration admits — pinning there keeps the package on the combination it was
 * tested with, without guessing at an upgrade.
 */
export declare function suggestionForFinding(finding: Pick<DriftFinding, 'kind' | 'declared' | 'latest' | 'packageName'>): string;
export interface ScanOptions {
    readonly dshHome?: string;
    readonly dshVersion?: string | null;
    /** Injected for tests; defaults to the real registry lookup. */
    readonly lookup?: typeof lookupPackage;
}
/**
 * One full scan.
 *
 * Ordering matters: an `engines.dsh` mismatch means the launcher will refuse
 * the bundle outright, so that finding is emitted before any registry work.
 */
export declare function scanDrift(config: DriftRadarConfig, options?: ScanOptions): Promise<DriftReport>;
/** Format a report as the log line the user actually reads. */
export declare function summarize(report: DriftReport): string;
/**
 * Register the periodic scan.
 *
 * The timer comes from the host (`ctx.timer`, provided by
 * `@deepseek-ai/cordis-plugin-timer`) so the interval dies with the fiber; a
 * bare `setInterval` would keep the process awake after unload.
 */
export declare function startDriftRadar(host: KeelwatchHost, config: DriftRadarConfig, onReport?: (report: DriftReport) => void): void;
