---
name: invest-agent-monthly-review
description: Generate an Invest Agent monthly review from weekly reviews, daily reviews, alert events, plan changes, user feedback, and actual market results. Use when the user asks for 月复盘, 月度复盘, 本月总结, 策略优化, or next-month planning.
---

# Invest Agent Monthly Review

## Purpose

Evaluate whether the investment assistant is improving the user's decision process over a full month. The monthly review should audit strategy quality, signal effectiveness, watchlist conversion, and repeated mistakes.

## Inputs

- `AGENTS.md`
- `docs/02-investment-methodology.md`
- Weekly reviews in `reviews/`
- Daily reviews when weekly reviews are missing
- Alert events and feedback
- Stock plans and plan changes
- Watchlist additions from screening reports
- Actual monthly market and stock performance
- Deterministic monthly context from `/api/reviews/monthly-context` or `/api/sandbox/reviews/monthly-context` when provided by the service.
- `behaviorStats`(WP5.6):本月行为事件统计(action_confirmed / wechat_conversation_turn / out_of_scope_query 计数 + 最近 30 条交易动作详情)

The monthly context currently includes daily review coverage, alert summaries, and structured viewpoint tracking statistics. It does not yet provide a full monthly market-performance table for every holding/watchlist stock. If source coverage is incomplete, say which weekly/daily artifacts, stock movements, or records were missing.

## Workflow

1. Identify the review month.
2. If a deterministic monthly context JSON is already included in the prompt, use it directly; do not call APIs again in service-owned WeChat/mobile flows.
3. Collect weekly reviews and daily reviews when the monthly context is incomplete.
4. Compare earlier monthly/weekly assumptions with actual market behavior.
5. Evaluate each product loop:
   - Screening to watchlist.
   - Watchlist to plan.
   - Plan to alert.
   - Alert to daily review.
   - Daily review to weekly/monthly correction.
6. Identify repeated mistakes and missing data.
7. Use monthly `viewpointSummary` to report validated / invalidated / pending / open counts and repeated judgment errors.
8. **系统性偏差归因(详见下方"偏差识别规则")**:从 viewpointSummary 找重复出错模式,结合本月 methodChangeProposals 已提议清单,通过 `/api/sandbox/method-changes/propose` 落地新候选。
9. Recommend methodology refinements, not just stock opinions. 每条改进必须落到具体方法候选(调 API propose)。
10. Save the report as `reviews/YYYY-MM_monthly.md` or under a future `reviews/monthly/` folder when the execution context expects artifact output.
11. **输出后行动指引(WP5.4)**:报告生成后,在回复末尾附"待用户确认的方法候选"清单(列 candidate_id + 一句话摘要),并明确告诉用户:"回复'采用 N' / '拒绝 N' 即可确认"。等用户后续在微信里回复时,按 service-tools skill 的"候选确认对话模式"处理。

## 输出后行动指引示例(WP5.4)

月复盘回复末尾必须包含类似以下段落(让用户知道有候选待确认、怎么操作):

```markdown
---
📌 **本月提议的方法候选,等你确认**:

- **candidate 27**:在 fundamental 方法里加入"存货周转率同比恶化>15%"作为减仓触发条件
- **candidate 28**:把"忽视 MACD 死叉"列为方法红线
- **candidate 29**:收紧 validation 标准(待回测堆积过多)

回复 "采用 27" 或 "拒绝 27" 即可确认。可批量回复 "采用 27,28"。
```

注意:
- candidate_id 必须真实(来自 `/api/sandbox/method-changes/propose` 返回的 id,或 monthly-context 里 methodChangeProposals 的 id)
- 摘要要具体可执行,不要"加强基本面"这种空话
- 即使本月没有新候选,也要明确说"本月无新提议候选"(避免用户以为系统漏了)

## 偏差识别规则(WP5.3)

月复盘的核心增值是"识别系统性偏差",不是"复述观点回测"。从 `viewpointSummary` 提取的偏差模式包括:

**命中率分析**:
- `validated / (validated + invalidated)` 是本月"判断质量"主指标
- `pending / open` 占比过高 → 决策拖沓,可能"持续 pending"是偏差来源
- `invalidated > validated` → 系统性看多/看空偏差

**重复出错模式**:
- 多条 invalidated 观点的 `reason` 字段聚类相似(如"资金回流"反复失效)→ 该信号源不可靠,提议降权或加约束
- 多条 invalidated 观点的 `invalidationSignals` 反复触发同一个(如"MACD 死叉"反复)→ 该失效信号有效,提议把"忽视 MACD 死叉"列为方法红线
- 同行业/同板块观点反复 invalidated → 该板块方法论缺失,提议补充

