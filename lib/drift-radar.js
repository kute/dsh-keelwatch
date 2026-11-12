/**
 * Drift Radar: watch what the installed bundles declare against what upstream
 * has actually published, and against the DSH version that is running.
 *
 * The install-time checks already exist (preflight, `engines.dsh` enforcement,
 * market-index filtering); nothing watches *afterwards*. This module only
 * reports — it never edits a manifest and never runs a package manager.
 */
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { matchesPattern } from './patterns.js';
import { minimumVersion } from './semver.js';
import { lookupPackage } from './registry.js';
import { checkEngine, classifyDrift } from './semver.js';
/** `$DSH_HOME`, defaulting to the documented platform location. */
export function resolveDshHome(env = process.env) {
    const configured = env['DSH_HOME'];
    return configured === undefined || configured === '' ? join(homedir(), '.dsh') : configured;
}
/**
 * The running DSH version.
 *
 * Every official `@deepseek-ai/dsh*` package is versioned in lockstep with the
 * launcher, so a resolvable sibling is a sound fallback when the launcher
 * package itself is not reachable from the profile.
 */
export function runningDshVersion() {
    const fromEnv = process.env['DSH_VERSION'];
    if (fromEnv !== undefined && fromEnv.trim() !== '')
        return fromEnv.trim();
    const require = createRequire(import.meta.url);
    for (const candidate of ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-tools/package.json']) {
        try {
            const manifest = require(candidate);
            if (typeof manifest.version === 'string')
                return manifest.version;
        }
        catch {
            // Fall through: the profile resolution may hide this package.
        }
    }
    return null;
}
async function readManifest(directory) {
    try {
        const raw = await readFile(join(directory, 'package.json'), 'utf8');
        const parsed = JSON.parse(raw);
        const name = parsed['name'];
        const version = parsed['version'];
        if (typeof name !== 'string' || typeof version !== 'string')
            return null;
        const engines = parsed['engines'];
        const dshEngine = typeof engines === 'object' && engines !== null ? engines['dsh'] : undefined;
        const dsh = parsed['dsh'];
        const bundle = typeof dsh === 'object' && dsh !== null ? dsh['bundle'] : undefined;
        const asRecord = (value) => {
            if (typeof value !== 'object' || value === null)
                return {};
            const result = {};
            for (const [key, raw] of Object.entries(value)) {
                if (typeof raw === 'string')
                    result[key] = raw;
            }
            return result;
        };
        return {
            name,
            version,
            directory,
            ...(typeof dshEngine === 'string' ? { enginesDsh: dshEngine } : {}),
            peerDependencies: asRecord(parsed['peerDependencies']),
            dependencies: asRecord(parsed['dependencies']),
            isBundle: typeof bundle === 'object' && bundle !== null,
        };
    }
    catch {
        return null;
    }
}
async function listPackageDirectories(nodeModules) {
    let entries;
    try {
        entries = await readdir(nodeModules);
    }
    catch {
        return [];
    }
    const directories = [];
    for (const entry of entries) {
        if (entry.startsWith('.'))
            continue;
        if (entry.startsWith('@')) {
            let scoped;
            try {
                scoped = await readdir(join(nodeModules, entry));
            }
            catch {
                continue;
            }
            for (const child of scoped)
                directories.push(join(nodeModules, entry, child));
            continue;
        }
        directories.push(join(nodeModules, entry));
    }
    return directories;
}
/**
 * Every package installed into any profile, deduplicated by name.
 *
 * Scanning all profiles rather than the "current" one is deliberate: the
 * launcher does not expose the active profile name to plugins, and a stale
 * profile still predicts the next broken startup.
 */
export async function collectInstalledBundles(dshHome) {
    const profilesDirectory = join(dshHome, 'profiles');
    let profiles;
    try {
        profiles = await readdir(profilesDirectory);
    }
    catch {
        return [];
    }
    const byName = new Map();
    for (const profile of profiles) {
        const directories = await listPackageDirectories(join(profilesDirectory, profile, 'node_modules'));
        for (const directory of directories) {
            const manifest = await readManifest(directory);
            if (manifest === null)
                continue;
            const existing = byName.get(manifest.name);
            // Keep one row per package; a newer copy wins so the report does not
            // grow with the number of profiles a user has accumulated.
            if (existing === undefined || existing.version !== manifest.version)
                byName.set(manifest.name, manifest);
        }
    }
    return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}
/**
 * One-line remedy for a finding.
 *
 * For a drifted dependency the safe target is the lowest version the bundle's own
 * declaration admits — pinning there keeps the package on the combination it was
 * tested with, without guessing at an upgrade.
 */
