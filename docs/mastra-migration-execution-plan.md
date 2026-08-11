# Mastra Migration: Phase 0-1 Execution Plan

## Background / Intent

This is the first executable increment of the migration strategy at `/Users/combo/MyFile/projects/invest-agent-ideal/docs/mastra-migration-strategy.md` (the source strategy is currently an untracked user artifact in the canonical worktree). The migration branch starts at local `main` commit `4b20aef6503022050cd38c8cad21a8386e49c4d3` on 2026-08-10.

The objective of this increment is to establish a reproducible baseline and introduce a Mastra execution facade that can be exercised in an isolated, no-write test. It must not change the default ACP execution path.

## Goals

1. Produce an evidence-backed ACP call matrix and experimental-repository comparison.
2. Record the current branch, dependency, runtime, and verification baseline.
3. Add a dynamically imported ESM Mastra facade and a narrow `runMastraTurn` adapter behind tests only.
4. Preserve application-layer response and usage contracts, including error, timeout, empty-response, and tool-call mapping.
5. Keep conversation history caller-owned; do not enable Mastra Memory.

## Non-goals

- Do not change WeChat, Portal, Platform, scheduler, or the default `createAgent().handleMessage()` path.
- Do not migrate service tools, external MCP clients, scope grants, confirmation gates, audit ownership, or scheduled-task execution in this increment.
- Do not call a real model or require credentials in automated tests.
- Do not touch production configuration, data, real Workspaces, `reviews/`, `.state/`, or deployment scripts.
- Do not copy code, dependencies, data, or configuration wholesale from `/Users/combo/MyFile/test-projects/invest-agent-mastra`.

## Assumptions

- Local `main` is the release baseline even when ahead of `origin/main`.
- The experimental repository is read-only reference material. Its claimed completed migration is not proof of compatibility with this repository.
- Until a gateway and model are explicitly selected, the Mastra adapter must obtain model configuration through an injectable/configured OpenAI-compatible boundary and tests must use fakes.

## Proposed Solution

Create a `src/mastra/` facade that is the only module aware of Mastra package loading. Use `import()` so the existing CommonJS TypeScript build does not statically import ESM-only packages. Define typed application-facing inputs and outputs at the facade boundary, map Mastra stream output into the existing ACP-compatible result structure, and make timeouts/cancellation explicit. Keep the facade unreachable from production request paths in this increment.

## Execution Plan

1. Record the baseline environment and run the existing verification suite without changing `main`.
2. Inventory current ACP entry points, lifecycle callers, scheduled task flow, MCP registries, context/prompt builders, trace, pending state, conversation memory, backend settings, and their test coverage. Write the matrix to `docs/mastra-migration-baseline-report.md`.
3. Compare the experimental repository only by selected source/docs/diffs. Record reusable patterns, known stale assumptions, and prohibited assets in the baseline report.
4. Add only the minimum Mastra dependencies required for the facade, pinned through the existing lockfile. If a compatible dependency boundary cannot be established without a material dependency upgrade, stop and report the blocker.
5. Implement the facade, model-config resolver, result mapper, and controlled stream timeout. Do not instantiate a long-lived Agent or change any existing request caller.
6. Add focused unit tests with fake bindings/stream outputs for text, usage, tool calls, empty responses, errors, and timeout. Ensure no test reads or writes real runtime roots.
7. Run the required checks and document results in the execution log.

## Deliverables

- `docs/mastra-migration-baseline-report.md`
- `src/mastra/` facade modules and focused tests
- Updated dependency manifest and lockfile only if necessary
- `docs/mastra-migration-execution-log.md`
- `docs/mastra-migration-execution-plan_acceptance_review.md`

## Acceptance Criteria

| ID | Requirement | Verification |
| --- | --- | --- |
| A0 | Branch begins from `4b20aef` and the canonical `main` worktree remains untouched. | `git worktree list`, branch ancestry, canonical status. |
| A1 | Baseline report includes ACP call matrix, current runtime/dependency facts, test inventory, experimental comparison, and no-data-change assessment. | Inspect report against source paths and strategy section 7 phase 0. |
| A2 | Mastra package access is isolated behind dynamic import and production request paths remain on ACP. | Source search plus typecheck/build. |
| A3 | Facade maps text, usage, tool-call summaries, empty responses, errors, and bounded timeout into an ACP-compatible result/error contract. | Focused deterministic tests. |
| A4 | No Mastra Memory, real model request, service-tool migration, default-backend switch, or runtime-data mutation is introduced. | Source diff, dependency/test inspection, and targeted searches. |
| A5 | `npm run typecheck`, focused tests, `npm run build`, and `npm run check:agent-context` pass. Baseline `npm run verify` is recorded as pass/fail with evidence. | Command output summarized in execution log and acceptance review. |

## Risks and Mitigations

- ESM/CJS incompatibility: use dynamic import only in the facade and test it through dependency injection.
- Result-shape ambiguity: derive types from the current `StdioAcpAgent.chatWithUsage` contract, not the experimental repository.
- Hidden default-path switch: search all new imports and retain an explicit no-caller-change test/review item.
- Baseline failures unrelated to migration: record them precisely; do not repair unrelated mainline defects in this increment.

## Open Questions

- Which production gateway/provider and default model should the later Agent factory use?
- Which internal test workspace and metrics thresholds will approve stages 2-4?
- How long must ACP remain available after a controlled default-backend switch?

## Executor Prompt

You are the executor for `/Users/combo/MyFile/projects/invest-agent-ideal-mastra`.

Read this plan and the source strategy at `/Users/combo/MyFile/projects/invest-agent-ideal/docs/mastra-migration-strategy.md`. Implement only phases 0-1 described here. Inspect current code before editing. Preserve unrelated user changes and do not modify the canonical worktree. The experiment repository is read-only reference only; do not copy it wholesale. Do not perform a production action, alter runtime data, invoke a real model, or change default ACP request handling.

Run the listed checks where feasible. Write the baseline report and append concise command results, changes, tests, and blockers to `docs/mastra-migration-execution-log.md`.

## Reviewer Prompt

Review this work independently against A0-A5. Treat the source strategy and this plan as the contract. Confirm behavior with direct source inspection and tests, especially ESM isolation, output mapping, non-default routing, and data isolation. Do not credit unverified executor claims.
