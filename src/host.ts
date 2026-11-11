/**
 * Host surface, isolated in its own module.
 *
 * These interfaces are structural on purpose: the DSH release candidates move
 * the concrete package types between minors, while the *shapes* documented in
 * `docs/subsystems/tools.zh.md` are the contract a plugin may rely on.
 */

export interface WarnSink {
  warn(message: string): void
  info?(message: string): void
}

export interface ToolExecutionLike {
  readonly name: string
  readonly callId?: string
}

export interface PostToolResultLike {
  readonly isError?: boolean
}

/** The around-dispatch waterfall result; opaque to this plugin. */
export type ToolResultLike = unknown

/** A `PreToolDecision` the brake may return. */
export interface PreToolDeny {
  readonly kind: 'deny'
  readonly reason: string
  readonly info?: { readonly name: string; readonly code: string }
}

export type PreToolDecisionLike = PreToolDeny | { readonly kind: 'allow' } | { readonly kind: 'cancel' }

export interface KeelwatchHost {
  readonly logger?: WarnSink
  /** Provided by `@deepseek-ai/cordis-plugin-timer`; dies with the fiber. */
  readonly timer?: { interval(callback: () => void, delay: number): unknown }
  /** Register a waterfall listener; the host owns its disposal. */
  on(event: string, listener: (...args: any[]) => unknown): unknown
}
