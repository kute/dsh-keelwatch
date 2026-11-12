/**
 * `keelwatch_report` — the one surface the model can drive.
 *
 * Reads are free; the single write (`action: 'disable'`) is explicit, requires
 * the exact bundle name, and reports `restart-required` truthfully. There is no
 * branch that disables something as a side effect of reporting.
 *
 * The rendering is bilingual by design: the numbers mean nothing without a
 * plain-language reading, and a report that only lists counters makes the reader
 * do the diagnosis. Every section therefore carries one English and one Chinese
 * sentence, and the whole report ends with a single conclusion.
 */
import type { CostAttributionConfig, DriftRadarConfig } from './config.js'
import type { CostLedger } from './cost-attribution.js'
import { formatTimingReport } from './cost-attribution.js'
import type { FailureBrake } from './failure-brake.js'
import type { KeelwatchHost } from './host.js'
import { disableBundle, readHealth, type HealthSnapshot } from './plugin-health.js'
import { scanDrift } from './drift-radar.js'
import { formatTokenUsage, type TokenAttribution, type TokenMeterLike, type TokenUsage } from './token-attribution.js'
import type { DriftReport } from './drift-radar.js'

export interface ReportDeps {
  readonly host: KeelwatchHost
  /** Tool registry handed over by the host; preferred over probing `host.tools`. */
  readonly registry?: unknown
  readonly driftConfig: DriftRadarConfig
  readonly costConfig: CostAttributionConfig
  readonly brake?: FailureBrake
  readonly ledger?: CostLedger
  readonly tokens?: TokenAttribution
}

/** One report section: raw data plus its bilingual reading. */
interface Section {
  readonly title: string
  readonly lines: readonly string[]
  readonly en: string
  readonly zh: string
}

function section(title: string, lines: readonly string[], en: string, zh: string): Section {
  return { title, lines, en, zh }
}

function heading(index: number, title: string): string {
  return `[${index}] ${title}`
}

async function bundlesSection(deps: ReportDeps): Promise<{ section: Section; problems: number }> {
  try {
    const health: HealthSnapshot = await readHealth(deps.host)
    if (!health.available) {
      return {
        problems: 0,
        section: section(
          'Bundles 插件包',
          ['bundle management unavailable in this profile 本 profile 未提供插件管理服务'],
          'This profile exposes no plugin manager, so bundle health cannot be read here.',
          '当前 profile 没有插件管理服务，读不到插件包健康状态。',
        ),
      }
    }
    if (health.problems.length === 0) {
      return {
        problems: 0,
        section: section(
          'Bundles 插件包',
          [`${health.scanned} bundle(s) tracked, no load errors 个插件包，无加载失败`],
          `All ${health.scanned} bundles loaded; nothing is silently missing.`,
          `${health.scanned} 个插件包全部加载成功，没有悄悄缺失的能力。`,
        ),
      }
    }
    const lines = [
      `${health.problems.length} of ${health.scanned} bundle(s) failed to load 个加载失败`,
      ...health.problems.map((problem) => `  - ${problem.bundle}: ${problem.detail}`),
    ]
    return {
      problems: health.problems.length,
      section: section(
        'Bundles 插件包',
        lines,
        'These bundles are selected but broken, so the capability they provide is missing. Turn them off to stop the noise, or fix and reinstall.',
        '这些包被选中但加载失败，它们提供的能力现在缺失。可以关掉止血，或修好后重装。',
      ),
    }
  } catch (error) {
    return {
      problems: 0,
      section: section(
        'Bundles 插件包',
        [`inventory failed 读取失败 (${error instanceof Error ? error.message : String(error)})`],
        'The inventory read threw; bundle health is unknown right now.',
        '读取插件清单时抛错，当前无法判断插件包健康状态。',
      ),
    }
  }
}