export function suggestionForFinding(finding) {
    if (finding.kind === 'engine-incompatible') {
        return `upgrade ${finding.packageName} to a version whose engines.dsh admits this DSH, or disable it (keelwatch_report action=disable bundle=${finding.packageName})`;
    }
    const pin = minimumVersion(finding.declared);
    if (pin !== null) {
        const pinned = `${pin.major}.${pin.minor}.${pin.patch}`;
        return `pin it back with a profile overrides entry: "@deepseek-ai/*": "${pinned}" (or upgrade ${finding.packageName} if it supports ${finding.latest ?? 'the newer release'})`;
    }
    return `upgrade ${finding.packageName} so its declared range covers ${finding.latest ?? 'the current release'}`;
}
function isWhitelisted(name, whitelist) {
    return whitelist.some((pattern) => matchesPattern(pattern, name));
}
function severityOf(level, alertLevel) {
    if (alertLevel === 'all')
        return level !== 'none' && level !== 'skipped';
    if (alertLevel === 'minor')
        return level === 'major' || level === 'minor';
    return level === 'major';
}
/**
 * One full scan.
 *
 * Ordering matters: an `engines.dsh` mismatch means the launcher will refuse
 * the bundle outright, so that finding is emitted before any registry work.
 */
export async function scanDrift(config, options = {}) {
    const dshHome = options.dshHome ?? resolveDshHome();
    const dshVersion = options.dshVersion === undefined ? runningDshVersion() : options.dshVersion;
    const lookup = options.lookup ?? lookupPackage;
    const bundles = await collectInstalledBundles(dshHome);
    const findings = [];
    const skipped = [];
    let scanned = 0;
    // One unreachable registry stops the rest of this scan: offline and
    // intranet-only machines would otherwise pay one timeout per dependency and
    // then report every package as "skipped", which reads as 19 problems.
    let registryDown = null;
    for (const bundle of bundles) {
        if (isWhitelisted(bundle.name, config.whitelist)) {
            skipped.push({ packageName: bundle.name, reason: 'whitelisted' });
            continue;
        }
        scanned += 1;
        if (bundle.enginesDsh !== undefined && dshVersion !== null) {
            const engine = checkEngine(bundle.enginesDsh, dshVersion);
            if (engine.level === 'major') {
                const engineFinding = {
                    packageName: bundle.name,
                    kind: 'engine-incompatible',
                    level: 'major',
                    declared: bundle.enginesDsh,
                    message: `${bundle.name}@${bundle.version} declares engines.dsh "${bundle.enginesDsh}" but DSH ${dshVersion} is running`,
                };
                findings.push({ ...engineFinding, suggestion: suggestionForFinding(engineFinding) });
            }
            else if (engine.level === 'skipped') {
                skipped.push({ packageName: bundle.name, reason: engine.reason });
            }
        }
        // Only the official `@deepseek-ai/*` dependencies are re-checked: they move
        // in lockstep with DSH, which is the failure mode this radar exists for.
        for (const [dependency, declared] of Object.entries(bundle.dependencies)) {
            if (!dependency.startsWith('@deepseek-ai/'))
                continue;
            if (registryDown !== null) {
                skipped.push({ packageName: `${bundle.name} -> ${dependency}`, reason: `registry unreachable earlier in this scan (${registryDown})` });
                continue;
            }
            const facts = await lookup(dependency, { registryUrl: config.registryUrl, timeoutMs: config.requestTimeoutMs });
            if (facts.status !== 'ok' || facts.latest === undefined) {
                if (facts.status === 'unreachable')
                    registryDown = facts.detail ?? 'unreachable';
                skipped.push({ packageName: `${bundle.name} -> ${dependency}`, reason: facts.detail ?? facts.status });
                continue;
            }
            const drift = classifyDrift(declared, facts.latest);
            if (drift.level === 'skipped') {
                skipped.push({ packageName: `${bundle.name} -> ${dependency}`, reason: drift.reason });
                continue;
            }
            if (!severityOf(drift.level, config.alertLevel))
                continue;
            const driftFinding = {
                packageName: bundle.name,
                kind: 'dependency-drift',
                level: drift.level,
                declared,
                latest: facts.latest,
                message: `${bundle.name} pins ${dependency} "${declared}" but upstream latest is ${facts.latest} (${drift.level})`,
            };
            findings.push({ ...driftFinding, suggestion: suggestionForFinding(driftFinding) });
        }
    }
    return { scannedAt: Date.now(), dshVersion, bundlesScanned: scanned, findings, skipped };
}
/** Format a report as the log line the user actually reads. */
export function summarize(report) {
    const head = `keelwatch: drift scan over ${report.bundlesScanned} bundle(s)`;
    if (report.findings.length === 0)
        return `${head}: no findings`;
    const lines = report.findings.map((finding) => finding.suggestion === undefined ? `  - ${finding.message}` : `  - ${finding.message}\n    → ${finding.suggestion}`);
    return [`${head}: ${report.findings.length} finding(s)`, ...lines].join('\n');
}
/**
 * Register the periodic scan.
 *
 * The timer comes from the host (`ctx.timer`, provided by
 * `@deepseek-ai/cordis-plugin-timer`) so the interval dies with the fiber; a
 * bare `setInterval` would keep the process awake after unload.
 */
export function startDriftRadar(host, config, onReport) {
    const run = () => {
        void scanDrift(config)
            .then((report) => {
            if (report.findings.length > 0)
                host.logger?.warn(summarize(report));
            try {
                onReport?.(report);
            }
            catch {
                // A history hook must never fail the scan that produced the data.
            }
        })
            .catch((error) => {
            host.logger?.warn(`keelwatch: drift scan failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    };
    run();
    if (config.checkIntervalHours > 0 && host.timer !== undefined) {
        host.timer.interval(run, config.checkIntervalHours * 3_600_000);
    }
}
