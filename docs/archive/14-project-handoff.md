# 项目交接总览

更新时间：2026-05-28
归档说明：2026-06-02 起本文仅保留为旧自研 Runtime 阶段交接记录，不再作为当前接手入口。当前接手入口见 `AGENTS.md`、`CLAUDE.md`、`docs/README.md`、`docs/16-skill-workflow-migration.md`、`docs/17-codex-acp-runtime-migration.md`、`docs/18-service-skill-boundary.md`。

本文是旧 Runtime 阶段的交接入口，现已归档，仅用于历史追溯。当前接手入口请读 [../README.md](../README.md)，同期后续路线见 [15-next-phase-roadmap.md](./15-next-phase-roadmap.md)。

## 1. 当前项目一句话

这是一个面向单客户试用的微信投资 AI 助手 Experimental MVP。当前重点不是做传统命令机器人，而是把用户的自然语言消息交给 Agent Runtime，由 AI 决定直接回答、追问，或调用确定性工具维护持有股票池、自选池、提醒、预案和复盘。

## 2. 当前阶段

当前处于：

```text
阶段 1A：Experimental MVP 本地体验测试
```

已完成的关键底座：

- 微信接入链路已跑通，用户能从微信收到回复和测试提醒。
- 本地管理页可访问：`http://localhost:22648/admin/weixin`。
- 数据看板可访问：`http://localhost:22648/dashboard`。
- 代码已从旧关键词路由转向 Agent Runtime v1。
- 21 个 Runtime 工具已全部接入（持仓/自选/监控概览/提醒规则/巡检间隔/信号配置/复盘/交易预案/复盘模板）。
- 复盘闭环已完成：预案→巡检提醒→复盘（含建议）→调整预案。
- 14 个系统信号可配置开关和参数（含资金流信号、放量滞涨/滞跌）。
- Dashboard 可操作看板已完成：网页端直接管理持仓/自选/预案/提醒/信号/巡检间隔。
- 东方财富资金流数据已接入：主力/超大单/大单净流入，用于巡检信号和复盘分析。
- Agent 决策过程已持久化追踪（`agent_traces` 表）。
- `npm run smoke` 已可做基础回归。

当前最重要的未完成点：

- 东方财富主力控盘/筹码集中度数据未接入。
- 盘前预案推送优化（D4-3，低优先级）。
- 新用户首次配置向导和使用示例提示（阶段五，低优先级）。

已完成（2026-05-28 ~ 05-30）：

- 提醒降噪：价格变化感知冷却(<1%不重复) + 每股每日上限 8 条（D4-4）。
- 复盘模板可配置：模板存 settings 表，7 个章节开关 + 关注重点 + 自定义要求（D4-1）。
- Agent 追踪记录：agent_traces 表记录每轮对话（D4-2）。

## 3. 用户核心要求

用户已经多次明确以下原则：

1. 这是 Agent，不是关键词命令机器人。
2. 用户不应该被要求记固定格式。
3. 用户可以说股票名称，不必提供股票代码。
4. 定性理解、意图判断、是否调用工具，由 AI 负责。
5. 工具只做确定性执行、事实查询、落库和校验。
6. 不需要仓位管理；持有股票池只关心“持有哪些股票”，不要求数量和成本。
7. 当前先在本地测试，不要每轮都部署到服务器。
8. 遇到异常体验时，优先看日志分析原因；用户经常会要求“先分析，别急着改”。

这一点是项目的设计红线：不要恢复旧关键词主路由。

## 4. 当前闭环形态

产品目标闭环：

```text
用户通过微信自然语言输入
→ Agent Runtime 读取会话记忆
→ AI 判断 direct_answer / ask_clarification / tool_call
→ 工具执行确定性动作
→ AI 基于工具结果生成最终回复
→ 保存记忆、日志和业务数据
→ 盘中巡检触发提醒
→ 收盘/周/月复盘反馈策略有效性
```

当前已经打通：