async function driftSection(deps: ReportDeps): Promise<{ section: Section; report: DriftReport | null }> {
  try {
    const report = await scanDrift(deps.driftConfig)
    const findings = report.findings
    if (findings.length === 0) {
      return {
        report,
        section: section(
          'Dependency drift 依赖漂移',
          [
            `${report.bundlesScanned} package(s) scanned, no findings 个包，无发现`,
            `alertLevel=${deps.driftConfig.alertLevel} · 告警级别`,
          ],
          'Every installed package still accepts the newest upstream release of what it depends on.',
          '所有已装包对上游最新版本仍然兼容，暂时没有"重装就会踩坑"的隐患。',
        ),
      }
    }
    const major = findings.filter((finding) => finding.level === 'major').length
    const lines = [
      `${report.bundlesScanned} package(s) scanned, ${findings.length} finding(s) 个包，${findings.length} 处发现`,
      `alertLevel=${deps.driftConfig.alertLevel} · 告警级别`,
      ...findings.flatMap((finding) =>
        finding.suggestion === undefined
          ? [`  - [${finding.level}] ${finding.message}`]
          : [`  - [${finding.level}] ${finding.message}`, `      → ${finding.suggestion}`],
      ),
    ]
    return {
      report,
      section: section(
        'Dependency drift 依赖漂移',
        lines,
        major > 0
          ? `${major} finding(s) are major: reinstalling or upgrading now can land an incompatible version. Pin the version or wait for the plugin to update.`
          : 'Nothing is broken today. The risk is deferred: the next reinstall or upgrade of these packages may pull a newer dependency than they were tested with.',
        major > 0
          ? `其中 ${major} 处是大版本漂移：现在重装或升级可能装到不兼容版本，建议先固定版本或等插件作者更新。`
          : '今天不会坏，风险是延后的：这些包下次重装或升级时，可能拉到比它测试过的新依赖。',
      ),
    }
  } catch (error) {
    return {
      report: null,
      section: section(
        'Dependency drift 依赖漂移',
        [`scan failed 扫描失败 (${error instanceof Error ? error.message : String(error)})`],
        'The scan could not run (registry unreachable or profile unreadable), so drift is unknown.',
        '扫描没能跑完（registry 不可达或 profile 读不到），本次无法判断漂移。',
      ),
    }
  }
}

function brakeSection(deps: ReportDeps): { section: Section; braking: boolean } {
  if (deps.brake === undefined) {
    return {
      braking: false,
      section: section(
        'Failure brake 失败刹车',
        ['disabled in configuration · 配置中未启用'],
        'Repeating failures are neither counted nor blocked; every retry still reaches the tool.',
        '未启用：连续失败既不统计也不拦截，模型每次重试都会真正打到工具。',
      ),
    }
  }
  const open = deps.brake.openTools()
  return {
    braking: open.length > 0,
    section: section(
      'Failure brake 失败刹车',
      open.length === 0
        ? ['enabled, nothing braking 已启用，当前无工具被刹车']
        : [`enabled, braking: ${open.join(', ')} · 正在刹车`],
      open.length === 0
        ? 'Armed and idle: no tool has failed enough times to be cooled down.'
        : 'These tools are cooling down: calls are refused with a structured reason so the model stops retrying and the turn continues.',
      open.length === 0
        ? '已武装但空闲：还没有工具连续失败到需要冷却。'
        : '这些工具正处于冷却：调用会被结构化拒绝，模型收到明确原因后停止重试，轮次不会中断。',
    ),
  }
}

function timingSection(deps: ReportDeps): Section {
  if (deps.ledger === undefined) {
    return section(
      'Tool time 工具耗时',
      ['not recorded (cost attribution disabled) · 未记录（成本归因已关闭）'],
      'Timing is off, so no per-tool latency is available.',
      '计时功能关闭，没有按工具的耗时数据。',
    )
  }
  const rows = deps.ledger.top(deps.costConfig.topN)
  if (rows.length === 0) {
    return section(
      'Tool time 工具耗时',
      ['no tool calls since the plugin started · 插件启动后尚无工具调用'],
      'Nothing has been timed yet in this process.',
      '本进程启动后还没有工具调用被计时。',
    )
  }
  const slowest = rows[0]
  return section(
    'Tool time 工具耗时',
    formatTimingReport(deps.ledger, deps.costConfig.topN).split('\n'),
    slowest === undefined
      ? 'Timing recorded.'
      : `Slowest total time: ${slowest.tool} (${slowest.totalMs}ms across ${slowest.calls} call(s), p95 ${slowest.p95Ms}ms). High p95 with many calls points at a tool that stalls, not one that is merely used often.`,
    slowest === undefined
      ? '已记录耗时。'
      : `累计耗时最高的是 ${slowest.tool}（${slowest.calls} 次共 ${slowest.totalMs}ms，p95 ${slowest.p95Ms}ms）。调用次数不多但 p95 很高，说明它是"会卡"，而不是"用得多"。`,
  )
}

