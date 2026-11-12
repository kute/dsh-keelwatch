import { Config, DEFAULTS, normalizeConfig } from './config.js';
import { expectedGuiToken, isAllowedRequest } from './host.js';
import { ROW_ID, readRowConfig, writeRowConfig } from './patch-writer.js';
const ROUTE_PATH = '/keelwatch/config';
const MAX_BODY_BYTES = 64 * 1024;
/** Cross-site requests cannot set a custom header without a preflight we refuse. */
const REQUIRED_HEADER = 'x-keelwatch-config';
function resolve(host, service) {
    try {
        const found = host.reflect?.get(service);
        if (typeof found === 'object' && found !== null)
            return found;
    }
    catch {
        // Absent services are a normal profile difference, not an error.
    }
    return null;
}
function send(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
}
async function readBody(req) {
    let total = 0;
    const chunks = [];
    for await (const chunk of req) {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        total += buffer.byteLength;
        if (total > MAX_BODY_BYTES)
            throw new Error('body too large');
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}
/** Merge the bundle-layer defaults with the profile override for display. */
export function effectiveConfig(inherited, override) {
    const merged = { ...DEFAULTS };
    for (const group of ['driftRadar', 'failureBrake', 'costAttribution']) {
        const blanket = (value) => typeof value === 'object' && value !== null ? value : {};
        const base = blanket(inherited[group]);
        const own = blanket(override[group]);
        merged[group] = { ...blanket(DEFAULTS[group]), ...base, ...own };
    }
    return normalizeConfig(merged);
}
/**
 * Validate a submitted configuration.
 *
 * The same schema the host validates at load time runs here first, so an invalid
 * form submission fails in the page with a readable reason instead of writing a
 * patch that would make the next start fail.
 */
export function validateSubmitted(input) {
    if (typeof input !== 'object' || input === null)
        return { ok: false, reason: 'expected a JSON object' };
    try {
        // Schemastery's call signature is typed against the full shape; a submitted
        // form is intentionally partial, so it is parsed through an untyped call and
        // the schema supplies defaults for the missing groups.
        const parse = Config;
        return { ok: true, config: normalizeConfig(parse(input)) };
    }
    catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
}
/**
 * Resolve the profile patch file to write.
 *
 * `configEditor.documentPath` is the authoritative answer (it is the file the
 * profile launcher composes last); `$DSH_HOME/profiles/<profile>/cordis.patch.yml`
 * is not derivable from inside a plugin without that pointer.
 */
function patchPathOf(host) {
    const editor = resolve(host, 'configEditor');
    const path = editor?.documentPath;
    return typeof path === 'string' && path !== '' ? path : null;
}
/**
 * Register the route.
 *
 * Returns false (with one log line) when the profile has no webserver or no
 * config editor — a headless or minimal profile simply has no config page.
 */
export function registerConfigApi(deps) {
    const { host } = deps;
    const injected = deps.webServer;
    const webServer = typeof injected === 'object' && injected !== null ? injected : resolve(host, 'webServer');
    if (webServer === null || typeof webServer.register !== 'function') {
        host.logger?.warn('keelwatch: config page unavailable (no webserver in this profile)');
        return false;
    }
    // Same reasoning as the dashboard: a custom path is outside the host's /api
    // fence, and GET here exposes the plugin configuration while POST rewrites it.
    const expected = expectedGuiToken(host);
    if (expected === null) {
        // Same-origin only: the host exposes no token to compare against.
        host.logger?.info?.('keelwatch: config endpoint guarded by same-origin check');
    }
    const authorized = (req) => isAllowedRequest({ url: req.url, headers: req.headers }, expected);
    const dispose = webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        async handler(req, res) {
            try {
                if (!authorized(req))
                    return send(res, 401, { ok: false, reason: 'unauthorized' });
                if (req.method === 'GET') {
                    const documentPath = patchPathOf(host);
                    if (documentPath === null)
                        return send(res, 503, { ok: false, reason: 'profile patch not resolvable' });
                    const row = await readRowConfig(documentPath, ROW_ID);
                    // A managed row already carries the full shape; a missing or
                    // hand-written row falls back to the documented defaults.
                    const config = row.config === null
                        ? DEFAULTS
                        : normalizeConfig({ ...DEFAULTS, ...row.config });
                    return send(res, 200, {
                        ok: true,
                        entryId: ROW_ID,
                        documentPath,
                        managed: row.config !== null,
                        config,
                    });
                }
                if (req.method === 'POST') {
                    if (req.headers[REQUIRED_HEADER] === undefined) {
                        return send(res, 403, { ok: false, reason: 'missing same-origin header' });
                    }
                    const raw = await readBody(req);
                    let parsed;
                    try {
                        parsed = JSON.parse(raw);
                    }
                    catch {
                        return send(res, 400, { ok: false, reason: 'body is not valid JSON' });
                    }
                    const validated = validateSubmitted(parsed);
                    if (!validated.ok)
                        return send(res, 400, { ok: false, reason: validated.reason });
                    const documentPath = patchPathOf(host);
                    if (documentPath === null)
                        return send(res, 503, { ok: false, reason: 'profile patch not resolvable' });
                    const written = await writeRowConfig(documentPath, { ...validated.config }, ROW_ID);
                    return send(res, 200, {
                        ok: true,
                        changed: written.changed,
                        createdRow: written.createdRow,
                        documentPath,
                        backupPath: written.backupPath,
                        config: validated.config,
                    });
                }
                return send(res, 405, { ok: false, reason: `method ${req.method ?? 'unknown'} not allowed` });
            }
            catch (error) {
                host.logger?.warn(`keelwatch: config endpoint failed: ${error instanceof Error ? error.message : String(error)}`);
                return send(res, 500, { ok: false, reason: error instanceof Error ? error.message : String(error) });
            }
        },
    });
    host.effect?.(() => () => {
        try {
            dispose();
        }
        catch {
            // The server may already be torn down during profile shutdown.
        }
    });
    if (deps.history !== undefined) {
        const historyLog = deps.history;
        const disposeHistory = webServer.register({
            kind: 'exact',
            path: '/keelwatch/history',
            async handler(req, res) {
                if (!authorized(req))
                    return send(res, 401, { ok: false, reason: 'unauthorized' });
                if (req.method !== 'GET')
                    return send(res, 405, { ok: false, reason: 'GET only' });
                try {
                    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
                    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 20) || 20));
                    const entries = await historyLog.read(limit);
                    return send(res, 200, { ok: true, count: entries.length, entries });
                }
                catch (error) {
                    return send(res, 500, { ok: false, reason: error instanceof Error ? error.message : String(error) });
                }
            },
        });
        host.effect?.(() => () => {
            try {
                disposeHistory();
            }
            catch {
                // Already torn down with the server.
            }
        });
    }
    host.logger?.info?.(`keelwatch: config page served at ${ROUTE_PATH}`);
    return true;
}
