/**
 * Browser half: the keelwatch configuration page inside Plugins → bundle page.
 *
 * Hand-written in the module-loader format the Web client expects
 * (`window.__ModuleLoader__.load({ id, factory })`) instead of being bundled by
 * vite: the page is one form, and avoiding a second build toolchain keeps the
 * published package reproducible with `tsc` alone. React comes from the client
 * module table, so nothing is vendored.
 *
 * Data path: `GET/POST /keelwatch/config` served by the host half. The host
 * writes through `ctx.configEditor`, so saving from this page is the same
 * operation as editing the profile patch by hand — the Loader then reloads the
 * row and the new values take effect.
 */
window.__ModuleLoader__.load({
  id: '@kute/dsh-keelwatch',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement

    /** Client services this page needs: the plugin page declares the slots. */
    const inject = ['slots']

    const ENDPOINT = '/keelwatch/config'
    const HEADER = 'x-keelwatch-config'

    const text = {
      title: 'Keelwatch 插件运维',
      intro: '依赖漂移雷达、失败刹车、Token 与耗时归因。保存后由 Loader 重新加载本行生效。',
      documentPath: '写入位置',
      save: '保存',
      saving: '保存中…',
      reloading: '已保存，Loader 正在重新加载该行',
      failed: '保存失败',
      loadFailed: '读取配置失败',
      overridden: '当前值来自 profile patch；其余字段使用插件默认值。',
      drift: '漂移雷达（Drift Radar）',
      brake: '失败刹车（Failure Brake）',
      cost: '成本归因（Cost Attribution）',
      enabled: '启用',
      action: '动作',
      logOnly: 'log（只记录，不拦截）',
      brakeAction: 'brake（冷却期内拒绝调用）',
      alertLevel: '告警级别',
      majorOnly: 'major（只报大版本）',
      minorPlus: 'minor（含小版本）',
      allLevels: 'all（全部）',
      hours: '扫描间隔（小时，0 = 仅启动时）',
      timeout: 'registry 超时（毫秒）',
      registry: 'registry 地址（留空用当前 npm）',
      whitelist: '白名单（包名通配，逗号分隔）',
      threshold: '连续失败次数阈值',
      cooldown: '冷却时长（分钟）',
      neverBrake: '永不拦截的工具（逗号分隔）',
      retention: '数据保留天数',
      topN: '报告条目数',
    }

    function readJson(response) {
      return response.json().catch(() => ({ ok: false, reason: `HTTP ${response.status}` }))
    }

    function splitList(value) {
      return String(value || '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '')
    }

    const styles = {
      wrapper: { display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '680px' },
      header: { display: 'flex', flexDirection: 'column', gap: '4px' },
      title: { fontSize: '15px', fontWeight: 600, color: 'inherit' },
      hint: { fontSize: '12px', opacity: 0.65, lineHeight: 1.5 },
      card: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '14px 16px', border: '1px solid rgba(128,128,128,0.25)', borderRadius: '10px' },
      cardTitle: { fontSize: '13px', fontWeight: 600 },
      row: { display: 'grid', gridTemplateColumns: '1fr 200px', alignItems: 'center', gap: '10px', fontSize: '12px' },
      input: { fontSize: '12px', padding: '4px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', width: '100%', boxSizing: 'border-box' },
      actions: { display: 'flex', alignItems: 'center', gap: '12px' },
      button: { fontSize: '12px', padding: '6px 14px', borderRadius: '7px', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      status: { fontSize: '12px', opacity: 0.75 },
      error: { fontSize: '12px', color: '#e5674f' },
    }

    function field(label, input) {
      return h('label', { key: label, style: styles.row }, h('span', null, label), input)
    }

    function checkbox(checked, onChange) {
      return h('input', { type: 'checkbox', checked: Boolean(checked), onChange })
    }

    function numberInput(value, onChange, extra) {
      return h('input', Object.assign({ type: 'number', style: styles.input, value: value ?? '', onChange }, extra || {}))
    }

    function textInput(value, onChange, placeholder) {
      return h('input', { type: 'text', style: styles.input, value: value ?? '', placeholder: placeholder || '', onChange })
    }

    function select(value, options, onChange) {
      return h(
        'select',
        { style: styles.input, value, onChange },
        options.map((option) => h('option', { key: option[0], value: option[0] }, option[1])),
      )
    }

    function update(config, group, key, value) {
      const next = Object.assign({}, config)
      next[group] = Object.assign({}, config[group], { [key]: value })
      return next
    }

    function ConfigForm() {
      const [config, setConfig] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [documentPath, setDocumentPath] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        fetch(ENDPOINT, { headers: { accept: 'application/json' } })
          .then(readJson)
          .then((payload) => {
            if (!alive) return
            if (payload.ok) {
              setConfig(payload.config)
              setDocumentPath(payload.documentPath || null)
            } else {
              setError(`${text.loadFailed}: ${payload.reason}`)
            }
          })
          .catch((failure) => {
            if (alive) setError(`${text.loadFailed}: ${failure.message}`)
          })
        return () => {
          alive = false
        }
      }, [])

      if (error !== null) return h('div', { style: styles.error }, error)
      if (config === null) return h('div', { style: styles.status }, '…')

      const save = () => {
        setBusy(true)
        setStatus(null)
        setError(null)
        fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [HEADER]: '1' },
          body: JSON.stringify(config),
        })
          .then(readJson)
          .then((payload) => {
            if (payload.ok) setStatus(text.reloading)
            else setError(`${text.failed}: ${payload.reason}`)
          })
          .catch((failure) => setError(`${text.failed}: ${failure.message}`))
          .finally(() => setBusy(false))
      }

      const drift = config.driftRadar
      const brake = config.failureBrake
      const cost = config.costAttribution

      return h(
        'div',
        { style: styles.wrapper },
        h('div', { style: styles.header }, h('div', { style: styles.title }, text.title), h('div', { style: styles.hint }, text.intro)),
        documentPath === null ? null : h('div', { style: styles.hint }, `${text.documentPath}: ${documentPath}`),
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.cardTitle }, text.drift),
          field(text.enabled, checkbox(drift.enabled, (e) => setConfig(update(config, 'driftRadar', 'enabled', e.target.checked)))),
          field(text.hours, numberInput(drift.checkIntervalHours, (e) => setConfig(update(config, 'driftRadar', 'checkIntervalHours', Number(e.target.value))), { min: 0, max: 720 })),
          field(
            text.alertLevel,
            select(drift.alertLevel, [['major', text.majorOnly], ['minor', text.minorPlus], ['all', text.allLevels]], (e) =>
              setConfig(update(config, 'driftRadar', 'alertLevel', e.target.value)),
            ),
          ),
          field(text.timeout, numberInput(drift.requestTimeoutMs, (e) => setConfig(update(config, 'driftRadar', 'requestTimeoutMs', Number(e.target.value))), { min: 500, max: 60000, step: 500 })),
          field(text.registry, textInput(drift.registryUrl, (e) => setConfig(update(config, 'driftRadar', 'registryUrl', e.target.value)), 'https://registry.npmjs.org')),
          field(text.whitelist, textInput(drift.whitelist.join(', '), (e) => setConfig(update(config, 'driftRadar', 'whitelist', splitList(e.target.value))))),
        ),
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.cardTitle }, text.brake),
          field(text.enabled, checkbox(brake.enabled, (e) => setConfig(update(config, 'failureBrake', 'enabled', e.target.checked)))),
          field(
            text.action,
            select(brake.action, [['log', text.logOnly], ['brake', text.brakeAction]], (e) =>
              setConfig(update(config, 'failureBrake', 'action', e.target.value)),
            ),
          ),
          field(text.threshold, numberInput(brake.maxConsecutiveErrors, (e) => setConfig(update(config, 'failureBrake', 'maxConsecutiveErrors', Number(e.target.value))), { min: 2, max: 100 })),
          field(text.cooldown, numberInput(brake.cooldownMinutes, (e) => setConfig(update(config, 'failureBrake', 'cooldownMinutes', Number(e.target.value))), { min: 1, max: 1440 })),
          field(text.neverBrake, textInput(brake.neverBrake.join(', '), (e) => setConfig(update(config, 'failureBrake', 'neverBrake', splitList(e.target.value))))),
        ),
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.cardTitle }, text.cost),
          field(text.enabled, checkbox(cost.enabled, (e) => setConfig(update(config, 'costAttribution', 'enabled', e.target.checked)))),
          field(text.retention, numberInput(cost.retentionDays, (e) => setConfig(update(config, 'costAttribution', 'retentionDays', Number(e.target.value))), { min: 1, max: 365 })),
          field(text.topN, numberInput(cost.topN, (e) => setConfig(update(config, 'costAttribution', 'topN', Number(e.target.value))), { min: 1, max: 100 })),
        ),
        h(
          'div',
          { style: styles.actions },
          h('button', { type: 'button', style: styles.button, onClick: save, disabled: busy }, busy ? text.saving : text.save),
          status === null ? null : h('span', { style: styles.status }, status),
        ),
        h('div', { style: styles.hint }, text.overridden),
      )
    }

    const NS = 'keelwatch'

    /**
     * Register the configuration page for this bundle.
     *
     * The key is the package name because the page is the bundle's own config,
     * not one row's; `plugins.bundle.config` is looked up by that key.
     */
    function apply(ctx) {
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            key: '@kute/dsh-keelwatch',
            locale: NS,
          },
          ConfigForm,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
