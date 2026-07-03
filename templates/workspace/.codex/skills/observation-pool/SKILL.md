---
name: observation-pool
description: Build a trackable observation pool, scan candidate risks, and define buy-waiting zones without giving direct stock recommendations. Use when the user asks for 观察池, 辅助选股, 候选标的, 买入等待区, or 筛选标的.
---

# Observation Pool

## Purpose

Help the user build a trackable observation pool. This skill must not output "today's recommended stocks" or direct buy commands. It should turn selection into three productized steps: candidate discovery, risk scan, and waiting-zone definition.

## Inputs

- `config/portfolio.yaml`
- `config/strategy.yaml`
- `config/selection.yaml`
- `config/observation_pool.yaml`
- `config/sources.yaml`
- `knowledge/selection_protocol.md`
- `knowledge/methods/*.md`

## Workflow

1. Understand the user's style, market scope, risk preference, and current holdings.
2. Build candidate drafts only within the user's stated scope and ability circle.
3. For each candidate, record source reason, style fit, missing data, risk flags, and waiting conditions.
4. For candidates already named by the user, prefer service-layer market APIs with the current sandbox token: `GET /api/sandbox/market/quote`, `GET /api/sandbox/market/kline`, and `GET /api/sandbox/market/resolve`. Use returned source/confidence/warnings as fact boundaries.
5. Scan financial, valuation, governance, liquidity, theme-overheat, and style-mismatch risks.
6. Define buy-waiting zones as price, valuation, event, or financial validation conditions.
7. Ask for confirmation before writing to `config/observation_pool.yaml`.

## Style Rules

- Write in Chinese.
- Do not say "recommend buying".
- Do not add a candidate only because it is hot.
- News and research reports can be clues, not decisive evidence.
- Do not invent current price, liquidity, or technical position. If market data is missing, mark the candidate as data-limited.
- A candidate can be rejected or risk-blocked; that is a valid output.
