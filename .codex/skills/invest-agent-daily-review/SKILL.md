---
name: invest-agent-daily-review
description: Generate or improve an Invest Agent daily review using the project runtime data model, user methodology, holdings, watchlist, alerts, stock plans, market data, capital flow, information filters, and prior review discipline. Use when the user asks for 日复盘, 每日复盘, 收盘复盘, 今日复盘, 明日关注, review quality improvement, or migrating the jr-backend review practice into Invest Agent.
---

# Invest Agent Daily Review

## Purpose

Produce a daily Chinese investment review that is more disciplined than the old service-generated review. The review must connect market facts, holdings/watchlist performance, alert events, trading plans, information changes, and tomorrow's observation rules.

This skill is workflow guidance. It should not replace deterministic code that collects data from SQLite, stock services, alert events, and plans.

## Required Inputs

Read project context first:

1. `AGENTS.md`
2. `CLAUDE.md`
3. `docs/02-investment-methodology.md`
4. `docs/04-core-workflows.md`
5. Existing review files in `reviews/`

When working through the running service, first request a deterministic context package. The service should provide:

- Market index data.
- Current holdings and watchlist quotes.
- Technical indicators.
- News/announcement/research snippets when available.
- Today's alert events and feedback.
- Existing stock plans.
- The latest daily plan/review.

## Workflow

### Service Context Workflow

If the prompt already includes a deterministic review context JSON from the service, use that context directly. Do not call curl or any service API again in that case. In that mode, do not save the report manually either; the service owns persistence and push.

If Codex is running standalone and no review context JSON was supplied, fetch deterministic context from the running service:

```bash
curl --max-time 180 -s -X POST http://localhost:22648/api/reviews/context \
  -H 'Content-Type: application/json' \
  -d '{}'
```

Use the returned `context` to write the full review according to this skill. Only when running standalone and the service did not already own persistence, save it back through the service:

```bash
curl --max-time 60 -s -X POST http://localhost:22648/api/reviews/save \
  -H 'Content-Type: application/json' \
  -d '{"date":"YYYY-MM-DD","content":"FULL_REVIEW_MARKDOWN","summary":"WECHAT_SUMMARY"}'
```

For WeChat/mobile service-owned flows, return the full customer-readable review text only. Do not mention local paths, localhost, ports, internal component names, logs, APIs, saving actions, or background execution details to the customer.

1. Establish today's market style:
   - Broad up/down.
   - High-to-low switch, technology retreat, resource retreat, consumption repair, defensive rotation, or broad selloff.
   - Do not infer risk only from index movement.

2. Build one authoritative stock table:
   - Holdings and watchlist should be clearly separated.
   - Include latest price, change, technical status, relevant signal, plan relationship, and information changes.
   - Do not duplicate inconsistent profit/loss numbers in prose.

3. Review alert events:
   - Classify each important alert as 命中, 误报, 待验证, or 未评估.
   - Explain whether the alert matched the previous plan.
   - Record whether signal parameters need adjustment.

4. Review plans:
   - For each holding/watchlist stock, state whether support/resistance/target/stop-loss still makes sense.
   - If the plan should change, give the old value, new value, and reason.
   - If there is no plan, suggest a cautious draft plan and mark confidence.

5. Information filter:
   - Separate announcement facts, news interpretations, and research opinions.
   - State whether each information item affects holdings, watchlist, industry trend, or only market noise.

6. Action guidance:
   - Use "观点 / 理由 / 操作 / 验证点".
   - Avoid forced trades.
   - When a stock reaches a zone, distinguish observation, small action, and high-confidence action.

7. Viewpoint tracking:
   - If the context includes `openViewpoints`, add a "上一轮观点回测" section before tomorrow's actions.
   - Use exactly this table shape so the service can update structured viewpoint status:
     `| 编号 | 状态 | 回测说明 |`
   - 状态 must be one of: `validated`, `invalidated`, `pending`.
   - Use `validated` only when the validation signal clearly happened, `invalidated` when the view was clearly wrong, and `pending` when it still needs observation.
   - Then create a new "观点追踪表" for today's important views.

