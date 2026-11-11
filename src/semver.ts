/**
 * Minimal SemVer handling for drift detection.
 *
 * Deliberately zero-dependency: the plugin must keep working when the host
 * provides no extra runtime packages, and a full semver implementation would
 * pull a transitive tree into a package whose entire job is to watch one.
 *
 * Modelled syntax: exact versions, `^`, `~`, `>=`, `>`, `<=`, `<`, `=`, `*`,
 * `latest`, `x`/`X` wildcards, space-separated conjunctions, and `||`
 * alternatives. Anything else (tags, git urls, `workspace:`, file paths, npm
 * aliases) classifies as `skipped` instead of guessing.
 *
 * Prerelease handling matches the host, not npm's default: DSH evaluates
 * `engines.dsh` with `semver.satisfies(version, range, { includePrerelease:
 * true })` (`packages/boot/app-boot/src/plugin-compatibility.ts`), so a
 * prerelease is compared by ordinary precedence and needs no same-tuple anchor.
 * Getting this wrong makes the scanner report bundles as incompatible that the
 * launcher happily loads — the one false positive that would destroy trust in
 * the report.
 */

export interface SemVer {
  readonly major: number
  readonly minor: number
  readonly patch: number
  /** Pre-release identifiers, empty for a release version. */
  readonly pre: readonly string[]
}

/** How far the upstream latest release has moved past what the declaration allows. */
export type DriftLevel = 'major' | 'minor' | 'patch' | 'none' | 'skipped'

export interface DriftResult {
  readonly level: DriftLevel
  /** Human-readable reason, always present for `skipped` and `none`. */
  readonly reason: string
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const PARTIAL = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/

function splitPre(pre: string | undefined): string[] {
  return pre === undefined || pre === '' ? [] : pre.split('.')
}

/** Parse a full `x.y.z[-pre]` version. Returns `null` for anything else. */
export function parseVersion(input: string): SemVer | null {
  const match = SEMVER.exec(input.trim())
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: splitPre(match[4]),
  }
}

function comparePre(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0
  // A release version outranks any pre-release of the same core version.
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      const diff = Number(left) - Number(right)
      if (diff !== 0) return diff < 0 ? -1 : 1
      continue
    }
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/** Standard SemVer precedence comparison. */
export function compareVersion(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return comparePre(a.pre, b.pre)
}

type BoundOperator = '>=' | '>' | '<=' | '<' | '='

interface Bound {
  readonly operator: BoundOperator
  readonly version: SemVer
}

type Operator = '=' | '>=' | '>' | '<=' | '<' | '^' | '~'

interface Comparator {
  readonly operator: Operator
  readonly version: SemVer
}

const COMPARATOR = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/

function parseComparator(token: string): Comparator | null {
  const match = COMPARATOR.exec(token)
  if (match === null) return null
  const raw = match[1]
  const operator: Operator = raw === undefined ? '=' : (raw as Operator)
  const version = parseVersion(match[2] ?? '')
  if (version === null) return null
  return { operator, version }
}

function upperBoundForCaret(version: SemVer): SemVer {
  // ^1.2.3 -> <2.0.0, ^0.2.3 -> <0.3.0, ^0.0.3 -> <0.0.4
  if (version.major > 0) return { major: version.major + 1, minor: 0, patch: 0, pre: [] }
  if (version.minor > 0) return { major: 0, minor: version.minor + 1, patch: 0, pre: [] }
  return { major: 0, minor: 0, patch: version.patch + 1, pre: [] }
}

function upperBoundForTilde(version: SemVer): SemVer {
  // ~1.2.3 -> <1.3.0
  return { major: version.major, minor: version.minor + 1, patch: 0, pre: [] }
}

/** Expand one token into plain bounds, or `null` for unmodelled syntax. */
function expandToken(token: string): { bounds: Bound[] } | null {
  const comparator = parseComparator(token)
  if (comparator !== null) {
    switch (comparator.operator) {
      case '=':
        return { bounds: [{ operator: '=', version: comparator.version }] }
      case '>=':
        return { bounds: [{ operator: '>=', version: comparator.version }] }
      case '>':
        return { bounds: [{ operator: '>', version: comparator.version }] }
      case '<=':
        return { bounds: [{ operator: '<=', version: comparator.version }] }
      case '<':
        return { bounds: [{ operator: '<', version: comparator.version }] }
      case '^':
        return {
          bounds: [
            { operator: '>=', version: comparator.version },
            { operator: '<', version: upperBoundForCaret(comparator.version) },
          ],
        }
      case '~':
        return {
          bounds: [
            { operator: '>=', version: comparator.version },
            { operator: '<', version: upperBoundForTilde(comparator.version) },
          ],
        }
    }
  }

  // Bare partial versions: `1` means >=1.0.0 <2.0.0, `1.2` means >=1.2.0 <1.3.0.
  const partial = PARTIAL.exec(token)
  if (partial === null) return null
  const major = Number(partial[1])
  const minorRaw = partial[2]
  const patchRaw = partial[3]
  if (minorRaw === undefined) {
    const low: SemVer = { major, minor: 0, patch: 0, pre: [] }
    const high: SemVer = { major: major + 1, minor: 0, patch: 0, pre: [] }
    return { bounds: [{ operator: '>=', version: low }, { operator: '<', version: high }] }
  }
  if (patchRaw === undefined) {
    const minor = Number(minorRaw)
    const low: SemVer = { major, minor, patch: 0, pre: [] }
    const high: SemVer = { major, minor: minor + 1, patch: 0, pre: [] }
    return { bounds: [{ operator: '>=', version: low }, { operator: '<', version: high }] }
  }
  const exact: SemVer = { major, minor: Number(minorRaw), patch: Number(patchRaw), pre: [] }
  return { bounds: [{ operator: '=', version: exact }] }
}

