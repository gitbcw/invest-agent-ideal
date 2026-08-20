# Mastra-Native Rebuild Contract

## Decision

This worktree is the active replacement runtime, not a dual-kernel migration.
Production runs solely on the open-source Mastra Agent runtime from
`feat/mastra-migration`.
Codex ACP, Hermes, their subprocess lifecycle, their session protocol, and
their compatibility configuration are not part of the target runtime.

The legacy `main` runtime is stopped. Real production data and Workspaces are
server-owned and are preserved during code-only releases; legacy runtime code
is not kept as an in-process fallback in this worktree.

## Target Runtime

- `src/mastra/` owns Agent construction, model gateway resolution, tool
  construction, streaming, cancellation, usage, and tool-call summaries.
- A neutral `src/runtime/` owns application request/response types, prompt
  construction, conversation context, scheduling entry points, and trace
  recording. It must not contain `acp`, `codex`, or `hermes` identifiers.
- Portal, WeChat, automation, and scheduler call the neutral runtime Agent.
- Service tools, confirmation, audit, locks, idempotency, SQLite ownership,
  push policy, and external read-only MCP remain service-owned. They are not
  reimplemented inside prompts or Mastra tools.
- The standalone development runtime uses a dedicated port and state roots.
  `npm run mastra:local` is the reproducible local entry point.

## Required Removals

Before final acceptance, this worktree must remove from runtime dependencies:

1. `src/acp/stdio-agent.ts`, ACP subprocess startup/disposal, and every
   Codex/Hermes backend setting or lifecycle call.
2. `@agentclientprotocol/sdk`, `CODEX_ACP_*`, `HERMES_*`, `ACP_BACKEND`, and
   executable/model compatibility configuration.
3. ACP-named request protocol, trace service/table names, and runtime-facing
   route/platform labels. New clean databases use neutral Agent trace names.
4. ACP-only MCP session assembly. External MCP uses the Mastra MCP client;
   service tools remain in-process Mastra tools.
5. Any fallback branch that can silently execute Codex ACP or Hermes.

Historical data migration is explicitly separate: existing trace/history data
may be transformed by a later one-way migration, but no target runtime code
may need legacy ACP/Hermes to read or execute requests.

## Acceptance Evidence

The replacement runtime is accepted only when all are true:

- `rg` finds no ACP/Codex/Hermes runtime imports or dependency references
  outside explicit archive or one-way data-migration documentation.
- Portal, WeChat, attachment, confirmation write, review, market-watch,
  rule-alert, automation, and external MCP representative flows use Mastra.
- The standalone runtime starts on its own port with its own DB/Workspace/
  runtime/reviews roots, and manual requests record the neutral Mastra trace.
- New conversations can change the configured model without changing any
  workspace or using a Codex/Hermes executable.
- A dedicated data-migration plan specifies source tables, target tables,
  backup, idempotence, verification, and rollback before customer cutover.
