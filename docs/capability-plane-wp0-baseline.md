# Capability Plane Extraction — WP0 Baseline & Dependency Inventory

> 工作包：WP0（建立基线与依赖清单），对应 `docs/capability-plane-extraction-plan.md` 第七节 Phase 0。
> 状态：已交付，仅新增文档与脱敏 fixture，未改动任何生产行为、provider 顺序、数据质量策略或算法。
> 关联：执行日志 `docs/capability-plane-extraction-plan_execution_log.md`；脱敏 fixture 与规则 `tests/capabilities/fixtures/`。

WP0 的目标是“在移动代码前明确当前行为和耦合点”。本文记录迁移前的行为基线、调用关系清单、能力依赖矩阵、fixture 清单与脱敏规则、迁移前验证记录。完成条件（计划要求）——执行者能回答每个能力是否依赖用户状态、是否有副作用、由哪些正式入口调用——见 §6。

## 1. 范围与不变量（迁移前行为基线）

三个待抽离能力及其当前实现文件：

| 能力 | 当前实现 | 行数 |
| --- | --- | --- |
| market-data | `src/services/market-data.ts`、`market-data-providers.ts`（+ `stock.ts`/`eastmoney.ts`/`sector-theme.ts`/`stock-news.ts`/`stock-resolver.ts`） | 985 + 553 |
| research | `src/services/external-evidence-search.ts`、`external-market-providers.ts` | 772 + 399 |
| indicators | `src/services/indicators.ts`、`script-indicator-engine.ts`、`composite-indicator-engine.ts`（+ `l3a/l3b-indicator-runner.ts`、`indicator-acknowledgement.ts`） | 427 + 164 + 397 |

**迁移过程禁止顺手改变的基线（计划 Phase 0 任务 5）：**

1. MCP 工具名、scope、安全校验、审计行为不变（`invest-agent-service-tools` 的 `market.*` / `research.*` 全部保留）。
2. provider 优先级与 fallback 链不变：行情 Tencent 主、Sina 兜底；资金流 Eastmoney 低置信；基本面 Tushare/TDX（按凭据启用）；`research.web_search` 链 Doubao（若配置且未禁用）→ SearXNG（若配置）或 sogou。
3. 数据质量策略不变：`MarketSourceMeta`（provider/endpoint/referenceUrl/fetchedAt/marketTime/confidence/evidenceLevel/usageBoundary/stale/warnings）字段不丢；资金流“观察信号、非主力控盘证据”告警保留；缺 `time` 落 `missing_market_time` 而非伪造新鲜度。
4. 指标算法版本、输入精度、缺失值与 warm-up 规则不变；script 指标的 `isolated-vm` 沙箱（64MB / 5000ms、禁止 Node API、`invest-agent-runtime` 别名）不放宽。
5. SSRF 防线不下沉：凭据 URL 拒绝、私网/保留地址拒绝、逐跳 redirect 校验、2MiB/15s/4 跳上限保持。

## 2. 能力依赖矩阵

资源维度缩写：ENV=环境变量、NET=网络、SQL=SQLite/drizzle、WS=WorkspaceStore/工作空间文件、USR=用户/instance/会话 id、CACHE=缓存、TEL=遥测、LOG=logger、AUD=审计。“label-only”表示仅作遥测/质控标签，不参与存储路径或取数行为。

| 模块 | ENV | NET | SQL | WS | USR | CACHE | TEL | LOG | AUD | 用户状态? | 副作用 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `market-data.ts`（quote/kline/indices/capitalFlow/sectorTheme/stockInfo/resolve/calendar/health） | — | 委托 stock/eastmoney/sector-theme/stock-news | — | — | label-only | 单次调用内 Map | 经 `withSourceEvent` | — | — | 否 | 网络 + 遥测写 |
| `market-data.ts` `marketSnapshot` | — | 同上 + 聚合 | 经 data-backend | 经 data-backend 读 portfolio/watchlist/plans | userId+instanceId 决定读取范围 | — | 同上 | — | — | **是** | 网络 + 遥测写 |
| `market-data-providers.ts` | `config.runtimeData.sourceTelemetryDir` | — | — | — | label-only | 进程内 `endpointStats` Map | **遥测 SSOT**（写 `data/source-telemetry/*.jsonl` + `setAlertSink`） | logger.warn | — | 否 | 文件写 |
| `external-evidence-search.ts`（news/web_search/web_read） | `EXTERNAL_WEB_SEARCH_SEARXNG_URL`/`DOUBAO_SEARCH_API_KEY`/`DOUBAO_SEARCH_ENABLED`/`DOUBAO_SEARCH_ENDPOINT`（已支持 DI `env`） | fetch + DNS lookup | — | — | label-only | 进程内 circuit/QPS | 经 `withSourceEvent` | — | — | 否 | 网络 + 遥测写 |
| `external-market-providers.ts`（fundamentals/tushare/tdx） | `config.marketProviders.*`（TUSHARE_TOKEN/TDX_MCP_*） | fetch POST 固定主机 | — | — | label-only | 进程内 provider 缓存/限流 | 经 `withSourceEvent` | — | — | 否 | 网络 + 遥测写 |
| `indicators.ts`（L1 纯函数） | — | — | — | — | — | — | — | — | — | 否 | **无**（纯） |
| `script-indicator-engine.ts`（L3b） | — | — | — | `workspaceRoot` 仅用于 cache + 脚本路径 | — | 文件编译缓存 `<workspaceRoot>/cache/build/*.<hash>.js` | — | — | — | 否（运行时） | 文件写（缓存） |
| `composite-indicator-engine.ts`（L3a） | — | — | — | 仅 `loadConfig(yamlPath)` 读 YAML | — | — | — | — | — | 否（运行时） | 无（除 loadConfig 读文件） |