- 微信消息到服务端。
- 服务端回复到微信。
- 测试提醒到微信。
- 持有股票池维护。
- 自选池维护。
- 基础巡检和提醒记录。
- 日复盘和预案雏形。
- Dashboard 网页端操作（持仓/自选/预案/提醒/信号管理）。
- 东方财富资金流数据接入（主力/超大单/大单净流入）。
- Agent 决策过程持久化追踪（`agent_traces` 表）。

当前尚未完整打通：

- 东方财富主力控盘/筹码集中度数据接入。
- 盘前预案推送优化。
- 选股问答和加入自选闭环。
- 新用户引导（阶段五）。

## 5. 推荐下一步执行计划

### P0：补 `query_monitor_overview`（已完成 2026-05-27）

目标：回答“我现在监控了什么、监控指标是什么”。

工具应汇总：

- `portfolio`：当前持有股票池。
- `watchlist`：当前自选池。
- `alerts`：显式提醒规则。
- `stock_plans`：人工交易预案。
- `alert_events`：最近触发提醒和反馈。

输出应区分：

- 正在监控哪些股票。
- 哪些规则是用户显式设置的。
- 哪些规则是系统默认巡检。
- 最近有没有触发提醒。
- 哪些数据暂缺，例如主力控盘、资金流、大单净流入。

验收话术：

```text
目前我做了哪些监控？监控指标是什么？
```

预期：基于真实数据库回答，而不是只说明产品功能。

### P1：接入提醒规则工具（已完成 2026-05-27）

建议新增 Runtime 工具：

- `query_alert_rules`
- `set_alert_rule`
- `remove_alert_rule`

验收话术：

```text
帮我看一下赣锋锂业现在设了哪些提醒
给宁德时代设置一个放量突破提醒
把赣锋锂业的涨跌幅提醒关掉
```

预期：AI 可自然理解，必要时追问缺失阈值，不要求固定命令格式。

### P2：接入交易预案工具（已完成 2026-05-28）

建议新增 Runtime 工具：

- `query_stock_plan`
- `set_stock_plan`
- `remove_stock_plan`

验收话术：

```text
帮我看一下赛轮轮胎的交易预案
宁德时代如果接近 200 先提醒我，跌破 190 就算风险信号
```

预期：工具落库，AI 回复说明已记录哪些观察位和风险位。

### P3：接入复盘工具（已完成 2026-05-28）

建议新增 Runtime 工具：

- `generate_daily_review`
- `query_review`
- `generate_weekly_review`

验收话术：

```text
帮我生成今天的复盘
看一下昨天的复盘
这个星期提醒质量怎么样
```

预期：复盘读取真实持有池、自选池、预案和提醒事件。

### P4：补 Agent trace（已完成 2026-05-28）

`agent_traces` 表已实现，每轮 Agent 决策过程持久化记录：
- userId、userMessage、mode（tool_call/direct_answer/ask_clarification）
- toolName、toolArgs、toolResult
- finalReply、memoryBefore、memoryAfter、createdAt

验收：任意一轮异常回复，都能从 trace 还原”上下文是什么、AI 为什么这么选、工具返回了什么”。

## 6. 本地测试流程

### 启动

```bash
npm run build
npm start
```

管理页：

```text
http://localhost:22648/admin/weixin
```

健康检查：

```bash
curl http://localhost:22648/health
```

### 回归

```bash
npm run smoke
```

### 重点体验话术

```text
我现在持有赣锋锂业、盛新锂能和赛轮轮胎
看一下我现在的持仓有哪些
再把这个池子里添加两个阳光电源和宁德时代
算了，把它移除吧
把宁德时代和阳光电源加入自选
目前我做了哪些监控？监控指标是什么？
帮我生成今天的复盘
```

观察重点：

- 是否像 Agent，而不是命令模板。
- 是否正确理解“这个池子 / 它 / 这两个”等指代。
- 是否不强制要求股票代码。
- 是否在缺数据时说明缺口。
- 是否避免编造主力控盘、资金流等数据。

## 7. 服务器信息