function tokenSection(deps: ReportDeps): Section {
  if (deps.tokens === undefined) {
    return section(
      'Tokens 上下文成本',
      ['not recorded (cost attribution disabled) · 未记录（成本归因已关闭）'],
      'Token attribution is off.',
      'Token 归因已关闭。',
    )
  }
  let meter: TokenMeterLike | null = null
  try {
    const candidate = deps.host.reflect?.get('tokenMeter')
    if (typeof candidate === 'object' && candidate !== null && typeof (candidate as TokenMeterLike).measure === 'function') {
      meter = candidate as TokenMeterLike
    }
  } catch {
    meter = null
  }
  if (meter === null) {
    return section(
      'Tokens 上下文成本',
      ['host exposes no token meter · 宿主未提供 token 计量服务'],
      'This host has no token meter, so context cost cannot be measured.',
      '宿主没有提供 token 计量服务，无法测量上下文成本。',
    )
  }
  const usages: TokenUsage[] = deps.tokens.measure(meter, deps.costConfig.topN)
  if (usages.length === 0) {
    return section(
      'Tokens 上下文成本',
      ['no requests observed since the plugin started · 插件启动后尚未观察到请求'],
      'Nothing observed yet; attribution starts with the next request in this process.',
      '还没有观察到请求；本进程的下一次请求开始才会有归因数据。',
    )
  }
  const top = usages[0]
  const lines = formatTokenUsage(usages, deps.costConfig.topN).split('\n')

  // Drill-down: which individual blocks are expensive, and what are they.
  try {
    const expensive = deps.tokens.topMessages(meter, Math.min(5, deps.costConfig.topN))
    if (expensive.length > 0) {
      lines.push('    most expensive messages 最贵的消息:')
      for (const message of expensive) {
        const preview = message.preview === '' ? '(no preview) 无预览' : message.preview
        lines.push(`      - [${message.kind}] ${message.tokens} tok · seq ${message.seq} · ${preview}`)
      }
    }
  } catch {
    // A drill-down failure must not hide the per-kind table above it.
  }

  return section(
    'Tokens 上下文成本',
    lines,
    top === undefined
      ? 'Measured per source kind, with the most expensive individual messages listed.'
      : `${top.surfaceTokens} tokens are on the surface right now (what the next request pays); ${top.unknownTokens} of them predate keelwatch and cannot be attributed. The named kinds are what the model actually reads: tool results, its own earlier messages, and context injected by plugins.`,
    top === undefined
      ? '已按来源统计，并列出最贵的单条消息。'
      : `当前表层 ${top.surfaceTokens} token（= 下一次请求要付的上下文成本）；其中 ${top.unknownTokens} 产生于 keelwatch 加载之前，无法归因。列出的来源就是模型真正读到的内容：工具结果、它自己之前的消息、以及插件注入的上下文。`,
  )
}

/**
 * One conclusion for the whole report, derived from what was actually measured.
 *
 * Deliberately singular: a reader who has to weigh five recommendations stops
 * reading. Order of importance: broken bundles, major drift, then noise.
 */
function conclude(input: { problems: number; drift: DriftReport | null; braking: boolean }): Section {
  const major = input.drift?.findings.filter((finding) => finding.level === 'major').length ?? 0
  const engine = input.drift?.findings.filter((finding) => finding.kind === 'engine-incompatible').length ?? 0
  const minorOnly = (input.drift?.findings.length ?? 0) > 0 && major === 0

  if (input.problems > 0) {
    return section(
      'Conclusion 结论',
      [`${input.problems} bundle(s) failed to load · 个插件包加载失败`],
      'Act on the broken bundles first: they are selected but provide nothing. Disable them (keelwatch_report action "disable") or reinstall, then restart.',
      '优先处理加载失败的插件包：它们被选中但没提供任何能力。可以先用工具把它关掉，或重装修复，然后重启。',
    )
  }
  if (engine > 0) {
    return section(
      'Conclusion 结论',
      [`${engine} bundle(s) declare an incompatible DSH engine range · 个插件声明的 DSH 版本范围不兼容`],
      'A bundle declares engines.dsh that the running DSH does not satisfy; the launcher will refuse it on the next install or start. Update the plugin or widen its engine range.',
      '有插件声明的 engines.dsh 与当前运行的 DSH 不匹配，下次安装或启动会被拒绝。请升级插件或放宽其版本范围。',
    )
  }
  if (major > 0) {
    return section(
      'Conclusion 结论',
      [`${major} major drift(s) · 处大版本漂移`],
      'Nothing is broken now, but reinstalling or upgrading can pull an incompatible dependency. Pin the versions listed above before the next upgrade.',
      '现在没坏，但重装或升级可能拉到不兼容依赖。下次升级前先把上面列出的版本固定住。',
    )
  }
  if (minorOnly) {
    return section(
      'Conclusion 结论',
      ['only minor drift, nothing to fix today · 仅有小版本漂移，今天无需处理'],
      'No action needed. Keep it in mind: the next reinstall of those packages will pick the newer dependency they were not tested against.',
      '无需处理。记一笔即可：这些包下次重装会拿到它们没测试过的新依赖。',
    )
  }
  return section(
    'Conclusion 结论',
    [input.braking ? 'brake active · 刹车生效中' : 'all checks clean · 各项检查正常'],
    input.braking
      ? 'Everything loaded and nothing drifted; the brake is the only active mechanism. Check the braking list above if a tool seems unavailable.'
      : 'No broken bundles, no drift, nothing braking. Nothing to do.',
    input.braking
      ? '加载正常、没有漂移；当前只有刹车在起作用。如果某个工具突然不可用，看上面"正在刹车"的列表。'
      : '没有加载失败、没有漂移、没有工具被刹车。不需要做任何事。',
  )
}