关键结论：

- **唯一读取用户状态的市场导出是 `marketSnapshot`**（经 `data-backend` 的 `portfolioBackend/watchlistBackend/planBackend` 聚合持仓/自选/预案）。其余市场导出的 `userId` 只是遥测标签。→ 符合计划 §1A.3：`market.snapshot` 留在 Core Service 编排。
- **research 两个模块对用户/工作空间/会话状态零读取、零按用户写入**，但**有服务级持久遥测写**（`withSourceEvent` → `data/source-telemetry/YYYY-MM-DD.jsonl`）和进程内 circuit/QPS/缓存状态。属“有副作用、无用户状态”。
- **`indicators.ts` 是唯一真正纯函数的模块**（仅 `import type { StockKline }`）。L3a/L3b 引擎对“给定定义+数据”确定性，但读文件/写缓存。
- **共享副作用是遥测 sink**：`market-data-providers.ts` 的 `withSourceEvent`/`appendTelemetry`/`setAlertSink` 同时被 market-data 与 research 使用。这正是计划 §1A 要抽成注入式 sink 的对象（默认测试用内存 sink）。

## 3. 当前调用关系清单

### 3.1 market-data

正式入口（工具名/路由/脚本）：

- **MCP**（`src/mcp/service-tools-core.ts` 分发，`invest-agent-service-tools.ts` 声明）：`market.snapshot/quote/kline/fundamentals/indices/capital_flow/sector_theme/calendar/health/stock_info/resolve`、`market_watch.snapshot`（→ `latestMarketWatchSnapshot`）。每个调用前后由 MCP 层做 scope + `audit(...)`。
- **HTTP**（`src/routes/sandbox.ts`，`invest.market.read` + sandbox-token）：`/api/sandbox/market/{quote,kline,indices,capital-flow,sector-theme,stock-info,resolve,snapshot,health,calendar}`。`src/routes/platform.ts` 仅用 `marketHealth`（partner runtime-health / source-quality）。
- **scheduler/watch-rule/review**：`watch-rules.ts`（marketQuote/marketKline，规则求值）、`market-watch-snapshot.ts`（captureMarketWatchSnapshot → marketSnapshot）、`handlers/review.ts`（marketKline/marketQuote/marketIndices）、`handlers/plan-conditions.ts`（marketQuote）、`handlers/data-quality-report.ts`（消费 `market-data-providers` 遥测）、`acp/scheduled-tasks.ts`（类型 + capture）。
- **runner/script**：`scripts/market-data-live-probe.mjs`（唯一直接打 market-data 的 runner，live probe）。

### 3.2 research

- **MCP**：`research.news_search`/`research.web_search`/`research.web_read` → `searchPublicFinanceNews`/`searchPublicWeb`/`readPublicWebPage`（`service-tools-core.ts` 唯一生产调用方）。`market.fundamentals` → `integratedFundamentals`（注意：基本面挂在 `market.*` 命名空间，实现在 `external-market-providers.ts`）。
- **其他服务**：`market-data.ts` 用 `externalProviderAvailability()`（health 上报）；`tushare*`/`tdx*` 仅被 `integratedFundamentals` 内部调用 + smoke。
- **HTTP/scheduler/review/platform**：无直接调用。
- **runner/script**：`scripts/external-market-providers-smoke.mjs`、`scripts/mcp-service-tools-smoke.mjs`（打三个 research 工具名）。
- **SSRF 防线全部在 `external-evidence-search.ts`**（`normalizePublicUrl`/`assertPublicUrl`/`isPublicAddress`/`fetchPublicPage` 手动 redirect，MAX_REDIRECTS=4，2MiB，15s，`safeHttpUrl`）；`external-market-providers.ts`、`stock-news.ts` 只打固定主机、无用户 URL、无 SSRF 守卫。审计层 URL 脱敏：`redactUrlForAudit`（`service-tools-core.ts`）。

