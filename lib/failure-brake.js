import { matchesPattern } from './patterns.js';
/**
 * Error codes that must not count as failures.
 *
 * Two families:
 * - cancellation the *user* caused (`ABORTED*`): stopping a turn is not a tool
 *   defect, and counting it would brake a perfectly healthy tool;
 * - this plugin's own denial (`TOOL_COOLED_DOWN`): a denied call is materialized
 *   as an error result, and if that were counted the brake would re-arm itself
 *   forever on the strength of its own refusals.
 */
const NON_COUNTABLE_CODES = new Set(['ABORTED', 'ABORTED_BEFORE_DISPATCH', 'TOOL_COOLED_DOWN']);
/**
 * Whether one settled call is a real failure worth counting.
 *
 * Reads the structured error identity rather than the message text: the host
 * exposes `error.info.code` for exactly this distinction.
 */
export function isCountableFailure(result) {
    if (result?.isError !== true)
        return false;
    const info = result.error?.info;
    const code = info?.code;
    if (typeof code === 'string' && NON_COUNTABLE_CODES.has(code))
        return false;
    return true;
}
/**
 * The Closed → Open → Half-open machine, pure and clock-injected.
 *
 * Kept free of host types so it can be unit-tested without a Cordis context and
 * so the persistence layer (Phase 2b) can snapshot it verbatim.
 */
export class FailureBrake {
    config;
    states = new Map();
    /** Monotonic counter of state changes, used by the persistence layer. */
    revision = 0;
    constructor(config) {
        this.config = config;
    }
    /** Whether this tool is subject to braking at all. */
    covers(tool) {
        if (!this.config.enabled)
            return false;
        if (this.config.neverBrake.some((pattern) => matchesPattern(pattern, tool)))
            return false;
        if (this.config.exclude.some((pattern) => matchesPattern(pattern, tool)))
            return false;
        if (this.config.tools.length > 0 && !this.config.tools.some((pattern) => matchesPattern(pattern, tool)))
            return false;
        return true;
    }
    stateOf(tool) {
        const existing = this.states.get(tool);
        if (existing !== undefined)
            return existing;
        const created = { failures: 0, openedAt: null, probeInFlight: false };
        this.states.set(tool, created);
        return created;
    }
    /**
     * Record one settled call.
     *
     * Failures are counted even when the action is `log`, so switching to
     * `brake` reuses the history instead of starting blind.
     */
    observe(tool, isError, now = Date.now(), error) {
        if (!this.covers(tool))
            return;
        const state = this.stateOf(tool);
        this.revision += 1;
        if (!isError) {
            state.failures = 0;
            state.openedAt = null;
            state.probeInFlight = false;
            return;
        }
        state.failures += 1;
        state.probeInFlight = false;
        if (error !== undefined)
            state.lastError = { ...error };
        if (state.openedAt !== null) {
            // A failed probe re-opens for a full cooldown.
            state.openedAt = now;
            return;
        }
        if (state.failures >= this.config.maxConsecutiveErrors)
            state.openedAt = now;
    }
    cooldownMs() {
        return this.config.cooldownMinutes * 60_000;
    }
    /**
     * Decide one dispatch.
     *
     * While open, every call is denied. Once the cooldown elapsed, exactly one
     * probe is admitted; if that probe fails, `observe` re-opens the brake.
     */
    check(tool, now = Date.now()) {
        if (this.config.action !== 'brake')
            return { deny: false };
        if (!this.covers(tool))
            return { deny: false };
        const state = this.states.get(tool);
        if (state === undefined || state.openedAt === null)
            return { deny: false };
        if (now - state.openedAt < this.cooldownMs()) {
            return { deny: true, reason: this.denyReason(tool) };
        }
        if (state.probeInFlight)
            return { deny: true, reason: this.denyReason(tool) };
        state.probeInFlight = true;
        return { deny: false };
    }
    denyReason(tool) {
        const state = this.states.get(tool);
        const last = state?.lastError;
        const detail = last === undefined || (last.code === undefined && last.message === undefined)
            ? ''
            : ` Last error: ${[last.code, last.message].filter((part) => part !== undefined && part !== '').join(' — ')}.`;
        const suggestion = suggestionFor(last?.code);
        return (`keelwatch: ${tool} failed ${this.config.maxConsecutiveErrors} times in a row and is cooling down ` +
            `for ${this.config.cooldownMinutes} minute(s). Do not retry the same call; ${suggestion} ` +
            `Otherwise tell the user what failed.${detail}`);
    }
    /** Monotonic count of observed calls; the persist layer compares it. */
    getRevision() {
        return this.revision;
    }
    /** Snapshot for persistence and for the report tool. */
    snapshot() {
        const result = {};
        for (const [tool, state] of this.states)
            result[tool] = { ...state };
        return result;
    }
    /** Restore a snapshot taken by {@link snapshot}. */
    restore(snapshot) {
        for (const [tool, state] of Object.entries(snapshot)) {
            this.states.set(tool, { ...state });
        }
    }
    /** Test/report hook: tools currently braking. */
    openTools(now = Date.now()) {
        const open = [];
        for (const [tool, state] of this.states) {
            if (state.openedAt !== null && now - state.openedAt < this.cooldownMs())
                open.push(tool);
        }
        return open;
    }
}
/**
 * Turn an error code into one actionable next step.
 *
 * A brake that only says "no" pushes the retry onto a neighbouring tool; naming
 * the likely cause lets the model change approach instead of repeating it. The
 * mapping is deliberately narrow — it only speaks for codes whose meaning is
 * unambiguous.
 */
