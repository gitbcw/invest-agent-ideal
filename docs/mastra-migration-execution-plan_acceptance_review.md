# Mastra Migration: Phase 0-1 Acceptance Review

## Review 1 - Phase 0 Baseline

Status: Partial

Phase 0 meets its stage gate. The migration worktree is isolated from the canonical release tree, the ACP seam and experimental-reference risks are documented from current source, and the full baseline verification passes. Phase 1 has not started: no Mastra facade, package addition, result mapper, or focused facade tests exist. The phase 0-1 increment therefore cannot be accepted as complete.

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| A0 | Isolated migration branch begins from `4b20aef`; canonical main remains untouched. | Pass | `git worktree list`; branch HEAD/merge-base; canonical status. | `feat/mastra-migration` starts at `4b20aef`; canonical untracked strategy file is unchanged. |
| A1 | Current ACP matrix, runtime/dependency facts, tests, experiment comparison, and no-data-change assessment. | Pass | `docs/mastra-migration-baseline-report.md`; direct source scan. | The report names each current transition seam and safety boundary. |
| A2 | Dynamic-import Mastra facade while production remains on ACP. | Fail | `src/mastra/` absent; package manifest has no Mastra dependency; caller scan remains ACP-only. | Correct for phase 0, but phase 1 is not complete. |
| A3 | Deterministic adapter coverage for result/error/timeout cases. | Fail | No facade test exists. | Must be added with fakes before any request-path switch. |
| A4 | No Memory, live model, tool migration, default switch, or data mutation. | Pass | Source/diff review; baseline test environment. | No product implementation changed. |
| A5 | Required verification succeeds. | Partial | `npm run verify` passed: 473 tests, build, agent-context, and 7 boundary tests. | Baseline checks pass, but focused facade tests do not yet exist. |

## Findings

- [Blocker] Phase 1 has no implementation. Two non-interactive `claude -p` attempts produced no output or repository changes and were stopped after bounded waits. An available executor or explicit authorization to use another executor is required before making facade code changes under the selected execution workflow.

## Verification Performed

- `npm run verify`: passed.
- Current-source scan of ACP entry points, scheduled task runners, MCP/session assembly, service grants, trace, pending state, and conversation memory.
- Read-only inspection of the experimental repository's tracked Mastra files, dependency manifest, HEAD, and dirty working-tree state.

## Follow-Up Checklist

- [ ] Make the phase 1 executor available or authorize a different executor.
- [ ] Implement and test the isolated ESM facade without changing ACP callers.
- [ ] Re-run this review against A0-A5 after the focused tests exist.

## Review 2 - Stage 1 Facade

Status: Pass with caveats

The isolated stage 1 facade is implemented and independently verified. The default ACP path remains unchanged, and no live model or runtime data was used. The facade dependency is pinned to `@mastra/core` `1.57.0`, while the experiment reference used `1.55.0`; this is recorded and must be revalidated at the next dependency or runtime acceptance gate.

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| A0 | Isolated branch/worktree and untouched main. | Pass | Git status/worktree inspection. | No canonical files changed. |
| A1 | Baseline matrix and safety assessment. | Pass | `docs/mastra-migration-baseline-report.md`. | Stage gate A remains satisfied. |
| A2 | Dynamic-import facade with ACP production path intact. | Pass | `src/mastra/bindings.ts`, source search, `npm run typecheck`, `npm run build`. | No existing caller imports `src/mastra`. |
| A3 | Text, usage, tool-call, empty, error, timeout and busy mapping. | Pass | `tests/mastra-facade.test.ts`; 7/7 passed. | Tests use fakes and no credentials. |
| A4 | No Memory, live model, tool migration, default switch, or data mutation. | Pass | Diff and test environment inspection. | Service tools and external MCP are not wired yet. |
| A5 | Verification expectations. | Pass with caveats | `npm run typecheck`, `npm run build`, focused tests passed; prior full `npm run verify` passed. | Full verify should be rerun after the next stage's tool changes. |

### Stage 1 Follow-Up

- [ ] Reconcile the exact Mastra version against the gateway/runtime compatibility matrix.
- [ ] Implement stage 2 in-process service-tool specs and fail-closed scope guard without changing callers.

## Review 3 - Stage 2/3 Acceptance

Status: Partial