8. 主力控盘情况:
   - Put this as the final analytical section, after holdings, watchlist, alerts, information, and tomorrow's actions.
   - Do not use capital-flow net inflow as a substitute for control analysis.
   - If no reliable deterministic 主力控盘 / 筹码集中度 / 逐笔成交 data is provided, say briefly that this data source is not connected yet and do not make a control conclusion.

9. Persistence boundary:
   - In service-owned WeChat/mobile flows, the service is responsible for saving artifacts and pushing the final reply.
   - In standalone runs without service-owned persistence, save through `/api/reviews/save`.
   - WeChat replies can summarize the full report, but the saved artifact should remain audit-friendly.

## Report Structure

```markdown
# YYYY-MM-DD 日复盘

## 一、核心结论

- 3-6 条最重要判断。

## 二、市场风格与指数表现

- 指数表现：
- 市场风格：
- 情绪与成交：
- 今日最重要的验证点：

## 三、持仓表现

| 标的 | 定位 | 最新价 | 涨跌幅 | 技术状态 | 预案关系 | 今日判断 |
| :--- | :--- | ---: | ---: | :--- | :--- | :--- |

## 四、自选股机会

| 标的 | 关注理由 | 最新价 | 涨跌幅 | 技术状态 | 信息变化 | 是否继续观察 |
| :--- | :--- | ---: | ---: | :--- | :--- | :--- |

## 五、今日提醒回测

| 时间 | 标的 | 信号 | 触发价 | 预案关系 | 结果 | 改进 |
| :--- | :--- | :--- | ---: | :--- | :--- | :--- |

## 六、信息过滤

- 事实：
- 推断：
- 噪音/暂不处理：

## 七、明日操作与观察

### 持仓

使用“观点 / 理由 / 操作 / 验证点”格式。

### 自选

使用“观点 / 理由 / 操作 / 验证点”格式。

## 八、上一轮观点回测

| 编号 | 状态 | 回测说明 |
| :--- | :--- | :--- |

状态只使用 validated / invalidated / pending。

## 九、观点追踪表

| 编号 | 今日观点 | 理由 | 操作建议 | 验证点 | 预计复盘时间 |
| :--- | :--- | :--- | :--- | :--- | :--- |

## 十、主力控盘情况

- 如果有确定性数据：只基于该数据判断。
- 如果没有确定性数据：说明暂未接入可靠数据源，本次不作主力控盘判断。

## 十一、数据来源与限制

- 数据来源：
- 数据缺口：
- 本复盘仅作投资决策辅助，不构成收益承诺。
```

## Quality Rules

- Every important view must include a reason and validation signal.
- Do not use capital-flow net inflow in the daily review unless the user explicitly asks for it.
- Do not call capital flow "主力建仓", "主力控盘", or a control signal.
- Missing 主力控盘, 筹码集中度, or 逐笔成交 data should be disclosed only in the final control/data-limit section, not repeated throughout the report.
- Do not promote a watchlist stock or non-core idea because of one-day strength.
- Keep the final user push short; keep detail in the saved review file.
- Never expose localhost, port numbers, curl commands, API paths, file paths, skill names, Codex/ACP, logs, or internal execution steps in customer-facing text.

## 复盘后续:预案补全/调整引导

复盘报告末尾的 `【预案建议】` 和 `【预案调整建议】` 清单是触发"基于策略起草预案"的入口。注意:

- 清单本身的支撑/压力是 K 线估算,**不是策略匹配结果**。复盘不感知策略实体(见 `docs/trading-strategy-design.md` §7)。
- 如果用户从清单中**主动选择**某一项,进入 `invest-agent-strategy-plan-drafting` SKILL 的两道闸门流程:
  1. 第一道:基于个股上下文 + 策略 applicability,推荐 1 份策略 + 1-2 份备选
  2. 第二道:基于选中策略起草预案草案 → 用户确认后落库
- 不要批量自动起草,不要绕过两道闸门,不要假设用户已默认接受。
- 调整类与新建类走同一流程,只是第二道闸门起草时多了"现有预案 + 当天变化"作为上下文。
