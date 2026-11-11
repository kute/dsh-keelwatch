/**
 * Failure Brake: stop a repeatedly failing tool from being retried into a
 * token fire.
 *
 * What the host already guarantees (upstream `docs/subsystems/tools.zh.md`):
 * a thrown tool becomes a structured error and does not end the turn. So the
 * remaining damage is amplification — the model retries a broken tool with new
 * arguments, each attempt paying a timeout plus a round trip. This module
 * brakes that pattern and nothing else: it never kills an in-flight call, never
 * rewrites arguments, and never touches the tool registry.
 */
import type { FailureBrakeConfig } from './config.js'
import { matchesPattern } from './patterns.js'
import type { KeelwatchHost, PostToolResultLike, ToolExecutionLike } from './host.js'

export interface BrakeState {
  /** Consecutive failures since the last success. */
  failures: number
  /** When the brake opened; `null` while closed. */
  openedAt: number | null
  /** A single half-open probe is already in flight. */
  probeInFlight: boolean
}

export type BrakeVerdict = { deny: false; reason?: never } | { deny: true; reason: string }

/**
 * The Closed → Open → Half-open machine, pure and clock-injected.
 *
 * Kept free of host types so it can be unit-tested without a Cordis context and
 * so the persistence layer (Phase 2b) can snapshot it verbatim.
 */
export class FailureBrake {
  private readonly states = new Map<string, BrakeState>()
  /** Monotonic counter of state changes, used by the persistence layer. */
  private revision = 0

  constructor(private readonly config: FailureBrakeConfig) {}

  /** Whether this tool is subject to braking at all. */
  covers(tool: string): boolean {
    if (!this.config.enabled) return false
    if (this.config.neverBrake.some((pattern) => matchesPattern(pattern, tool))) return false
    if (this.config.exclude.some((pattern) => matchesPattern(pattern, tool))) return false
    if (this.config.tools.length > 0 && !this.config.tools.some((pattern) => matchesPattern(pattern, tool))) return false
    return true
  }

  private stateOf(tool: string): BrakeState {
    const existing = this.states.get(tool)
    if (existing !== undefined) return existing
    const created: BrakeState = { failures: 0, openedAt: null, probeInFlight: false }
    this.states.set(tool, created)
    return created
  }

  /**
   * Record one settled call.
   *
   * Failures are counted even when the action is `log`, so switching to
   * `brake` reuses the history instead of starting blind.
   */
  observe(tool: string, isError: boolean, now: number = Date.now()): void {
    if (!this.covers(tool)) return
    const state = this.stateOf(tool)
    this.revision += 1
    if (!isError) {
      state.failures = 0
      state.openedAt = null
      state.probeInFlight = false
      return
    }
    state.failures += 1
    state.probeInFlight = false
    if (state.openedAt !== null) {
      // A failed probe re-opens for a full cooldown.
      state.openedAt = now
      return
    }
    if (state.failures >= this.config.maxConsecutiveErrors) state.openedAt = now
  }

  private cooldownMs(): number {
    return this.config.cooldownMinutes * 60_000
  }

  /**
   * Decide one dispatch.
   *
   * While open, every call is denied. Once the cooldown elapsed, exactly one
   * probe is admitted; if that probe fails, `observe` re-opens the brake.
   */
  check(tool: string, now: number = Date.now()): BrakeVerdict {
    if (this.config.action !== 'brake') return { deny: false }
    if (!this.covers(tool)) return { deny: false }
    const state = this.states.get(tool)
    if (state === undefined || state.openedAt === null) return { deny: false }

    if (now - state.openedAt < this.cooldownMs()) {
      return { deny: true, reason: this.denyReason(tool) }
    }
    if (state.probeInFlight) return { deny: true, reason: this.denyReason(tool) }
    state.probeInFlight = true
    return { deny: false }
  }

  private denyReason(tool: string): string {
    return (
      `keelwatch: ${tool} failed ${this.config.maxConsecutiveErrors} times in a row and is cooling down ` +
      `for ${this.config.cooldownMinutes} minute(s). Do not retry it; use another tool or tell the user.`
    )
  }

  /** Monotonic count of observed calls; the persist layer compares it. */
  getRevision(): number {
    return this.revision
  }

  /** Snapshot for persistence and for the report tool. */
  snapshot(): Record<string, BrakeState> {
    const result: Record<string, BrakeState> = {}
    for (const [tool, state] of this.states) result[tool] = { ...state }
    return result
  }

  /** Restore a snapshot taken by {@link snapshot}. */
  restore(snapshot: Readonly<Record<string, BrakeState>>): void {
    for (const [tool, state] of Object.entries(snapshot)) {
      this.states.set(tool, { ...state })
    }
  }

  /** Test/report hook: tools currently braking. */
  openTools(now: number = Date.now()): string[] {
    const open: string[] = []
    for (const [tool, state] of this.states) {
      if (state.openedAt !== null && now - state.openedAt < this.cooldownMs()) open.push(tool)
    }
    return open
  }
}

/**
 * Wire the brake into the two host waterfalls.
 *
 * `tools/pre-execute` denies with a structured reason (the model reads it and
 * moves on, the turn continues) and `tools/post-execute` does the accounting.
 * Every listener body is guarded: an exception inside a monitor must never
 * become a tool failure.
 */
export function installFailureBrake(host: KeelwatchHost, config: FailureBrakeConfig): FailureBrake {
  const brake = new FailureBrake(config)

  host.on('tools/post-execute', async (exec: ToolExecutionLike, result: PostToolResultLike, next: () => Promise<unknown>) => {
    const decision = await next()
    try {
      brake.observe(exec.name, result?.isError === true)
    } catch (error) {
      host.logger?.warn(`keelwatch: post-execute accounting failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return decision
  })

  host.on('tools/pre-execute', async (exec: ToolExecutionLike, next: () => Promise<unknown>) => {
    try {
      const verdict = brake.check(exec.name)
      if (verdict.deny) {
        host.logger?.warn(`keelwatch: braked ${exec.name} (cooldown active)`)
        return {
          kind: 'deny',
          reason: verdict.reason,
          info: { name: 'KeelwatchBrake', code: 'TOOL_COOLED_DOWN' },
        }
      }
    } catch (error) {
      host.logger?.warn(`keelwatch: pre-execute check failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  })

  return brake
}
