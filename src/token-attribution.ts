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
import type { WarnSink } from './host.js'

export interface SessionLike {
  readonly id?: unknown
}

export interface SessionEventLike {
  readonly seq?: unknown
  readonly data?: unknown
}

export interface TokenMeterLike {
  measure(session: unknown): {
    readonly totalTokens?: number
    readonly surfaceTokens?: number
    readonly nodes?: readonly { readonly seq: number; readonly tokens: number }[]
  }
}

export interface TokenUsage {
  readonly session: string
  readonly totalTokens: number
  readonly surfaceTokens: number
  readonly byKind: Readonly<Record<string, number>>
  /** Tokens on surface nodes whose producer could not be identified. */
  readonly unknownTokens: number
  readonly nodes: number
}

/** Sessions are tracked bounded: a long-lived host must not grow a registry. */
const MAX_SESSIONS = 20
/** Per-session seq map bound; enough for a very long conversation's surface. */
const MAX_SEQ_ENTRIES = 5000

function sessionIdOf(session: unknown): string | null {
  if (typeof session !== 'object' || session === null) return null
  const id = (session as SessionLike).id
  return typeof id === 'string' ? id : null
}

/**
 * Producer kind of one event, read defensively.
 *
 * The feed carries `SessionEvent` with a plugin-owned `data` payload; the
 * message may sit at `data` or `data.message` depending on the event type, so
 * both are probed and anything unrecognized yields `null` (recorded as unknown,
 * never guessed).
 */
export function sourceKindOf(event: SessionEventLike): string | null {
  const data = event.data
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  const candidates: unknown[] = [record['message'], record]
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const source = (candidate as Record<string, unknown>)['source']
    if (typeof source !== 'object' || source === null) continue
    const kind = (source as Record<string, unknown>)['kind']
    if (typeof kind === 'string') return kind
  }
  return null
}

interface TrackedSession {
  readonly session: unknown
  readonly kinds: Map<number, string>
}

/**
 * Keeps a bounded `seq -> kind` map per session and reports measured usage.
 *
 * Nothing here writes to a session or touches the request path; a failure to
 * observe is a gap in reporting, never a broken conversation.
 */
export class TokenAttribution {
  private readonly tracked = new Map<string, TrackedSession>()

  constructor(private readonly logger?: WarnSink) {}

  /** Record one committed event. Errors are contained by the caller's guard. */
  observe(session: unknown, event: SessionEventLike): void {
    const id = sessionIdOf(session)
    if (id === null) return
    const kind = sourceKindOf(event)
    if (kind === null) return
    const seq = event.seq
    if (typeof seq !== 'number') return

    let entry = this.tracked.get(id)
    if (entry === undefined) {
      entry = { session, kinds: new Map() }
      this.tracked.set(id, entry)
      // Re-insert to move to the end: Map preserves insertion order, so the
      // first key is the least recently observed session.
      if (this.tracked.size > MAX_SESSIONS) {
        const oldest = this.tracked.keys().next()
        if (!oldest.done) this.tracked.delete(oldest.value)
      }
    } else {
      this.tracked.delete(id)
      this.tracked.set(id, entry)
    }

    entry.kinds.set(seq, kind)
    if (entry.kinds.size > MAX_SEQ_ENTRIES) {
      const oldestSeq = entry.kinds.keys().next()
      if (!oldestSeq.done) entry.kinds.delete(oldestSeq.value)
    }
  }

  /** Measured usage for every tracked session, newest first. */
  measure(meter: TokenMeterLike, limit = 5): TokenUsage[] {
    const usages: TokenUsage[] = []
    for (const [id, entry] of [...this.tracked.entries()].reverse().slice(0, limit)) {
      try {
        const measurement = meter.measure(entry.session)
        const nodes = measurement.nodes ?? []
        const byKind: Record<string, number> = {}
        let unknownTokens = 0
        for (const node of nodes) {
          const kind = entry.kinds.get(node.seq)
          if (kind === undefined) {
            unknownTokens += node.tokens
            continue
          }
          byKind[kind] = (byKind[kind] ?? 0) + node.tokens
        }
        usages.push({
          session: id,
          totalTokens: measurement.totalTokens ?? 0,
          surfaceTokens: measurement.surfaceTokens ?? 0,
          byKind,
          unknownTokens,
          nodes: nodes.length,
        })
      } catch (error) {
        this.logger?.warn(`keelwatch: token measurement failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return usages
  }

  /** Number of sessions currently tracked (report/test aid). */
  size(): number {
    return this.tracked.size
  }
}

/** Render one session's kind breakdown, largest first. */
export function formatTokenUsage(usages: readonly TokenUsage[], limit: number): string {
  if (usages.length === 0) return 'tokens: no requests observed yet'
  const lines: string[] = []
  for (const usage of usages) {
    const entries = Object.entries(usage.byKind)
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
      .map(([kind, tokens]) => `${kind} ${tokens}`)
    if (usage.unknownTokens > 0) entries.push(`unattributed ${usage.unknownTokens}`)
    lines.push(
      `  ${usage.session}: ${usage.surfaceTokens} surface / ${usage.totalTokens} total over ${usage.nodes} node(s) — ` +
        (entries.length === 0 ? 'no breakdown' : entries.join(', ')),
    )
  }
  return ['tokens (per session, by source kind)', ...lines].join('\n')
}
