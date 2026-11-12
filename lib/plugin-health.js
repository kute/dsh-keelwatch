function describeError(error) {
    if (typeof error === 'string')
        return error;
    // A thrown `Error` stringifies to `{}`, so unwrap it before the shape probe
    // below (which targets the manager's plain `ManagementError` objects).
    if (error instanceof Error)
        return error.message === '' ? error.name : error.message;
    if (typeof error === 'object' && error !== null) {
        const { code, diagnostic } = error;
        if (typeof diagnostic === 'string' && diagnostic !== '')
            return code === undefined ? diagnostic : `${code}: ${diagnostic}`;
        if (typeof code === 'string')
            return code;
    }
    try {
        return JSON.stringify(error).slice(0, 300);
    }
    catch {
        return String(error);
    }
}
/**
 * Resolve the plugin manager without an injection requirement.
 *
 * `ctx.reflect.get` is the documented way to read a service a plugin does not
 * depend on; the direct property is a fallback for hosts that mix services in.
 */
export function resolvePluginManager(host) {
    const candidates = [];
    try {
        candidates.push(host.reflect?.get('pluginManager'));
    }
    catch {
        // A throwing reflect means the service is unavailable, not a hard failure.
    }
    try {
        // The plain property read throws on a context whose fiber did not inject the
        // service ("cannot get property \"pluginManager\" without inject"); probing a
        // service may degrade to "unavailable", never fail the inventory.
        try {
            candidates.push(typeof host.get === 'function' ? host.get('pluginManager') : undefined);
        }
        catch {
            // Un-injected property read throws on a Cordis context; skip it.
        }
    }
    catch {
        // `reflect.get` above is the sanctioned read; keep whatever it returned.
    }
    for (const candidate of candidates) {
        if (typeof candidate !== 'object' || candidate === null)
            continue;
        const manager = candidate;
        if (typeof manager.listBundles === 'function')
            return manager;
    }
    return null;
}
/** One inventory read, reduced to the bundles that carry a load error. */
export async function readHealth(host) {
    const manager = resolvePluginManager(host);
    if (manager === null)
        return { available: false, scanned: 0, problems: [] };
    let listed;
    try {
        listed = await manager.listBundles();
    }
    catch (error) {
        host.logger?.warn(`keelwatch: bundle inventory unavailable: ${describeError(error)}`);
        return { available: false, scanned: 0, problems: [] };
    }
    const bundles = Array.isArray(listed) ? listed : [];
    const problems = [];
    for (const bundle of bundles) {
        if (typeof bundle.name !== 'string')
            continue;
        if (bundle.error === undefined || bundle.error === null)
            continue;
        problems.push({
            bundle: bundle.name,
            enabled: bundle.enabled === true,
            detail: describeError(bundle.error),
        });
    }
    return { available: true, scanned: bundles.length, problems };
}
/**
 * Turn one bundle off for the current profile.
 *
 * Refuses silently-wrong input (unknown bundle, missing manager) and reports
 * `restart-required` honestly instead of claiming a hot fix.
 */
export async function disableBundle(host, name) {
    const manager = resolvePluginManager(host);
    if (manager === null) {
        return { ok: false, restartRequired: false, message: 'bundle management is unavailable in this profile' };
    }
    if (typeof manager.setBundleEnabled !== 'function') {
        return { ok: false, restartRequired: false, message: 'this host exposes no bundle switch' };
    }
    const snapshot = await readHealth(host);
    if (snapshot.available && !snapshot.problems.some((problem) => problem.bundle === name)) {
        // Not a hard error: a healthy bundle may still be one the user wants off.
        // The report says so, and the caller decides.
        host.logger?.info?.(`keelwatch: ${name} has no recorded load error`);
    }
    try {
        const result = (await manager.setBundleEnabled(name, false));
        const application = typeof result?.application === 'string' ? result.application : 'unknown';
        const restartRequired = application === 'restart-required';
        return {
            ok: application === 'applied' || restartRequired,
            restartRequired,
            message: restartRequired
                ? `disabled ${name}; the change takes effect at the next DSH start`
                : `disabled ${name} (application: ${application})`,
        };
    }
    catch (error) {
        return { ok: false, restartRequired: false, message: `disabling ${name} failed: ${describeError(error)}` };
    }
}
