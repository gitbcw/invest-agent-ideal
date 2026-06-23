---
name: invest-agent-technical-entry-analysis
description: Evaluate technical timing for Invest Agent screening candidates. Use when candidate stocks need a dedicated technical-position pass covering long-term percentile, recent abnormal activity, support/resistance, trend, volume, and entry observation conditions.
---

# Invest Agent Technical Entry Analysis

## Purpose

Translate “这家公司不错” into “现在适不适合观察、等回踩、还是先别碰”.

## Required Context

Read first:

1. `AGENTS.md`
2. `docs/02-investment-methodology.md`

Use runtime quote, K-line, support/resistance, MACD, volume, and any capital-flow context already collected. If chip concentration or direct main-force control is absent, say so.

## Workflow

1. Judge location:
   - Price position within the past year.
   - Whether it is low-position accumulation, mid-trend continuation, or high-position extension.

2. Check abnormal activity:
   - Recent surge days.
   - Abnormal volume bursts.
   - Whether there are signs of repeated active large prints if the context mentions them.

3. Check trend structure:
   - Moving-average structure.
   - MACD direction.
   - Volume confirmation.
   - Support/resistance.

4. Convert to observation conditions:
   - Watch now.
   - Wait for pullback.
   - Wait for breakout confirmation.
   - Avoid for now.

## Output Structure

```markdown
## 技术位置判断

- 公司：
- 当前定位：

### 事实
- 一年位置：
- 趋势结构：
- 量能：
- 支撑/压力：

### 推断
- 当前更像低位启动、震荡蓄势、还是高位扩张：

### 观察条件
- 适合立即观察的条件：
- 需要等回踩的条件：
- 需要等突破确认的条件：
```

## Quality Rules

- Separate “可观察” from “可出手”.
- No direct claims about 主力控盘 unless the context truly contains that data.
- A good company with a bad technical location should be labeled “等待条件” rather than forced into a buy-style conclusion.
