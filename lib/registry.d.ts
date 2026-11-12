/**
 * Registry lookups for Drift Radar.
 *
 * Plain HTTPS instead of spawning a package manager: no shell, no PATH
 * assumptions, no Windows `.cmd` shims, and no lockfile mutations. Failures are
 * data — an unreachable registry must degrade to "unknown", never to a warning
 * storm.
 */
export type LookupStatus = 'ok' | 'not-found' | 'unreachable';
export interface PackageFacts {
    readonly name: string;
    readonly status: LookupStatus;
    /** Newest release per the registry's `latest` dist-tag. */
    readonly latest?: string;
    /** Registry version list, newest first, when the payload carried one. */
    readonly versions?: readonly string[];
    /** Diagnostic detail for non-`ok` statuses. */
    readonly detail?: string;
    readonly fetchedAt: number;
}
export interface LookupOptions {
    readonly registryUrl?: string;
    readonly timeoutMs?: number;
    /** Cache lifetime; lookups inside the window are reused. */
    readonly ttlMs?: number;
}
/**
 * Look up one package's published versions.
 *
 * Never throws: every failure mode becomes a `PackageFacts` with a non-`ok`
 * status so the caller can report "unknown" without retry logic of its own.
 */
export declare function lookupPackage(name: string, options?: LookupOptions): Promise<PackageFacts>;
/** Test hook: drop cached lookups. */
export declare function clearLookupCache(): void;
