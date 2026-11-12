import { type Config as ConfigShape } from './config.js';
import { type KeelwatchHost } from './host.js';
import type { HistoryLog } from './history.js';
export interface ConfigApiDeps {
    readonly host: KeelwatchHost;
    /** Detection history; served at GET /keelwatch/history when present. */
    readonly history?: HistoryLog;
    /**
     * Webserver handed over by `ctx.inject(['webServer'])`.
     *
     * `reflect.get` only returns an *active* provider, and this plugin's fiber can
     * load before the webserver finishes activating — which is exactly how the
     * route silently went missing the first time. Injection waits instead.
     */
    readonly webServer?: unknown;
}
/** Merge the bundle-layer defaults with the profile override for display. */
export declare function effectiveConfig(inherited: Record<string, unknown>, override: Record<string, unknown>): ConfigShape;
/**
 * Validate a submitted configuration.
 *
 * The same schema the host validates at load time runs here first, so an invalid
 * form submission fails in the page with a readable reason instead of writing a
 * patch that would make the next start fail.
 */
export declare function validateSubmitted(input: unknown): {
    ok: true;
    config: ConfigShape;
} | {
    ok: false;
    reason: string;
};
/**
 * Register the route.
 *
 * Returns false (with one log line) when the profile has no webserver or no
 * config editor — a headless or minimal profile simply has no config page.
 */
export declare function registerConfigApi(deps: ConfigApiDeps): boolean;
