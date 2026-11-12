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
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
    /** Pre-release identifiers, empty for a release version. */
    readonly pre: readonly string[];
}
/** How far the upstream latest release has moved past what the declaration allows. */
export type DriftLevel = 'major' | 'minor' | 'patch' | 'none' | 'skipped';
export interface DriftResult {
    readonly level: DriftLevel;
    /** Human-readable reason, always present for `skipped` and `none`. */
    readonly reason: string;
}
/** Parse a full `x.y.z[-pre]` version. Returns `null` for anything else. */
export declare function parseVersion(input: string): SemVer | null;
/** Standard SemVer precedence comparison. */
export declare function compareVersion(a: SemVer, b: SemVer): number;
/**
 * Whether `version` satisfies `range`, including `||` alternatives.
 *
 * Returns `null` when every non-matching alternative used syntax this parser
 * does not model, so callers can report "cannot judge" instead of a wrong
 * `false`.
 */
export declare function satisfies(version: SemVer, range: string): boolean | null;
/**
 * Whether {@link satisfies} can model `range` at all — used to tell
 * "declaration we cannot judge" apart from "declaration satisfied".
 */
export declare function isAnalyzableRange(range: string): boolean;
/** Lowest version the declaration admits, when derivable; used for reporting. */
export declare function minimumVersion(range: string): SemVer | null;
/**
 * Classify how far `latest` has drifted from what `declared` allows.
 *
 * `none` means the newest upstream release is still inside the declared range,
 * so nothing has drifted yet — the declaration is simply permissive.
 */
export declare function classifyDrift(declared: string, latest: string): DriftResult;
/** Whether the running DSH version satisfies a plugin's declared `engines.dsh`. */
export declare function checkEngine(engineRange: string, runningVersion: string): DriftResult;
