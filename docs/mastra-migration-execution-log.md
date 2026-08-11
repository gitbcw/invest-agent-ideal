# Mastra Migration Execution Log

## 2026-08-10 - Setup

- Created branch `feat/mastra-migration` in worktree `/Users/combo/MyFile/projects/invest-agent-ideal-mastra` from local `main` commit `4b20aef6503022050cd38c8cad21a8386e49c4d3`.
- Source strategy: `/Users/combo/MyFile/projects/invest-agent-ideal/docs/mastra-migration-strategy.md`.
- Scope for attempt 1: phase 0 baseline and phase 1 isolated facade only.
- Canonical worktree contains an unrelated untracked source strategy document and must remain untouched.

## 2026-08-10 - Executor Attempt 1

- `claude --version`: `2.1.220`.
- Started `claude -p` from this worktree with the phase 0-1 executor prompt.
- After approximately five minutes it had no stdout, no child test process, and no repository changes. It was interrupted with status 130. No implementation claim is recorded from this attempt.

## 2026-08-10 - Executor Attempt 2

- Retried `claude -p` with phase 0 only, limited to a baseline report and no code/dependency changes.
- It again produced no stdout or repository changes after more than four minutes and was interrupted with status 130.
- The CLI is installed but this environment did not yield an executor response. No Claude implementation result is claimed.

## 2026-08-10 - Phase 0 Evidence

- Created `docs/mastra-migration-baseline-report.md` from direct repository inspection and a bounded baseline-execution subtask.
- `npm run verify` passed in the migration worktree: 473 tests passed; agent-context check, TypeScript build, and all seven boundary tests passed.
- No application code, dependency, production configuration, or runtime data was changed.
- Stage gate A: Pass. Stage 1 remains unimplemented pending an available executor or explicit authorization to use a different executor.

## 2026-08-10 - Phase 1 Facade

- Added pinned `@mastra/core@1.57.0` dependency. Mastra package loading is isolated to `src/mastra/bindings.ts` and uses dynamic `import("@mastra/core/agent")`; no current ACP caller imports the facade.
- Added an injectable OpenAI-compatible model gateway resolver, per-call Agent factory, and `runMastraTurn` adapter under `src/mastra/`. The adapter keeps history caller-owned, does not configure Mastra Memory, passes an abort signal, maps text/usage/tool-call summaries, and reports stable busy/timeout/empty/provider error codes.
- Added `tests/mastra-facade.test.ts` with fake bindings/agents only. The focused suite covers factory config, text/history/usage/tool calls, estimated usage, provider errors, empty output, timeout abort, and same-conversation busy behavior. No model request or runtime data path is used.
- Verification: `node --import tsx --test tests/mastra-facade.test.ts` passed (7/7); full `npm test` passed (480 tests, 17 suites); `npm run typecheck` passed; `npm run build` passed; `npm run check:agent-context` passed (`108` Markdown files, `83` npm scripts); `git diff --check` passed.
- Stage 1 remains isolated and does not change `createAgent`, `handleMessage`, scheduled tasks, MCP registries, service tools, DB schema, production env, or Workspace state. Stages 2+ are not claimed.

## 2026-08-10 - Stage 1 Facade

- Added `@mastra/core` `1.57.0` to the migration branch. This is newer than the dirty experiment reference (`1.55.0`) and is pinned exactly in `package.json`/`package-lock.json`; no other Mastra package or experiment asset was imported.
- Added isolated `src/mastra/` modules: dynamic bindings, OpenAI-compatible model gateway descriptor, Agent factory, application-facing turn/result types, and `runMastraTurn`.
- The adapter supports caller-owned history injection, usage estimation/mapping, bounded tool-call summaries, empty-response/error/timeout/busy codes, AbortSignal cancellation, and no Mastra Memory.
- Added `tests/mastra-facade.test.ts` with seven deterministic fake-driven tests. No existing ACP caller was changed.
- Verification: `npm run typecheck` passed; `npm run build` passed; focused facade tests passed 7/7; built dynamic import of `@mastra/core/agent` returned an Agent constructor.
- Stage gate B: Pass for the isolated facade. Real model/network execution and request-path integration remain intentionally deferred to later gates.

## 2026-08-10 - Stage 2 Tool And Scope Parity

