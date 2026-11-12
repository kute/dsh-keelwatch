# keelwatch

DeepSeek Harness 插件生态的**运维层**。它不新增任何 agent 能力，只管「插件装多之后」的三件事：

| 能力 | 解决什么 | 官方现状 |
|:---|:---|:---|
| **Drift Radar** | 上游升版或 `engines.dsh` 变化导致某次启动后插件突然坏，用户无从得知原因 | 只有安装期检查，装完之后没人看 |
| **Failure Brake** | 一个工具连续失败后模型反复重试，烧 Token 还拖慢会话 | 官方只管单次超时与重复参数提醒，不管连续失败 |
| **Cost Attribution** | 装了十几个插件后 Token/延迟上涨，不知道是谁贡献的 | 官方只给总量，没有按来源归因的视图 |

## 不做什么

- 不做超时（官方 `@deepseek-ai/dsh-tool-call-timeout-policy` 已有）
- 不做重复调用提醒（官方 `@deepseek-ai/dsh-repeat-tool-reminder` 已有）
- 不改任何插件源码，不替换工具执行器，不硬杀正在运行的调用
- 不做独立 Web 界面与健康评分

## 安装

发布后从 npm 安装：

```sh
dsh plugin --profile <your-profile> add @kute/dsh-keelwatch
```

**本地开发时**（还没发布），从目录或 tarball 安装：

```sh
# 方式一：目录直链（link），改代码后 `pnpm build` 再重启 dsh 即生效
pnpm build
dsh plugin --profile <your-profile> add /Users/kute/work/gitwork/dsh-keelwatch

# 方式二：tarball，最接近真实发布形态
pnpm pack
dsh plugin --profile <your-profile> add ./kute-dsh-keelwatch-0.1.0.tgz
```

两个要点：① 入口是 `lib/index.js`，所以目录安装前必须 `pnpm build`（仓库里 `lib/` 不入版本库）；
② **不要装进正在用的 `web` profile**，用独立 profile 验证，详见 [VERIFY.md](VERIFY.md)。

依赖宿主提供 `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`（声明为 peer），并要求 `engines.dsh` 兼容。

## 配置页面

Web GUI 里：**侧栏「插件」→ `@kute/dsh-keelwatch` 详情页 → 配置区块**（`plugins.bundle.config`）。表单覆盖三个分组的常用项，**保存即写入 profile 的 `cordis.patch.yml` 并让 Loader 重新加载该行**，不需要手工编辑 YAML。

编辑器不可用（headless、无 webserver 的 profile）时，直接改 `~/.dsh/profiles/<profile>/cordis.patch.yml`。

## 配置文件形态

全部键都有默认值；缺失即「只记录、不动作」，绝不会让 DSH 启动失败。

```yaml
- id: keelwatch
  name: '@kute/dsh-keelwatch'
  config:
    driftRadar:
      enabled: true
      checkIntervalHours: 24        # 0 = 只在启动时扫一次
      alertLevel: major             # major | minor | all
      whitelist: []                 # 包名 glob
      registryUrl: ''               # 空 = 使用当前 npm registry
      requestTimeoutMs: 8000
    failureBrake:
      enabled: false                # 默认关闭
      action: log                   # log | brake
      maxConsecutiveErrors: 5
      cooldownMinutes: 10
      tools: []                     # 只对这些工具生效
      exclude: []                   # 工具名 glob
      neverBrake: [ask_user_question]
    costAttribution:
      enabled: true
      retentionDays: 7
      toolToBundle: {}
      topN: 10
```

`failureBrake.action` 默认 `log`：只记录与告警。改成 `brake` 才会在冷却期内 `deny` 该工具的调用——`deny` 是结构化错误，模型会收到明确提示，轮次继续，不会中断会话。

## 归因精度（先看这段再用数据）

| 维度 | 精度 |
|:---|:---|
| 会话总量、上下文压力 | 精确（来自官方 `ctx.tokenMeter`） |
| 按消息来源 kind 的 Token | 精确（surface 节点价格 + `MessageSource.kind`） |
| 按工具的耗时与失败率 | 精确（`tools/execute` 计时） |
| 按来源 kind（`system-prompt` / `tool` / 各插件自定义 kind） | 精确：`session/event` 记录 `seq → MessageSource.kind`，与 `tokenMeter` 的 surface 节点按 `seq` 对齐 |
| 按 npm 包（「哪个插件花最多 Token」） | **推断**：插件注入的消息若声明了自己的 source kind 才精确；没声明 kind 的节点记为 `unattributed`，不猜 |
| 索引文件 | `pnpm market` 由 `package.json` 生成，`pnpm market:check` 校验是否过期 |

不承诺与计费账单一致。

## 版本与平台

- `engines.dsh`：`>=0.2.1-0 <0.3.0-0`
  为什么这样写：宿主用 `semver.satisfies(v, range, { includePrerelease: true })` 判定，而 DSH 的每个版本都是 prerelease。以 release 为锚（`>=0.2.1`）时永远不包含它自己的 `0.2.1-rc.*`；`<0.3.0-0` 则挡住下一个 minor 的 prerelease。
- 平台：无平台专属代码，`dsh.bundle.platforms` 省略即全平台。

## 开发

```sh
pnpm install
pnpm build      # tsc -> lib/ + 浏览器半侧 src/client/index.js -> lib/client.js
pnpm test       # node --test test/*.test.mjs
```

目录直链安装后，改完代码只需 `pnpm build` + 重启 dsh web，不必重新打包。

浏览器半侧是手写的模块加载器格式（`window.__ModuleLoader__.load`），由 `scripts/build-client.mjs`
复制并做加载校验——不引入第二套前端构建链。

测试跑在 `lib/` 构建产物上，与 DSH 社区惯例一致；每个用例把 `DSH_HOME` 指向临时目录。

## 协议

MIT
