# Mastra-Native Runtime Removal Inventory

## Scope and Rule

This is a source inventory for the replacement runtime defined by
`docs/mastra-native-rebuild-contract.md`.  It covers runtime code, tests,
configuration, and developer scripts in this worktree.  It does not authorize
changes to production data, existing customer Workspaces, or archive material.

Target end state: Portal, WeChat, automation, and scheduler call a neutral
runtime facade backed only by Mastra.  No runtime import, setting, fallback, or
subprocess may require ACP, Codex, or Hermes.  Existing
`codex_acp_traces` data requires a separately reviewed one-way migration; the
new runtime must not retain that table as its active store.

## `src/acp` Disposition

| Current module | Disposition | Rehome / change | Rationale |
| --- | --- | --- | --- |
| `agent.ts` | Replace, then delete | `src/runtime/agent.ts` owns `handleMessage`; call `runMastraTurn` unconditionally and record a neutral trace. | It is the public orchestrator, but contains ACP types, timeout names, trace names, and the `selectExecutionBackend` ACP fallback. |
| `stdio-agent.ts` | Delete | None. | ACP SDK connection, stdio child processes, session pooling, Codex/Hermes home/auth/config lifecycle, backend settings, and compatibility model routing are all forbidden. |
| `protocol.ts` | Move and rename | `src/runtime/protocol.ts`: `AgentMessage`, `AgentContent`, `AgentResponse`, `textResponse`.  Rename `/acp/*` HTTP paths separately. | Application request/response envelope is product-neutral; only its ACP names are legacy. |
| `trace.ts` | Move and rewrite | `src/runtime/trace.ts`: `recordAgentTrace`, neutral usage/model fields, `agent_traces` table. | Redaction, truncation, and audit serialization are product-neutral; `codexAcpTraces`, `AcpTraceInput`, and `acpBackend/acpModel` are not. |
| `prompt-context-builder.ts` | Move and rename | `src/runtime/prompt-context.ts`: `buildPromptContext`. | Sandbox token construction, review compaction, prompt/context assembly are application behavior, but the exported ACP name must disappear. |
| `mobile-prompt.ts` | Move and rename | `src/runtime/mobile-prompt.ts`. | Prompt text and daily-review compaction do not depend on ACP. |
| `spreadsheet-output-policy.ts` | Move | `src/runtime/output-policy.ts` (or a domain policy module). | Customer-output policy is product-neutral. |
| `tool-manifest.ts` | Move | `src/runtime/tool-manifest.ts` or `src/mcp/tool-manifest.ts`. | Tool policy descriptions are product-neutral and feed context construction. |
| `context-packet.ts` | Move | `src/runtime/context-packet.ts`. | Aggregates owned service state and conversation context; it must remain service/runtime-owned. |
| `pending-state.ts` | Move | `src/runtime/pending-state.ts`; rename `PendingConfirmationKind` imports. | In-memory confirmation context is not ACP-specific. |
| `scheduled-tasks.ts` | Move and split | `src/runtime/scheduled-tasks.ts`; route to `runMastraTurn`, `createMastraToolMap`, and neutral trace. Rename exports `buildScheduledAcpChatParams` and `isLegacyReviewOrch`. | The business workflows are required; current file imports ACP agent/prompt/trace and retains an ACP execution branch. |
| `mcp-registry.ts` | Move | `src/mcp/registry.ts`. Preserve registration validation, placeholder resolution, readiness checks, ownership/trust constraints. | It is a service-owned MCP control plane, not an ACP protocol concern. |
| `external-mcp-registrations.ts` | Move | `src/mcp/external-registrations.ts`; update `src/mastra/external-mcp.ts` and observer callers. | External read-only registration policy is shared and Mastra already consumes it. |
| `mcp-tool-conflict-probe.ts` | Conditional replacement | Keep only an MCP-client transport-neutral conflict check under `src/mcp/`; remove `stdio` spawning and ACP-session cache integration. | Mastra toolsets are namespaced; re-evaluate whether conflict blocking is needed before porting. It must not remain coupled to Codex's flat namespace. |
| `mcp-session-manifest.ts` | Delete after extracting only proven-needed policy | Mastra uses in-process service tools plus `resolveExternalMastraToolsets`; move a small neutral manifest builder only if trace/audit requires it. | Its `AcpMcpServer`, stdio server assembly, `AcpBackendId`, session key, and service-MCP subprocess manifest exist for ACP. Service grants remain in `src/mcp/service-tool-classification.ts` and Mastra scope guards. |
| `budget-convergence.ts` | Delete | Replace with Mastra-native timeout/cancellation/tool-budget behavior only if a contract needs it. | `AcpBudgetRun`, capability probing, and post-exhaustion synthesis are ACP session semantics. |

After this work there should be no `src/acp/` runtime directory.  Do not keep
compatibility re-exports: they would violate the contract's no-ACP runtime
identifier requirement.

## Direct Runtime Callers to Rewire

