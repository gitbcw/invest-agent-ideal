---
name: service-capability-policy
description: Use whenever the investment assistant needs service-owned facts, conversation history, confirmations, durable writes, schedules, reviews, plans, watchlists, or explicit watch rules.
---

# Service Capability Policy

Use only the named tools exposed by `invest-agent-service-tools` for service-owned facts and durable actions. HTTP routes, localhost ports, tokens, curl commands, database access, and service files are implementation details and must not be discovered or called from the workspace Agent.

Prefer the narrowest named read tool. Available market tools include `market.snapshot`, `market.quote`, `market.kline`, `market.indices`, `market.capital_flow`, `market.sector_theme`, `market.stock_info`, `market.resolve`, `market.calendar`, and `market.health`. Current user state is available through `portfolio.read`, `watchlist.read`, `plans.read`, `conversation.history`, and the watch-rule read tools.

For durable user-visible writes, register the exact operation and payload with `confirmations.request`, show the draft, and wait for a later explicit user confirmation. Then consume the returned `confirmationId` through the corresponding named write tool. Never edit workspace state files to imitate a successful service write. Onboarding is intentionally different: use `onboarding.draft.*` to keep each accepted section in the service-owned draft, then use `onboarding.draft.enqueue_commit` only after all sections are accepted; the background service is the sole writer of final onboarding configuration.

Legacy `onboarding.complete_watch_setup` remains only for older flows. New onboarding drafts include `watch_rules` as a final accepted section and must not ask the user for a redundant “确认完成”.

If the required named tool is missing or returns an unavailable/data-gap result, tell the user what cannot currently be read or changed. Do not bypass the boundary through shell commands, hidden interfaces, or direct files. Never expose tool names or internal execution details in the user-facing reply.