**待回测堆积**:
- `pending` 数量 > 总数 50% → 复盘节奏不够,或失效信号设得太宽松,提议收紧 validation 标准

**对照 methodChangeProposals**:
- 已有 proposed 但本月仍反复出错的候选 → 重申并标注"再次出现,优先确认"
- 已 confirmed 但本月效果不佳 → 提议调整或撤销(新候选)
- 没人提议过但明显需要的偏差 → 新提议

**输出方式**:
- 报告"六、策略与方法论改进"段每条改进都要对应一个 API 调用(`/api/sandbox/method-changes/propose`)
- 改进示例格式:
  ```
  - **基本面规则**(已提议 candidate_id=xxx):描述...
  - **技术面规则**(已提议 candidate_id=yyy):描述...
  ```
- 不要在报告里只写空泛方向(如"加强基本面"),必须可执行

## Report Structure

```markdown
# YYYY-MM 月复盘

## 一、本月核心结论

- 3-6 条最重要判断。

## 二、本月市场与组合表现

| 项目 | 月初 | 月末/最新 | 月变化 | 判断 |
| :--- | ---: | ---: | ---: | :--- |

## 三、核心闭环质量

| 闭环 | 本月表现 | 问题 | 改进 |
| :--- | :--- | :--- | :--- |
| 选股问答 -> 自选 |  |  |  |
| 自选 -> 预案 |  |  |  |
| 预案 -> 巡检 |  |  |  |
| 巡检 -> 日复盘 |  |  |  |
| 日复盘 -> 周/月修正 |  |  |  |

## 四、周复盘观点回测

| 周次 | 原观点 | 实际结果 | 结论 | 偏差原因 | 改进 |
| :--- | :--- | :--- | :--- | :--- | :--- |

## 五、信号与提醒表现

- 有效信号：
- 低质量信号：
- 需要关闭/调参的信号：
- 数据缺口：

## 六、系统性偏差归因

- 命中率:validated X / invalidated Y / pending Z / open W
- 重复出错模式:(具体描述,引用具体 reason/invalidationSignals)
- 待回测堆积情况:(具体描述)
- 对照 methodChangeProposals:(已有候选的复述、调整、撤销建议)

## 七、行为纠偏(WP5.6)

基于 `behaviorStats.recentActions` 自行识别月级行为模式,代码不做"模式识别",信任 Codex 判断。识别维度:

- **追高**:连续买入同一标的且价格递增
- **频繁短线**:open→close 间隔过短、月内交易次数异常
- **规则外请求**:`outOfScopeCount` 异常多
- **复盘节奏**:`conversationTurnCount` 与 `dailyReviewCount` 不匹配(说明对话 vs 复盘不平衡)
- **月度趋势**:与上月对比(若可推断)

输出格式:

```markdown
## 七、行为纠偏

- 月度交易次数:N(action_confirmed 共 X 条)
- 识别到的偏差:
  - (具体描述,引用 occurred_at + code + price)
- 与上月对比:(若有数据,描述趋势)
- 建议:
  - (具体改进)
- 数据缺失说明:(若 behaviorStats.available=false)
```

## 八、策略与方法论改进

每条改进都已通过 `/api/sandbox/method-changes/propose` 落地为方法候选。

- 基本面规则(candidate_id=xxx):具体改动描述
- 技术面规则(candidate_id=yyy):具体改动描述
- 信息过滤规则:...
- 仓位/风险规则:...

## 九、下月情景推演

| 情景 | 倾向 | 理由 | 触发条件 | 应对动作 | 验证/失效信号 |
| :--- | :--- | :--- | :--- | :--- | :--- |

## 十、下月检查清单

- 只列可执行事项。

## 十一、备注

本报告是复盘与策略改进，不构成确定收益承诺。
```

## Quality Rules

- Monthly review should update the system, not only judge the market.
- Prefer improving rules over adding many new stocks.
- Any recommendation to change methodology must cite repeated evidence from the month, and must be落地为 `/api/sandbox/method-changes/propose` 调用。
- 命中率低不等于方法全错,可能是市场风格切换。区分"方法错误"和"环境错误"。
- 已有 proposed 候选不要重复提议;已 confirmed 但效果差的提议"调整"而非新提议。
- Never expose localhost, port numbers, curl commands, API paths, file paths, skill names, Codex/ACP, logs, or internal execution steps in customer-facing text.
