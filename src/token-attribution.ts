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

/** One expensive surface message, identified by seq, producer and a short preview. */
export interface ExpensiveMessage {
  readonly session: string
  readonly seq: number
  readonly kind: string
  readonly tokens: number
  readonly preview: string
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
/** Characters of message text kept for the "most expensive message" list. */
const PREVIEW_CHARS = 100

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

/**
 * First line of an event's model-visible text, trimmed to a preview.
 *
 * Kept short on purpose: the list exists to answer "which block is burning the
 * budget", and a long excerpt would itself become context the reader pays for.
 */
export function previewOf(event: SessionEventLike): string {
  const data = event.data
  if (typeof data !== 'object' || data === null) return ''
  const record = data as Record<string, unknown>
  const message = (typeof record['message'] === 'object' && record['message'] !== null
    ? record['message']
    : record) as Record<string, unknown>
  const content = message['content']
  const blocks = Array.isArray(content) ? content : [content]
  for (const block of blocks) {
    if (typeof block === 'string') return block.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS)
    if (typeof block !== 'object' || block === null) continue
    const text = (block as Record<string, unknown>)['text']
    if (typeof text === 'string' && text.trim() !== '') {
      return text.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS)
    }
  }
  return ''
}

interface SeqRecord {
  readonly kind: string
  readonly preview: string
}

interface TrackedSession {
  readonly session: unknown
  readonly kinds: Map<number, SeqRecord>
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
    const preview = previewOf(event)
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

    entry.kinds.set(seq, { kind, preview })
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
          const record = entry.kinds.get(node.seq)
          if (record === undefined) {
            unknownTokens += node.tokens
            continue
          }
          byKind[record.kind] = (byKind[record.kind] ?? 0) + node.tokens
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

  /**
   * The most expensive identifiable surface messages across tracked sessions.
   *
   * This is the drill-down the per-kind table cannot give: *which* block costs
   * 18k tokens, and what is it. Nodes with no recorded preview are still listed
   * (their seq and cost are known), just without text.
   */
  topMessages(meter: TokenMeterLike, limit = 5): ExpensiveMessage[] {
    const collected: ExpensiveMessage[] = []
    for (const [id, entry] of this.tracked) {
      let nodes: readonly { readonly seq: number; readonly tokens: number }[] = []
      try {
        nodes = meter.measure(entry.session).nodes ?? []
      } catch (error) {
        this.logger?.warn(`keelwatch: token measurement failed: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      for (const node of nodes) {
        const record = entry.kinds.get(node.seq)
        if (record === undefined) continue
        collected.push({ session: id, seq: node.seq, kind: record.kind, tokens: node.tokens, preview: record.preview })
      }
    }
    return collected.sort((left, right) => right.tokens - left.tokens).slice(0, limit)
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
    if (usage.unknownTokens > 0) entries.push(`unattributed ${usage.unknownTokens} (events keelwatch did not observe)`)
    lines.push(
      `  ${usage.session}: ${usage.surfaceTokens} surface / ${usage.totalTokens} total over ${usage.nodes} node(s) — ` +
        (entries.length === 0 ? 'no breakdown' : entries.join(', ')),
    )
  }
  return ['tokens (per session, by source kind)', ...lines].join('\n')
}
