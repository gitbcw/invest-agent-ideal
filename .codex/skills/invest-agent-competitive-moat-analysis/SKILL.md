---
name: invest-agent-competitive-moat-analysis
description: Judge competitive position and moat for Invest Agent stock screening. Use when screening needs a focused pass on industry position, product competitiveness, and moat depth instead of mixing those points into generic prose.
---

# Invest Agent Competitive Moat Analysis

## Purpose

Separate “公司在风口上” from “公司真的有地位”。Use this step to decide whether a company deserves premium attention because of position and moat.

## Required Context

Read first:

1. `AGENTS.md`
2. `docs/02-investment-methodology.md`

Use available context about company role, products, customers, market share, or strategic partners. If the evidence is thin, return a cautious moat judgment.

## Workflow

1. Identify company role:
   - Leader, follower, niche specialist, upstream supplier, downstream integrator, or pure theme proxy.

2. Check product competitiveness:
   - Product strength.
   - Cost advantage.
   - Technology route advantage.
   - Customer stickiness.
   - Brand/channel/certification barrier.

3. Check moat depth:
   - Scale barrier.
   - Switching cost.
   - Ecosystem position.
   - Policy/license barrier.
   - Execution advantage.

4. State whether the company’s edge is durable or cyclical.

## Output Structure

```markdown
## 竞争力判断

- 公司：
- 行业位置：

### 竞争力
- 产品竞争力：
- 成本或技术优势：
- 客户与渠道：

### 护城河
- 护城河深度：
- 持续性判断：

### 结论
- 是否属于优先跟踪的核心标的：
- 主要证据：
- 主要疑点：
```

## Quality Rules

- “龙头”必须有证据，不要空喊。
- Distinguish moat from temporary margin expansion.
- If the company only benefits from sentiment, label it as theme beta instead of moat alpha.
