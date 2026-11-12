/**
 * dsh-keelwatch — the operations layer for a DSH plugin ecosystem.
 *
 * Three jobs, all of them *after* installation: watch what installed bundles
 * declare against what upstream published (Drift Radar), stop a repeatedly
 * failing tool from being retried into a token fire (Failure Brake), and record
 * where tool time actually goes (Cost Attribution).
 *
 * Deliberately absent: timeouts (the host's `tool-call-timeout-policy` owns
 * them), repeat-call reminders (the host's `repeat-tool-reminder` owns them),
 * and any independent web UI.
 */
import type { Context } from '@deepseek-ai/cordis';
import { type Config as ConfigShape } from './config.js';
/** Cordis row name; short because it prefixes every log line. */
export declare const name = "keelwatch";
/**
 * Required services.
 *
 * `tools` is declared statically rather than reached through `ctx.inject` or
 * `ctx.get`: reading an un-injected service off a Cordis context throws
 * `cannot get property "tools" without inject`, and that throw silently cost
 * this plugin its only tool. Both services exist in every profile that can run
 * a tool at all.
 */
export declare const inject: string[];
export { Config } from './config.js';
export type { Config as KeelwatchConfig } from './config.js';
/**
 * Plugin entry point.
 *
 * Every branch is guarded and nothing here throws: a monitoring plugin that can
 * stop the host from booting is a net loss, so a broken configuration degrades
 * to "no monitoring" with one log line.
 */
export declare function apply(ctx: Context, config: ConfigShape): void;
