# Skill Workflow Migration

> Created: 2026-06-01

## Background

The `jr-backend` project proved a useful approach: investment reasoning quality can improve significantly through `AGENTS.md` plus `.codex/skills`, without writing much backend code.

`invest-agent` is now the main project. It already has a TypeScript runtime, WeChat bridge, SQLite database, dashboard, alert scheduler, review handler, and screening handler. Its review output works, but the method is shallower than the `jr-backend` review practice.

## Decision

Use `invest-agent` as the product主体, and migrate the `jr-backend` method as workflow assets:

- Add project-level `AGENTS.md`.
- Add `.codex/skills` for daily, weekly, monthly reviews.
- Add `.codex/skills` for stock screening QA.
- Use `jr-backend` as a methodology reference layer, not as a second runtime or document storage system.
- Keep deterministic data collection in TypeScript.
- Move investment reasoning structure, evidence discipline, and output format into skills.

## Target Shape

```text
WeChat / Dashboard / Scheduler
  -> TypeScript runtime collects deterministic context
  -> strategy Skill provides protected skeleton plus confirmed instance expansion
  -> profile provides runtime compatibility summary and quick index
  -> skill-defined workflow determines reasoning structure
  -> AI generates review or screening report
  -> TypeScript persists report, updates plans/watchlist/trace
```

## JR Method Reference Boundary

The previous attempt to run a dedicated `jr-backend` ideal instance exposed a source-of-truth problem: JR has file-based config, knowledge, memory, and reports, while the current platform already has service persistence, profiles, Hermes memory, sandbox audit, and saved review artifacts.

The adopted direction is option B:

- JR contributes operating discipline: low-noise watch, strong confirmation, review closure, viewpoint tracking, behavior correction, and method evolution.
- JR files do not become runtime storage.
- Formal investment strategy lives in a strategy Skill engineering unit: protected skeleton plus instance expansion.
- Profile is a runtime compatibility summary and quick index, not the primary methodology carrier.
- Proposed strategy or methodology changes live first as instance expansion candidates; skeleton-level improvements are maintainer-only candidates.
- Hermes memory is only conversation continuity and short-term context. If it implies a strategy change, that change must be converted into a confirmation-backed instance update candidate.
- Deterministic facts always come from the current Invest Agent service and current `instanceId` scope.

## Why This Direction

The runtime should not hard-code every investment habit. The user's methodology will keep evolving through reviews, alert feedback, and screening outcomes. Skills are a better home for this layer because they are easier to inspect, edit, and improve than compiled code.

## Migration Scope

Completed in this migration pass:

- `AGENTS.md`
- `.codex/skills/invest-agent-daily-review/SKILL.md`
- `.codex/skills/invest-agent-weekly-review/SKILL.md`
- `.codex/skills/invest-agent-monthly-review/SKILL.md`
- `.codex/skills/invest-agent-stock-screening-qa/SKILL.md`

Not changed yet:

- `src/handlers/review.ts`
- `src/handlers/screening.ts`
- Runtime tool schemas
- Dashboard APIs

## Next Implementation Steps

1. Update the review handler prompt to follow `invest-agent-daily-review`.
2. Save daily reports as Markdown by default instead of plain `.txt`.
3. Let weekly reviews read daily review files and alert events, not only current watchlist movement.
4. Add monthly review support in `handleReviewTool`.
5. Update the screening handler prompt to follow `invest-agent-stock-screening-qa`.
6. Add a watchlist-confirmation flow after screening output.
7. Migrate `method_change_candidate` semantics toward instance expansion candidates and maintainer-facing skeleton improvement candidates.

## Guardrails

- Do not reintroduce keyword routing as the main architecture.
- Do not remove deterministic data collection from TypeScript.
- Do not make skills responsible for DB writes.
- Do not create a second JR document workspace as runtime state inside Invest Agent.
- Do not let Hermes memory, profile summaries, or JR reference files override service data or confirmed strategy Skill expansion.
- Do not let a single-user instance modify protected strategy skeleton files.
- Do not let AI invent unavailable financial data, chip concentration, or main-force control data.
- Keep final user-facing investment language cautious and auditable.