- Added `src/mastra/tools/registry.ts`, a 49-tool declarative registry matched one-for-one against the current service MCP registrations and `SERVICE_TOOL_CLASSIFICATION`. This includes current `assets.*`, `automation.*`, and `research.*` tools omitted by the old experiment reference.
- Added `src/mastra/tools/scope-guard.ts` and `index.ts`. Each wrapper validates input, requires an in-memory `userId`/`instanceId` request context, rejects unclassified tools, applies explicit interactive allowlists and scheduled grants, then delegates to `callServiceTool`. Service-owned confirmation, audit, idempotency, and resource locking stay in the existing core.
- Corrected the existing classification inventory to include the already registered `file.parse` read tool, with its grant test inventory updated accordingly.
- Added `tests/mastra-tools.test.ts`: interactive delegation; allowlist rejection; scheduled write rejection; daily/weekly/monthly review grant; unknown scheduled fail-closed; missing context; registry/classification parity; unknown tool rejection; raw-value-free summaries.
- Verification: focused Mastra + grant suites passed (32 tests); `npm run typecheck`, `npm run build`, and `git diff --check` passed.
- Stage gate C: Pass for service-tool schema/scope wrapper equivalence. External read-only MCP remains a separate transport and is not represented as an in-process service tool.

## 2026-08-10 - Stage 3 Controlled Request Seam

- Added `selectExecutionBackend` under `src/mastra/backend-selection.ts`. ACP remains the default. Mastra can be selected only by server configuration `INVEST_AGENT_MASTRA_ENABLED=true` plus optional server allowlists `INVEST_AGENT_MASTRA_INTERNAL_USERS` / `INVEST_AGENT_MASTRA_INTERNAL_INSTANCES`; no user message field can select it.
- Wired the controlled Mastra branch into interactive `createAgent().handleMessage()` and the shared scheduled `runAcpTask()`. Both construct per-request in-process tools bound to the in-memory service context and record `acpBackend=mastra` in the existing trace table. The Mastra scheduled trace branch intentionally omits ACP sandbox token fields.
- Added application result adapter and backend-selection tests. Default ACP behavior remains covered by the full verification suite.
- The request seam now converts the wrapper registry into genuine `@mastra/core/tools` `createTool` instances through the same dynamic ESM bindings before giving them to an Agent. A fake-binding test verifies all 49 instances are constructed without loading a live provider.
- A built-artifact runtime smoke loaded the actual ESM bindings and constructed all 49 Tool instances successfully. The selector was tightened so `INVEST_AGENT_MASTRA_ENABLED=true` without an internal user or instance allowlist still selects ACP.
- Added `tests/mastra-runtime-smoke.test.ts`: a real `@mastra/core` Agent and all 49 real Tool instances complete a local-only OpenAI-compatible SSE turn against an in-process HTTP mock. It verifies request routing, streaming response decoding, and actual usage mapping without a network call or credential.
- Added exact `@mastra/mcp@1.15.1` and `src/mastra/external-mcp.ts`. It reuses the current declarative external registration table, filters by interactive/scheduled-read session kind, injects only declared Authorization headers into `MCPClient`, and exposes an explicit disconnect callback. `tests/mastra-external-mcp.test.ts` covers disabled/missing-credential fail-closed behavior.
- Live authorized local read-only check: Mastra `MCPClient` discovered 21 `market-data-tool` tools and successfully executed the non-mutating `get_sector_list` call, then disconnected. No raw result, URL, header, or token was logged. A temporary shadow user/workspace `mastra-migration-shadow-20260810` was created under a temporary root and removed in the same command (`created=true`, `cleanup=true`).
- Full verification after the external client integration: 496 tests passed; `check:agent-context`, build, and all 7 boundary smokes passed.
- Real provider probes established that the currently stored local DeepSeek key is invalid, StepFun's configured endpoint returns 404, and Doubao's account is overdue. The adapter now recognizes provider `error` stream chunks and maps them to `MASTRA_TURN_ERROR` rather than incorrectly reporting `MASTRA_EMPTY_RESPONSE`; a focused regression test passes.
- Final verification after the error-stream fix: 497 tests passed, followed by `check:agent-context`, build, and all 7 boundary smokes.
- Verification: `npm run verify` passed: 492 tests, `check:agent-context`, TypeScript build, and all 7 boundary smokes. Focused Mastra/tool/grant suites also passed 32/32.
- This is not a gray rollout. No customer session, Workspace mutation, scheduler execution, push, production configuration, or rollback exercise was performed.

## 2026-08-10 - Authorized Codex Gateway Live Turn

