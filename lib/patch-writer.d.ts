/** Marks the block this plugin owns, so a human reading the file knows. */
export declare const ROW_MARKER = "# keelwatch: config managed by the plugin page";
/** System-agnostic row id; also the Loader entry id in the bundle patch. */
export declare const ROW_ID = "keelwatch";
export interface RowRead {
    readonly found: boolean;
    /** Parsed JSON config written by this plugin, when present. */
    readonly config: Record<string, unknown> | null;
    /** The raw `config:` line, for diagnostics. */
    readonly raw: string | null;
}
/** Read the config this plugin previously wrote for its row. */
export declare function readRowConfig(patchPath: string, rowId?: string): Promise<RowRead>;
export interface WriteResult {
    readonly changed: boolean;
    readonly backupPath: string | null;
    readonly createdRow: boolean;
}
/**
 * Persist one row's config.
 *
 * The value is written as JSON on one line under `config:`; the row's other
 * keys (`disabled`, `name`, ...) survive untouched.
 */
export declare function writeRowConfig(patchPath: string, config: Record<string, unknown>, rowId?: string): Promise<WriteResult>;
