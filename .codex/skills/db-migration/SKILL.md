---
name: db-migration
description: Use when changing Invest Agent SQLite schema, Drizzle migrations, table ownership, backfills, data migration scripts, workspace-vs-service persistence, or production database rollout/rollback.
---

# DB Migration

Use this skill for SQLite schema changes, data backfills, and persistence ownership decisions.

## Guardrails

- Do not delete or rewrite production data without explicit user confirmation and a backup.
- Prefer additive, backward-compatible migrations for the current MVP.
- Keep service-owned SQLite data and workspace-owned artifacts separate.
- Before changing a table, check whether it should exist at all under current product boundaries.

## Read First

- `CLAUDE.md` database section for current DB facts and commands.
- `docs/table-ownership.md` for service/workspace/discard ownership.
- `docs/system-overview.md` for runtime ownership.
- `docs/23-multi-user-sandbox-design.md` if sandbox audit, permissions, or workspace isolation are involved.
- `.codex/skills/volcano-ops/references/volcano-runtime-migration-plan.md` before production DB migration or rollback.

## Decision Workflow

1. Identify the data: who owns it, how it is written, how it is read, and whether it is user-visible.
2. Decide storage:
   - service SQLite for canonical runtime state, audit, queues, portal conversation log, scheduler, and deterministic APIs;
   - workspace files for user-specific investment configuration/artifacts;
   - no persistence for derived/transient values that can be recomputed.
3. Check existing schema and table ownership before adding fields.
4. Prefer additive schema changes: new nullable column, new table, compatibility read path, then optional cleanup later.
5. Add backfill only when existing rows need it for current behavior.
6. Add smoke/test coverage that proves migration and read/write paths.

## Commands

```bash
npm run db:generate
npm run db:migrate
npm run build
npm test
```

Use targeted smoke commands when the schema backs a runtime path:

```bash
npm run smoke:onboarding-confirm-step
npm run smoke:stage1-scheduler
npm run smoke:stage2-watch-rules
npm run smoke:portal-conversation-log
npm run smoke:mcp-service-tools
```

Inspect local DB when needed:

```bash
sqlite3 data/invest-agent.db ".schema <table>"
sqlite3 -header -column data/invest-agent.db "select * from <table> limit 5;"
```

## Migration Checklist

- Schema change is compatible with existing local and production data.
- `src/db/index.ts` initialization/incremental migration remains coherent with `src/db/schema.ts`.
- New columns/tables have clear ownership and are documented if durable.
- Existing code paths tolerate missing/old data during rollout.
- Production rollout includes backup, verification query, and rollback plan.
- Tests or smoke cover both migration and business path.

`src/db/index.ts` is currently the canonical runtime migration path. `db:generate` and `db:migrate` are development utilities only until generated Drizzle migrations are committed and covered by fresh/upgrade/idempotency tests; do not treat them as the production rollout contract.

## Report Shape

Summarize:

- Tables/columns changed.
- Ownership decision.
- Migration/backfill behavior.
- Verification run.
- Production risk and rollback note.
