# Agent Trace and Audit Observability Contract

This contract keeps agent observability small, safe, and useful. It separates customer conversation history, ACP turn traces, deterministic service audits, and delivery/task records instead of treating one table as the source of truth for everything.

## What exists now

- `conversation_messages`: user-visible conversation history and delivery-facing message records. This is the source for chat history, not raw trace.
- `agent_traces`: one runtime turn record for debugging model/runtime behavior, independent of ACP or Mastra.
- `sandbox_audit_logs`: deterministic service/MCP operation audit for state reads, writes, confirmations, review publication, market facade calls, and public evidence tools owned by the service.
- `pending_sandbox_confirmations`: confirmation lifecycle records for durable writes.
- `scheduled_task_runs`, `push_jobs`, `weixin_delivery_attempts`: scheduler and delivery lifecycle.
- `agent_traces_legacy_runtime_v1`: preserved legacy self-managed runtime table when a database still had the incompatible historical shape.
- `codex_acp_traces`: frozen legacy ACP audit table. Existing rows are copied once to `agent_traces` on database initialization.

## Keep in `agent_traces`

Keep fields that answer "what happened to this ACP turn?" without storing unnecessary internal content:

- Scope: `user_id`, `project_id`, `instance_id`, `conversation_id`, `message_id`, `channel`, `mode`.
- Outcome: `status`, `error_message`, `elapsed_ms`, `created_at`.
- Model/runtime: `agent_backend`, `agent_model`.
- Tool assembly: sanitized `tool_manifest` with server ids, transport kind, version, and config fingerprint only. No secrets, env values, tool results, or payloads.
- Tool events: compact, valid-JSON `tool_calls` summaries with tool call ids, title/tool name when exposed, status, elapsed time, and input/output sizes. Oversized payloads are stored as a valid JSON truncation envelope rather than sliced text. These prove that the runtime emitted/observed a tool-call event; they do not yet prove which external MCP server executed it.
- User/customer text: `user_text` and `reply_text_sanitized`, redacted and truncated.
- Size/cost: `prompt_chars`, `reply_chars`, token/cost fields, `usage_source`.
- Narrow task summary: `review_context_summary`, `sandbox_token_id`, `sandbox_permissions`.

By default, successful turns should not store full `prompt_text`, `reply_text_raw`, or `usage_raw`. They may be enabled temporarily with debug env flags during local diagnosis:

- `AGENT_TRACE_STORE_PROMPT_TEXT=true`
- `AGENT_TRACE_STORE_RAW_REPLY=true`

Errors may still retain truncated prompt/raw reply because failure diagnosis needs more context.

## Keep in `sandbox_audit_logs`

Service-owned deterministic actions should be audited here, not expanded into ACP trace:

- Operation name, status, scope, resource type/id.
- Compact request/result summaries.
- Confirmation request/write lifecycle.
- Service-owned market facade calls while they exist.
- Public evidence search/read calls owned by the service.

Do not store large market payloads, full webpages, raw MCP stdout, credentials, sandbox tokens, or full model prompts.

## Known gap

External read-only MCP native tool calls, such as `market-data-tool`, are currently visible to ACP and their ACP-side lifecycle is captured in `tool_calls`, but they are not uniformly mirrored into `sandbox_audit_logs` because they bypass `invest-agent-service-tools`. For local diagnosis, `mcp_manifest` proves which external servers were mounted, while `tool_calls` proves the Agent-side event; neither currently proves which external server received and executed the request.

When `INVEST_AGENT_MCP_OBSERVER_ENABLED=true`, the built-in Streamable HTTP observer is placed between ACP and each enabled external HTTP MCP. It records only:

- server id, tool name, status, elapsed time, and the per-turn `run_id`;
- result size and provider/source metadata when available;
- no raw result payload by default.

For observer-routed external HTTP MCPs, the session is scoped to a single turn because MCP headers are fixed at session creation. `run_id` equals `agent_traces.message_id`, so observer evidence can be joined to one exact agent trace instead of merely the broader conversation.

The observer is opt-in so existing direct MCP installations remain compatible. It keeps external credentials in the service process; ACP receives only the service observer token and scope headers. Do not re-wrap external data tools into service-owned market facades just for trace.

## What to remove or stop relying on

- Do not use `agent_traces.prompt_text` as conversation history.
- Do not write new rows to `codex_acp_traces` or `agent_traces_legacy_runtime_v1`.
- Do not store full successful prompts or raw replies by default.
- Do not duplicate deterministic tool payloads into both trace and audit unless needed for confirmation/security.
- Do not infer MCP tool availability from ACP slash commands or resources; use session manifest for mounted servers and MCP/audit evidence for calls.