当前不建议每轮都部署服务器。服务器信息仅作为需要远程验证时参考。

- 火山云 IP：`118.145.115.197`
- 远程目录：`/home/claude/invest-agent`
- 部署脚本：`./scripts/deploy-volcano.sh`
- 远程管理页：`http://118.145.115.197:22648/admin/weixin`

服务器部署前请先本地跑通并执行：

```bash
npm run smoke
```

## 8. 重要文件索引

- `src/router/message.ts`：用户消息入口。
- `src/agent/runtime.ts`：Agent Runtime 工具选择、工具执行、最终回复。
- `src/agent/memory.ts`：会话记忆。
- `src/handlers/portfolio.ts`：持有股票池工具。
- `src/handlers/watchlist.ts`：自选池工具。
- `src/handlers/alert.ts`：提醒规则工具（`handleAlertTool`）。
- `src/handlers/monitor.ts`：监控概览工具（`handleMonitorTool`）。
- `src/handlers/signal-config.ts`：信号配置工具（`handleSignalConfigTool`）。
- `src/handlers/plan.ts`：交易预案工具（`handlePlanTool`）。
- `src/handlers/review.ts`：复盘工具（`handleReviewTool`）。
- `src/scheduler/alert-check.ts`：盘中巡检引擎。
- `src/routes/dashboard.ts`：Dashboard API 和路由。
- `src/admin/dashboard-page.ts`：数据看板前端。
- `src/admin/weixin-page.ts`：微信管理页。
- `docs/15-next-phase-roadmap.md`：当前迭代总计划（**优先阅读**）。
- `docs/archive/13-agent-runtime-handoff.md`：Runtime v1 交接（已归档，仅历史参考）。
- `docs/archive/12-current-capability-audit.md`：旧 Runtime 阶段能力和差距，仅历史参考。

## 9. 风险和边界

- 投资输出必须是辅助决策，不承诺收益，不替用户自动交易。
- 当前免费行情源缺少客户最关心的主力控盘、筹码集中度、大单净流入等数据。
- 如果 AI 无法确认用户意图，应追问，而不是猜测并落库。
- 如果用户问超出工具范围的问题，AI 可以直接回答，不必强行调用工具。
- 工具返回结果不应直接作为最终回复，最终回复应由 AI 基于工具结果组织成自然语言。

## 10. 给下一任 AI 的执行提示词

```text
你正在接手 /Users/combo/MyFile/projects/invest-agent。

请先阅读 docs/15-next-phase-roadmap.md（当前迭代总计划）、docs/archive/14-project-handoff.md（本文档）、docs/archive/12-current-capability-audit.md。

当前项目目标是本地继续打磨微信投资 Agent Experimental MVP。P0-P4 已完成（监控概览、提醒规则、交易预案、复盘、Agent trace 均已接入 Runtime）。阶段二（Dashboard 可操作）和阶段三（数据增强/资金流）已完成。不要恢复旧关键词路由。用户希望这是一个真正的 Agent：AI 负责理解自然语言、决定是否调用工具、必要时追问；工具只负责确定性查询、落库和执行。

下一步优先：提醒降噪 → 复盘模板可配置 → 盘前推送优化。改动前先看现有代码和日志；改动后运行 npm run smoke。用户如果要求先分析，就先报告原因和方案，不要急着改。
```

## 11. 给验收 AI 的审查提示词

```text
请基于 docs/archive/14-project-handoff.md、docs/archive/13-agent-runtime-handoff.md 和 docs/archive/09-experimental-mvp-demo-checklist.md 审查本次实现。

重点检查：
1. 是否仍坚持 Agent Runtime，而不是恢复关键词路由。
2. 用户是否可以用自然语言完成持有池、自选池、提醒、预案和复盘相关动作。
3. 工具是否只做确定性执行，最终回复是否由 AI 生成。
4. 是否不强制要求股票代码。
5. 是否对主力控盘、资金流等缺失数据明确说明。
6. npm run smoke 是否通过。
```
