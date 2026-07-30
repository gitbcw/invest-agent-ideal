# WP6：非价格确定性规则分类与决策清单

> 状态：技术审计完成，**等待用户产品决策**。
>
> 这是 [重构计划](./mcp-registry-and-agent-tooling-refactor-plan.md) WP6 的产物。执行者只做技术审计材料，**不代替产品判断**。你的决策会决定每类规则的后续任务。

## 一、8 类规则全景

| 规则 | status | 用户可见入口 | 数据需求 | 求值 LOC | 维护风险 |
| --- | --- | --- | --- | --- | --- |
| `ma_cross` | active | HTTP API + MCP 工具 | 日 close 序列 ~period+5 根 | ~65 行 | 低（computeMA 稳定） |
| `macd_cross` | active | HTTP API + MCP 工具 | 日 close 序列 固定 120 根 | ~70 行 | 低（EMA 种子语义偏差，有记录） |
| `kdj_cross` | active | HTTP API + MCP 工具 | 日 OHLCV 80 根 | ~40 行 | 中（SMA 种子=50，少量 K 线时主导） |
| `rsi_threshold` | active | HTTP API + MCP 工具 | 日 close 序列 ~period+5 根 | ~33 行 | 低（Wilder 法，avgLoss=0 极端值无防护） |
| `boll_break` | active | HTTP API + MCP 工具 | 日 OHLCV ~period+5 根 | ~38 行 | 低（总体标准差，语义已记录） |
| `wr_threshold` | active | HTTP API + MCP 工具 | 日 OHLCV ~period+5 根 | ~32 行 | 低（hh=ll 时返回 50，可能误触发） |
| `volume_ratio` | active | HTTP API + MCP 工具 | 日 volume 序列 ~period+2 根 | ~33 行 | 中（**手算**，绕过 indicatorCapability，逻辑重复） |
| `near_plan_level` | **beta** | HTTP API + MCP 工具 | **当前价 + 预案价位**（无 K 线） | ~40 行 | 低（levelValue>0 防除零；依赖两个 backend） |

**用户可见入口统一**：全部通过 `watch_rules.*` MCP 工具（Agent 驱动，带确认门）+ `GET/POST /api/watch-rules*` HTTP API。**无 UI/Portal 页面**。无面向用户的规则类型说明文档（权威规范是 `WATCH_RULE_CATALOG` 本身，通过 `watch_rules.catalog` 暴露）。

**生产消费者**：`scheduler/alert-check.ts` 的 `runAlertCheck` 巡检（`rule-alert-check` 任务每分钟扫描）。所有规则类型都已被 `buildStage2AlertItem` 覆盖。

## 二、技术建议分组（验证计划 §八 的初步判断）

### 分组 A：`near_plan_level` → 复用价格事实 + 计划状态（无需新契约）

**数据需求**：`quote.price`（当前价）+ `loadLatestPlan`（预案支撑/阻力/目标/止损价位）。

**结论**：可以迁移到「`RulePriceFact`（价格，WP5 已就绪）+ `planBackend`/`dailyPlanBackend`（计划状态）」，**不需要新的数据序列契约**。这是唯一一个不依赖 K 线序列的非价格规则。

### 分组 B：6 类指标规则（ma/macd/kdj/rsi/boll/wr）+ volume_ratio → 共享日 K 线序列契约

**数据需求**：全部是**日周期 OHLCV K 线序列**（约 80-120 根）。数据形状高度同质：
- 仅 close：ma、macd、rsi
- close+high+low：kdj、boll、wr
- close+volume：volume_ratio

**结论**：一个共享的**确定性日 K 线序列契约**（类似 `getRuleKlineSeries(codes): Map<code, KlineSeriesFact>`）可同时服务全部 7 类规则。它们不需要 7 个独立契约——对"日 OHLCV 序列 + 稳定 indicatorCapability 算子"的需求完全一致。这**优化了**计划原文"独立 series contract"的表述：是**一个共享**契约，而非七个。

**附带收益**：当前每条指标规则独立调 `marketDataReadCapability.kline`，同一股票 N 条规则 = N 次冗余请求。共享契约可在 tick 级批量（与 WP5 的 price 批量预取同构）。

## 三、需要你决策的事项

对以下 8 类规则，请逐类选择：**保留（正式）/ 降级（beta，禁止新建）/ 退役（禁止新建 + 存量处理）**。

未决定前，代码保持当前行为不变（计划 §八 WP6 边界）。

### 决策 1：6 类纯指标规则（ma/macd/kdj/rsi/boll/wr）

这 6 类高度同质，可作为一个整体决策，也可分开。

**技术事实**：
- 都依赖日 K 线序列 + indicatorCapability（已稳定的纯计算）
- 都已 active，通过统一入口暴露
- 迁移成本：共享 K 线序列契约 + 各自轻量 evaluator（模板代码几乎相同）
- **生产零启用**（见第四节），无存量用户负担

**需你判断**：这些技术指标类规则对你的产品定位是否需要？你的产品是"确定性规则盯盘"导向，还是更偏向"ACP 开放式研究"？

### 决策 2：`volume_ratio`（量比）

**技术事实**：
- 唯一**手算**的规则（绕过 indicatorCapability，逻辑与 `indicators.ts` 的 volumeAnalysis 重复）
- 是维护债务的一个点

**需你判断**：量比规则是否有独立产品价值？还是可以合并到其他规则或交给 ACP 自由分析？

### 决策 3：`near_plan_level`（接近预案价位）

**技术事实**：
- 唯一 **beta** 状态、唯一用 `plan` scope 的规则
- 迁移最简单（复用 RulePriceFact + planBackend，无需 K 线）

**需你判断**：这个 beta 规则是否要转正？它的"价格接近预案关键价位"语义对你的盯盘产品是否有价值？

## 四、生产启用情况（已查证，关键证据）

**已查主仓生产 DB** `data/invest-agent.db`（只读统计，脱敏）：

| 表 | 行数 | 含义 |
| --- | --- | --- |
| `alert_rules`（stage2 watch rules + stage1 legacy 共用，`relation_to_plan='stage2_watch_rule'` 区分） | **0** | 没有任何 watch rule 被创建过 |
| `alert_events`（规则触发记录） | **0** | 没有任何规则触发过 |

**结论：生产环境当前没有任何用户启用过任何 watch rules（包括这 8 类非价格规则和 price_cross）。** 这些规则功能完整、代码稳定、测试覆盖，但在生产中**零启用**。

这对决策的含义：**退役或降级任何规则都不会影响现有用户**（无存量依赖）。决策可以纯粹基于"这些规则对你产品的未来价值"，而不需要处理存量迁移负担。

> 注：`indicator_results` 表有 6 行，但那是复盘用的指标快照（`recordIndicatorResultSnapshot`），不是 watch rule 触发记录。

## 五、决策后的后续任务

- **保留的规则**：各自创建后续任务契约（迁移到对应契约：near_plan_level → 价格事实+计划；指标规则 → 共享 K 线序列契约）
- **降级为 beta 的规则**：catalog status 改 beta + 禁止新建（存量保留）
- **退役的规则**：禁止新建 + 存量用户处理方案（不删历史记录，按计划边界）
- **全部分类完成后**：WP6 标记 Accepted，向 WP9 交接
