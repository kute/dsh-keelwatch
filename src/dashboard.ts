/**
 * Opt-in dashboard: one page, served by the host webserver, no client plugin.
 *
 * Deliberately not a client-half slot: a dashboard that needs its own React
 * bundle inside the Plugins page couples this package to the Web client's module
 * table. A plain HTML page served from the same origin works in any browser,
 * works when the client bundle fails to load, and can be switched off with one
 * config key — which is the whole point of `dashboard.enabled`.
 *
 * Data comes from the same services the report tool uses, so the page and the
 * chat report can never disagree.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CostAttributionConfig, DriftRadarConfig, FailureBrakeConfig } from './config.js'
import type { CostLedger } from './cost-attribution.js'
import type { FailureBrake } from './failure-brake.js'
import type { HistoryEntry, HistoryLog } from './history.js'
import { expectedGuiToken, isAllowedRequest, type KeelwatchHost } from './host.js'
import { readHealth, type HealthSnapshot } from './plugin-health.js'
import { scanDrift } from './drift-radar.js'
import type { TokenAttribution } from './token-attribution.js'

export interface DashboardDeps {
  readonly host: KeelwatchHost
  /** Injected webserver; falls back to `ctx.reflect` when omitted. */
  readonly webServer?: unknown
  readonly history?: HistoryLog
  readonly brake?: FailureBrake
  readonly ledger?: CostLedger
  readonly tokens?: TokenAttribution
  readonly driftConfig: DriftRadarConfig
  readonly brakeConfig: FailureBrakeConfig
  readonly costConfig: CostAttributionConfig
  readonly refreshSeconds: number
  readonly documentPath?: string
}

interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

export interface StatusPayload {
  readonly generatedAt: number
  readonly bundles: { available: boolean; scanned: number; problems: readonly { bundle: string; detail: string }[] }
  readonly drift: {
    scanned: number
    alertLevel: string
    findings: readonly { packageName: string; kind: string; level: string; message: string; suggestion?: string }[]
    skipped: number
  }
  readonly brake: { enabled: boolean; action: string; braking: readonly string[]; configuredErrors: number; cooldownMinutes: number }
  readonly timing: readonly { tool: string; calls: number; errors: number; totalMs: number; p95Ms: number }[]
  readonly tokens: readonly {
    session: string
    surfaceTokens: number
    totalTokens: number
    byKind: Readonly<Record<string, number>>
    unknownTokens: number
  }[]
  readonly expensive: readonly { kind: string; tokens: number; seq: number; preview: string }[]
  readonly history: readonly HistoryEntry[]
  /** Entries per day for the last week, oldest first. */
  readonly trend: readonly { date: string; ok: number; info: number; warn: number; error: number }[]
  readonly refreshSeconds: number
  readonly documentPath: string | null
}

function resolve<T>(host: KeelwatchHost, service: string): T | null {
  try {
    const found = host.reflect?.get(service)
    if (typeof found === 'object' && found !== null) return found as T
  } catch {
    // Absent services are a normal profile difference.
  }
  return null
}

/**
 * Collect everything the page shows.
 *
 * Each block degrades on its own: a registry outage must not blank the bundle
 * list that explains why a capability is missing.
 */
