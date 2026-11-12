/**
 * Token attribution: where the context budget actually goes.
 *
 * Two public host surfaces are enough, and neither requires a session
 * projection or a deprecated synchronous read:
 *
 * 1. `session/event` — the post-commit append feed, which reports each accepted
 *    event with its durable `seq`. The producer of a message is recorded in
 *    `MessageSource.kind`, so this feed gives a `seq -> kind` map.
 * 2. `ctx.tokenMeter.measure(session)` — returns the current surface as
 *    `TokenSurfaceNode[]`, each node carrying the `seq` it projects and the
 *    tokens that node costs under the routed model.
 *
 * Joining the two turns "the session costs 40k tokens" into "12k come from
 * system-prompt, 6k from tool results, 3k from the compaction plugin's notices".
 * Nodes without a recorded kind stay `unknown` rather than being guessed.
 */
import type { WarnSink } from './host.js';
export interface SessionLike {
    readonly id?: unknown;
}
export interface SessionEventLike {
    readonly seq?: unknown;
    readonly data?: unknown;
}
export interface TokenMeterLike {
    measure(session: unknown): {
        readonly totalTokens?: number;
        readonly surfaceTokens?: number;
        readonly nodes?: readonly {
            readonly seq: number;
            readonly tokens: number;
        }[];
    };
}
/** One expensive surface message, identified by seq, producer and a short preview. */
export interface ExpensiveMessage {
    readonly session: string;
    readonly seq: number;
    readonly kind: string;
    readonly tokens: number;
    readonly preview: string;
}
export interface TokenUsage {
    readonly session: string;
    readonly totalTokens: number;
    readonly surfaceTokens: number;
    readonly byKind: Readonly<Record<string, number>>;
    /** Tokens on surface nodes whose producer could not be identified. */
    readonly unknownTokens: number;
    readonly nodes: number;
}
/**
 * Producer kind of one event, read defensively.
 *
 * The feed carries `SessionEvent` with a plugin-owned `data` payload; the
 * message may sit at `data` or `data.message` depending on the event type, so
 * both are probed and anything unrecognized yields `null` (recorded as unknown,
 * never guessed).
 */
export declare function sourceKindOf(event: SessionEventLike): string | null;
/**
 * First line of an event's model-visible text, trimmed to a preview.
 *
 * Kept short on purpose: the list exists to answer "which block is burning the
 * budget", and a long excerpt would itself become context the reader pays for.
 */
export declare function previewOf(event: SessionEventLike): string;
/**
 * Keeps a bounded `seq -> kind` map per session and reports measured usage.
 *
 * Nothing here writes to a session or touches the request path; a failure to
 * observe is a gap in reporting, never a broken conversation.
 */
export declare class TokenAttribution {
    private readonly logger?;
    private readonly tracked;
    constructor(logger?: WarnSink | undefined);
    /** Record one committed event. Errors are contained by the caller's guard. */
    observe(session: unknown, event: SessionEventLike): void;
    /** Measured usage for every tracked session, newest first. */
    measure(meter: TokenMeterLike, limit?: number): TokenUsage[];
    /**
     * The most expensive identifiable surface messages across tracked sessions.
     *
     * This is the drill-down the per-kind table cannot give: *which* block costs
     * 18k tokens, and what is it. Nodes with no recorded preview are still listed
     * (their seq and cost are known), just without text.
     */
    topMessages(meter: TokenMeterLike, limit?: number): ExpensiveMessage[];
    /** Number of sessions currently tracked (report/test aid). */
    size(): number;
}
/** Render one session's kind breakdown, largest first. */
export declare function formatTokenUsage(usages: readonly TokenUsage[], limit: number): string;
