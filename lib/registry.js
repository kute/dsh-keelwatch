/**
 * Registry lookups for Drift Radar.
 *
 * Plain HTTPS instead of spawning a package manager: no shell, no PATH
 * assumptions, no Windows `.cmd` shims, and no lockfile mutations. Failures are
 * data — an unreachable registry must degrade to "unknown", never to a warning
 * storm.
 */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const cache = new Map();
function registryBase(registryUrl) {
    const base = registryUrl === undefined || registryUrl.trim() === '' ? DEFAULT_REGISTRY : registryUrl.trim();
    return base.endsWith('/') ? base.slice(0, -1) : base;
}
function compareVersionsDesc(a, b) {
    const parse = (value) => value
        .split(/[.-]/)
        .map((part) => Number(part))
        .map((part) => (Number.isFinite(part) ? part : 0));
    const left = parse(a);
    const right = parse(b);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
        const diff = (left[index] ?? 0) - (right[index] ?? 0);
        if (diff !== 0)
            return diff > 0 ? -1 : 1;
    }
    return 0;
}
/**
 * Look up one package's published versions.
 *
 * Never throws: every failure mode becomes a `PackageFacts` with a non-`ok`
 * status so the caller can report "unknown" without retry logic of its own.
 */
export async function lookupPackage(name, options = {}) {
    const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
    const cached = cache.get(name);
    if (cached !== undefined && Date.now() - cached.fetchedAt < ttl)
        return cached;
    const url = `${registryBase(options.registryUrl)}/${name.replace('/', '%2F')}`;
    const timeoutMs = options.timeoutMs ?? 8000;
    let result;
    try {
        const response = await fetch(url, {
            headers: { accept: 'application/vnd.npm.install-v1+json' },
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status === 404) {
            result = { name, status: 'not-found', detail: 'registry returned 404', fetchedAt: Date.now() };
        }
        else if (!response.ok) {
            result = { name, status: 'unreachable', detail: `registry returned ${response.status}`, fetchedAt: Date.now() };
        }
        else {
            const document = (await response.json());
            const latest = document['dist-tags']?.latest;
            const versions = document.versions === undefined ? undefined : Object.keys(document.versions).sort(compareVersionsDesc);
            result =
                latest === undefined
                    ? { name, status: 'unreachable', detail: 'registry payload has no dist-tags.latest', fetchedAt: Date.now() }
                    : { name, status: 'ok', latest, ...(versions === undefined ? {} : { versions }), fetchedAt: Date.now() };
        }
    }
    catch (error) {
        result = {
            name,
            status: 'unreachable',
            detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            fetchedAt: Date.now(),
        };
    }
    cache.set(name, result);
    return result;
}
/** Test hook: drop cached lookups. */
export function clearLookupCache() {
    cache.clear();
}
