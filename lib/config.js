/**
 * Plugin configuration.
 *
 * Every key carries a default so a missing or partial config degrades to
 * "record, never act" instead of failing the host at load time.
 */
import z from '@deepseek-ai/schemastery';
const alertLevelSchema = z.union([z.const('major'), z.const('minor'), z.const('all')]);
const brakeActionSchema = z.union([z.const('log'), z.const('brake')]);
export const Config = z.object({
    driftRadar: z
        .object({
        enabled: z.boolean().default(true),
        checkIntervalHours: z.number().default(24),
        alertLevel: alertLevelSchema.default('major'),
        whitelist: z.array(String).default([]),
        registryUrl: z.string().default(''),
        requestTimeoutMs: z.number().default(8000),
    })
        .description('Dependency drift scanning across installed bundles.'),
    failureBrake: z
        .object({
        enabled: z.boolean().default(false),
        action: brakeActionSchema.default('log'),
        maxConsecutiveErrors: z.number().default(5),
        cooldownMinutes: z.number().default(10),
        tools: z.array(String).default([]),
        exclude: z.array(String).default([]),
        neverBrake: z.array(String).default(['ask_user_question']),
    })
        .description('Consecutive-failure brake for tool calls.'),
    costAttribution: z
        .object({
        enabled: z.boolean().default(true),
        retentionDays: z.number().default(7),
        toolToBundle: z.dict(String).default({}),
        topN: z.number().default(10),
    })
        .description('Token and latency attribution per source and tool.'),
});
export const DEFAULTS = {
    driftRadar: {
        enabled: true,
        checkIntervalHours: 24,
        alertLevel: 'major',
        whitelist: [],
        registryUrl: '',
        requestTimeoutMs: 8000,
    },
    failureBrake: {
        enabled: false,
        action: 'log',
        maxConsecutiveErrors: 5,
        cooldownMinutes: 10,
        tools: [],
        exclude: [],
        neverBrake: ['ask_user_question'],
    },
    costAttribution: {
        enabled: true,
        retentionDays: 7,
        toolToBundle: {},
        topN: 10,
    },
};
function clamp(value, low, high, fallback) {
    if (!Number.isFinite(value))
        return fallback;
    return Math.min(high, Math.max(low, Math.round(value)));
}
/**
 * Clamp user-supplied numbers into ranges where the plugin stays safe.
 *
 * A `maxConsecutiveErrors` of 1 would brake on the first flaky call and a
 * cooldown of 0 would make the brake meaningless, so both are bounded rather
 * than trusted.
 */
export function normalizeConfig(config) {
    const brake = config.failureBrake;
    const drift = config.driftRadar;
    const cost = config.costAttribution;
    return {
        driftRadar: {
            ...drift,
            checkIntervalHours: clamp(drift.checkIntervalHours, 0, 24 * 30, DEFAULTS.driftRadar.checkIntervalHours),
            requestTimeoutMs: clamp(drift.requestTimeoutMs, 500, 60_000, DEFAULTS.driftRadar.requestTimeoutMs),
        },
        failureBrake: {
            ...brake,
            maxConsecutiveErrors: clamp(brake.maxConsecutiveErrors, 2, 100, DEFAULTS.failureBrake.maxConsecutiveErrors),
            cooldownMinutes: clamp(brake.cooldownMinutes, 1, 1440, DEFAULTS.failureBrake.cooldownMinutes),
        },
        costAttribution: {
            ...cost,
            retentionDays: clamp(cost.retentionDays, 1, 365, DEFAULTS.costAttribution.retentionDays),
            topN: clamp(cost.topN, 1, 100, DEFAULTS.costAttribution.topN),
        },
    };
}
