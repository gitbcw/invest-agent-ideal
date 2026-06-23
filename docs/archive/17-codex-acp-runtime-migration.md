# Codex ACP Runtime Migration

> Created: 2026-06-01

## Architecture Decision

`invest-agent` should no longer own the Agent Runtime.

The new architecture is:

```text
WeChat / Dashboard user input
  -> invest-agent ACP adapter
  -> local Codex through ACP
  -> Codex uses project AGENTS.md + .codex/skills
  -> Codex calls deterministic invest-agent APIs/tools as needed
  -> invest-agent keeps DB, scheduler, inspection, alerts, review artifacts, and dashboard
```

## What Stays In Code

Keep deterministic capabilities in `invest-agent`:

- SQLite schema and persistence.
- Dashboard APIs.
- Holdings/watchlist/stock plans/alert rule CRUD.
- Market data fetching.
- Intraday inspection scheduler.
- Alert event logging and WeChat push.
- Review artifact persistence.

## What Moves To Codex

Move qualitative agent behavior to Codex:

- Intent understanding.
- Tool planning.
- Final natural-language replies.
- Review reasoning.
- Screening QA reasoning.
- Methodology iteration through `AGENTS.md` and `.codex/skills`.

## First Code Change

`src/acp/agent.ts` now delegates to a service-owned Codex ACP stdio process:

- It no longer imports `routeMessage()`.
- It no longer calls the self-built `runAgentTurn()`.
- `src/acp/codex-stdio-agent.ts` starts `codex-acp` with the service.
- It keeps one Codex ACP session per WeChat `conversationId`, preserving conversational context.
- It sets the ACP session `cwd` to the invest-agent project root so Codex can load `AGENTS.md` and `.codex/skills`.
- Shutdown handlers stop scheduler, WeChat listener, HTTP server, and the Codex ACP process group together.

## Configuration

Set:

```bash
CODEX_ACP_COMMAND=/Users/combo/.local/bin/codex-acp
CODEX_ACP_ARGS=
CODEX_ACP_CWD=/Users/combo/MyFile/projects/invest-agent
CODEX_ACP_TIMEOUT_MS=1800000
```

`CODEX_ACP_COMMAND` defaults to `/Users/combo/.local/bin/codex-acp`, which is a shim around `npx -y @zed-industries/codex-acp`.
`CODEX_ACP_TIMEOUT_MS` controls the maximum duration of one Codex ACP round. Review and research requests can take longer than ordinary chat, so the project default is 30 minutes. WeChat review requests should acknowledge immediately and push the result asynchronously when finished.

## Follow-up Work

1. Expose deterministic invest-agent operations as tool APIs for Codex.
2. Old self-built Runtime code has been deleted (`src/agent/*`, `src/router/*`).
3. Update remaining historical docs so they are clearly marked as old Runtime references.
4. Make `/api/chat` either proxy to Codex or become a low-level diagnostic endpoint.
5. Add smoke tests for:
   - `codex-acp` starts during service startup.
   - Service shutdown terminates the `codex-acp` process group.
   - ACP messages reuse sessions by conversation id.
   - Scheduler and alert push still work without self runtime.

## Guardrails

- Do not reintroduce keyword routing.
- Do not put investment reasoning back into the Node service.
- Do not remove inspection, alert logging, or database APIs.
- Keep skill files as the primary reasoning workflow layer.
