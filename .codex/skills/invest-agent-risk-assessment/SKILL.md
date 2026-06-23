---
name: invest-agent-risk-assessment
description: Assess downside and uncertainty for Invest Agent screening candidates. Use when screening needs a dedicated risk pass covering margin of safety, drawdown risk, volatility, crowding, data gaps, and why a candidate may still be unsuitable despite attractive industry or company logic.
---

# Invest Agent Risk Assessment

## Purpose

Prevent screening from becoming a one-sided bullish report. This step forces downside, uncertainty, and execution risk into the final candidate judgment.

## Required Context

Read first:

1. `AGENTS.md`
2. `docs/02-investment-methodology.md`

Use deterministic technical or valuation context when available. If safety margin cannot be estimated reliably, say so directly.

## Workflow

1. Assess valuation/risk cushion:
   - Is there a visible safety margin.
   - If no reliable valuation basis exists, say “安全边际暂不清晰”.

2. Assess price risk:
   - Drawdown risk.
   - Volatility.
   - Whether the stock is already crowded or extended.

3. Assess thesis risk:
   - Policy reversal.
   - Technology route uncertainty.
   - Demand-cycle risk.
   - Execution risk.
   - Information/data blind spots.

4. Convert risk into action language:
   - Can observe.
   - Observe only with strict trigger.
   - Not suitable now.

## Output Structure

```markdown
## 风险评估

- 公司：
- 风险结论：

### 风险来源
- 安全边际：
- 回撤与波动：
- 主题风险：
- 公司执行风险：
- 数据缺口：

### 风险后的动作建议
- 可以观察但需满足：
- 触发回避的条件：
```

## Quality Rules

- Risk must change the recommendation, not sit as decoration.
- If drawdown risk is obvious, say it early.
- Do not hide data gaps behind fluent wording.
