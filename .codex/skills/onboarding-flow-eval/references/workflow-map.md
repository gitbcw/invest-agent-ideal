# Onboarding Audit Map

## Files

- Executor: the `onboarding-flow-eval` Skill, using the current WeChat simulation capability directly.

## Generated Scope

The Skill creates:

- `userId`: `eval-onboarding-<run-id>`, lowercased.
- `instanceId`: `invest-agent-<userId>`.
- `conversationId`: `eval-onboarding-<run-id>`.
- `workspacePath`: resolved by `resolveWorkspacePath(userId)`.

Record these IDs in the Codex conversation before inspecting evidence. Do not write them to a shared report directory.

## Scope

Use natural user turns appropriate to the changed behavior. The quality baseline is `standards.md`, the active workspace onboarding Skill, and real audit evidence; do not recreate a scripted golden workflow.

## Useful SQLite Queries

Use the generated IDs:

```sql
select created_at, channel, role, substr(content,1,800) as content
from conversation_messages
where user_id='<userId>' or instance_id='<instanceId>' or conversation_id='<conversationId>'
order by created_at asc;

select created_at, operation, resource_type, status, substr(request_body,1,800) as request, substr(result_summary,1,400) as result
from sandbox_audit_logs
where user_id='<userId>' or instance_id='<instanceId>'
order by created_at asc;

select created_at, mode, status, substr(user_text,1,300) as input, substr(reply_text_sanitized,1,800) as output
from codex_acp_traces
where user_id='<userId>' or instance_id='<instanceId>'
order by created_at asc;
```

## When To Improve This Skill

After every meaningful onboarding audit, update the smallest relevant reference:

- New quality bar: `standards.md`
- New evidence step: `audit-checklist.md`
- New recurring bug class: `failure-modes.md`
- Direct execution path or material location changes: `workflow-map.md`
