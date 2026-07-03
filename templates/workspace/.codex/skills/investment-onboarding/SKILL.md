---
name: investment-onboarding
description: Guide a new user through WeChat-based setup when portfolio memory is empty, including holdings, watchlist, methods, skill templates, schedules, and market-watch rules. Use when the user starts setup, sends holdings, sends a screenshot, or asks to adjust memory.
---

# Investment Onboarding

## Purpose

Reduce setup cost through WeChat while preventing memory pollution. Every long-term write must be summarized and confirmed before saving.

## Workflow

1. If `config/portfolio.yaml` has no holdings and no watchlist, start first-use guidance.
2. Ask the user to provide holdings and watchlist by text or screenshot.
3. Parse the input into a structured draft, mark ambiguous or missing fields, and ask for confirmation.
4. After confirmation, write holdings to `config/portfolio.yaml`, update `AGENTS.md` summary if needed, and append `memory/change_log.jsonl`.
5. Keep cold start light: first confirm holdings/cash/watchlist, then style pack, then review schedule, market-watch schedule, and P0/P1/P2 notification policy.
6. Offer default style packs from `config/style_packs.yaml`: 稳健价值型, 指数配置型, 趋势辅助型. The user may select a pack, customize it, or describe a fully custom style through WeChat.
7. Based on holdings and selected/custom style, suggest fundamental, technical, macro, and risk methods. Let the user adjust by WeChat.
8. Summarize method changes and ask for confirmation before writing `knowledge/methods/*.md`.
9. Generate daily, weekly, monthly, company-analysis, QA, and market-watch ability templates for confirmation.
10. Ask the user to confirm review schedules, market-watch fixed times or frequency, notification policy, and market-watch preferences.

For the `review_schedule`, `market_watch_schedule`, `notification`, and `watch_rules` onboarding steps, prefer the lightweight service endpoint `POST /api/sandbox/onboarding/confirm-step`. It updates onboarding progress and default workspace preferences without expanding the turn into many file edits.

Market-watch schedule times have exactly one source of truth: `config/schedules.yaml` field `market_watch.default_windows`. Do not copy fixed intraday schedule times into `config/watch.yaml` or `config/notification.yaml`.

The `market_watch_schedule` step must be explicit in the user-visible reply: list the exact market-watch check times, for example `09:55 / 11:20 / 14:30`, and ask the user to confirm or customize them before moving to notification policy.

Confirming the `watch_rules` onboarding step means the user accepts the default watch policy and quiet notification boundaries. It must not automatically call watch-rule catalog/validate/create or batch-create concrete MA, price, or indicator rules. Create concrete watch rules only after a separate explicit user request such as “现在创建这些提醒规则” or “批量创建均线提醒”.

## Confirmation Rules

Require confirmation before writing:

- Holdings, cash, or watchlist.
- Strategy or position roles.
- Selected style pack or custom style.
- Analysis methods.
- Skill templates and schedules.
- Notification policy and operation confirmation rules.
- Watch rules and alert thresholds.
- Information sources and report paths.

## Response Style

- Keep WeChat messages short.
- Use structured drafts and clear confirmation prompts.
- Never silently write unconfirmed user text into memory.
