---
name: invest-agent-company-value-analysis
description: Evaluate a company's value quality for Invest Agent screening. Use when candidate stocks need a structured company-value pass covering financial quality, profitability trend, cash flow, efficiency, and valuation rather than only theme relevance.
---

# Invest Agent Company Value Analysis

## Purpose

Assess whether a candidate company deserves to stay in the screening shortlist from the angle of business quality and financial discipline.

## Required Context

Read first:

1. `AGENTS.md`
2. `docs/02-investment-methodology.md`

Use deterministic runtime data when available. If exact financial fields are missing, switch to qualitative grading and state the data gap.

## Workflow

1. Start with business-fit summary:
   - What part of the industry chain the company occupies.
   - Why it matters for this theme.

2. Review financial quality using the image-derived framework:
   - ROE trend.
   - Cash flow quality.
   - Revenue growth.
   - Profit growth.
   - Gross margin trend.
   - Period expense ratio.
   - Inventory turnover.
   - Per-share operating cash flow.
   - ROIC or capital return efficiency.
   - ROA or asset-use efficiency.
   - PE / PEG only as valuation context, not isolated truth.

3. Classify each item:
   - Strength.
   - Neutral.
   - Weakness.
   - Unknown because data is missing.

4. Give an overall company-value judgment:
   - High-quality core candidate.
   - Worth observing but not yet clean.
   - Theme-related but company quality weak.

## Output Structure

```markdown
## 公司价值判断

- 公司：
- 总体结论：

### 财务评估
- ROE：
- 现金流：
- 营收增长：
- 利润增长：
- 毛利率与费用率：
- 周转效率：
- 资本回报：
- 估值位置：

### 结论
- 主要优点：
- 主要短板：
- 是否适合进入精选名单：
```

## Quality Rules

- Do not fabricate precise quarterly formulas when the raw data is not present.
- Valuation is a tie-breaker, not the whole thesis.
- A company can be theme-correct but value-quality mediocre; say that plainly.
