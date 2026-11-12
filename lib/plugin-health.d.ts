/**
 * Plugin health: read the profile's bundle inventory and report the bundles
 * that failed to load.
 *
 * The launcher reports a failed bundle only inside its own startup log; the
 * running process already knows it, because `pluginManager.listBundles()`
 * keeps `error` on a selected bundle whose layer was skipped. Reading that is
 * far safer than parsing diagnostics text.
 *
 * Disabling a bundle is offered, never performed on its own: it rewrites the
 * profile's `cordis.patch.yml`, and the upstream contract says the change may
 * only take effect at the next start (`application: 'restart-required'`).
 */
import type { WarnSink } from './host.js';
export interface ManagementErrorLike {
    readonly code?: string;
    readonly diagnostic?: string;
}
export interface BundleInfoLike {
    readonly name?: unknown;
    readonly version?: unknown;
    readonly enabled?: unknown;
    readonly availability?: unknown;
    readonly installed?: unknown;
    readonly error?: unknown;
}
export interface BundleProblem {
    readonly bundle: string;
    readonly enabled: boolean;
    readonly detail: string;
}
export interface HealthSnapshot {
    /** Whether the profile even exposes bundle management. */
    readonly available: boolean;
    readonly scanned: number;
    readonly problems: readonly BundleProblem[];
}
export interface PluginManagerLike {
    listBundles(): Promise<unknown>;
    setBundleEnabled(name: string, enabled: boolean): Promise<unknown>;
}
export interface ManagerHost {
    readonly reflect?: {
        get(name: string): unknown;
    };
    /** `ctx.get` — the guarded way to reach an un-injected service. */
    readonly get?: (name: string) => unknown;
    /** Only safe when the host mixes the service in; never read directly. */
    readonly pluginManager?: unknown;
    readonly logger?: WarnSink;
}
/**
 * Resolve the plugin manager without an injection requirement.
 *
 * `ctx.reflect.get` is the documented way to read a service a plugin does not
 * depend on; the direct property is a fallback for hosts that mix services in.
 */
export declare function resolvePluginManager(host: ManagerHost): PluginManagerLike | null;
/** One inventory read, reduced to the bundles that carry a load error. */
export declare function readHealth(host: ManagerHost): Promise<HealthSnapshot>;
export interface DisableOutcome {
    readonly ok: boolean;
    readonly restartRequired: boolean;
    readonly message: string;
}
/**
 * Turn one bundle off for the current profile.
 *
 * Refuses silently-wrong input (unknown bundle, missing manager) and reports
 * `restart-required` honestly instead of claiming a hot fix.
 */
export declare function disableBundle(host: ManagerHost, name: string): Promise<DisableOutcome>;
