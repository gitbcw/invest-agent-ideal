---
name: market-watch
description: Generate an intraday market-watch brief or help create and inspect explicit deterministic watch rules using named service tools and the user's confirmed notification preference.
---

# Market Watch

Use `service-capability-policy`. Do not call localhost HTTP, curl, sandbox tokens, database files, or hidden service routes.

## Scheduled Brief

`market-watch` is a scheduled intraday brief, not deterministic rule evaluation. `rule-alert-check` is the separate service-owned rule evaluator.

1. Obtain current market facts through at least one exposed MCP read capability before forming a conclusion. Use service MCP for portfolio/watchlist/plan state and scheduler-window evidence; use external read-only data MCP for live quotes, indices, price history, flows, themes, calendar, announcements, or news when available. Choose capabilities by their descriptions and schemas, using the smallest useful combination actually needed.
2. Assess the trading session and source health when useful, but do not treat calendar or health evidence alone as current market evidence.
3. A scheduler-captured window snapshot may be used as immutable audit and comparison evidence, but it is not a live quote or market-data substitute. When sources disagree, state the conflict and reduce conclusion strength.
4. Respect `config/notification.yaml`: active watch may receive window briefs; low disturbance and evening summary do not receive routine intraday pushes.
5. Separate facts, inference, explicit-rule status, risk level, notification decision, evidence time, and the next check.
6. If data is missing, stale, conflicting, or unchanged, say so plainly and reduce conclusion strength. Never fabricate intraday facts.

Risk level is an analysis label, not permission to override the user's notification preference. Suppress routine noise, unverified rumors, and repeated information without a meaningful change.

## Explicit Rules

For a user request to add or inspect a deterministic rule:

1. Read `watch_rules.catalog` and `watch_rules.list`.
2. Use `watch_rules.validate` to create the exact draft.
3. Register the write through `confirmations.request` and wait for a later explicit user confirmation.
4. On confirmation, call `watch_rules.create` with the confirmation contract.
5. Verify using `watch_rules.list` or `watch_rules.dry_run` before saying the rule exists.

Current tools do not authorize modification or deletion. Do not edit `config/watch.yaml` or memory files to imitate a service rule. Keep the final WeChat reply concise and never expose internal tools or execution details.