| Caller | Current dependency | Mastra-native destination |
| --- | --- | --- |
| `src/server.ts` | Singleton `createAgent`, `AcpMessage/AcpResponse`, `/acp/message`, `/acp/alerts`, `codexAcpTraces` scheduler lookup | Neutral `createRuntimeAgent`, neutral message types and paths (for example `/agent/message`), neutral trace query. Preserve external API migration/versioning intentionally. |
| `src/channels/weixin-message-bridge.ts` | `AcpAgent`, `createAgent`, `clearAcpSessions`; config backend passed into identity provisioning | Runtime agent interface; remove ACP-session cleanup and backend argument. |
| `src/services/conversation-log.ts` | `AcpAgent`, `AcpMessage/AcpResponse`, `createAgent`; ACP error codes/comments | Runtime agent/message/response types and neutral error codes. |
| `src/services/automation-runner.ts` | ACP agent/envelope and `ACP_TURN_FAILED` | Runtime facade and `AGENT_TURN_FAILED` (or stable neutral equivalent). |
| `src/services/generic-automation-runner.ts` | ACP agent/envelope; spreadsheet policy | Runtime facade/types; import output policy from its neutral home. |
| `src/scheduler/index.ts`, `src/scheduler/review.ts` | `src/acp/scheduled-tasks.ts` | Neutral scheduled-task module. Rename `scheduled-acp` metadata/source values. |
| `src/portal/connector.ts` | `disposeAllAcp` on shutdown | Remove; use a Mastra/runtime disposal hook only if actual Mastra clients need one. |
| `src/platform/project-registry.ts` | ACP disposal and Codex/Hermes workspace runtime provisioning; backend union | Remove per-instance executable backend and provisioning. Instances represent `mastra` (or omit backend); leave Workspace assets untouched. |
| `src/routes/platform.ts` | ACP registry and executable provisioning; config backend in runtime view; ACP trace table | `src/mcp/registry.ts`, no executable provisioning, neutral trace/model fields. |
| `src/services/external-mcp-observer.ts`, `src/services/mcp-control-plane.ts` | ACP registry/registrations | Repoint to `src/mcp/*`; update ACP wording in comments and audit correlation labels. |
| `src/mastra/external-mcp.ts` | Imports `src/acp/external-mcp-registrations.ts` | Repoint to the new `src/mcp/external-registrations.ts`. |
| `scripts/mcp-registry-check.ts` | ACP registry paths | Repoint to `src/mcp/*` and retain as a neutral validation script. |
| `scripts/stage1-scheduled-tasks-smoke.mjs`, `scripts/scheduled-review-publication-probe.mjs` | `dist/acp/scheduled-tasks`, ACP disposal | Repoint to `dist/runtime/scheduled-tasks`; delete disposal. |
| `scripts/scheduled-review-publication-smoke.mjs` | Codex executable preflight and ACP imports | Replace with a Mastra gateway/config preflight or remove if it is legacy-only. |

## Non-`src/acp` Runtime Dependencies to Remove

1. `src/mastra/backend-selection.ts`: delete ACP fallback branches and
   `INVEST_AGENT_*` allowlist compatibility controls; a native worktree should
   always select Mastra.  Update `src/acp/agent.ts` and scheduled tasks first,
   then delete this selector rather than preserving an `"acp"` union.
2. `src/mastra/types.ts` and `src/mastra/run-turn.ts`: rename compatibility
   comments/aliases and `source: "acp-event"` to neutral Mastra/runtime terms.
   `mapMastraUsage` may keep its fields but must not describe them as ACP
   field names.
3. `src/lib/config.ts` and `src/lib/user-context.ts`: remove the
   `RuntimeBackend = "hermes" | "codex"` union and all `config.acp`,
   `config.codex`, and `config.hermes` objects. Add/retain only the model
   gateway configuration and neutral runtime timeouts/labels.
4. `src/lib/user-identity.ts`, `src/services/push-queue.ts`,
   `src/mcp/service-tools-core.ts`, `src/channels/weixin-mobile.ts`,
   `src/routes/platform.ts`, and `src/server.ts` still persist or pass
   `"codex"`/`"hermes"` backend values. Change their contracts/defaults in
   the same schema migration as project instances.
5. `src/lib/customer-output.ts` has ACP diagnostic filtering. Replace the
   patterns with neutral runtime diagnostics only where user-facing filtering
   remains necessary.
6. `src/services/conversation-log.ts`, `src/services/automation-runner.ts`,
   and tests contain `ACP_TURN_*` operational strings. Rename together to
   avoid breaking persisted task-run error-code display.

## Database and Config Inventory