### 3.3 indicators

- **无 `indicator.*` MCP 工具，无直接 HTTP 路由**：指标当前**不是**面向 Workspace 的能力，只作为 review/watch-rule 的内部计算被间接使用。
- **`indicators.ts`（生产活跃）**：`handlers/review.ts`（`analyzeIndicators`）、`services/watch-rules.ts`（`computeMA/MACD/KDJ/BOLL/RSI/WR` 规则求值）、`services/sandbox-runtime.ts`（作为 L3b bundle 的 `invest-agent-runtime` 别名重导出，非直接调用方）、`scripts/indicators-smoke.mjs`。
- **`script-indicator-engine.ts` / `composite-indicator-engine.ts` / `l3a` / `l3b` / `indicator-acknowledgement.ts`：生产零静态调用方**。仅被 smoke 脚本（`script-indicator-smoke`/`composite-indicator-smoke`/`main-force-control-smoke`/`indicator-acknowledgement-smoke`）和彼此引用。`scheduler/alert-check.ts` 只识别 `composite:`/`script:` 信号前缀做 DB 标签，**从不调用** runner——即调度侧“能接收”这类信号，但无生产代码“产生”它们。
- **acknowledgement 所有权**：无版本/授权系统，仅有 `user_acknowledged`+`acknowledged_at` 标志，由各 runner 在加载期内联判断（l3a:131 / l3b:107）+ 引擎 evaluate 期再判（composite-indicator-engine.ts:379）。正式策略模块 `indicator-acknowledgement.ts`（含 `acknowledged_via` 白名单与时间戳校验）**未被接线**，生产无调用方。
- **指标缓存位置**：唯一持久缓存是 L3b 脚本编译缓存 `<workspaceRoot>/cache/build/<base>.<hash>.js`（`clear-indicator-cache.mjs` 扫的就是它）。DB 表 `indicatorResults` 是告警快照日志，非计算缓存。

## 4. Fixture 清单与脱敏规则

脱敏基线 fixture 位于 `tests/capabilities/fixtures/`，覆盖计划要求的成功/部分失败/空结果/限流/无权限五类（README 含完整规则）。要点：

| Fixture | 能力 | 覆盖用例 |
| --- | --- | --- |
| `market-quote.success.json` | market-data | 成功（多代码 + 完整 `MarketSourceMeta`） |
| `market-quote.partial.json` | market-data | 部分失败（一代码 stale → `missing_market_time`） |
| `market-capital-flow.empty.json` | market-data | 空结果（Eastmoney 无行 + 观察信号告警） |
| `research-web-search.success.json` | research | 成功（SearXNG/sogou + provider 溯源） |
| `research-web-search.empty-both-fail.json` | research | 空结果 + 部分失败（双 provider 失败、不泄漏 key） |
| `research-doubao.rate-limit.json` | research | 限流（`doubao_qps_exceeded` 结构化告警 + 回退） |
| `market-fundamentals.no-permission.json` | market/research provider | 无权限（`tushare:not_configured`/`tdx:not_configured`） |
| `indicators.deterministic.json` | indicators | 成功（L1 纯函数确定性输出，复刻 smoke 基线） |

脱敏规则（摘要，详见 fixture README）：凭据/token 全替换为 `"<redacted>"` 且断言告警不含 key 子串；真实 `userId/instanceId` → `user-test/instance-test`；时间戳 → 占位符但 `fetchedAt`/`marketTime`/缓存返回时间三字段保持可区分；公开 provider 主机保留（属溯源身份）；只存归一化结果信封，不存原始 provider 响应/凭据 URL；`market.snapshot` 等“用户状态聚合”不收录。**fixture 为 WP0 参考基线，未接入任何测试 runner**（接入是 WP1/WP2/WP6）。

既有测试已覆盖大量基线（迁移期不得回归）：`tests/external-evidence-search.test.ts`（news 成功/失败告警、sogou、searxng、web_read redirect/私网拒绝/TLS、doubao 成功/截断/各类回退/双失败不泄 key、provider 注册）、`tests/market-kline-contract.test.ts`（日线精度、Sina 兜底日期范围）、`tests/market-watch-snapshot.test.ts`、`tests/stock-news.test.ts`、`tests/market-calendar.test.ts`。

