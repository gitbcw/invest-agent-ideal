# Agent Runtime 交接说明

> **注意**：本文档写于 Runtime v1 阶段，保留作为历史参考。当前入口见 [../README.md](../README.md)，同期后续路线见 [15-next-phase-roadmap.md](./15-next-phase-roadmap.md)。

更新时间：2026-05-28（添加过时说明）

本文是 Agent Runtime 细节交接。旧项目总交接见 [14-project-handoff.md](./14-project-handoff.md)，仅用于追溯历史。

## 1. 当前阶段判断

项目正在从“关键词路由 + handler 模板回复”转向“Agent Runtime + 工具调用 + 记忆”的形态。

用户明确否定了旧命令式体验。当前产品目标不是让用户记住指令，而是：

```text
用户自然语言 + 会话记忆
→ AI 判断是否需要工具
→ 工具执行确定性动作
→ AI 读取工具结果并生成最终回复
→ 保存记忆和日志
```

旧关键词路由不再应作为用户消息入口。旧 handler 可以继续作为底层工具复用。

## 2. 当前代码状态

当前本地代码已经实现 Agent Runtime v1。

关键文件：

- `src/router/message.ts`
  - 当前用户消息入口。
  - 已改为只调用 `runAgentTurn()`。
  - 不再使用旧关键词路由作为主路径。

- `src/agent/runtime.ts`
  - 新 Agent Runtime。
  - 负责选择工具、执行工具、让模型基于工具结果生成最终回复。
  - 当前支持工具：
    - `query_holding_pool`
    - `add_holding_stocks`
    - `remove_holding_stocks`
    - `query_watchlist`
    - `add_watchlist_stocks`
    - `remove_watchlist_stocks`
    - `none`
  - `none` 代表直接回答，不再回退旧路由。

- `src/agent/memory.ts`
  - 轻量会话记忆。
  - 存在 `settings` 表中，key 形如 `conversation_memory:{userId}`。
  - 当前记忆字段：
    - `activePool`
    - `currentTopic`
    - `lastMentionedStocks`
    - `lastAction`

- `src/handlers/portfolio.ts`
  - 持有股票池底层工具。
  - 持仓语义已经改为“持有股票池”，不要求成本和数量。
  - 支持通过股票名称解析代码。

- `src/handlers/watchlist.ts`
  - 自选池底层工具。
  - 已新增结构化工具接口 `handleWatchlistTool()`。

- `src/services/stock-resolver.ts`
  - 股票名称/代码解析工具。
  - 用腾讯股票搜索确认名称到代码。

- `src/services/stock.ts`
  - 修复过腾讯搜索返回字段解析：返回格式是 `市场~代码~名称`。

## 3. 当前本地验证结果

本地服务地址：

```text
http://localhost:22648/admin/weixin
```

当前只建议本地测试，不要每次部署服务器。

已验证通过的体验：

```text
看一下我现在的持仓有哪些
```

会调用 `query_holding_pool`，再由 AI 生成自然回复。

```text
再把这个池子里添加两个阳光电源和宁德时代
```

会调用 `add_holding_stocks`，加入持有股票池。

```text
算了，把它移除吧
```

会引用上一轮 `lastMentionedStocks`，调用 `remove_holding_stocks`。

`npm run smoke` 已加入 Agent 级回归测试，并在本地通过。

## 4. 当前重要限制

### 4.1 服务器不是最新开发重点

用户已明确要求当前阶段以本地测试为主，先不要每次部署到火山云。

火山云信息仍可参考：

- 管理页：`http://118.145.115.197:22648/admin/weixin`
- 部署脚本：`./scripts/deploy-volcano.sh`

但本轮 Agent Runtime 最新迭代主要在本地验证。

### 4.2 Runtime 工具范围仍很窄

Agent Runtime v1 目前只覆盖：

- 持有股票池
- 自选池
- 直接回答

还未结构化接入：

- 提醒设置/查看
- 监控规则概览
- 交易预案
- 复盘
- 行情分析
- 选股问答

