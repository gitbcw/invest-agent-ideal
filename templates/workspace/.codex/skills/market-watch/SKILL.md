---
name: market-watch
description: Generate an intraday market-watch brief or help create and inspect explicit deterministic watch rules using named service tools and the user's confirmed notification preference.
---

# Market Watch

Use `service-capability-policy`. Do not call localhost HTTP, curl, sandbox tokens, database files, or hidden service routes.

## Scheduled Brief

`market-watch` is a scheduled intraday brief, not deterministic rule evaluation. `rule-alert-check` is the separate service-owned rule evaluator.

1. Call `market_watch.snapshot` for the current scheduled window. It is the authoritative window snapshot and change set.
2. Use `market.snapshot` only when current holdings, watchlist, plans, or broader market context are additionally required.
3. Respect `config/notification.yaml`: active watch may receive window briefs; low disturbance and evening summary do not receive routine intraday pushes.
4. Separate facts, inference, explicit-rule status, risk level, notification decision, evidence time, and the next check.
5. If data is missing, stale, conflicting, or unchanged, say so plainly and reduce conclusion strength. Never fabricate intraday facts.

Risk level is an analysis label, not permission to override the user's notification preference. Suppress routine noise, unverified rumors, and repeated information without a meaningful change.

## Explicit Rules

For a user request to add or inspect a deterministic rule:

1. Read `watch_rules.catalog` and `watch_rules.list`.
2. Use `watch_rules.validate` to create the exact draft.
3. Register the write through `confirmations.request` and wait for a later explicit user confirmation.
4. On confirmation, call `watch_rules.create` with the confirmation contract.
5. Verify using `watch_rules.list` or `watch_rules.dry_run` before saying the rule exists.

Current tools do not authorize modification or deletion. Do not edit `config/watch.yaml` or memory files to imitate a service rule. Keep the final WeChat reply concise and never expose internal tools or execution details.
