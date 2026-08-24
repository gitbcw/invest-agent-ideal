# Mastra Runtime Observability Contract

## Scope

This contract applies to Mastra-native turns from Portal, WeChat, scheduler, and automation. `agent_traces` is the authoritative Agent execution table; conversation, automation, artifact, and delivery tables remain owners of their own business state.

## Correlation

| Field | Meaning | Required source |
| --- | --- | --- |
| `traceId` | One Agent request/turn correlation key | Runtime message id |
| `conversationId` | User-visible conversation or scheduler conversation | Channel/scheduler context |
| `runId` | A concrete automation/scheduled run | Automation or scheduler runner |
| `taskId` | Automation task definition | Automation context |
| `messageId` | Channel or persisted message identity | Portal/WeChat/runtime adapter |

Interactive turns must have `traceId`, `conversationId`, backend and model. Scheduler turns must additionally have `runId` when the runner owns one (since 2026-08-24 / WP3 the market-watch and review runners pass their `taskKey` as `runId`, so scheduler traces link to `scheduled_task_runs.taskKey` explicitly). Automation turns must additionally have `taskId`. Coverage is reported by `/api/platform/audit/trace-coverage` and does not count inapplicable fields as missing.

Service-tool audits written from an agent turn carry the turn's `trace_id` in `sandbox_audit_logs` (explicit correlation; no time-proximity inference). Legacy audit rows without `trace_id` remain conversation-level evidence only and are counted as gaps by the run-diagnostic coverage metrics. The end-to-end diagnostic view lives in [run-diagnostic-view-contract.md](./run-diagnostic-view-contract.md) and `GET /api/platform/audit/run-diagnostic`.

## Required execution data

- `agentBackend=mastra` and the actual `agentModel`.
- `modelSource` describing controlled runtime configuration, never a secret.
- terminal status: `success`, `error`, or `timeout`; cancellation is represented in the response/error classification as `TASK_CANCELLED`.
- bounded usage, tool-call summaries, elapsed time, and redacted error text.

## Secret boundary

API keys, Authorization headers, MCP credentials, local auth-file contents, and raw gateway configuration must never enter a trace, audit response, log, or artifact.

## Failure behavior

Trace persistence is best effort and must not block the customer response. A persistence failure is logged as an operational warning; the coverage endpoint exposes the resulting gap for follow-up.

## Verification

- `tests/acp-trace-observability.test.ts` verifies additive schema compatibility, redaction, compact tool metadata, and correlation fields.
- `tests/portal-conversation-cancel.test.ts` verifies cancellation/restart terminal evidence.
- `npm test`, `npm run typecheck`, `npm run build`, and `git diff --check` are required after changes.
