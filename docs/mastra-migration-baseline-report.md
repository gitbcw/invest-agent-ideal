# Mastra Migration Baseline Report

Date: 2026-08-10

## Baseline Identity

| Item | Evidence |
| --- | --- |
| Canonical release baseline | `/Users/combo/MyFile/projects/invest-agent-ideal` on `main` at `4b20aef6503022050cd38c8cad21a8386e49c4d3` |
| Migration branch/worktree | `feat/mastra-migration` at `/Users/combo/MyFile/projects/invest-agent-ideal-mastra`, created directly from that commit |
| Remote relationship | Local `main` is ahead of `origin/main` by 20 commits; migration deliberately uses local `main`, not the older remote ref. |
| Runtime | Node `v22.22.0`, npm `10.9.4` |
| Dependency baseline | No Mastra packages are present. The current package describes the product as an ACP Agent. |

The canonical worktree was not modified. Its pre-existing untracked `docs/mastra-migration-strategy.md` remains the source strategy and is intentionally not copied or altered by this increment.

## Verification Baseline

`npm run verify` passed in the isolated migration worktree.

- Unit/integration tests: 473 passed, 0 failed, 0 skipped.
- `npm run check:agent-context`: passed (`107` Markdown files, `83` npm scripts).
- `npm run build`: passed.
- `npm run test:boundary`: passed all 7 configured checks: `db-legacy-migration`, `db-legacy-alerts-drop`, `mcp-service-tools`, `security-boundary`, `route-uniqueness`, `platform-investment-state`, and `offline-runtime`.

The test command explicitly uses `NODE_ENV=test`, `DB_PATH=./data/test.db`, `WORKSPACE_ROOT=./data/test-workspaces`, and `RUNTIME_DATA_ROOT=./data/test-runtime`. No production database, Workspace, `.state/`, `reviews/`, or `.env` was read or replaced by this verification.

## ACP Call Matrix

| Concern | Current source of truth | Current behavior that migration must preserve |
| --- | --- | --- |
| Interactive entry | `src/acp/agent.ts` `createAgent().handleMessage()` | Builds `UserContext` and ACP prompt context, obtains the workspace agent, calls `chatWithUsage`, records a trace, then returns the application response. Callers include `src/server.ts`, the WeChat bridge, conversation log, and automation runners. |
| ACP turn contract | `src/acp/stdio-agent.ts` `StdioAcpAgent.chatWithUsage()` and `AcpChatResult` | Owns subprocess/session handling plus text, usage, model/backend and tool-call result collection. The replacement must return the same application-facing result shape before callers change. |
| Scheduled execution | `src/acp/scheduled-tasks.ts` | Market-watch and daily/weekly/monthly review flows construct a scheduled `UserContext`, build prompt context, run `chatWithUsage`, validate/publicize artifacts, push only under the existing policy, and record traces. `src/scheduler/index.ts` and `src/scheduler/review.ts` call these exports. |
| Prompt/context and memory | `src/acp/prompt-context-builder.ts`, `src/acp/context-packet.ts`, `src/lib/weixin-conversation-memory.ts` | Existing conversation history is loaded explicitly from `conversation_messages` (default recent limit 12) and prompt context also derives sandbox context. Do not add Mastra Memory or introduce a second history store. |
| MCP assembly | `src/acp/mcp-registry.ts`, `src/acp/external-mcp-registrations.ts`, `src/acp/mcp-session-manifest.ts` | Service-scoped and external-readonly MCP registrations are independently assembled per session. Credentials are excluded from manifests and unready/unsupported registrations fail closed. |
| Permission grants | `src/mcp/service-tool-classification.ts`, `src/acp/mcp-session-manifest.ts` | `resolveScheduledServiceGrant(taskType)` narrows scheduled grants. Unknown scheduled task types receive a conservative reads-only grant; this behavior is tested and must remain service-owned. |
| Audit and pending state | `src/acp/trace.ts`, `src/acp/pending-state.ts`, `src/db/schema.ts` | `recordAcpTrace` records a bounded backend/model/usage/tool-call view; pending confirmation state is keyed from user, instance, and conversation context. The existing `acp_backend` trace column is a historical schema name, not authority to bypass auditing. |
| Lifecycle callers | `src/index.ts`, `src/portal/connector.ts`, `src/platform/project-registry.ts`, `src/routes/platform.ts` | Lifecycle disposal and per-workspace runtime setup still refer to ACP lifecycle functions. They are deliberately outside the first facade increment. |

## Existing Test Evidence

The migration-relevant suite includes ACP trace observation, session keys, MCP registry and external MCP behavior, scheduled task scope/grants, sandbox context, scheduler contracts, publication/push contracts, and Portal/WeChat conversation paths. A symbol scan finds 18 direct source/test files referencing the core transition symbols; the highest-signal tests are:

- `tests/acp-trace-observability.test.ts`
- `tests/acp-mcp-external.test.ts`
- `tests/acp-mcp-registry.test.ts`
- `tests/acp-session-key.test.ts`
- `tests/service-tool-grant.test.ts`
- `tests/scheduled-acp-scope.test.ts`
- `tests/scheduled-daily-review-contract.test.ts`
- `tests/scheduled-market-watch-contract.test.ts`
- `tests/mcp-confirmation.test.ts`
- `tests/sandbox-context.test.ts`

Stage 1 needs new deterministic facade tests. Stage 2 must add explicit negative tests for interactive, scheduled read-only, scheduled final-action, and unknown task type behavior.

## Experimental Repository Comparison

The reference repository `/Users/combo/MyFile/test-projects/invest-agent-mastra` is not a merge base and is dirty. Its HEAD is `e6ac7da` and its working tree has modified runtime-restart assets, `.env.example`, `docs/README.md`, `ecosystem.config.js`, plus an untracked migration playbook. It is therefore evidence only.

Useful patterns to evaluate, not copy:

- Dynamic ESM Mastra bindings under `src/mastra/`.
- A narrow runtime adapter that maps Mastra stream output to the former ACP-compatible application result.
- Explicit context passing and external MCP separation.

Its tracked manifest uses `@mastra/core` `^1.55.0` and `@mastra/mcp` `^1.15.1`, and no longer has `@agentclientprotocol/sdk`. Version choice and API compatibility must be revalidated against this repository; importing its dependency graph, schema assumptions, Workspace assets, environment files, or runtime state is prohibited.

## Data and Safety Assessment

Stage 0 did not require a schema migration, data backfill, runtime package, production deployment, Workspace template adoption, or credential change. No hidden data-change step was found in the baseline work. Later phases remain required to keep scope, confirmation, audit, locking, idempotency, publication, and push enforcement in the service layer.

## Stage Gate A

Status: **Pass**.

The baseline is reproducible, the ACP seam has been remapped from current source rather than old line references, test evidence is recorded, the experiment is classified as read-only reference, and no production-data or Workspace mutation is required to begin the isolated facade work.
