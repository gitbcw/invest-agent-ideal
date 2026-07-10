# Service Tools MCP

`invest-agent-service-tools` is the service-owned stdio MCP server attached to Codex ACP sessions. It is the preferred path for deterministic reads and confirmed writes because Codex ACP shell networking may not be able to reach `127.0.0.1:22655`.

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
- After a later user turn explicitly confirms that draft, call the write tool with its `confirmationId` and `confirmedByUser: true`.
- The service binds confirmations to user, project, instance, conversation, operation, and payload; confirmations expire and can be consumed only once.
- Write tools must record service audit.
- Deletion, disabling, active push, and forced scheduler triggers are not exposed in the first write batch.
- HTTP sandbox APIs remain a fallback when MCP tools are unavailable.

## Current Tools

Read tools:

- `market.snapshot`
- `market.quote`
- `market.health`
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

Confirmed write tools:

- `onboarding.confirm_portfolio`
- `onboarding.confirm_step`
- `watchlist.add`
- `plans.set`
- `plans.watch_conditions`
- `method_changes.propose`
- `reviews.save`
- `watch_rules.create`

`reviews.save` is the only current write exception: scheduled review completion may save an artifact without an interactive confirmation record. It remains audited.

## Verification

Run locally or on Volcano:

```bash
npm run smoke:mcp-service-tools
```

Expected checks:

- TypeScript build passes.
- Core tools can read portfolio, watchlist, plans, conversation history, pending confirmations, market snapshot, market health, and watch-rule catalog/list/validate.
- Stdio MCP protocol exposes all required read/write tools.
- `market.snapshot` returns usable holdings/watchlist/plan facts without relying on shell network access.
- Durable writes reject missing, expired, replayed, cross-scope, or payload-mismatched confirmations.