这些旧 handler 仍存在，但不应再通过关键词路由直接接管用户消息。

### 4.3 监控语义仍需补工具

用户问：

```text
目前来说，我做了哪些监控呢？监控的汇报指标是什么呢？
```

当前 Runtime 会直接回答。这个比错误返回持仓列表好，但还没有真实查询 `alerts`、`stock_plans`、`alert_events`。

下一步应新增工具：

```text
query_monitor_overview
```

它应回答：

- 当前监控池来源：持有股票池、自选池。
- 当前有哪些提醒规则。
- 每个规则的指标、阈值、开关。
- 最近触发了哪些提醒。
- 用户反馈过哪些提醒有效/无效/误报。
- 当前缺口：主力控盘、资金流等直接数据暂缺。

### 4.4 最终回复风格还需约束

现在最终回复由 AI 根据工具结果生成，比工具模板自然很多，但仍可能：

- 过度礼貌或过度解释。
- 每次重复“持仓池不要求成本和数量”。
- 没有严格区分“已查询事实”和“产品能力说明”。

后续可优化 `FINAL_REPLY_PROMPT`。

## 5. 接手后的推荐工作顺序

### Step 1：继续本地体验测试

先保持本地服务运行：

```bash
npm run build
npm start
```

测试重点：

- 自然语言维护持有股票池。
- 自然语言维护自选池。
- “这个池子 / 它 / 这两个 / 刚才那几个”的指代。
- 不需要工具的问题是否能直接回答。
- 需要工具的问题是否调用正确工具。

查看日志：

```text
Agent Runtime: tool=...
工具结果: ...
最终回复: ...
更新记忆: ...
```

### Step 2：补 `query_monitor_overview`

这是当前最优先的工具缺口。

建议输出结构先不用复杂，底层工具可以返回文本或结构化对象，但最好逐步转成结构化结果。

数据来源：

- `portfolio`：持有股票池。
- `watchlist`：自选池。
- `alerts`：提醒规则。
- `stock_plans`：人工交易预案。
- `alert_events`：触发记录和反馈。

### Step 3：把 alert/review/plan 纳入 Runtime

不要恢复旧关键词路由。

建议新增工具：

- `query_alert_rules`
- `set_alert_rule`
- `remove_alert_rule`
- `query_stock_plan`
- `set_stock_plan`
- `generate_daily_review`
- `query_review`

工具负责确定性执行；AI 负责理解用户自然语言和最终回复。

### Step 4：完善 trace

目前日志只落 stdout。后续建议新增 `agent_traces` 表或写入 `settings`/日志文件，记录：

- userId
- userMessage
- memoryBefore
- toolPlan
- toolResult
- finalReply
- memoryAfter
- createdAt

这对测试阶段非常关键。

### Step 5：扩大 Runtime 工具面

完成监控概览后，再逐步接入提醒、交易预案、复盘、选股问答和行情分析。旧 handler 可以作为底层工具复用，但用户消息主入口仍应保持：

```text
message.ts → runAgentTurn() → tool/direct answer/clarification → final reply
```

不要把旧关键词匹配重新放回用户主链路。

## 6. 当前设计原则

接手时请坚持以下原则：

1. 不再新增关键词主路由。
2. AI 是对话总控，不是分类器。
3. 工具只做确定性执行、事实校验和落库。
4. 工具结果不要直接等同于最终用户回复。
5. 用户不需要记指令，不需要提供股票代码。
6. 不确定时追问；能根据上下文判断时不要多余确认。
7. 投资输出必须说明不确定性，不承诺收益，不自动交易。

## 7. 重要上下文

用户对当前体验的核心要求：

- “我们要做的是 Agent。”
- “定性的决策路由应该由 AI 把握。”
- “只有完全确定性的东西才要工具去执行。”
- “旧命令格式不要保留，它太蠢了。”

因此，后续优化重点不是补更多命令，而是把 Runtime 做成真正的 Agent 回合。
