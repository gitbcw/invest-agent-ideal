---
name: daily-portfolio-review
description: Generate and publish a daily Chinese portfolio review using named market and portfolio tools, auditable evidence, the user's confirmed strategy, and the reviews.save publication contract.
---

# Daily Portfolio Review

Use `service-capability-policy`. Do not call localhost HTTP, shell fallbacks, sandbox tokens, or service files.

## Evidence And Analysis

1. Read the user's confirmed portfolio, watchlist, plans, strategy, schedules, notification preference, and relevant Workspace methods.
2. Use `market.snapshot` as the primary current portfolio and index fact source. Add `market.quote`, `market.kline`, `market.indices`, `market.capital_flow`, `market.sector_theme`, or `market.stock_info` only when needed.
3. Record the data cutoff, source confidence, warnings, conflicts, and missing evidence. Never invent exact prices or events.
4. Separate facts, inference, action, required user confirmation, validation signals, and invalidation signals.
5. Connect any action suggestion to the user's confirmed strategy, plans, rules, position state, and risk discipline. Do not promise returns or imply automatic trading.

The report structure and length should follow the actual day rather than a fixed word count. It must still make the three decisions easy to find: whether action is needed, whether attention is needed, and whether user confirmation is needed.

## Publication Contract

Publish through `reviews.save`:

- `content`: the complete Markdown report.
- `pushBrief`: an independently written concise WeChat brief.
- `decisionRecords`: only important views that require later validation.
- `sourceEvents`: material data gaps, staleness, or conflicts.

For a scheduled daily review, successful `reviews.save` is the only completion path. If it fails, do not output an unpublished review or brief. After success, the final response must exactly match the saved `pushBrief` and must not mention tools, paths, or publication mechanics.

When the user explicitly asks to generate a review, that request authorizes saving this report; use the tool's user-request confirmation field and do not add a redundant confirmation round.
