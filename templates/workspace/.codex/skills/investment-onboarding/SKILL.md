---
name: investment-onboarding
description: Guide a new investment user through the service-owned onboarding draft when setup is incomplete, including holdings, watchlist, style, review schedule, market-watch windows, notification preference, and optional explicit rules.
---

# Investment Onboarding

Use `service-capability-policy` for every read and write. `config/onboarding_state.yaml` is the first initialization gate; the service-owned draft is only the progress source when that state is not completed. Do not edit Workspace YAML directly and do not call legacy HTTP or shell fallbacks.

## Start Or Resume

1. Read `config/onboarding_state.yaml` first.
2. If `status` is `completed`, stop onboarding. Handle ordinary investment requests normally; do not call any `onboarding.draft.*` write tool and do not let an old or unrelated active draft block the request.
3. Only when `status` is not `completed`, call `onboarding.draft.get` and continue from its `nextStep` without repeating accepted information.
4. A new or revised draft requires explicit user intent to start or change initialization, such as “重新配置投资风格”“重新录入持仓” or “修改初始化设置”. A review, holdings query, market question, screening request, or next-day action assessment is not onboarding intent.
5. Keep each turn focused on one clear decision. Reuse information the user already supplied.

## Draft And Confirmation Contract

For each step:

1. Build the exact structured payload. Holdings and watchlist entries require an unambiguous six-digit security code; resolve ambiguity before drafting.
2. Call `onboarding.draft.upsert_step`.
3. Call `onboarding.draft.request_confirmation` for that exact draft revision.
4. Show a concise user-facing draft and wait for a later explicit confirmation.
5. On confirmation, call `onboarding.draft.accept_step`. Say that the section was added to the initial-setup draft, not that it is already saved or active.
6. Continue naturally to the next step in the same reply.

The minimum sequence is holdings/watchlist/cash, investment style, review schedule, market-watch windows, notification preference, and optional explicit watch rules. Notification preference has only three user-facing choices: 低打扰, 积极盯盘, 晚间汇总.

If the user skips explicit rules, call `onboarding.draft.skip_watch_rules`. When all required sections are accepted, call `onboarding.draft.enqueue_commit`. Tell the user that setup is being completed and that the service will notify them when it becomes active. Do not request a redundant final confirmation and do not claim success before the background commit succeeds.

## Safety

- Never expose tool names, internal step names, payload schemas, paths, or audit details in the final user reply.
- Never start or resume onboarding for a user whose `config/onboarding_state.yaml` already has `status: completed` unless the user explicitly requests reconfiguration.
- Never create an onboarding draft while answering an ordinary investment request.
- Never bypass the service draft by editing portfolio, strategy, schedules, notification, watch, or onboarding-state files.
- Never invent codes, holdings, methods, rules, or notification choices.
- If a named capability is unavailable, state the user-visible limitation and stop the write path.
