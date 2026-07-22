# Service Tools MCP

`invest-agent-service-tools` is the service-owned stdio MCP server attached to Codex ACP sessions. It is the only service capability surface exposed to workspace Agents. HTTP remains an adapter for Dashboard, Platform, Portal, operations, and compatibility callers, but workspace prompts and skills must not instruct Agents to call it.

Implementation:

- ACP wiring: `src/acp/stdio-agent.ts`
- MCP entrypoint: `src/mcp/invest-agent-service-tools.ts`
- Tool core: `src/mcp/service-tools-core.ts`
- Smoke: `npm run smoke:mcp-service-tools`

## Tool Policy

- Do not add a generic HTTP proxy tool.
- Add named tools that wrap service-owned functions or backends.
- Read tools may run directly.
- Before asking the user to confirm a durable write, call `confirmations.request` with the exact operation and payload.
- `confirmations.request` pre-validates onboarding drafts, so an invalid style or portfolio payload is rejected before the user is asked to confirm it.
- After a later user turn explicitly confirms that draft, call the write tool with its `confirmationId` and `confirmedByUser: true`.
- The service binds confirmations to user, project, instance, conversation, operation, and payload; confirmations expire and can be consumed only once.
- A confirmation is consumed only after the durable write succeeds. Failed validation or state progression remains auditable and leaves the confirmation pending instead of forcing the user to confirm the same draft again.
- Write tools must record service audit.
- ACP sessions may set a service-owned MCP allowlist for an isolated task phase. When present, the stdio server registers only those named tools; the scheduled review publication probe uses this boundary to expose only `reviews.save`.
- Deletion, disabling, active push, and forced scheduler triggers are not exposed in the first write batch.
- When a required MCP capability is unavailable, the Agent reports the capability or data gap. It must not discover or call hidden HTTP routes, tokens, ports, or local files as a fallback.
- MCP and HTTP adapters reuse the same deterministic service functions; neither adapter owns independent product semantics.

## Current Tools

Read tools:

- `market.snapshot`
- `market_watch.snapshot`（当前 user/instance 最近一次 scheduler 盘中快照及有效变化标记）
- `market.quote`
- `market.kline`
- `market.indices`
- `market.capital_flow`
- `market.sector_theme`
- `market.calendar`
- `market.health`
- `market.stock_info`
- `market.resolve`
- `portfolio.read`
- `watchlist.read`
- `plans.read`
- `conversation.history`
- `confirmations.pending`
- `watch_rules.catalog`
- `watch_rules.list`
- `watch_rules.validate`
- `watch_rules.dry_run`

Confirmation workflow tool:

- `confirmations.request`

Onboarding workflow completion tool:

- `onboarding.complete_watch_setup`

Draft-first onboarding tools:

- `onboarding.draft.get`
- `onboarding.draft.upsert_step`
- `onboarding.draft.request_confirmation`
- `onboarding.draft.accept_step`
- `onboarding.draft.skip_watch_rules`
- `onboarding.draft.enqueue_commit`
- `onboarding.draft.commit_status`

New workspace onboarding flows use these tools instead of `onboarding.confirm_portfolio` / `onboarding.confirm_step`: intermediate confirmations only accept a service-owned draft revision. The sole exception is the optional final rule step: `skip_watch_rules` accepts only an explicit latest-user skip and makes no Workspace write. When every section is accepted, `enqueue_commit` freezes that revision. The service worker waits for the initiating assistant reply to be durably recorded, using its message ID rather than parsing customer wording, then writes and verifies the Workspace configuration once before marking onboarding complete and notifying the user.

This tool closes the final watch-setup step without another user confirmation. The service accepts only an explicit skip in the latest user message, or scoped rule IDs with successful `watch_rules.create` audit evidence from the current conversation and no active pending rule drafts.

Confirmed write tools:

- `onboarding.confirm_portfolio`
- `onboarding.confirm_step`
- `watchlist.add`
- `plans.set`
- `plans.watch_conditions`
- `method_changes.propose`
- `reviews.save`
- `watch_rules.create`

`reviews.save` is the only current write exception: a scheduled daily-review conversation may publish without an interactive confirmation record. The Agent owns the report content and calls the tool with full Markdown `content` plus an independent WeChat `pushBrief`; optional `decisionRecords` and `sourceEvents` are appended to workspace memory. The service preserves the content, mirrors/indexes the artifact, records audit, and never derives the full report from the final customer reply. Manual durable saves still require `confirmedByUser=true`.

## Verification

Run locally or on Volcano:

```bash
npm run smoke:mcp-service-tools
```

For a no-push, fixed-content publication probe against an explicitly authorized test scope:

```bash
npm run smoke:scheduled-review-publication -- <userId> <instanceId> <YYYY-MM-DD>
```

The probe does not collect market data or enqueue a push. It opens an isolated scheduled ACP session with only `reviews.save`, verifies the exact user/instance publication artifact, and retries at most once.

Expected checks:

- TypeScript build passes.
- Core tools can read portfolio, watchlist, plans, conversation history, pending confirmations, market snapshot, quotes, K-lines, indices, market calendar, market health, and watch-rule catalog/list/validate.
- Stdio MCP protocol exposes all required read/write tools.
- A restricted stdio MCP session exposes only its allowlisted tools.
- `market.snapshot` returns usable holdings/watchlist/plan facts without relying on shell network access.
- Durable writes reject missing, expired, replayed, cross-scope, or payload-mismatched confirmations.
- Scheduled `reviews.save` accepts only the trusted scheduler conversation scope, preserves full report and push brief separately, appends optional decision/source records, and keeps manual unconfirmed saves rejected.
- Final onboarding watch setup completes after an explicit skip or verified confirmed-rule creation without a redundant completion-only confirmation.
