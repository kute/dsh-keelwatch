/**
 * Shared matching helpers.
 *
 * `*`-wildcard only, by design: the upstream plugin convention for tool and
 * package predicates is a glob over names, not a regex dialect — a pattern must
 * never be able to ReDoS a hot path (`tools/pre-execute` runs per call).
 */
/** Whether `value` matches `pattern`, where `*` matches any run of characters. */
export function matchesPattern(pattern, value) {
    if (pattern === value)
        return true;
    if (!pattern.includes('*'))
        return false;
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`).test(value);
}
