/**
 * Persistent detection history.
 *
 * Until now a scan result existed only in the moment: a log line nobody reads
 * and a tool call the user has to think of making. "What did keelwatch find
 * yesterday?" had no answer. This module is that answer:
 * `$DSH_HOME/keelwatch/history.jsonl`, one JSON object per line, pruned by
 * `retentionDays` and by a hard entry cap so the file cannot grow without bound.
 *
 * Every entry carries both readings, so the history renders in the same
 * bilingual shape as the report instead of needing a second translation pass at
 * display time.
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { rm } from 'node:fs/promises'

export type HistoryKind = 'bundle' | 'drift' | 'brake' | 'config'
export type HistoryLevel = 'ok' | 'info' | 'warn' | 'error'

export interface HistoryEntry {
  /** Unix milliseconds. */
  readonly at: number
  readonly kind: HistoryKind
  readonly level: HistoryLevel
  /** One-line English reading. */
  readonly en: string
  /** One-line Chinese reading. */
  readonly zh: string
  /** Optional raw detail (package names, error codes). */
  readonly detail?: string
}

const DEFAULT_MAX_ENTRIES = 500

/** `$DSH_HOME/keelwatch/history.jsonl`. */
export function historyPath(dshHome: string): string {
  return join(dshHome, 'keelwatch', 'history.jsonl')
}

/**
 * Append-only log with lazy compaction.
 *
 * Appends are cheap (one `appendFile`); pruning happens on read, when the file's
 * age distribution is already in memory. A crash between appends can at worst
 * leave a truncated last line, which the parser drops.
 */
export class HistoryLog {
  constructor(
    private readonly path: string,
    private readonly retentionDays: number,
    private readonly maxEntries: number = DEFAULT_MAX_ENTRIES,
  ) {}

  /** Record one detection. Never throws: history is an aid, not a dependency. */
  async append(entry: Omit<HistoryEntry, 'at'> & { at?: number }): Promise<void> {
    const line = JSON.stringify({ ...entry, at: entry.at ?? Date.now() })
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, `${line}\n`, 'utf8')
    } catch {
      // A read-only home or a full disk must not break the scan that produced it.
    }
  }

  /**
   * Read the newest entries, newest first.
   *
   * Expired entries are filtered out and compacted away in the same pass, so a
   * long-idle install self-heals on the first read.
   */
  async read(limit = 20): Promise<HistoryEntry[]> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch {
      return []
    }

    const cutoff = Date.now() - this.retentionDays * 86_400_000
    const entries: HistoryEntry[] = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed = JSON.parse(line) as HistoryEntry
        if (typeof parsed.at !== 'number' || parsed.at < cutoff) continue
        entries.push(parsed)
      } catch {
        // Truncated or hand-edited line: drop it, keep the rest.
      }
    }

    if (entries.length > this.maxEntries) entries.splice(0, entries.length - this.maxEntries)
    if (entries.length !== raw.split('\n').filter((line) => line.trim() !== '').length) {
      await this.compact(entries)
    }
    return entries.reverse().slice(0, limit)
  }

  private async compact(entries: readonly HistoryEntry[]): Promise<void> {
    try {
      if (entries.length === 0) {
        await rm(this.path, { force: true })
        return
      }
      await writeFile(this.path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8')
    } catch {
      // Compaction is best effort; the next read retries it.
    }
  }
}

/** Render one entry as the single bilingual line the UI shows. */
export function describeEntry(entry: HistoryEntry): { time: string; level: HistoryLevel; zh: string; en: string } {
  return {
    time: new Date(entry.at).toISOString(),
    level: entry.level,
    zh: entry.zh,
    en: entry.en,
  }
}
