---
name: invest-agent-industry-outlook-analysis
description: Analyze an industry, concept, or theme from the Invest Agent methodology angle. Use when stock screening needs a dedicated industry outlook step covering policy support, market space, growth stage, technology route, and competitive structure before narrowing companies.
---

# Invest Agent Industry Outlook Analysis

## Purpose

Turn a user topic such as an industry, concept, policy theme, or technology route into a concise industry judgment that can be reused by screening, review, or watchlist decisions.

## Required Context

Read first:

1. `AGENTS.md`
2. `docs/02-investment-methodology.md`

Use any deterministic context already provided by the runtime. Do not invent exact market-size or policy figures when you do not have a reliable source in context.

## Workflow

1. Clarify the topic:
   - Industry, concept, upstream/midstream/downstream link, or policy theme.
   - Short-cycle catalyst or long-cycle structural direction.

2. Judge policy support:
   - Is there a policy tailwind, subsidy, procurement, strategic planning, or SOE/large-capital participation.
   - Distinguish long-term industrial policy from short-term stimulus.

3. Judge market space:
   - Is the market still expanding, or already mature and crowded.
   - Is penetration still rising, or has the theme become consensus trade.

4. Judge industry structure:
   - Technology route.
   - Supply-chain bottlenecks.
   - Competition intensity.
   - Whether profits are likely to stay with leaders, integrators, or component players.

5. Produce a directional conclusion:
   - Worth tracking now / only event-driven / temporarily avoid.
   - Key validation signals for the next stage.

## Output Structure

```markdown
## 行业前景判断

- 主题：
- 当前结论：

### 事实
- 政策：
- 市场空间：
- 产业阶段：
- 竞争格局：

### 推断
- 最可能受益环节：
- 当前更像长期机会还是短期催化：

### 风险
- 最大不确定性：
- 需要继续验证的点：
```

## Quality Rules

- Separate policy fact from market interpretation.
- Do not jump from “政策支持” directly to “股票一定受益”.
- If the topic is already overcrowded, say so clearly.
- Output should support later company screening, not replace it.