export async function collectStatus(deps: DashboardDeps): Promise<StatusPayload> {
  let bundles: HealthSnapshot = { available: false, scanned: 0, problems: [] }
  try {
    bundles = await readHealth(deps.host)
  } catch {
    // Keep the empty snapshot.
  }

  let drift: StatusPayload['drift'] = { scanned: 0, alertLevel: deps.driftConfig.alertLevel, findings: [], skipped: 0 }
  try {
    const report = await scanDrift(deps.driftConfig)
    drift = {
      scanned: report.bundlesScanned,
      alertLevel: deps.driftConfig.alertLevel,
      findings: report.findings.map((finding) => ({
        packageName: finding.packageName,
        kind: finding.kind,
        level: finding.level,
        message: finding.message,
        ...(finding.suggestion === undefined ? {} : { suggestion: finding.suggestion }),
      })),
      skipped: report.skipped.length,
    }
  } catch {
    // Registry unreachable: the section shows zero scanned, which reads as unknown.
  }

  const timing =
    deps.ledger === undefined
      ? []
      : deps.ledger.top(deps.costConfig.topN).map((row) => ({
          tool: row.tool,
          calls: row.calls,
          errors: row.errors,
          totalMs: row.totalMs,
          p95Ms: row.p95Ms,
        }))

  let tokens: StatusPayload['tokens'] = []
  let expensive: StatusPayload['expensive'] = []
  if (deps.tokens !== undefined) {
    const meter = resolve<{ measure(session: unknown): unknown }>(deps.host, 'tokenMeter')
    if (meter !== null && typeof meter.measure === 'function') {
      const usages = deps.tokens.measure(meter as never, 5)
      tokens = usages.map((usage) => ({
        session: usage.session,
        surfaceTokens: usage.surfaceTokens,
        totalTokens: usage.totalTokens,
        byKind: usage.byKind,
        unknownTokens: usage.unknownTokens,
      }))
      expensive = deps.tokens
        .topMessages(meter as never, 5)
        .map((message) => ({ kind: message.kind, tokens: message.tokens, seq: message.seq, preview: message.preview }))
    }
  }

  let history: HistoryEntry[] = []
  let trend: StatusPayload['trend'] = []
  if (deps.history !== undefined) {
    try {
      history = await deps.history.read(12)
      // The trend needs a whole week, not the dozen rows the page lists.
      trend = buildTrend(await deps.history.read(500))
    } catch {
      history = []
      trend = []
    }
  }

  return {
    generatedAt: Date.now(),
    bundles: {
      available: bundles.available,
      scanned: bundles.scanned,
      problems: bundles.problems.map((problem) => ({ bundle: problem.bundle, detail: problem.detail })),
    },
    drift,
    brake: {
      enabled: deps.brakeConfig.enabled,
      action: deps.brakeConfig.action,
      braking: deps.brake === undefined ? [] : deps.brake.openTools(),
      configuredErrors: deps.brakeConfig.maxConsecutiveErrors,
      cooldownMinutes: deps.brakeConfig.cooldownMinutes,
    },
    timing,
    tokens,
    expensive,
    history,
    trend,
    refreshSeconds: deps.refreshSeconds,
    documentPath: deps.documentPath ?? null,
  }
}

/**
 * Sample payload for documentation screenshots (`?demo=1`).
 *
 * Deliberately synthetic: a real dashboard shows real conversation text, and a
 * README image must not leak whoever took it. The page labels itself as sample
 * data so the distinction is visible.
 */
