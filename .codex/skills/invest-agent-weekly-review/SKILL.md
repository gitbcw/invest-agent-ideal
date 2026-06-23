---
name: invest-agent-weekly-review
description: Generate an Invest Agent weekly review by auditing daily reviews, alert events, plans, signal performance, holdings/watchlist movement, and strategy mistakes. Use when the user asks for 周复盘, 本周复盘, 下周关注, signal quality review, or weekly review migration.
---

# Invest Agent Weekly Review

## Purpose

Turn daily reviews and alert events into a weekly feedback loop. The weekly review should not merely summarize; it should judge whether the week's assumptions, alerts, and plans were useful.

## Inputs

- `AGENTS.md`
- `docs/02-investment-methodology.md`
- Daily review files in `reviews/`
- Alert events from the current week
- Stock plans and any user feedback
- Actual weekly price movement for holdings and watchlist
- `behaviorStats`(WP5.6):本周行为事件统计(action_confirmed / wechat_conversation_turn / out_of_scope_query 计数 + 最近 30 条交易动作详情)

At the current stage, weekly review is still a mixed workflow: it may rely on saved daily reviews plus current database state. If the required week context was not deterministically provided, state the missing days or data gaps explicitly instead of pretending full automation.

## Workflow

1. Identify the week range using China trading calendar conventions where possible.
2. Collect all daily reviews in the week. State missing trading days.
3. Extract daily core views, plans, alerts, and validation points.
4. Pull structured viewpoints from `weekly-context` (字段含 `invalidationSignals`/`validation`/`confidence`/`expectedReviewDate`)。
5. **对 open/pending 状态的观点逐条做回测**(详见下方"观点回测判定"小节):
   - 自行调 `get_quote` / `get_kline` / 资金流接口拉当周行情
   - 根据 `validation`(满足→`validated`)和 `invalidationSignals`(任一触发→`invalidated`)判定状态
   - 不到期的、未触发任何信号的 → `pending`
   - 解析不到单一标的(如板块观点)→ 保留原状态,在报告里说明"未自动回测"
6. Classify views as 命中(validated), 部分命中, 未验证(pending), or 明显错误(invalidated)。
7. Classify alert quality by signal key and stock.
8. Identify process problems:
   - Overreacting to one-day moves.
   - Missing market style switch.
   - Ignoring plan constraints.
   - Treating auxiliary capital flow as a decisive signal.
   - Inconsistent numbers between table and prose.
9. Produce next-week plan suggestions.
10. 输出"观点回测结论"段(格式见 Report Structure 第三节),服务端会解析回填 viewpoint 状态。
11. Save the report as `reviews/YYYY-MM-DD_weekly.md` or the existing project weekly naming convention when the execution context expects artifact output.

## 观点回测判定(WP5.2)

回测只针对 status 为 `open` / `pending` 的观点。已 `validated` / `invalidated` 的不动。

**判定规则**(任一优先级):
- `validation` 条件满足 → 判定 `validated`
- `invalidationSignals` 中任一信号触发 → 判定 `invalidated`
- 都未触发 → 判定 `pending`(若 `expectedReviewDate` 已过,可在依据里标注"已过复核日期")

**判定依据要落到行情事实**:
- 价格类条件(如"跌破 1700"):用 K 线最低价或当前价对比
- 技术指标类(如"MACD 死叉"):用 `get_kline` 拉数据后自行计算或调用指标工具
- 形态类(如"突破前高"):用 K 线最高价对比历史压力位
- 板块/指数类(无法对应单一标的):标 `pending` 并说明"无对应标的"

**输出格式**(报告第三节),供服务端 `syncViewpointResolutions` 解析回填:

```markdown
## 三、日复盘观点回测

| 编号 | 判定 | 日期 | 原观点 | 失效信号 | 当周行情 | 依据 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| v1 | invalidated | 2026-06-15 | 看多茅台 | 跌破 1700;MACD 死叉 | 1685→1688,最低 1680,MACD 死叉 | 跌破 1700(最低 1680),且 MACD 死叉已形成 |
| v2 | pending | 2026-06-16 | 关注新能源 | (未声明) | 板块无对应单一标的 | 无对应标的,需用户手动判断 |
```

- 标题必须是"日复盘观点回测",服务端按此识别
- **第一列必须为编号(如 v1),第二列必须为判定**(服务端解析规则固定)
- "判定"列必须为 `validated` / `invalidated` / `pending` 三者之一,服务端按此解析回填 backend
- 已 validated/invalidated 的观点不需要重复判定,但在表格里仍列出供完整性

## Report Structure

```markdown
# YYYY-MM-DD 至 YYYY-MM-DD 周复盘

## 一、本周核心结论

- 3-6 条最重要判断。

## 二、本周市场与持仓表现

| 项目 | 周初 | 周末/最新 | 周变化 | 判断 |
| :--- | ---: | ---: | ---: | :--- |

## 三、日复盘观点回测

| 编号 | 判定 | 日期 | 原观点 | 失效信号 | 当周行情 | 依据 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |

第一列必须为编号,第二列必须为判定(validated / invalidated / pending 之一),供服务端解析回填。

## 四、提醒与信号质量

| 信号 | 触发次数 | 命中 | 误报 | 待验证 | 处理建议 |
| :--- | ---: | ---: | ---: | ---: | :--- |

## 五、交易预案质量

- 哪些预案有效：
- 哪些预案需要调整：
- 哪些股票缺少预案：

## 六、行为纠偏(WP5.6)

基于 `behaviorStats.recentActions` 自行识别行为模式,代码不做"模式识别",信任 Codex 判断。识别维度:

- **追高**:连续买入同一标的且价格递增(action 序列中 buy 价格单调上升)
- **频繁短线**:open→close 间隔过短(buy 后短时间内 sell)
- **规则外请求**:`outOfScopeCount` 异常多(说明用户偏离方法论)
- **复盘节奏**:`conversationTurnCount` 过低(说明用户没充分对话)或过高(说明反复问同一问题)

输出格式:

```markdown
## 六、行为纠偏

- 交易次数:N(action_confirmed 共 X 条)
- 识别到的偏差:
  - (具体描述,引用 action 的 occurred_at + code + price)
- 建议:
  - (具体改进,如"未来 3 天内不再追加买入 X")
- 数据缺失说明:(若 behaviorStats.available=false,说明"workspace 未启用,行为数据缺失")
```

## 七、明显错误与系统改进

- 错误：
- 原因：
- 改进：

## 八、下周情景判断

| 情景 | 倾向 | 触发条件 | 组合影响 | 应对动作 | 验证点 |
| :--- | :--- | :--- | :--- | :--- | :--- |

## 九、下周检查清单

- 只列可执行事项。

## 十、备注

本报告是复盘与策略改进，不构成确定收益承诺。
```

## Quality Rules

- Distinguish bad process from normal market noise.
- Do not punish a valid plan solely because short-term price moved against it.
- Make concrete suggestions for alert thresholds only when there is enough evidence.
- Weekly review should improve the next daily review template and signal parameters.
- 观点回测依据必须落到行情事实(具体价位、指标读数、日期),不要只说"已触发"。
- 不到复核日期的观点若已触发失效信号,可以判 invalidated,但要在依据里说明"提前触发"。
- Never expose localhost, port numbers, curl commands, API paths, file paths, skill names, Codex/ACP, logs, or internal execution steps in customer-facing text.