Stages 0--2 satisfy their local gates, and a server-controlled Mastra seam now exists for both interactive and scheduled request paths while ACP remains the default. This is not acceptance of the full migration strategy: the required real runtime parity, attachment/external-MCP validation, isolated shadow behavior, controlled rollout metrics, rollback drill, merge/freeze, and observation window have not occurred. The plan must remain active.

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Gate A | Current baseline and isolated worktree. | Pass | Baseline report; worktree history; `npm run verify`. | Canonical `main` remains separate. |
| Gate B | Dynamic Mastra facade, no Mastra Memory, mapping/errors/timeouts. | Pass | `src/mastra/{bindings,agent-factory,run-turn,types}.ts`; facade tests; `tests/mastra-runtime-smoke.test.ts`. | Includes a local OpenAI-compatible SSE smoke using the real Mastra Agent and 49 real Tool instances; no external provider is contacted. |
| Gate C | Current tool inventory/schema parity and fail-closed grants. | Pass | `src/mastra/tools/`; `tests/mastra-tools.test.ts`; `tests/service-tool-grant.test.ts`. | 49 registry ids equal current classification; wrappers call the existing service core only after authorization and become real Mastra `createTool` instances at the request seam. |
| Gate C | External read-only MCP remains separately controlled and credential-safe. | Pass with caveats | `src/mastra/external-mcp.ts`; `tests/mastra-external-mcp.test.ts`; live local `MCPClient` discovery/call. | Mastra uses the current declarative registrations, session filters, declared Authorization header only, and explicit disconnect. QSSE was not called in this run; only the configured local market-data read call was exercised. |
| Gate D | Explicit internal-only Mastra selection, default ACP, interactive and scheduler seams. | Pass with caveats | `src/mastra/backend-selection.ts`; `src/acp/agent.ts`; `src/acp/scheduled-tasks.ts`; backend selection tests; authorized live gateway turn. | Selection is server policy only; an enabled flag without an allowlist remains ACP. A real Agent completed one isolated text-only turn through the authorized Codex gateway; the application request seams were not enabled for that call. |
| Gate D | ACP/Mastra fixture parity for interaction, attachments, confirmation write, review, market-watch, rule-alert, Portal and WeChat. | Pass with caveats | Authorized live text turn; real local tool round-trip; isolated scheduled `reviews.save` publication and `market-watch` `NO_PUSH`; isolated interactive, Portal, and WeChat runs; PNG attachment persistence; Portal two-turn confirmation-write; `mastra-parity-fixture.test.ts`; service-tool scope tests; local external MCP discovery/call. | All named Agent-path representatives now have isolated evidence. Rule-alert is deterministic scheduler/service behavior and retains its existing contract tests. This does not substitute for Gate E running-service rollout evidence. |
| Gate E | Internal gray rollout, metrics, observation window, rollback exercise. | Partial | Isolated compiled HTTP runtime, internal allowlist Portal request; three independent fresh Portal conversations all succeeded; configuration rollback drill; selector tests. | Non-production internal gray behavior is now proven. The strategy explicitly leaves acceptance thresholds and the formal observation window for human confirmation, so this cannot be promoted to a production-equivalent Gate E pass. |
| Stage 5 | Freeze/sync/merge, default switch, observation, optional ACP deletion. | Fail | Default remains ACP; no merge or release action. | Correctly deferred; no deletion should occur before Gate E. |
| Safety | No production data, Workspace, `.env`, scheduler state, or WeChat state changed. | Pass | Scope inspection and test environment paths; no deploy commands. | Full verification uses test DB/workspace/runtime paths. |

## Findings

- [Resolved] The configured DeepSeek key returned 401, StepFun returned 404 for the configured endpoint, and Doubao returned account-overdue 403. The authorized Codex self-hosted gateway exposes `gpt-5.6-terra` through OpenAI-compatible chat completions, and a real Mastra Agent completed an isolated live text turn with actual usage reporting. The remaining gap is application-level representative fixture parity, not live-model availability.
- [Risk] External MCP client parity is proven for local market-data discovery and one safe read; QSSE and full agent tool-call consumption still need a separate run.
- [Blocker] The strategy requires representative attachment, confirmation-write, scheduled review, market-watch, rule-alert, Portal connector, WeChat bridge, shadow isolation, rollout metrics, and a rollback drill. None can be accepted from unit/build evidence alone.

## Verification Performed

- `npm run verify`: passed, 497 tests; agent-context check; TypeScript build; seven boundary smoke tests.
- `npm run typecheck && npm run build`: passed after Stage 3 scheduler wiring.
- Focused Mastra facade, tool scope, backend selection, and service-grant suites: 32/32 passed.
- Direct source inspection of controlled selection, interactive and scheduler request seams, tool registry, scope guard, and trace fields.
- Authorized isolated live `runMastraTurn` through the Codex self-hosted gateway using `gpt-5.6-terra`; no application state or external tool was used.

## Follow-Up Checklist

- [x] Obtain an approved isolated OpenAI-compatible Mastra gateway/model configuration and credentials; prove one real Agent turn.
- [x] Implement and test the separately authenticated external read-only MCP client for Mastra, including credential redaction and disconnect.
- [~] Build and run ACP-vs-Mastra representative fixtures with isolated DB/workspace/runtime roots and no real push. Mastra fixtures cover interaction, tool round-trip, review publication, Portal, WeChat, and attachment; confirmation-write, market-watch, rule-alert, and automated ACP-vs-Mastra comparison remain.
- [ ] Obtain rollout approval, execute internal shadow/gray runs, capture metrics, and perform a documented rollback drill.
- [ ] Merge the latest `main`, repeat full verification, and perform final release acceptance before any default switch or ACP removal.
