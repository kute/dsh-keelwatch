/**
 * Failure Brake: stop a repeatedly failing tool from being retried into a
 * token fire.
 *
 * What the host already guarantees (upstream `docs/subsystems/tools.zh.md`):
 * a thrown tool becomes a structured error and does not end the turn. So the
 * remaining damage is amplification — the model retries a broken tool with new
 * arguments, each attempt paying a timeout plus a round trip. This module
 * brakes that pattern and nothing else: it never kills an in-flight call, never
 * rewrites arguments, and never touches the tool registry.
 */
import type { FailureBrakeConfig } from './config.js';
import type { KeelwatchHost, PostToolResultLike } from './host.js';
export interface BrakeState {
    /** Consecutive failures since the last success. */
    failures: number;
    /** When the brake opened; `null` while closed. */
    openedAt: number | null;
    /** A single half-open probe is already in flight. */
    probeInFlight: boolean;
    /** Code and message of the most recent countable failure. */
    lastError?: {
        code?: string;
        message?: string;
    };
}
export type BrakeVerdict = {
    deny: false;
    reason?: never;
} | {
    deny: true;
    reason: string;
};
/**
 * Whether one settled call is a real failure worth counting.
 *
 * Reads the structured error identity rather than the message text: the host
 * exposes `error.info.code` for exactly this distinction.
 */
export declare function isCountableFailure(result: PostToolResultLike): boolean;
/**
 * The Closed → Open → Half-open machine, pure and clock-injected.
 *
 * Kept free of host types so it can be unit-tested without a Cordis context and
 * so the persistence layer (Phase 2b) can snapshot it verbatim.
 */
export declare class FailureBrake {
    private readonly config;
    private readonly states;
    /** Monotonic counter of state changes, used by the persistence layer. */
    private revision;
    constructor(config: FailureBrakeConfig);
    /** Whether this tool is subject to braking at all. */
    covers(tool: string): boolean;
    private stateOf;
    /**
     * Record one settled call.
     *
     * Failures are counted even when the action is `log`, so switching to
     * `brake` reuses the history instead of starting blind.
     */
    observe(tool: string, isError: boolean, now?: number, error?: {
        code?: string;
        message?: string;
    }): void;
    private cooldownMs;
    /**
     * Decide one dispatch.
     *
     * While open, every call is denied. Once the cooldown elapsed, exactly one
     * probe is admitted; if that probe fails, `observe` re-opens the brake.
     */
    check(tool: string, now?: number): BrakeVerdict;
    private denyReason;
    /** Monotonic count of observed calls; the persist layer compares it. */
    getRevision(): number;
    /** Snapshot for persistence and for the report tool. */
    snapshot(): Record<string, BrakeState>;
    /** Restore a snapshot taken by {@link snapshot}. */
    restore(snapshot: Readonly<Record<string, BrakeState>>): void;
    /** Test/report hook: tools currently braking. */
    openTools(now?: number): string[];
}
/**
 * Turn an error code into one actionable next step.
 *
 * A brake that only says "no" pushes the retry onto a neighbouring tool; naming
 * the likely cause lets the model change approach instead of repeating it. The
 * mapping is deliberately narrow — it only speaks for codes whose meaning is
 * unambiguous.
 */
export declare function suggestionFor(code: string | undefined): string;
/**
 * Wire the brake into the two host waterfalls.
 *
 * `tools/pre-execute` denies with a structured reason (the model reads it and
 * moves on, the turn continues) and `tools/post-execute` does the accounting.
 * Every listener body is guarded: an exception inside a monitor must never
 * become a tool failure.
 */
export declare function installFailureBrake(host: KeelwatchHost, config: FailureBrakeConfig): FailureBrake;