const DEMO_STATUS: StatusPayload & { demo: true } = {
  generatedAt: Date.now(),
  bundles: { available: true, scanned: 29, problems: [
    { bundle: '@acme/dsh-sidebar', detail: 'incompatible-version: engines.dsh rejects 0.2.1-rc.5' },
  ] },
  drift: { scanned: 19, alertLevel: 'all', skipped: 1, findings: [
    { packageName: 'dsh-example-toolkit', kind: 'dependency-drift', level: 'major', message: 'dsh-example-toolkit pins @deepseek-ai/cordis "^3.0.0" but upstream latest is 4.1.0 (major)' },
    { packageName: '@acme/dsh-sidebar', kind: 'dependency-drift', level: 'minor', message: '@acme/dsh-sidebar pins @deepseek-ai/schemastery "3.18.4" but upstream latest is 3.19.0 (minor)' },
  ] },
  brake: { enabled: true, action: 'brake', braking: ['web_search'], configuredErrors: 3, cooldownMinutes: 5 },
  timing: [
    { tool: 'keelwatch_report', calls: 3, errors: 0, totalMs: 1140, p95Ms: 620 },
    { tool: 'bash', calls: 42, errors: 4, totalMs: 9860, p95Ms: 480 },
    { tool: 'web_search', calls: 9, errors: 6, totalMs: 7420, p95Ms: 1900 },
    { tool: 'read', calls: 71, errors: 1, totalMs: 2130, p95Ms: 46 },
  ],
  tokens: [
    { session: 'session-demo', surfaceTokens: 41280, totalTokens: 91040,
      byKind: { 'system-prompt': 18400, tool: 9100, model: 5600, 'plugin:memory': 4100, user: 1200 },
      unknownTokens: 2880 },
  ],
  expensive: [
    { kind: 'system-prompt', tokens: 18400, seq: 3, preview: 'You are a coding agent working in a repository. Follow the project conventions…' },
    { kind: 'tool', tokens: 9100, seq: 128, preview: 'keelwatch: drift scan over 19 bundle(s): 2 finding(s)' },
    { kind: 'plugin:memory', tokens: 4100, seq: 96, preview: 'Relevant memory from previous sessions: …' },
  ],
  history: [
    { at: Date.now() - 60000, kind: 'bundle', level: 'error', zh: '插件包检查：29 个包里有 1 个加载失败（@acme/dsh-sidebar）。', en: 'Bundle check: 1 of 29 bundles failed to load (@acme/dsh-sidebar).' },
    { at: Date.now() - 90000, kind: 'drift', level: 'warn', zh: '依赖漂移扫描：19 个包中发现 2 处，其中 1 处为大版本。', en: 'Drift scan: 2 finding(s) across 19 packages, 1 major.' },
    { at: Date.now() - 3600000, kind: 'drift', level: 'ok', zh: '依赖漂移扫描：19 个包，没有超出「major」级别的漂移。', en: 'Drift scan: 19 packages scanned, nothing drifted past the "major" level.' },
  ],
  refreshSeconds: 30,
  documentPath: '~/.dsh/profiles/web/cordis.patch.yml',
  trend: [
    { date: '…-06', ok: 2, info: 1, warn: 0, error: 0 },
    { date: '…-07', ok: 2, info: 2, warn: 1, error: 0 },
    { date: '…-08', ok: 2, info: 1, warn: 0, error: 1 },
    { date: '…-09', ok: 3, info: 1, warn: 0, error: 0 },
    { date: '…-10', ok: 2, info: 2, warn: 1, error: 0 },
    { date: '…-11', ok: 2, info: 2, warn: 1, error: 1 },
    { date: '…-12', ok: 2, info: 2, warn: 1, error: 1 },
  ],
  demo: true,
}

/** Serialised once, injected into the page so `?demo=1` renders sample data. */
const DEMO_JSON = JSON.stringify(DEMO_STATUS).replace(/</g, '\\u003c')

/**
 * Count entries per calendar day for the last seven days.
 *
 * Days with no detection are kept as zeros: a gap in a health chart is
 * information ("nothing ran") and dropping the row would hide it.
 */
export function buildTrend(entries: readonly HistoryEntry[], days = 7, now = Date.now()): StatusPayload['trend'] {
  const buckets = new Map<string, { ok: number; info: number; warn: number; error: number }>()
  const order: string[] = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now - offset * 86_400_000).toISOString().slice(0, 10)
    buckets.set(date, { ok: 0, info: 0, warn: 0, error: 0 })
    order.push(date)
  }
  for (const entry of entries) {
    const date = new Date(entry.at).toISOString().slice(0, 10)
    const bucket = buckets.get(date)
    if (bucket === undefined) continue
    bucket[entry.level] += 1
  }
  return order.map((date) => ({ date, ...(buckets.get(date) ?? { ok: 0, info: 0, warn: 0, error: 0 }) }))
}

