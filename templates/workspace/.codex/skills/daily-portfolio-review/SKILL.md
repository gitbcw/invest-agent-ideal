---
name: daily-portfolio-review
description: Generate and publish a daily Chinese portfolio review using named market and portfolio tools, auditable evidence, the user's confirmed strategy, and the reviews.save publication contract.
---

# Daily Portfolio Review

Use `service-capability-policy`. Do not call localhost HTTP, shell fallbacks, sandbox tokens, or service files.

## Evidence And Analysis

1. Read the user's confirmed portfolio, watchlist, plans, strategy, schedules, notification preference, and relevant Workspace methods.
2. Inspect the currently exposed MCP read capabilities and choose the narrowest useful sources. Use service MCP for current portfolio/watchlist/plan state and external read-only data MCP for indices, targeted quotes, price history, flows, themes, announcements, financial reports, or news when available. Tool selection follows the task and returned evidence, not a hard-coded Workspace inventory.
3. Record the data cutoff, source confidence, warnings, conflicts, and missing evidence. Never invent exact prices or events.
4. Separate facts, inference, action, required user confirmation, validation signals, and invalidation signals.
5. Connect any action suggestion to the user's confirmed strategy, plans, rules, position state, and risk discipline. Do not promise returns or imply automatic trading.
6. When one market dimension is missing, continue the review with the other verified dimensions. Identify the affected conclusion, data cutoff, and coverage boundary; do not turn a partial portfolio or market picture into a blanket no-answer.

The report structure and length should follow the actual day rather than a fixed word count. It must still make the three decisions easy to find: whether action is needed, whether attention is needed, and whether user confirmation is needed.

## Publication Contract

Publish through `reviews.save`:

- `content`: the complete Markdown report.
- `pushBrief`: an independently written decision-complete WeChat review, separate from `content` but not merely a headline or teaser.
- `decisionRecords`: only important views that require later validation.
- `sourceEvents`: material data gaps, staleness, or conflicts.

For a scheduled daily review, successful `reviews.save` is the only completion path. If it fails, do not output an unpublished review or brief. After success, the final response must exactly match the saved `pushBrief` and must not mention tools, paths, or publication mechanics.

## WeChat Brief Requirements

The WeChat brief is the user's primary notification and must stand on its own for the next decision. Keep it materially shorter than the full report, but do not compress away the reasoning needed to act:

- On an ordinary trading day, target roughly 400-700 Chinese characters; on a material market, portfolio, or data-risk day, target roughly 700-1000 characters.
- Always include the three decisions: whether action is needed, whether attention is needed, and whether user confirmation is needed.
- Include the key portfolio or watchlist facts, the most important inference, and whether a prior tracked view was supported, weakened, or still unverified.
- Include the next validation signal or invalidation condition, plus the most relevant data cutoff/source-quality caveat.
- Mention only material positions, risks, and levels. Do not pad the brief with a full holding table or repeat the complete report.
- Write the brief as concise Markdown that WeChat can render. Use `**bold**` for decision labels or key conclusions, keep clear paragraph breaks, and add lists or short headings when they improve scanning; do not return an unformatted wall of text.
- End with `回复“查看完整复盘”获取完整报告。` when the full report contains material detail that is not included in the brief.

When the user explicitly asks to generate a review, that request authorizes saving this report; use the tool's user-request confirmation field and do not add a redundant confirmation round.