| Location | Required change |
| --- | --- |
| `src/db/schema.ts` | Replace `codexAcpTraces` / `codex_acp_traces` with a neutral `agentTraces` table (new clean DB); replace `acpBackend/acpModel` with provider/model/runtime fields as needed. |
| `src/db/index.ts` | Remove creation, `ensureColumn`, indexes, seed/defaults, backup table list, and `normalizeRuntimeBackendToCodex()` migration for legacy names. Add a separately reviewed, idempotent old-to-new trace and `ai_instances.backend` migration. Do not make target startup depend on it. |
| `src/routes/platform.ts`, `src/routes/sandbox.ts`, `src/server.ts`, `src/platform/project-registry.ts`, `scripts/recent-logs.mjs` | Query/delete/report the neutral trace table, including project deletion and scheduler-status lookup. |
| `.env.example` | Remove `ACP_*`, `CODEX_ACP_*`, `HERMES_*`, `CODEX_SOURCE_HOME`, `CODEX_SIMPLE_MODEL`, `CODEX_COMPLEX_MODEL`, `ACP_MODEL_ROUTER_*`, `PORTAL_DIRECT_ACP_TIMEOUT_MS`, and ACP wording in external-MCP comments. Add neutral gateway/timeout names only. |
| `scripts/run-mastra-local.sh` | It currently parses `/Users/combo/.codex/config.toml` and `auth.json`; replace with explicit `MASTRA_GATEWAY_BASE_URL`/`MASTRA_GATEWAY_API_KEY` environment inputs or a neutral secret source. Remove `INVEST_AGENT_EXECUTION_BACKEND=mastra` once no selector exists. |
| `package.json`, `package-lock.json` | Remove `@agentclientprotocol/sdk`; delete ACP-only probe scripts (`probe:mcp-acp-e2e`, `probe:mcp-tool-call`, `probe:mcp-qsse-tool-call`, `probe:mcp-fixture-tool-call`) or rename/reimplement for Mastra. Keep `@mastra/core`, `@mastra/mcp`, and `@modelcontextprotocol/sdk` because external MCP and transport-neutral inspection still use them. Update description from ACP Agent. |

Codex-named Workspace paths (`templates/workspace/.codex`,
`src/lib/workspace-compatibility.ts`, workspace backup/deploy scripts, and
Codex-usage reporting) need a separate asset-adoption plan. They are customer
Workspace assets under the repository policy, not safe runtime cleanup.
However, the target runtime cannot provision `.codex` homes, read Codex auth,
or depend on those paths to answer a request. The relevant provisioning and
auth code is in `stdio-agent.ts`/`project-registry.ts`, and must be removed.

## Minimal Test Changes

Delete ACP implementation tests once their neutral replacements exist:

- `tests/acp-mcp-runtime-env.test.ts`, `tests/acp-session-key.test.ts`,
  `tests/mcp-conflict-session-integration.test.ts`, and
  `tests/acp-customer-output.test.ts` (the `ResponseCollector` portion).
- `tests/acp-budget-convergence.test.ts` and the ACP fallback cases in
  `tests/mastra-backend-selection.test.ts`.
- ACP stdio/process probe scripts and any test asserting Codex/Hermes runtime
  homes or executable setup.

Move and rename tests that cover retained behavior:

- `tests/mobile-prompt.test.ts`, `tests/output-volume-policy.test.ts`,
  `tests/scheduled-daily-review-contract.test.ts`,
  `tests/scheduled-market-watch-contract.test.ts`, and the useful non-ACP
  parts of `tests/scheduled-acp-scope.test.ts` to `runtime-*` names/imports.
- `tests/acp-trace-observability.test.ts` to `agent-trace-observability.test.ts`,
  targeting the neutral table and `recordAgentTrace`.
- `tests/acp-mcp-registry.test.ts`, `tests/acp-mcp-external.test.ts`,
  `tests/mcp-control-plane.test.ts`, `tests/service-tool-grant.test.ts`, and
  `tests/mcp-tool-conflict-probe.test.ts` to `mcp-*` imports. Retain service
  grants, external-read-only restrictions, and secret-isolation assertions;
  replace only the ACP stdio manifest/session assertions.
- `tests/portal-visual-policy.test.ts`, `tests/automation-generic-tasks.test.ts`,
  scheduler/automation tests, and WeChat long-task tests for renamed runtime
  types/error codes.

Add focused replacement coverage: native route-to-runtime wiring (no fallback),
WeChat/Portal/automation/scheduler use `runMastraTurn`, Mastra external MCP
toolset connection/disconnect, neutral trace persistence/query, clean DB with
no ACP/Codex/Hermes table/settings, and `mastra:local` with explicit neutral
gateway configuration.

## Verification Gates

1. `rg -n -i 'agentclientprotocol|acp|codex|hermes' src package.json
   package-lock.json .env.example scripts tests` has no runtime references;
   allow only separately documented one-way migration material and unmodified
   customer-asset templates after review.
2. Run `npm run typecheck`, `npm test`, `npm run build`, `npm run
   test:boundary`, and `npm run mastra:local` with dedicated roots and gateway
   variables. Exercise message, attachment, confirmation, automation,
   scheduled review/watch, and external-MCP representative paths.
3. Verify fresh DB schema and portal/admin trace queries use neutral names;
   validate a one-way historical migration independently before any customer
   cutover.
