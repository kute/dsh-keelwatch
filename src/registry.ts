/**
 * Registry lookups for Drift Radar.
 *
 * Plain HTTPS instead of spawning a package manager: no shell, no PATH
 * assumptions, no Windows `.cmd` shims, and no lockfile mutations. Failures are
 * data — an unreachable registry must degrade to "unknown", never to a warning
 * storm.
 */

export type LookupStatus = 'ok' | 'not-found' | 'unreachable'

export interface PackageFacts {
  readonly name: string
  readonly status: LookupStatus
  /** Newest release per the registry's `latest` dist-tag. */
  readonly latest?: string
  /** Registry version list, newest first, when the payload carried one. */
  readonly versions?: readonly string[]
  /** Diagnostic detail for non-`ok` statuses. */
  readonly detail?: string
  readonly fetchedAt: number
}

export interface LookupOptions {
  readonly registryUrl?: string
  readonly timeoutMs?: number
  /** Cache lifetime; lookups inside the window are reused. */
  readonly ttlMs?: number
}

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const DEFAULT_TTL_MS = 60 * 60 * 1000
const cache = new Map<string, PackageFacts>()

function registryBase(registryUrl: string | undefined): string {
  const base = registryUrl === undefined || registryUrl.trim() === '' ? DEFAULT_REGISTRY : registryUrl.trim()
  return base.endsWith('/') ? base.slice(0, -1) : base
}

interface RegistryDocument {
  'dist-tags'?: Record<string, string>
  versions?: Record<string, unknown>
}

function compareVersionsDesc(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .split(/[.-]/)
      .map((part) => Number(part))
      .map((part) => (Number.isFinite(part) ? part : 0))
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff > 0 ? -1 : 1
  }
  return 0
}

/**
 * Look up one package's published versions.
 *
 * Never throws: every failure mode becomes a `PackageFacts` with a non-`ok`
 * status so the caller can report "unknown" without retry logic of its own.
 */
export async function lookupPackage(name: string, options: LookupOptions = {}): Promise<PackageFacts> {
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS
  const cached = cache.get(name)
  if (cached !== undefined && Date.now() - cached.fetchedAt < ttl) return cached

  const url = `${registryBase(options.registryUrl)}/${name.replace('/', '%2F')}`
  const timeoutMs = options.timeoutMs ?? 8000
  let result: PackageFacts

  try {
    const response = await fetch(url, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status === 404) {
      result = { name, status: 'not-found', detail: 'registry returned 404', fetchedAt: Date.now() }
    } else if (!response.ok) {
      result = { name, status: 'unreachable', detail: `registry returned ${response.status}`, fetchedAt: Date.now() }
    } else {
      const document = (await response.json()) as RegistryDocument
      const latest = document['dist-tags']?.latest
      const versions = document.versions === undefined ? undefined : Object.keys(document.versions).sort(compareVersionsDesc)
      result =
        latest === undefined
          ? { name, status: 'unreachable', detail: 'registry payload has no dist-tags.latest', fetchedAt: Date.now() }
          : { name, status: 'ok', latest, ...(versions === undefined ? {} : { versions }), fetchedAt: Date.now() }
    }
  } catch (error) {
    result = {
      name,
      status: 'unreachable',
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      fetchedAt: Date.now(),
    }
  }

  cache.set(name, result)
  return result
}

/** Test hook: drop cached lookups. */
export function clearLookupCache(): void {
  cache.clear()
}
