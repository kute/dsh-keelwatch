/** Path of a keelwatch state file inside `$DSH_HOME`. */
export declare function stateFilePath(dshHome: string, file: string): string;
/** Read JSON, treating any failure (missing, truncated, malformed) as absent. */
export declare function readJsonFile<T>(path: string): Promise<T | null>;
/**
 * Write text atomically through a same-directory placeholder.
 *
 * Returns `false` instead of throwing: persistence is an enhancement here, and
 * a read-only or full disk must not turn into a plugin failure.
 */
export declare function writeTextAtomic(path: string, text: string): Promise<boolean>;
/** Write JSON atomically. */
export declare function writeJsonAtomic(path: string, value: unknown): Promise<boolean>;
