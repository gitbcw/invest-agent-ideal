# MCP 注册与 Agent 工具架构重构 — WP0 基线

> 状态：Accepted（调查完成，不改运行行为）
>
> 适用工作包：WP1–WP9 的输入基线。本文件是 [重构计划](./mcp-registry-and-agent-tooling-refactor-plan.md) WP0 的明确产物。

## 一、测试基线（worktree `invest-agent-ideal-bigthing` @ 71ccfcd）

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm run typecheck` | ✅ EXIT 0 | 新 worktree `npm install` 后通过 |
| `npm run build` | ✅ EXIT 0 | tsc 编译通过 |
| `npm run capability:market-data:test` | ✅ 6/6 pass | capability 边界 + runner 离线测试 |

未运行（依赖 `.env` / 真实 DB / 真实行情，按红线不在 WP0 阶段接入生产凭据）：`npm test`、`npm run verify`、各 `smoke:*`（stage1/2、mcp-service-tools、scheduled-review-publication、security-boundary、db-legacy-migration）。这些是后续 WP 验收门，WP0 不需要它们。

## 二、调用方矩阵

### 2.1 MCP 组装（WP1/WP2/WP3 核心）

**单一注入点**：所有 ACP 会话（interactive / scheduled / eval）的 `mcpServers` 都由 `StdioAcpAgent.getOrCreateSession`（`src/acp/stdio-agent.ts:696`）→ `buildInvestAgentMcpServers`（`stdio-agent.ts:169`）统一派生。调用方无法直接传 mcpServers，只能通过 `UserContext.mcpAllowedTools`（scheduled）或 `ACP_EVAL_*` env（eval）影响 allowlist。

| 入口 | 文件:行 | 当前行为 | 迁移 WP |
| --- | --- | --- | --- |
| `buildInvestAgentMcpServers` 定义 | `stdio-agent.ts:169-241` | 只装 1 个本地 stdio server `invest-agent-service-tools`；hermes backend 返回 `[]`（`stdio-agent.ts:175`） | WP1 改为注册表驱动 |
| service MCP env 注入 | `stdio-agent.ts:191-231` | 注入 userId/instanceId/workspace/convId/DB_PATH/凭据引用 | WP1 保持，禁止泄露给外部 MCP |
| interactive 会话装配 | `src/acp/agent.ts:85-97` | 不设 `mcpAllowedTools`，用全量 service MCP 工具面 | WP3 |
| scheduled 会话装配 | `scheduled-tasks.ts:368-386` `buildScheduledAcpChatParams`/`runAcpTask` | 把 userContext（含 mcpAllowedTools）原样传入 | WP3 |
| eval 隔离会话 | `scripts/acp-data-quality-eval.mjs:48-51,134-136` | 设 `ACP_EVAL_*` env 收窄 + 剥离继承 mcp.toml | WP3 保留隔离 |
| `stripCodexMcpConfigForEvaluation` | `stdio-agent.ts:870-879` | 给 codex 继承的 config.toml 剥 mcp_servers section | WP1 保留 |

**外部 MCP 现状**：代码中**完全没有** `market-data-tool`、`streamable-http` 或任何外部 MCP server 引用。现有"外部数据"只是通过 env 凭据透传（`TUSHARE_TOKEN`/`TDX_MCP_API_KEY`/`SEARXNG_URL`，`stdio-agent.ts:222-231`）给本地 service MCP 进程。WP2 从零接入。

### 2.2 Scheduled tasks / review / snapshot（WP4/WP7 核心）

| 入口 | 文件:行 | 当前行为（预编排范式） | 迁移 WP |
| --- | --- | --- | --- |
| market-watch 任务 | `scheduled-tasks.ts:159` `runScheduledMarketWatchTask` | "Agent 自取 + 审计校验"：抓 snapshot 但**不注入** prompt；`MARKET_WATCH_ALLOWED_TOOLS`(:46-59) + `MARKET_WATCH_FACT_TOOLS`(:63-72) + `readMarketWatchFactsWereAudited`(:221) 强制调用具名行情工具 + `runMarketWatchCorrection`(:204) 纠偏重跑 + `buildMarketWatchFallbackBrief`(:474) 固定简报兜底 | WP4 |
| daily-review 任务 | `scheduled-tasks.ts:299` + `handlers/review.ts:421` `buildDailyReviewContext` | "服务端预聚合 + 注入 + 禁工具"：全量取 120 日K线/指标/支撑压力/实时行情/新闻/预案，压缩成 JSON 注入 prompt（`mobile-prompt.ts:79` 禁止调用研究工具，发布例外 reviews.save） | WP4 |
| weekly/monthly-review | `scheduled-tasks.ts:328` `runStructuredReviewPrompt` | 同 daily 范式，结果写 `reports/{kind}/{key}.md`（`writeWorkspaceReview` :491） | WP4 |
| publication probe | `scheduled-tasks.ts:78` | 只验发布：只给 reviews.save，固定 content/pushBrief，反查 publication 字段(:132-149) | WP4 保留 |
| snapshot 写入 | `scheduled-tasks.ts:166` `captureMarketWatchSnapshot` | 唯一写入方，写 `market_watch_snapshots` 表 | WP7 冻结 |
| snapshot 实现 | `services/market-watch-snapshot.ts:7` | 取 `marketSnapshot` + 算 delta（holdings/watchlist/plans 逐项 diff） | WP7 |
| reviews.save 校验 | `mcp/service-tools-core.ts:1006-1026` | scope 来自 ServiceToolContext；非定时需 confirmedByUser；定时强制 pushBrief 非空；写 publication 字段 | WP4 不降级 |

**snapshot 消费者矩阵**（WP7 关键证据）：
- **写入方**：仅 `scheduled-tasks.ts:166`（market-watch 任务）。
- **ACP 读方**：仅 `market_watch.snapshot` MCP 工具（`service-tools-core.ts:100-111`），供 Agent 看上一窗口，写 audit log。
- **规则路径**：无（watch-rules 走 `alert_events` 表，与 snapshot 无关）。
- **HTTP/Platform/Portal**：无读取。
- **结论**：单写单读，WP7 冻结写入后 ACP 唯一消费者是 `market_watch.snapshot` MCP 工具——但 WP4 移除 market-watch 预编排后会改变其角色。

### 2.3 确定性规则（WP5/WP6 核心）

**职责分层**：规则求值（`watch-rules.ts`）与 cooldown/dedupe/事件/投递（`scheduler/alert-check.ts` + `scheduler/index.ts`）分离。WP5/WP6 只动数据获取/规则类型，**不得改 alert-check.ts 的 cooldown/dedupe/事件落库**。

| 规则类型 | 求值行号（`watch-rules.ts`） | 数据需求 | 迁移 WP |
| --- | --- | --- | --- |
| `price_cross` | `590-608` | `marketDataReadCapability.quote`(:566) 单代码 | **WP5**（迁到 `getRulePrices`） |
| `ma_cross` | `610-675` | kline count=`max(80,period+5)` + `computeMA` | WP6（需 series contract） |
| `macd_cross` | `677-746` | kline count=120 + `computeMACD` | WP6 |
| `kdj_cross` | `748-788` | kline count=80 + `computeKDJ` | WP6 |
| `rsi_threshold` | `790-822` | kline count=`max(80,period+5)` + `computeRSI` | WP6 |
| `boll_break` | `824-861` | kline + `computeBOLL` | WP6 |
| `wr_threshold` | `863-894` | kline + `computeWR` | WP6 |
| `volume_ratio` | `896-928` | kline 手算量比 | WP6 |
| `near_plan_level` | `930-970`（**beta**） | quote.price + `loadLatestPlan`(:1227) 预案价位 | WP6（可评估复用价格事实+计划状态） |

**price_cross 当前取价**：`marketDataReadCapability.quote([rule.stockCode])`（`watch-rules.ts:566`），单代码单次，用 `quoteResult.items[0].price` 比较。WP5 改为 tick 级批量 `getRulePrices(codes)`。

**cooldown/dedupe/投递（WP5/WP6 不可触碰）**：全在 `src/scheduler/alert-check.ts`——`runAlertCheck`(:67)、`buildStage2AlertItem`(:190)、`filterAndRecordAlerts`(:395，每股每日上限 8、signalKey state、cooldown 窗)、`shouldPushAlert`(:721)；投递在 `src/scheduler/index.ts`。

**名称→代码解析**：watch-rules 是 **code-first**，创建/修改/调度均不做名称解析（`validateWatchRule` 只 `trim()`，:513）。`resolveStockRefs` 存在于 `stock-resolver.ts` 但不被 watch-rules 复用。WP5 若需引入，在创建入口前置，不在调度期做。

### 2.4 旧市场 MCP / HTTP / Platform（WP8 核心）

**服务自有 MCP 工具清单**（`src/mcp/invest-agent-service-tools.ts` 注册，`service-tools-core.ts` 分发）：
- market.* — `snapshot`(:63, 聚合**用户状态+行情**)、`watch.snapshot`(:70)、`quote`(:77)、`kline`(:84)、`fundamentals`(:97)、`indices`(:107)、`capital_flow`(:114)、`sector_theme`(:121)、`calendar`(:128)、`health`(:135)、`stock_info`(:142)、`resolve`(:185)
- research.* — `news_search`(:152)、`web_search`(:163)、`web_read`(:174)

**HTTP 行情路由**（`src/routes/sandbox.ts`，权限 `invest.market.read`，全走 capability 不直打 provider）：quote(:1774)、kline(:1787)、indices(:1808)、capital-flow(:1818)、sector-theme(:1831)、stock-info(:1844)、resolve(:1859)、snapshot(:1872/1876)、health(:1880)、calendar(:1890)。**Portal 不消费这些路由；Platform 仅消费 health**。

**Platform source-quality / telemetry**（旧运维资产）：`/api/platform/source-quality`(`platform.ts:1550`) + owner UI `view-source.ts`，数据来自 `market.health()` + `source-quality/` 磁盘目录。Partner 侧 `partnerSourceQualitySummary`(`platform.ts:781`)。WP8 降级为旧路径运维资产。

**provider 层**：腾讯解析在 `src/services/stock.ts`（`getQuote`:53、`getKline`:169），新浪 fallback 同文件。fallback 编排在 `market-data.ts`（quote 交叉校验 :522、kline fallback :595）。provider 表 + telemetry 在 `market-data-providers.ts`（`PROVIDERS`:76、`endpointStats`:314、`withSourceEvent`:475）。

### 2.5 capability-plane 旧计划残留

契约已抽离到 `src/capabilities/`（market-data/research/indicators 各有 contract.ts + freeze 工厂），但**生产实现仍在 `src/services/*`**，capability 目录只持接口边界。fixture runner 在 `scripts/capabilities/`，离线测试 + fixture 在 `tests/capabilities/`。详见 §四冲突项表。

## 三、`UserContext.mcpAllowedTools`

- 定义：`src/lib/user-context.ts:18-19`（可选 `string[]`）
- 唯一读取点：`stdio-agent.ts:188-198`（非空时写 `INVEST_AGENT_MCP_ALLOWED_TOOLS` env）
- 写入点：仅 scheduled tasks（`scheduled-tasks.ts:104` reviews.save、`:162` MARKET_WATCH_ALLOWED_TOOLS）；interactive 不设
- WP3 含义：替代普通任务级读工具 allowlist 的"风险例外机制"只用于写/高费/敏感/隔离任务

## 四、旧计划冲突项状态表

| 旧计划判断/成果 | 状态 | 处理 WP | 备注 |
| --- | --- | --- | --- |
| `marketDataReadCapability`（capability 契约 + freeze 工厂） | **保留** | — | `market-data.ts:917`，仍是过渡兼容层 |
| `market-internal-boundary.test.ts`（锁 watch-rules 用 capability） | **保留** | — | WP5 改取价路径后需更新此护栏 |
| fixture runner + 离线测试（`scripts/capabilities/`、`tests/capabilities/`） | **保留** | — | 仍可用于确定性测试 |
| 外部数据须经服务 adapter 归一化才能供 ACP | **替代** | WP2 | ACP 直接消费受信任外部只读 MCP 原生结果 |
| 现有市场 MCP 工具（market.*）作为 ACP 稳定兼容面 | **转为待退役兼容面** | WP8 | 是否删除先审计消费者 |
| scheduler/review/规则共享同一 capability | **替代** | WP3/WP4/WP5 | 三类消费者契约不同 |
| `market.snapshot` 聚合用户状态+行情 | **冻结并拆分** | WP7/WP8 | 用户状态服务读，开放行情 ACP 工具读，规则走窄事实 |
| provider telemetry/source-quality 是 ACP 研究链必要统一资产 | **降级为旧路径运维资产** | WP8 | 外部 MCP 自负数据质量 |

## 五、WP0 交接

- **向 WP1**：MCP 入口清单 = `buildInvestAgentMcpServers`(`stdio-agent.ts:169`) 单一注入点 + service MCP env 注入集(:191-231) + eval 隔离机制。支持的 transport 当前仅 stdio（ACP SDK 是否支持 streamable-http 需 WP1 探针确认）。
- **向 WP2**：无任何现有外部 MCP 基础设施，从零接入；外部 MCP 绝不能收到 DB_PATH/Workspace/sandbox secret/服务 token（见 env 注入集）。
- **向 WP3**：会话装配入口 = interactive(`agent.ts:85`)、scheduled(`scheduled-tasks.ts:384`)、eval(`acp-data-quality-eval.mjs`)；`UserContext.mcpAllowedTools` 仅 scheduled 写。
- **向 WP4**：两种预编排范式（market-watch 自取+审计 vs daily/weekly/monthly 预聚合+注入+禁工具）的具体删除点见 §2.2。
- **向 WP5**：price_cross 取价点 `watch-rules.ts:566`；cooldown/dedupe 在 `alert-check.ts` 不可触碰；code-first 不做名称解析。
- **向 WP6**：8 种非价格规则求值行号见 §2.3；near_plan_level(beta) 可评估复用价格事实+计划状态。
- **向 WP7**：snapshot 单写（`scheduled-tasks.ts:166`）单读（`market_watch.snapshot` MCP 工具）；冻结写入前需 WP4 先清零 ACP 消费者。
- **向 WP8**：兼容入口清单 = market.* MCP 工具 + sandbox HTTP 路由 + Platform source-quality；无证据不删除。

## 六、禁止下游重新假设的事项

- 没有发现任何运行时动态调用或未知外部客户端（grep 完整覆盖 src/tests/scripts）。
- 当前 ACP SDK 的 transport 支持范围未经验证（WP1 探针任务），不要假设已支持 streamable-http。
- watch-rules 的 cooldown/dedupe/投递语义完整定义在 `alert-check.ts`，WP5/WP6 改数据层时不得触碰。
- snapshot 表的 ACP 消费者角色会随 WP4 改变，WP7 冻结必须等 WP4 完成。
