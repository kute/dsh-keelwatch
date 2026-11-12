/** Sessions are tracked bounded: a long-lived host must not grow a registry. */
const MAX_SESSIONS = 20;
/** Per-session seq map bound; enough for a very long conversation's surface. */
const MAX_SEQ_ENTRIES = 5000;
function sessionIdOf(session) {
    if (typeof session !== 'object' || session === null)
        return null;
    const id = session.id;
    return typeof id === 'string' ? id : null;
}
/**
 * Producer kind of one event, read defensively.
 *
 * The feed carries `SessionEvent` with a plugin-owned `data` payload; the
 * message may sit at `data` or `data.message` depending on the event type, so
 * both are probed and anything unrecognized yields `null` (recorded as unknown,
 * never guessed).
 */
export function sourceKindOf(event) {
    const data = event.data;
    if (typeof data !== 'object' || data === null)
        return null;
    const record = data;
    const candidates = [record['message'], record];
    for (const candidate of candidates) {
        if (typeof candidate !== 'object' || candidate === null)
            continue;
        const source = candidate['source'];
        if (typeof source !== 'object' || source === null)
            continue;
        const kind = source['kind'];
        if (typeof kind === 'string')
            return kind;
    }
    return null;
}
/**
 * Keeps a bounded `seq -> kind` map per session and reports measured usage.
 *
 * Nothing here writes to a session or touches the request path; a failure to
 * observe is a gap in reporting, never a broken conversation.
 */
export class TokenAttribution {
    logger;
    tracked = new Map();
    constructor(logger) {
        this.logger = logger;
    }
    /** Record one committed event. Errors are contained by the caller's guard. */
    observe(session, event) {
        const id = sessionIdOf(session);
        if (id === null)
            return;
        const kind = sourceKindOf(event);
        if (kind === null)
            return;
        const seq = event.seq;
        if (typeof seq !== 'number')
            return;
        let entry = this.tracked.get(id);
        if (entry === undefined) {
            entry = { session, kinds: new Map() };
            this.tracked.set(id, entry);
            // Re-insert to move to the end: Map preserves insertion order, so the
            // first key is the least recently observed session.
            if (this.tracked.size > MAX_SESSIONS) {
                const oldest = this.tracked.keys().next();
                if (!oldest.done)
                    this.tracked.delete(oldest.value);
            }
        }
        else {
            this.tracked.delete(id);
            this.tracked.set(id, entry);
        }
        entry.kinds.set(seq, kind);
        if (entry.kinds.size > MAX_SEQ_ENTRIES) {
            const oldestSeq = entry.kinds.keys().next();
            if (!oldestSeq.done)
                entry.kinds.delete(oldestSeq.value);
        }
    }
    /** Measured usage for every tracked session, newest first. */
    measure(meter, limit = 5) {
        const usages = [];
        for (const [id, entry] of [...this.tracked.entries()].reverse().slice(0, limit)) {
            try {
                const measurement = meter.measure(entry.session);
                const nodes = measurement.nodes ?? [];
                const byKind = {};
                let unknownTokens = 0;
                for (const node of nodes) {
                    const kind = entry.kinds.get(node.seq);
                    if (kind === undefined) {
                        unknownTokens += node.tokens;
                        continue;
                    }
                    byKind[kind] = (byKind[kind] ?? 0) + node.tokens;
                }
                usages.push({
                    session: id,
                    totalTokens: measurement.totalTokens ?? 0,
                    surfaceTokens: measurement.surfaceTokens ?? 0,
                    byKind,
                    unknownTokens,
                    nodes: nodes.length,
                });
            }
            catch (error) {
                this.logger?.warn(`keelwatch: token measurement failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return usages;
    }
    /** Number of sessions currently tracked (report/test aid). */
    size() {
        return this.tracked.size;
    }
}
/** Render one session's kind breakdown, largest first. */
export function formatTokenUsage(usages, limit) {
    if (usages.length === 0)
        return 'tokens: no requests observed yet';
    const lines = [];
    for (const usage of usages) {
        const entries = Object.entries(usage.byKind)
            .sort((left, right) => right[1] - left[1])
            .slice(0, limit)
            .map(([kind, tokens]) => `${kind} ${tokens}`);
        if (usage.unknownTokens > 0)
            entries.push(`unattributed ${usage.unknownTokens} (events keelwatch did not observe)`);
        lines.push(`  ${usage.session}: ${usage.surfaceTokens} surface / ${usage.totalTokens} total over ${usage.nodes} node(s) — ` +
            (entries.length === 0 ? 'no breakdown' : entries.join(', ')));
    }
    return ['tokens (per session, by source kind)', ...lines].join('\n');
}
