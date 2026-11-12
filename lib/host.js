/**
 * Host surface, isolated in its own module.
 *
 * These interfaces are structural on purpose: the DSH release candidates move
 * the concrete package types between minors, while the *shapes* documented in
 * `docs/subsystems/tools.zh.md` are the contract a plugin may rely on.
 */
/**
 * The GUI's access token, or `null` when this profile has no Web app.
 *
 * `webApp.getAdvertisedUrl()` is the advertised entry URL and carries it as
 * `?token=`. Reading it is the only way for a plugin to know what the GUI
 * expects; the `/api` fence is not reusable from an arbitrary route.
 */
export function expectedGuiToken(host) {
    try {
        const app = host.reflect?.get('webApp');
        if (typeof app?.getAdvertisedUrl !== 'function')
            return null;
        const advertised = app.getAdvertisedUrl();
        const token = new URL(advertised).searchParams.get('token');
        return token === null || token === '' ? null : token;
    }
    catch {
        return null;
    }
}
/**
 * Whether a request may touch a plugin route.
 *
 * Two tiers, because the host exposes no reusable check:
 *
 * - When a token can be discovered (`webApp.getAdvertisedUrl()` carrying
 *   `?token=`), it is required — query, `x-dsh-token`, or `dsh_token` cookie.
 * - Otherwise the route falls back to a **same-origin check**: a request with an
 *   `Origin` header whose host does not match the served host is refused. That
 *   is the practical threat (a page in the browser reaching localhost); a local
 *   process can read the token file anyway, so pretending otherwise would be
 *   security theatre.
 *
 * Note: `getAdvertisedUrl()` in this host returns the origin *without* a token,
 * so in practice the same-origin tier is what runs — this is stated plainly in
 * the README rather than claiming a token check that never happens.
 */
export function isAllowedRequest(req, expected) {
    if (expected !== null)
        return carriesGuiToken(req.url, req.headers, expected);
    const origin = req.headers['origin'];
    if (typeof origin !== 'string' || origin === '')
        return true;
    const host = req.headers['host'];
    try {
        return typeof host === 'string' && new URL(origin).host === host;
    }
    catch {
        return false;
    }
}
/**
 * Whether a request carries the GUI token.
 *
 * When the profile has no Web app (headless, SDK) there is nothing to compare
 * against and the route is local-only anyway, so the caller decides what to do
 * with a `null` expectation.
 */
export function carriesGuiToken(url, headers, expected) {
    try {
        const parsed = new URL(url ?? '/', 'http://127.0.0.1');
        if (parsed.searchParams.get('token') === expected)
            return true;
        const header = headers['x-dsh-token'];
        if (typeof header === 'string' && header === expected)
            return true;
        const cookie = headers['cookie'];
        if (typeof cookie === 'string' && cookie.split(';').some((part) => part.trim() === `dsh_token=${expected}`))
            return true;
    }
    catch {
        // Malformed request target: treat as unauthorized.
    }
    return false;
}