- The user authorized use of the local Codex self-hosted gateway configuration for this isolated migration validation. The command read `/Users/combo/.codex/config.toml` for the configured base URL and `/Users/combo/.codex/auth.json` only in-process for its API credential; neither secret was printed, written to this repository, or added to an environment file.
- The gateway model catalog included `gpt-5.6-terra`, and an authenticated OpenAI-compatible `POST /v1/chat/completions` probe completed successfully.
- A real `@mastra/core` Agent then completed an isolated `runMastraTurn` against that gateway with `MASTRA_GATEWAY_PROVIDER=openai`, `MASTRA_DEFAULT_MODEL=gpt-5.6-terra`, a 120-second timeout, and no service tools, MCP toolsets, database, Workspace, scheduler, Portal, or WeChat interaction. It returned `backend=mastra`, `model=gpt-5.6-terra`, the expected reply, and provider-reported actual usage.
- The Codex configuration declares `wire_api = "responses"`, but this gateway also supports the OpenAI-compatible chat-completions endpoint required by the current Mastra adapter. No adapter protocol change was necessary.

## 2026-08-10 - Isolated Gate D Fixture Evidence

- A real Mastra Agent with the complete in-process tool map completed a two-request tool round-trip against an isolated local SSE model fixture: `portfolio.read` executed through the existing service core and the final response was returned with actual usage.
- The scheduled publication probe completed through the Mastra branch with a real `reviews.save` tool call, service-owned publication, exact artifact re-read, and a final `PUBLISHED` response. The fixture used separate temporary `DB_PATH`, `WORKSPACE_ROOT`, `RUNTIME_DATA_ROOT`, and `REVIEWS_ROOT`; it issued two model requests and removed the temporary root afterward.
- A local model fixture through `createAgent().handleMessage()` completed an internal interactive Mastra request. The same seam also completed a Portal `chatViaConversationLog` request (`portal Mastra channel ok`) in one model request.
- The WeChat bridge completed an internal Mastra request with a temporary user allowlist. A second WeChat run accepted a real PNG upload, persisted one scoped `conversation_attachments` row with `source=weixin`, and returned the Mastra response. The first attempted non-image file was rejected by the existing WeChat media contract before model execution, as expected.
- These are isolated fixture proofs, not production gray rollout evidence. No push was sent and no real Workspace or production state was used.

## 2026-08-10 - Market-Watch And Rollback Drill

- `runScheduledMarketWatchTask` completed through the internal Mastra seam in an isolated runtime. The controlled model fixture returned the exact `NO_PUSH` token, the task returned `null`, and no delivery was enqueued.
- Rule-alert remains a deterministic scheduler/service check (`runAlertCheck` plus the existing delivery policy), not an ACP/Mastra Agent request. Its existing scheduler contract tests therefore remain the relevant parity evidence.
- Configuration rollback drill: an internal allowlisted context selected `mastra` with `INVEST_AGENT_MASTRA_ENABLED=true`; changing only that server flag selected `acp` for the next request; re-enabling it selected `mastra` again. This is a configuration-only isolated exercise and did not alter a running service or customer session.
- A two-message Portal conversation fixture proved the confirmation gate end to end: the first Mastra turn called `confirmations.request`, the second user message was exactly `确认`, and the second Mastra turn called `watchlist.add` with the service-issued confirmation id. The temporary DB showed the request and write path, then was removed.
- Added `tests/mastra-parity-fixture.test.ts`, which automatically compares the ACP fixture's text/usage/budget contract with the Mastra adapter result.

## 2026-08-11 - Non-Production Runtime Gray Evidence

- With user approval for non-production-only testing, started the compiled HTTP runtime in `INVEST_AGENT_OFFLINE_MODE=true` on a temporary port with a temporary DB, Workspace root, runtime root, reviews root, and API token. The Portal API completed an internal allowlisted Mastra request with HTTP 200 and one local model request; the runtime then shut down cleanly.
- A second isolated runtime observed three separate new Portal conversations through the same allowlisted Mastra route. All three returned HTTP 200 with the expected distinct replies (3/3). The local model endpoint, runtime, and temporary root were removed afterward.
- A prior attempt to make an ACP fallback request in that same harness was stopped because an unavailable ACP executable did not yield a bounded response and left an isolated listener; that exact listener was terminated and its temporary state removed. The rollback claim therefore remains the separately verified server-configuration selector drill, not a simulated unavailable-ACP success claim.