function holds(version: SemVer, bound: Bound): boolean {
  const order = compareVersion(version, bound.version)
  switch (bound.operator) {
    case '=':
      return order === 0
    case '>=':
      return order >= 0
    case '>':
      return order > 0
    case '<=':
      return order <= 0
    case '<':
      return order < 0
  }
}

function isUnmodelled(trimmed: string): boolean {
  return /^(workspace:|file:|link:|npm:|github:|git\+|https?:|\/|\.)/.test(trimmed) || trimmed === 'beta' || trimmed === 'next'
}

/** One conjunction clause (no `||`). */
function satisfiesSingle(version: SemVer, range: string): boolean | null {
  const trimmed = range.trim()
  if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'X' || trimmed === 'latest') return true
  if (isUnmodelled(trimmed)) return null

  const tokens = trimmed.split(/\s+/).filter((token) => token !== '' && token !== '-')
  if (tokens.length === 0) return true

  const bounds: Bound[] = []
  for (const token of tokens) {
    const expanded = expandToken(token)
    if (expanded === null) return null
    bounds.push(...expanded.bounds)
  }

  return bounds.every((bound) => holds(version, bound))
}

/**
 * Whether `version` satisfies `range`, including `||` alternatives.
 *
 * Returns `null` when every non-matching alternative used syntax this parser
 * does not model, so callers can report "cannot judge" instead of a wrong
 * `false`.
 */
export function satisfies(version: SemVer, range: string): boolean | null {
  const alternatives = range
    .split('||')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (alternatives.length === 0) return true

  let unknown = false
  for (const alternative of alternatives) {
    const result = satisfiesSingle(version, alternative)
    if (result === null) {
      unknown = true
      continue
    }
    if (result) return true
  }
  return unknown ? null : false
}

/**
 * Whether {@link satisfies} can model `range` at all — used to tell
 * "declaration we cannot judge" apart from "declaration satisfied".
 */
export function isAnalyzableRange(range: string): boolean {
  const probe: SemVer = { major: 0, minor: 0, patch: 0, pre: [] }
  return satisfies(probe, range) !== null
}

/** Lowest version the declaration admits, when derivable; used for reporting. */
export function minimumVersion(range: string): SemVer | null {
  const trimmed = range.trim()
  if (trimmed === '' || trimmed === '*' || trimmed === 'latest') return null
  const firstClause = trimmed.split('||')[0]?.trim() ?? ''
  const first = firstClause.split(/\s+/)[0]
  if (first === undefined) return null
  const comparator = parseComparator(first)
  if (comparator !== null) return comparator.version
  const partial = PARTIAL.exec(first)
  if (partial === null) return null
  return {
    major: Number(partial[1]),
    minor: Number(partial[2] ?? 0),
    patch: Number(partial[3] ?? 0),
    pre: [],
  }
}

/**
 * Classify how far `latest` has drifted from what `declared` allows.
 *
 * `none` means the newest upstream release is still inside the declared range,
 * so nothing has drifted yet — the declaration is simply permissive.
 */
export function classifyDrift(declared: string, latest: string): DriftResult {
  const latestVersion = parseVersion(latest)
  if (latestVersion === null) {
    return { level: 'skipped', reason: `latest "${latest}" is not a parsable version` }
  }
  const allowed = satisfies(latestVersion, declared)
  if (allowed === null) {
    return { level: 'skipped', reason: `declaration "${declared}" uses syntax this scanner does not model` }
  }
  if (allowed) {
    return { level: 'none', reason: `latest ${latest} is inside "${declared}"` }
  }
  const anchor = minimumVersion(declared)
  if (anchor === null) {
    return { level: 'skipped', reason: `declaration "${declared}" has no comparable version anchor` }
  }
  if (latestVersion.major !== anchor.major) {
    return { level: 'major', reason: `latest ${latest} crosses a major boundary against "${declared}"` }
  }
  if (latestVersion.minor !== anchor.minor) {
    return { level: 'minor', reason: `latest ${latest} crosses a minor boundary against "${declared}"` }
  }
  return { level: 'patch', reason: `latest ${latest} drifts within the same minor against "${declared}"` }
}

/** Whether the running DSH version satisfies a plugin's declared `engines.dsh`. */
export function checkEngine(engineRange: string, runningVersion: string): DriftResult {
  const running = parseVersion(runningVersion)
  if (running === null) {
    return { level: 'skipped', reason: `running DSH version "${runningVersion}" is not parsable` }
  }
  const allowed = satisfies(running, engineRange)
  if (allowed === null) {
    return { level: 'skipped', reason: `engines.dsh "${engineRange}" uses syntax this scanner does not model` }
  }
  if (allowed) return { level: 'none', reason: `running DSH ${runningVersion} satisfies "${engineRange}"` }
  return { level: 'major', reason: `running DSH ${runningVersion} does not satisfy engines.dsh "${engineRange}"` }
}
