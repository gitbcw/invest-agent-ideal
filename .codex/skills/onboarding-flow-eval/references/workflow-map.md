# Onboarding Execution And Evidence Map

## Generated Scope

- `runId`: timestamped unique run identifier.
- `userId`: `eval-onboarding-<run-id>`, lowercased.
- `instanceId`: `invest-agent-<userId>`.
- `conversationId`: `eval-onboarding-<run-id>`.
- `workspacePath`: resolved with `resolveWorkspacePath(userId)`.

Record these before sending the first turn. Keep the same conversation and one long-lived evaluation controller through evidence collection and cleanup handling.

## Execution Paths

- **Changed-step path:** run the shortest natural journey that reaches and exits the changed behavior.
- **Skip path:** draft `watch_rules` with `skip=true`, receive a separate confirmation, accept the draft and enqueue the final commit; expect zero scoped rules.
- **Configured path:** draft one executable catalog-supported rule inside `watch_rules`, receive a separate confirmation, accept the draft, enqueue the final commit, then verify the created rule.

When first-time rule setup changes, run both skip and configured paths unless the user explicitly narrows scope.

## Evidence Locations

Use generated IDs to scope queries:

```sql
select created_at, channel, role, substr(content,1,800) as content
from conversation_messages
where user_id='<userId>' or instance_id='<instanceId>' or conversation_id='<conversationId>'
order by created_at asc;

select created_at, operation, resource_type, status,
       substr(request_body,1,800) as request,
       substr(result_summary,1,400) as result
from sandbox_audit_logs
where user_id='<userId>' or instance_id='<instanceId>'
order by created_at asc;

select created_at, mode, status, substr(user_text,1,300) as input,
       substr(reply_text_sanitized,1,800) as output
from codex_acp_traces
where user_id='<userId>' or instance_id='<instanceId>'
order by created_at asc;

select id, stock_code, stock_name, indicator_key, condition, enabled, params
from alert_rules
where user_id='<userId>' and instance_id='<instanceId>'
order by id asc;

select id, operation, status, expires_at
from pending_sandbox_confirmations
where user_id='<userId>' and instance_id='<instanceId>'
order by created_at asc;
```

Workspace evidence lives under `<workspacePath>/config/`; write history is in `<workspacePath>/memory/change_log.jsonl`.

## Retention And Cleanup

Default to `retain` and report all generated IDs for Platform inspection. For an explicit cleanup request, invoke `eval-instance-cleanup` after evidence capture; it must delete the instance, scoped records, workspace, and ACP runtime. Verify each is absent. Do not hand-delete rows or treat `disposeAcpForWorkspace` as instance deletion.

## Maintenance Routing

- Stable user outcome or failure boundary: `standards.md`.
- Evidence needed to grade a standard: `audit-checklist.md`.
- Severity or owner class: `failure-modes.md`.
- Concrete recurring incident: `regressions.md`.
- IDs, execution paths, evidence locations, or cleanup mechanics: this file.
