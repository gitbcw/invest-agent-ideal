# ACP Trace and Audit Observability Contract

This contract keeps runtime observability small, safe, and useful. It separates customer conversation history, ACP turn traces, deterministic service audits, and delivery/task records instead of treating one table as the source of truth for everything.

## What exists now

- `conversation_messages`: user-visible conversation history and delivery-facing message records. This is the source for chat history, not raw trace.
- `codex_acp_traces`: one ACP turn record for debugging model/runtime behavior.
- `sandbox_audit_logs`: deterministic service/MCP operation audit for state reads, writes, confirmations, review publication, market facade calls, and public evidence tools owned by the service.
- `pending_sandbox_confirmations`: confirmation lifecycle records for durable writes.
- `scheduled_task_runs`, `push_jobs`, `weixin_delivery_attempts`: scheduler and delivery lifecycle.
- `agent_traces`: frozen legacy runtime table; current `src/` should not write new rows.

## Keep in `codex_acp_traces`

Keep fields that answer "what happened to this ACP turn?" without storing unnecessary internal content:

- Scope: `user_id`, `project_id`, `instance_id`, `conversation_id`, `message_id`, `channel`, `mode`.
- Outcome: `status`, `error_message`, `elapsed_ms`, `created_at`.
- Model/runtime: `acp_backend`, `acp_model`.
- MCP assembly: sanitized `mcp_manifest` with server ids, transport kind, version, and config fingerprint only. No secrets, env values, tool results, or payloads.
- User/customer text: `user_text` and `reply_text_sanitized`, redacted and truncated.
- Size/cost: `prompt_chars`, `reply_chars`, token/cost fields, `usage_source`.
- Narrow task summary: `review_context_summary`, `sandbox_token_id`, `sandbox_permissions`.

By default, successful turns should not store full `prompt_text`, `reply_text_raw`, or `usage_raw`. They may be enabled temporarily with debug env flags during local diagnosis:

- `ACP_TRACE_STORE_PROMPT_TEXT=true`
- `ACP_TRACE_STORE_RAW_REPLY=true`

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

External read-only MCP native tool calls, such as `market-data-tool`, are currently visible to ACP but not uniformly mirrored into `sandbox_audit_logs` because they bypass `invest-agent-service-tools`. For local diagnosis, `mcp_manifest` proves which external servers were mounted, but it does not enumerate every native tool call.

If exact external MCP tool-call telemetry becomes necessary, add a small MCP proxy/observer layer or a Codex ACP event hook that records only:

- server id, tool name, status, elapsed time;
- result size and provider/source metadata when available;
- no raw result payload by default.

Do not re-wrap external data tools into service-owned market facades just for trace.

## What to remove or stop relying on

- Do not use `codex_acp_traces.prompt_text` as conversation history.
- Do not write new `agent_traces` rows.
- Do not store full successful prompts or raw replies by default.
- Do not duplicate deterministic tool payloads into both trace and audit unless needed for confirmation/security.
- Do not infer MCP tool availability from ACP slash commands or resources; use session manifest for mounted servers and MCP/audit evidence for calls.
