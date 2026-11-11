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

```sh
dsh plugin --profile <your-profile> add @kute/dsh-keelwatch
```

依赖宿主提供 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`（声明为 peer），并要求 `engines.dsh` 兼容。

## 配置

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
| 按 npm 包（「哪个插件花最多 Token」） | **推断**：插件注入的消息若声明了自己的 source kind 才精确，否则按工具名映射，可在 `toolToBundle` 里补 |

不承诺与计费账单一致。

## 版本与平台

- `engines.dsh`：`>=0.2.1-0 <0.3.0 || >=0.2.2-0 <0.3.0`
  为什么是联合范围：DSH 只发布 prerelease，而 npm semver 规定 prerelease 只有在范围里出现**同一 major.minor.patch** 的 prerelease 时才被接受。所以 `>=0.2.1 <0.3.0` 会同时拒绝 `0.2.1-rc.5` 和 `0.2.2-rc.1`。
- 平台：无平台专属代码，`dsh.bundle.platforms` 省略即全平台。

## 开发

```sh
pnpm install
pnpm build      # tsc -> lib/
pnpm test       # node --test test/*.test.mjs
```

测试跑在 `lib/` 构建产物上，与 DSH 社区惯例一致；每个用例把 `DSH_HOME` 指向临时目录。

## 协议

MIT