export function suggestionFor(code) {
    switch (code) {
        case 'ENOENT':
            return 'check that the path exists before calling again;';
        case 'EACCES':
        case 'EPERM':
            return 'the path or command is not permitted for this process — pick a writable location;';
        case 'EISDIR':
            return 'that path is a directory — list it instead of reading it as a file;';
        case 'TOOL_TIMEOUT':
            return 'narrow the scope (fewer paths, smaller range) or use a faster tool;';
        case 'UNKNOWN_TOOL':
            return 'confirm the tool name against the available tools;';
        case 'INVALID_ARGUMENTS':
        case 'TOOL_OUTPUT_INVALID':
            return 're-read the tool schema and fix the arguments;';
        default:
            return 'change the approach (different tool, smaller scope, or check the precondition first).';
    }
}
/**
 * Wire the brake into the two host waterfalls.
 *
 * `tools/pre-execute` denies with a structured reason (the model reads it and
 * moves on, the turn continues) and `tools/post-execute` does the accounting.
 * Every listener body is guarded: an exception inside a monitor must never
 * become a tool failure.
 */
export function installFailureBrake(host, config) {
    const brake = new FailureBrake(config);
    host.on('tools/post-execute', async (exec, result, next) => {
        const decision = await next();
        try {
            const info = result.error;
            const detail = info === undefined
                ? undefined
                : {
                    ...(typeof info.info?.code === 'string' ? { code: info.info.code } : {}),
                    ...(typeof info.message === 'string' ? { message: info.message.slice(0, 200) } : {}),
                };
            brake.observe(exec.name, isCountableFailure(result), Date.now(), detail);
        }
        catch (error) {
            host.logger?.warn(`keelwatch: post-execute accounting failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return decision;
    });
    host.on('tools/pre-execute', async (exec, next) => {
        try {
            const verdict = brake.check(exec.name);
            if (verdict.deny) {
                host.logger?.warn(`keelwatch: braked ${exec.name} (cooldown active)`);
                return {
                    kind: 'deny',
                    reason: verdict.reason,
                    info: { name: 'KeelwatchBrake', code: 'TOOL_COOLED_DOWN' },
                };
            }
        }
        catch (error) {
            host.logger?.warn(`keelwatch: pre-execute check failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return next();
    });
    return brake;
}