function render(sections: readonly Section[]): string {
  const blocks: string[] = ['keelwatch status report · keelwatch 状态报告', '='.repeat(44)]
  sections.forEach((item, index) => {
    blocks.push('')
    blocks.push(heading(index + 1, item.title))
    for (const line of item.lines) blocks.push(`    ${line}`)
    blocks.push(`    EN: ${item.en}`)
    blocks.push(`    ZH: ${item.zh}`)
  })
  return blocks.join('\n')
}

/**
 * Build the status text.
 *
 * Every section is independently guarded: a failed registry lookup must not hide
 * the bundle inventory that explains why the session started broken.
 */
export async function buildStatusReport(deps: ReportDeps): Promise<string> {
  const bundles = await bundlesSection(deps)
  const drift = await driftSection(deps)
  const brake = brakeSection(deps)
  const timing = timingSection(deps)
  const tokens = tokenSection(deps)
  const conclusion = conclude({ problems: bundles.problems, drift: drift.report, braking: brake.braking })

  return render([bundles.section, drift.section, brake.section, timing, tokens, conclusion])
}

/** Register the tool when the profile exposes a tool registry. */
export function registerReportTool(deps: ReportDeps): boolean {
  const registry = resolveRegistry(deps)
  if (registry === null) {
    deps.host.logger?.warn('keelwatch: no tool registry available; keelwatch_report stays unregistered')
    return false
  }

  // Built by hand instead of through `defineTool`: that helper lives in
  // `@deepseek-ai/dsh-tools`, which is a host-internal package that pnpm cannot
  // resolve at install time (it publishes only prereleases), so depending on it
  // made `dsh plugin add <git url>` fail outright. The definition below is the
  // same shape the host validates: JSON Schema parameters plus a canonical
  // output declaration.
  const tool = {
    name: 'keelwatch_report',
    description:
      'Report DSH plugin ecosystem health: bundles that failed to load, dependency drift, the failure brake state, ' +
      'per-tool latency, and token cost per source. Returns a bilingual (EN/ZH) reading for every section plus one ' +
      'conclusion. Use action "disable" with an exact bundle name only when the user asks to turn a broken bundle off.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Either "status" (default) or "disable".' },
        bundle: { type: 'string', description: 'Exact bundle name to disable; required when action is "disable".' },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: unknown) {
      const input = (args ?? {}) as { action?: unknown; bundle?: unknown }
      const action = typeof input.action === 'string' && input.action !== '' ? input.action : 'status'

      if (action === 'disable') {
        if (typeof input.bundle !== 'string' || input.bundle.trim() === '') {
          return 'keelwatch: action "disable" needs a bundle name, for example { "action": "disable", "bundle": "@kutebai/dsh-keelwatch" }'
        }
        const outcome = await disableBundle(deps.host, input.bundle.trim())
        return `keelwatch: ${outcome.message}`
      }

      if (action !== 'status') {
        return `keelwatch: unknown action "${action}"; use "status" or "disable"`
      }
      return buildStatusReport(deps)
    },
  }

  try {
    registry.register(tool)
    return true
  } catch (error) {
    deps.host.logger?.warn(`keelwatch: report tool not registered: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Find a tool registry.
 *
 * `ctx.tools` only exists once the `tools` service is injected/mixed in, so a
 * plugin that merely listens to events cannot assume it. `ctx.reflect.get` reads
 * a service without the injection requirement, which is why it is tried too.
 */
function resolveRegistry(deps: ReportDeps): { register(tool: unknown): unknown } | null {
  const candidates: unknown[] = [deps.registry]
  // Every read goes through a guarded lookup: a Cordis context throws when an
  // un-injected service is read as a property, and that throw used to escape
  // here and silently disable the tool.
  try {
    candidates.push(deps.host.reflect?.get('tools'))
  } catch {
    // Normal on hosts without a reflect layer.
  }
  try {
    candidates.push(typeof deps.host.get === 'function' ? deps.host.get('tools') : undefined)
  } catch {
    // Same story for `ctx.get` on a context that does not expose it.
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const registry = candidate as { register?: unknown }
    if (typeof registry.register === 'function') return registry as { register(tool: unknown): unknown }
  }
  return null
}
