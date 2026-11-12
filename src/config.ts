/**
 * Plugin configuration.
 *
 * Every key carries a default so a missing or partial config degrades to
 * "record, never act" instead of failing the host at load time.
 */
import z from '@deepseek-ai/schemastery'

/** How much has to move upstream before Drift Radar speaks up. */
export type AlertLevel = 'major' | 'minor' | 'all'

/** Whether a tripped brake only records or actually denies the next call. */
export type BrakeAction = 'log' | 'brake'

export interface DriftRadarConfig {
  /** Master switch. */
  enabled: boolean
  /** Rescan period; `0` scans once at startup only. */
  checkIntervalHours: number
  /** Minimum drift level that produces a warning. */
  alertLevel: AlertLevel
  /** Package-name globs excluded from scanning. */
  whitelist: string[]
  /** Registry base URL; empty uses the npm default. */
  registryUrl: string
  /** Per-request timeout for registry lookups. */
  requestTimeoutMs: number
}

export interface FailureBrakeConfig {
  /** Master switch; off means no accounting at all. */
  enabled: boolean
  /** `log` records and warns, `brake` denies calls once the state machine opens. */
  action: BrakeAction
  /** Consecutive failures that open the brake. */
  maxConsecutiveErrors: number
  /** How long the brake stays open before a single probe call is admitted. */
  cooldownMinutes: number
  /** Only brake these tool names; empty means every tool. */
  tools: string[]
  /** Tool-name globs never braked. */
  exclude: string[]
  /** Tool names that must never be braked, whatever the configuration says. */
  neverBrake: string[]
}

export interface CostAttributionConfig {
  /** Master switch. */
  enabled: boolean
  /** Days of local JSONL records to keep. */
  retentionDays: number
  /** Tool name to bundle name hints used when a message carries no source kind. */
  toolToBundle: Record<string, string>
  /** Entries reported per table. */
  topN: number
}

export interface DashboardConfig {
  /** Serve /keelwatch/dashboard and /keelwatch/status. */
  enabled: boolean
  /** Page refresh interval; the page clamps it to >= 10 s. */
  refreshSeconds: number
}

export interface Config {
  driftRadar: DriftRadarConfig
  failureBrake: FailureBrakeConfig
  costAttribution: CostAttributionConfig
  dashboard: DashboardConfig
}

const alertLevelSchema = z.union([z.const('major'), z.const('minor'), z.const('all')])
const brakeActionSchema = z.union([z.const('log'), z.const('brake')])

export const Config: z<Config> = z.object({
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
  dashboard: z
    .object({
      enabled: z.boolean().default(false),
      refreshSeconds: z.number().default(30),
    })
    .description('Opt-in web dashboard at /keelwatch/dashboard.'),
})

export const DEFAULTS: Config = {
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
  dashboard: {
    enabled: false,
    refreshSeconds: 30,
  },
}

function clampNumber(value: number, low: number, high: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(high, Math.max(low, Math.round(value)))
}

/**
 * Clamp user-supplied numbers into ranges where the plugin stays safe.
 *
 * A `maxConsecutiveErrors` of 1 would brake on the first flaky call and a
 * cooldown of 0 would make the brake meaningless, so both are bounded rather
 * than trusted.
 */
export function normalizeConfig(config: Config): Config {
  // A host normally fills every group from the schema, but a profile patch can
  // hand over a partial object; normalisation must not throw on that.
  const brake = config.failureBrake ?? DEFAULTS.failureBrake
  const drift = config.driftRadar ?? DEFAULTS.driftRadar
  const cost = config.costAttribution ?? DEFAULTS.costAttribution
  const dashboard = config.dashboard ?? DEFAULTS.dashboard
  return {
    driftRadar: {
      ...drift,
      checkIntervalHours: clampNumber(drift.checkIntervalHours, 0, 24 * 30, DEFAULTS.driftRadar.checkIntervalHours),
      requestTimeoutMs: clampNumber(drift.requestTimeoutMs, 500, 60_000, DEFAULTS.driftRadar.requestTimeoutMs),
    },
    failureBrake: {
      ...brake,
      maxConsecutiveErrors: clampNumber(brake.maxConsecutiveErrors, 2, 100, DEFAULTS.failureBrake.maxConsecutiveErrors),
      cooldownMinutes: clampNumber(brake.cooldownMinutes, 1, 1440, DEFAULTS.failureBrake.cooldownMinutes),
    },
    costAttribution: {
      ...cost,
      retentionDays: clampNumber(cost.retentionDays, 1, 365, DEFAULTS.costAttribution.retentionDays),
      topN: clampNumber(cost.topN, 1, 100, DEFAULTS.costAttribution.topN),
    },
    dashboard: {
      ...dashboard,
      refreshSeconds: clampNumber(dashboard.refreshSeconds, 10, 600, DEFAULTS.dashboard.refreshSeconds),
    },
  }
}
