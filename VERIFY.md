# 本机验证与回滚

验证原则：**只在独立 profile 里装插件，永远不碰 `web`**。下面的步骤都遵守这一条，任一步失败都不会影响你正在用的 DSH。

## 0. 安全前提（先读这 30 秒）

| 规则 | 原因 |
|:---|:---|
| 不执行 `dsh plugin --profile web add ...` | 主 profile 挂了，GUI 就打不开 |
| 验证用 `keelwatch-verify`（无前端）或 `keelwatch-web`（独立端口） | 两者互不影响 |
| 出问题先 `disable`，不急着删 | 禁用只改一行配置，可逆 |

三条止血命令（DSH 启不启得来都能跑，只依赖 bash + python3）：

```sh
./scripts/rollback.sh status  keelwatch-web    # 看装没装、禁没禁
./scripts/rollback.sh disable keelwatch-web    # 改配置禁用（重启生效，最稳）
./scripts/rollback.sh remove  keelwatch-web    # 卸载包
./scripts/rollback.sh purge   keelwatch-web    # 删掉整个验证 profile（拒绝 web/desktop）
```

真装错了主 profile 也能救：

```sh
./scripts/rollback.sh disable web   # 在 ~/.dsh/profiles/web/cordis.patch.yml 里关掉 keelwatch 行
```

## 1. 构建 + 单元测试

```sh
cd ~/dsh-keelwatch
pnpm install
pnpm build
pnpm test
```

预期：`tsc` 无输出；测试 `# pass 46`、`# fail 0`。

## 2. 装进隔离 profile

```sh
dsh plugin --profile keelwatch-verify add ~/dsh-keelwatch
```

预期：`+ @kutebai/dsh-keelwatch link:/...`，且**不出现** `installation rejected`。

> 若出现 `incompatible with dsh 0.2.1-rc.5`，说明 `engines.dsh` 写错了。正确形式是
> `>=0.2.1-0 <0.3.0-0`：宿主用 `semver.satisfies(v, range, { includePrerelease: true })`
> 判断，而以 release 为锚（`>=0.2.1`）时永远不包含它自己的 `rc`。

## 3. 静态检查（不启动进程）

```sh
# 3.1 插件行是否进了组合配置
dsh --profile keelwatch-verify --dump-config | grep -A4 "== @kutebai/dsh-keelwatch"

# 3.2 运行时是否真的 import 到了本包的 Config schema
dsh --profile keelwatch-verify --dump-config-schema | grep -o "driftRadar\|failureBrake\|costAttribution" | sort -u
```

预期：3.1 输出 `# == @kutebai/dsh-keelwatch` 及其 `config` 段；3.2 三行分别命中。

## 4. 运行时验证（真启动一次）

```sh
dsh keelwatch-web --port 3199 --no-open
```

预期：终端打印 `dsh web: http://127.0.0.1:3199/?token=...`，浏览器打开该地址能看到 GUI。

> 注意是 `dsh <profile> --port ...`（位置参数），不是 `dsh --profile <profile> --port ...`——后者
> 的 `--port` 不会被 web 应用收到，会去抢 3080 和你正在用的实例打架。

跑通即证明：loader 加载了 keelwatch、`Config` 解析成功、`apply()` 执行且没有抛错（否则该 bundle 会被标为失败）。

结束时 `Ctrl-C`，或另开终端 `pkill -f keelwatch-web`。

## 5. 功能验证（不需要前端）

### 5.1 漂移雷达：直接扫真实 `$DSH_HOME`

```sh
node -e "
import('./lib/drift-radar.js').then(async (m) => {
  const { DEFAULTS } = await import('./lib/config.js')
  const report = await m.scanDrift({ ...DEFAULTS.driftRadar, alertLevel: 'all', requestTimeoutMs: 6000 })
  console.log(m.summarize(report))
  console.log('dshVersion:', report.dshVersion, '| scanned:', report.bundlesScanned)
})
"
```

预期：输出 `keelwatch: drift scan over N bundle(s): M finding(s)`，每条都是可解释的（`engines.dsh`
不兼容，或 `@deepseek-ai/*` 依赖的 minor/major 漂移）。本机当前实测：

```
keelwatch: drift scan over 19 bundle(s): 1 finding(s)
  - dsh-context-compression-improved pins @deepseek-ai/schemastery "3.18.4" but upstream latest is 3.19.0 (minor)
```

数量随你装了什么而变，判据只有一条：**能正常加载的插件不应被判为 `engine-incompatible`**。
若出现这种结果，说明 semver 判定比宿主更严，是 bug 而不是发现（实现期就踩过一次，
详见设计文档 §0 第 13 条补记）。

### 5.2 失败刹车：用单测覆盖状态机

```sh
node --test test/brake.test.mjs
```

预期 9 项全过：阈值前不拦 → 达阈值 open → 冷却后半开探测 → 成功复位 / 失败重开。

### 5.3 报告工具：看它注册了没

```sh
node -e "
import('./lib/index.js').then(({ apply }) => {
  const registered = []
  const host = {
    logger: { warn: (m) => console.log('[warn]', m) },
    on: () => () => {},
    timer: { interval: () => {}, timeout: (fn) => fn() },
    tools: { register: (tool) => registered.push(tool.name) },
    reflect: { get: () => undefined },
  }
  apply(host, {
    driftRadar: { enabled: false },
    failureBrake: { enabled: true, action: 'brake', maxConsecutiveErrors: 2 },
    costAttribution: { enabled: true },
  })
  setTimeout(() => console.log('registered tools:', registered), 50)
})
"
```

预期：`registered tools: [ 'keelwatch_report' ]`。

## 6. 回滚

```sh
# 只关掉插件（推荐，最小改动）
./scripts/rollback.sh disable keelwatch-web

# 卸载包（保留 profile）
./scripts/rollback.sh remove keelwatch-web

# 彻底删掉验证 profile
./scripts/rollback.sh purge keelwatch-web

# 确认现状
./scripts/rollback.sh status keelwatch-web
```

`disable` 之后必须重启对应 profile 才生效；`purge` 之后该 profile 首次启动会用模板重建。

## 7. 万一 GUI 打不开

按代价从低到高：

1. **命令行起一个"干净"实例**：`dsh web`（主力 profile 没装插件，不受影响）。
2. **禁用可疑行**：`./scripts/rollback.sh disable <profile>`，或在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 末尾加：
   ```yaml
   - id: keelwatch
     disabled: true
   ```
3. **看启动诊断**：`ls -t ~/.dsh/logs | head -1`，读最近一份 `startup-*.log`，里面明确写了哪一行失败、错误是什么。
4. **删掉 profile**：`./scripts/rollback.sh purge <profile>`（拒绝 `web`/`desktop`，这两个改用 disable）。
5. **最后手段**：`dsh rescue --from-default-profile web` —— 官方提供的一次性救援 profile，用干净的 web 模板启动。

## 8. 清理

验证完成后：

```sh
./scripts/rollback.sh purge keelwatch-verify
./scripts/rollback.sh purge keelwatch-web
./scripts/rollback.sh purge keelwatch-hl
```

`$DSH_HOME/keelwatch/` 下的状态文件可以直接删，没有副作用（下一次启动会重新生成）。