const PAGE = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>keelwatch · 插件运维面板</title>
<style>
  :root { color-scheme: light dark; --fg: #1b1b1b; --bg: #fbfaf8; --card: #ffffff; --line: #e3e0da; --muted: #6b6b6b; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e8e6e1; --bg: #16150f; --card: #1f1e17; --line: #34322a; --muted: #9a978d; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 28px 24px 48px; background: var(--bg); color: var(--fg);
         font: 13px/1.55 -apple-system, "Helvetica Neue", "PingFang SC", sans-serif; }
  header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
  h1 { font-size: 17px; font-weight: 600; margin: 0; }
  .meta { color: var(--muted); font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  h2 { font-size: 13px; font-weight: 600; margin: 0 0 10px; display: flex; justify-content: space-between; gap: 8px; }
  h2 span { font-weight: 400; color: var(--muted); font-size: 11px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 4px 6px 4px 0; vertical-align: top; }
  th { color: var(--muted); font-weight: 500; border-bottom: 1px solid var(--line); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .ok { color: #2f7d4f; } .warn { color: #b07a12; } .error { color: #c0483a; } .info { color: var(--muted); }
  .empty { color: var(--muted); font-size: 12px; }
  .bar { height: 4px; background: var(--line); border-radius: 3px; overflow: hidden; margin-top: 3px; }
  .bar > i { display: block; height: 100%; background: currentColor; opacity: .55; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
  footer { margin-top: 20px; color: var(--muted); font-size: 11px; }
</style>
</head>
<body>
<header>
  <h1>keelwatch 插件运维面板</h1>
  <div class="meta" id="meta">loading…</div>
</header>
<div class="grid">
  <section><h2>插件包 Bundles <span id="b-sub"></span></h2><div id="b-body"></div></section>
  <section><h2>依赖漂移 Drift <span id="d-sub"></span></h2><div id="d-body"></div></section>
  <section><h2>失败刹车 Brake <span id="k-sub"></span></h2><div id="k-body"></div></section>
  <section><h2>工具耗时 Tool time <span id="t-sub"></span></h2><div id="t-body"></div></section>
  <section><h2>Token 来源 Token cost <span id="m-sub"></span></h2><div id="m-body"></div></section>
  <section><h2>最贵消息 Expensive <span id="e-sub"></span></h2><div id="e-body"></div></section>
  <section><h2>近 7 天 Trend <span id="r-sub"></span></h2><div id="r-body"></div></section>
  <section style="grid-column: 1 / -1;"><h2>最近检测 History <span id="h-sub"></span></h2><div id="h-body"></div></section>
</div>
<footer id="foot"></footer>
<script>
const params = new URLSearchParams(location.search);
const token = params.get('token') || '';
const q = token ? ('?token=' + encodeURIComponent(token)) : '';
const demo = params.get('demo') === '1';

const SAMPLE = __KEELWATCH_SAMPLE__;

function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function table(headers, rows) {
  const t = el('table');
  const head = el('tr');
  for (const h of headers) head.appendChild(el('th', h));
  t.appendChild(head);
  for (const row of rows) {
    const tr = el('tr');
    for (const cell of row) {
      if (cell && typeof cell === 'object') { tr.appendChild(cell); continue; }
      tr.appendChild(el('td', String(cell)));
    }
    t.appendChild(tr);
  }
  return t;
}
function empty(text) { const d = el('div', text, 'empty'); return d; }
function num(value, cls) { return el('td', value, 'num ' + (cls || '')); }

function render(data) {
  document.getElementById('meta').textContent =
    '更新于 ' + new Date(data.generatedAt).toLocaleTimeString() +
    ' · 每 ' + data.refreshSeconds + 's 自动刷新' +
    (data.documentPath ? ' · ' + data.documentPath : '');

  const bSub = document.getElementById('b-sub');
  const bBody = document.getElementById('b-body');
  bBody.replaceChildren();
  if (!data.bundles.available) {
    bSub.textContent = '不可用 unavailable';
    bBody.appendChild(empty('当前 profile 未提供插件管理服务'));
  } else if (data.bundles.problems.length === 0) {
    bSub.textContent = data.bundles.scanned + ' 个 · 正常';
    bSub.className = 'ok';
    bBody.appendChild(empty('全部加载成功，没有悄悄缺失的能力'));
  } else {
    bSub.textContent = data.bundles.problems.length + ' / ' + data.bundles.scanned + ' 失败';
    bSub.className = 'error';
    bBody.appendChild(table(['包', '错误'], data.bundles.problems.map((p) => [p.bundle, p.detail])));
  }

  const d = data.drift;
  document.getElementById('d-sub').textContent = d.scanned + ' 个包 · ' + d.findings.length + ' 处 · level=' + d.alertLevel;
  document.getElementById('d-sub').className = d.findings.length === 0 ? 'ok' : 'warn';
  const dBody = document.getElementById('d-body');
  dBody.replaceChildren();
  dBody.appendChild(d.findings.length === 0
    ? empty('没有超出告警级别的漂移')
    : table(['级别', '包', '说明 / 建议'], d.findings.map((f) => {
        const level = el('td', f.level, f.level === 'major' ? 'error' : 'warn');
        const detail = el('td', f.message);
        if (f.suggestion) detail.appendChild(el('div', '→ ' + f.suggestion, 'empty'));
        return [level, f.packageName, detail];
      })));
  if (d.skipped > 0) dBody.appendChild(el('div', '另有 ' + d.skipped + ' 项未能判断（离线或声明无法解析）', 'empty'));

  const k = data.brake;
  document.getElementById('k-sub').textContent = k.enabled ? ('已启用 · ' + k.action) : '未启用';
  document.getElementById('k-sub').className = k.enabled ? 'warn' : 'info';
  const kBody = document.getElementById('k-body');
  kBody.replaceChildren(empty(
    k.enabled
      ? ('连续失败 ' + k.configuredErrors + ' 次后冷却 ' + k.cooldownMinutes + ' 分钟 · 当前刹车中：' + (k.braking.length ? k.braking.join(', ') : '无'))
      : '连续失败只记录、不拦截；在插件配置里启用后生效'));

  const t = data.timing;
  document.getElementById('t-sub').textContent = t.length + ' 个工具';
  const tBody = document.getElementById('t-body');
  tBody.replaceChildren(t.length === 0
    ? empty('本进程启动后还没有工具调用')
    : table(['工具', '次数', '错误', '累计 ms', 'p95 ms'],
        t.map((row) => [row.tool, num(row.calls), num(row.errors), num(row.totalMs), num(row.p95Ms)])));

  const m = data.tokens;
  document.getElementById('m-sub').textContent = m.length + ' 个会话';
  const mBody = document.getElementById('m-body');
  mBody.replaceChildren(m.length === 0
    ? empty('还没有观察到请求')
    : table(['会话', '表层', '总量', '来源'],
        m.map((row) => {
          const kinds = Object.entries(row.byKind).sort((a, b) => b[1] - a[1])
            .map(([kind, tokens]) => kind + ' ' + tokens).join(' · ') || '—';
          return [row.session, num(row.surfaceTokens), num(row.totalTokens), kinds + (row.unknownTokens ? ' · 未归因 ' + row.unknownTokens : '')];
        })));

  const e = data.expensive;
  document.getElementById('e-sub').textContent = e.length + ' 条';
  const eBody = document.getElementById('e-body');
  eBody.replaceChildren(e.length === 0
    ? empty('没有可识别的消息（插件启动前的历史无法归因）')
    : table(['来源', 'tok', '内容'], e.map((row) => [row.kind, num(row.tokens), row.preview || '（无预览）'])));

  const trend = data.trend || [];
  document.getElementById('r-sub').textContent = trend.length + ' 天';
  const rBody = document.getElementById('r-body');
  if (trend.length === 0) {
    rBody.replaceChildren(empty('还没有足够的历史'));
  } else {
    // Stacked columns: one bar per day, height by total, segments by level.
    const peak = Math.max(1, ...trend.map((d) => d.ok + d.info + d.warn + d.error));
    const chart = el('div');
    chart.style.cssText = 'display:flex;align-items:flex-end;gap:10px;height:120px;padding:4px 0 0;';
    const legend = el('div', undefined, 'empty');
    legend.style.cssText = 'display:flex;gap:12px;margin-top:8px;font-size:11px;';
    const colorOf = { ok: '#2f7d4f', info: '#7a8798', warn: '#b07a12', error: '#c0483a' };
    const labelOf = { ok: '正常', info: '提示', warn: '注意', error: '故障' };

    for (const day of trend) {
      const total = day.ok + day.info + day.warn + day.error;
      const column = el('div');
      column.style.cssText = 'flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%;justify-content:flex-end;';
      column.title = day.date + ' · ' + total + ' 条（正常 ' + day.ok + '，提示 ' + day.info + '，注意 ' + day.warn + '，故障 ' + day.error + '）';

      const stack = el('div');
      stack.style.cssText = 'width:100%;max-width:34px;display:flex;flex-direction:column-reverse;height:' +
        Math.max(2, Math.round((total / peak) * 96)) + 'px;border-radius:3px;overflow:hidden;background:transparent;';
      for (const level of ['ok', 'info', 'warn', 'error']) {
        if (day[level] === 0) continue;
        const segment = el('div');
        segment.style.cssText = 'flex:' + day[level] + ';background:' + colorOf[level] + ';opacity:.8;';
        stack.appendChild(segment);
      }
      if (total === 0) {
        const flat = el('div');
        flat.style.cssText = 'height:2px;width:100%;background:var(--line);';
        stack.appendChild(flat);
      }
      column.appendChild(stack);
      column.appendChild(el('div', day.date.slice(5), 'empty'));
      column.appendChild(el('div', String(total), 'empty'));
      chart.appendChild(column);
    }

    for (const level of ['ok', 'info', 'warn', 'error']) {
      const item = el('span');
      const dot = el('span');
      dot.style.cssText = 'display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px;background:' + colorOf[level];
      item.appendChild(dot);
      item.appendChild(el('span', labelOf[level]));
      legend.appendChild(item);
    }

    rBody.replaceChildren(chart, legend);
  }

  const h = data.history;
  document.getElementById('h-sub').textContent = h.length + ' 条';
  const hBody = document.getElementById('h-body');
  hBody.replaceChildren(h.length === 0
    ? empty('还没有检测记录')
    : table(['时间', '级别', '内容'], h.map((row) => [
        new Date(row.at).toLocaleString(),
        el('td', row.level, row.level === 'error' ? 'error' : row.level === 'warn' ? 'warn' : 'info'),
        row.zh + ' / ' + row.en,
      ])));

  document.getElementById('foot').textContent =
    '本页由 @kutebai/dsh-keelwatch 提供，可用配置项 dashboard.enabled 关闭。';
}

async function refresh() {
  if (demo) {
    render(SAMPLE);
    document.getElementById('meta').textContent = '示例数据 sample data · 布局演示，非真实会话';
    return;
  }
  try {
    const response = await fetch('/keelwatch/status' + q, { headers: { accept: 'application/json' } });
    const payload = await response.json();
    if (payload && payload.ok) {
      render(payload.status);
      const wait = Math.max(10, payload.status.refreshSeconds || 30) * 1000;
      setTimeout(refresh, wait);
      return;
    }
    document.getElementById('meta').textContent = '读取失败：' + (payload && payload.reason ? payload.reason : 'unknown');
  } catch (error) {
    document.getElementById('meta').textContent = '读取失败：' + error.message;
  }
  setTimeout(refresh, 30000);
}
refresh();
</script>
</body>
</html>`

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Register both routes.
 *
 * Returns false when the profile has no webserver — a headless profile simply
 * has no dashboard, which is not an error.
 */
export function registerDashboard(deps: DashboardDeps): boolean {
  const injected = deps.webServer
  const webServer =
    typeof injected === 'object' && injected !== null ? (injected as WebServerLike) : resolve<WebServerLike>(deps.host, 'webServer')
  if (webServer === null || typeof webServer.register !== 'function') {
    deps.host.logger?.warn('keelwatch: dashboard unavailable (no webserver in this profile)')
    return false
  }

  // The GUI's own /api fence does not cover a custom path, so the page and the
  // status endpoint check the advertised token themselves. Without this any
  // local process could read session token costs and message previews.
  const expected = expectedGuiToken(deps.host)
  if (expected === null) {
    deps.host.logger?.info?.('keelwatch: dashboard guarded by same-origin check')
  }
  const authorized = (req: IncomingMessage): boolean =>
    isAllowedRequest({ url: req.url, headers: req.headers as Record<string, unknown> }, expected)

  const disposers: (() => void)[] = []

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: '/keelwatch/dashboard',
      handler(req, res) {
        if (!authorized(req)) {
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('unauthorized: open the dashboard with the GUI token (?token=...)')
          return
        }
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('GET only')
          return
        }
        const page = PAGE.replace('__KEELWATCH_SAMPLE__', DEMO_JSON)
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(page),
        })
        res.end(page)
      },
    }),
  )

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: '/keelwatch/status',
      async handler(req, res) {
        if (!authorized(req)) return sendJson(res, 401, { ok: false, reason: 'unauthorized' })
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, reason: 'GET only' })
        try {
          return sendJson(res, 200, { ok: true, status: await collectStatus(deps) })
        } catch (error) {
          return sendJson(res, 500, { ok: false, reason: error instanceof Error ? error.message : String(error) })
        }
      },
    }),
  )

  deps.host.effect?.(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // The server may already be down during shutdown.
      }
    }
  })
  deps.host.logger?.info?.('keelwatch: dashboard served at /keelwatch/dashboard')
  return true
}
