/**
 * Plugin configuration.
 *
 * Every key carries a default so a missing or partial config degrades to
 * "record, never act" instead of failing the host at load time.
 */
import z from '@deepseek-ai/schemastery';
/** How much has to move upstream before Drift Radar speaks up. */
export type AlertLevel = 'major' | 'minor' | 'all';
/** Whether a tripped brake only records or actually denies the next call. */
export type BrakeAction = 'log' | 'brake';
export interface DriftRadarConfig {
    /** Master switch. */
    enabled: boolean;
    /** Rescan period; `0` scans once at startup only. */
    checkIntervalHours: number;
    /** Minimum drift level that produces a warning. */
    alertLevel: AlertLevel;
    /** Package-name globs excluded from scanning. */
    whitelist: string[];
    /** Registry base URL; empty uses the npm default. */
    registryUrl: string;
    /** Per-request timeout for registry lookups. */
    requestTimeoutMs: number;
}
export interface FailureBrakeConfig {
    /** Master switch; off means no accounting at all. */
    enabled: boolean;
    /** `log` records and warns, `brake` denies calls once the state machine opens. */
    action: BrakeAction;
    /** Consecutive failures that open the brake. */
    maxConsecutiveErrors: number;
    /** How long the brake stays open before a single probe call is admitted. */
    cooldownMinutes: number;
    /** Only brake these tool names; empty means every tool. */
    tools: string[];
    /** Tool-name globs never braked. */
    exclude: string[];
    /** Tool names that must never be braked, whatever the configuration says. */
    neverBrake: string[];
}
export interface CostAttributionConfig {
    /** Master switch. */
    enabled: boolean;
    /** Days of local JSONL records to keep. */
    retentionDays: number;
    /** Tool name to bundle name hints used when a message carries no source kind. */
    toolToBundle: Record<string, string>;
    /** Entries reported per table. */
    topN: number;
}
export interface Config {
    driftRadar: DriftRadarConfig;
    failureBrake: FailureBrakeConfig;
    costAttribution: CostAttributionConfig;
}
export declare const Config: z<Config>;
export declare const DEFAULTS: Config;
/**
 * Clamp user-supplied numbers into ranges where the plugin stays safe.
 *
 * A `maxConsecutiveErrors` of 1 would brake on the first flaky call and a
 * cooldown of 0 would make the brake meaningless, so both are bounded rather
 * than trusted.
 */
export declare function normalizeConfig(config: Config): Config;
