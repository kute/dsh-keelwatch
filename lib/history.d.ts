export type HistoryKind = 'bundle' | 'drift' | 'brake' | 'config';
export type HistoryLevel = 'ok' | 'info' | 'warn' | 'error';
export interface HistoryEntry {
    /** Unix milliseconds. */
    readonly at: number;
    readonly kind: HistoryKind;
    readonly level: HistoryLevel;
    /** One-line English reading. */
    readonly en: string;
    /** One-line Chinese reading. */
    readonly zh: string;
    /** Optional raw detail (package names, error codes). */
    readonly detail?: string;
}
/** `$DSH_HOME/keelwatch/history.jsonl`. */
export declare function historyPath(dshHome: string): string;
/**
 * Append-only log with lazy compaction.
 *
 * Appends are cheap (one `appendFile`); pruning happens on read, when the file's
 * age distribution is already in memory. A crash between appends can at worst
 * leave a truncated last line, which the parser drops.
 */
export declare class HistoryLog {
    private readonly path;
    private readonly retentionDays;
    private readonly maxEntries;
    constructor(path: string, retentionDays: number, maxEntries?: number);
    /** Record one detection. Never throws: history is an aid, not a dependency. */
    append(entry: Omit<HistoryEntry, 'at'> & {
        at?: number;
    }): Promise<void>;
    /**
     * Read the newest entries, newest first.
     *
     * Expired entries are filtered out and compacted away in the same pass, so a
     * long-idle install self-heals on the first read.
     */
    read(limit?: number): Promise<HistoryEntry[]>;
    private compact;
}
/** Render one entry as the single bilingual line the UI shows. */
export declare function describeEntry(entry: HistoryEntry): {
    time: string;
    level: HistoryLevel;
    zh: string;
    en: string;
};
