---
name: invest-agent-strategy-middle-trend
description: "Use this skill when an Invest Agent instance follows or is being shaped toward a middle-term trend investment practice. It provides the strategy skill engineering unit: protected skeleton rules, instance-specific expansion rules, review discipline, alert/watch rules, screening preferences, and confirmation-based evolution."
---

# Middle-Term Trend Strategy

## Purpose

This skill is a strategy engineering unit for middle-term trend investing.

It is not only a prompt. It contains a protected strategy skeleton plus instance-specific expansion material. The skeleton defines the stable practice. The instance expansion carries one user's interpretation, aesthetic preferences, execution discipline, and accumulated confirmed lessons.

## Loading Order

1. Read `references/skeleton.md` for the protected strategy skeleton.
2. Read the matching instance file under `references/instances/` when the current `instanceId` is known.
   - `invest-agent-jr-method-tester-2.md` is the current JR method tester expansion.
   - If no exact file exists, use `default.md`.
3. Read task-specific references only as needed:
   - `references/review.md` for daily/weekly/monthly review.
   - `references/screening.md` for stock screening and research QA.
   - `references/alerts.md` for watchlist, alerts, and low-noise monitoring.
   - `references/evolution.md` for method updates and candidate handling.

## Governance Boundary

Single-user instances may evolve only their instance expansion layer.

Single-user instances must not directly modify:

- `references/skeleton.md`
- shared workflow rules in this `SKILL.md`
- shared task references unless the platform maintainer explicitly requests it

If a user-specific lesson appears broadly useful, record it as a maintainer-facing skeleton improvement candidate. Do not apply it to the skeleton automatically.

## Runtime Boundary

Use the Invest Agent service for deterministic state: holdings, watchlist, alerts, plans, reviews, viewpoints, audit logs, and push state.

Use this skill for investment method and output discipline. Do not invent holdings, prices, alerts, or plans. Missing data should be named plainly.

## Evolution Rule

When a conversation, review, or alert outcome implies a durable change:

1. Decide whether it affects the instance expansion or the protected skeleton.
2. For instance-specific changes, produce an instance update candidate and require user confirmation before applying it.
3. For skeleton-level changes, produce a maintainer candidate only. The user instance cannot approve it into the skeleton.
4. Keep facts, inference, action, validation, and invalidation signals separate.