## 5. 迁移前验证记录

已运行的只读/离线验证（2026-07-30，未触网、未触真实状态）：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck`（`tsc --noEmit`） | ✅ 通过（exit 0，无报错） |
| `npm run build`（`tsc`） | ✅ 通过（exit 0） |
| `npm run smoke:indicators` | ✅ 通过（离线确定性，所有 L1 算子；输出已固化为 `indicators.deterministic.json` 基线） |
| `npm run smoke:script-indicator` | ❌ 失败（**前置条件未满足**，见下） |
| `npm run smoke:composite-indicator` | ❌ 失败（同上） |

网络/状态相关命令（计划要求“记录其能验证的范围”，本次按红线未实跑）：`npm run smoke:mcp-service-tools` 验证 Codex 可见 MCP 工具能调 `market.snapshot` 并返回价格（需公网 Tencent）；`npm run probe:market-data-live` 对真实 provider 做只读 live probe（quote/kline/indices/health/calendar/sectorTheme/stockInfo，需公网，不得把 live 结果固化为 golden）。

## 6. 完成条件自检

- **market-data 是否依赖用户状态？** 仅 `marketSnapshot` 依赖（读持仓/自选/预案）；其余导出否。**是否有副作用？** 是：网络 + 持久遥测写。**正式入口？** MCP `market.*`/`market_watch.snapshot` + sandbox `/api/sandbox/market/*` + platform `marketHealth` + watch-rule/review/scheduler 内部 + `market-data-live-probe.mjs`。
- **research 是否依赖用户状态？** 否。**副作用？** 网络 + 持久遥测写 + 进程内 circuit/QPS。**正式入口？** MCP `research.news_search/web_search/web_read` + `market.fundamentals`（实现在 external-market-providers）；`external-market-providers-smoke.mjs`。
- **indicators 是否依赖用户状态？** 运行时不依赖（定义/ack 所有权属工作空间契约，引擎本身只接收显式输入）。**副作用？** `indicators.ts` 无；L3b 写编译缓存。**正式入口？** 无独立 MCP/HTTP 入口——经 `watch-rules`（dry-run）/`review`/scheduler 间接调用；L3a/L3b/script/composite 仅 smoke。

## 7. 风险、阻塞与待确认

阻塞（需在 WP6 前处理，非 WP0 引入）：

- `smoke:script-indicator` 与 `smoke:composite-indicator` 在当前 `main` 上**红**：缺 `templates/workspace/scripts/indicators/double_ma_cross.ts` 与 `templates/workspace/config/composite_indicators.yaml`，二者在 commit `771bbe9`（workspace 模板迁移至 .codex skills、清理旧配置与示例脚本）被移除，引用它们的 smoke 已过期。WP6（indicator capability）需先决定恢复模板资产还是改写 smoke 入口。
- L3a/L3b/composite/script/`indicator-acknowledgement` **生产无调用方**：Phase 3“抽离 indicator-tool”没有活跃生产入口可迁移，迁移价值需重新评估；`indicator-acknowledgement.ts` 正式策略被 runner 内联判断旁路，抽离时要决定先接线还是先抽引擎。

风险：

- 遥测 sink（`withSourceEvent`/`appendTelemetry`/`setAlertSink`）是 market-data 与 research 共享的持久副作用，抽成注入式 sink 时必须保证默认测试用内存 sink、且不改变“失败必写、恢复写 recovered、连续失败 3/10 次告警”的现有语义。
- `userId` 贯穿纯路径仅作标签：抽离 contract 时不得让 capability 按 userId 改变取数或写按用户状态。
- `market.fundamentals` 命名空间属 `market.*` 但实现属 research/provider 模块——抽离边界划分时需明确归属，避免双实现。

待确认（计划 §十三，不阻塞 WP0/WP1）：runner 面向 CLI 还是未来本地 MCP 子进程；遥测持久化继续由 service adapter 还是注入 sink；`market.health` 拆 capability-local 与 Core Service 综合；indicator 首批范围（建议先基础指标 → composite → script engine）。

## 8. WP0 产出文件

- `docs/capability-plane-wp0-baseline.md`（本文）
- `tests/capabilities/fixtures/`（README + 8 个脱敏基线 fixture）
- `docs/capability-plane-extraction-plan_execution_log.md`（更新执行输出指针）

均为新增文件，未修改任何生产源码、测试、配置或用户状态，独立可回滚（`git clean`/删除即恢复）。
