---
name: scheduler-push-debug
description: Use when diagnosing Invest Agent scheduled tasks, market-watch pushes, review pushes, rule inspection, push_jobs, scheduled_task_runs, WeChat SendMessage failures, ret codes, delayed pushes, or why a user did not receive a scheduled message.
---

# Scheduler Push Debug

Use this skill when the symptom is “it should have pushed/replied/run, but did not” or when scheduled review, market-watch, rule inspection, and WeChat delivery timing need to be explained.

## Guardrails

- Start read-only. Do not replay pushes, edit schedules, or mark jobs complete until the failure mode is understood.
- Separate three stages: scheduler decision, job execution, and delivery through WeChat/portal.
- Always include exact timestamps and timezone assumptions in the conclusion.
- Do not expose internal paths, tokens, curl commands, or DB details in customer-facing text.

## Read First

- `references/stage1-runbook.md` for manual scheduler/push acceptance and DB inspection.
- `docs/watch-runtime-phased-implementation.md` for current watch runtime behavior and rule inspection ownership.
- `docs/quality/test-system-health-review.md` when turning the incident into a deterministic regression contract.
- `CLAUDE.md` for commands, table names, scripts, and API entry points.

## Fast Triage

1. Identify affected user, instance, channel, expected task type, expected time window, and whether the report concerns local dev or Volcano production.
2. Check process health and recent logs:

```bash
npm run logs
npm run logs:errors
```

3. Query scheduler and push state around the expected time:

```sql
select * from scheduled_task_runs
where user_id = '<user>' or instance_id = '<instance>'
order by created_at desc
limit 50;

select * from push_jobs
where user_id = '<user>' or instance_id = '<instance>'
order by created_at desc
limit 50;
```

4. Check user-visible and ACP traces:

```sql
select created_at, channel, role, substr(content,1,400)
from conversation_messages
where user_id = '<user>' or instance_id = '<instance>'
order by created_at desc
limit 50;

select created_at, mode, status, substr(user_text,1,200), substr(reply_text_sanitized,1,300)
from codex_acp_traces
where user_id = '<user>' or instance_id = '<instance>'
order by created_at desc
limit 50;
```

5. Check sandbox/API actions when a deterministic capability should have been called:

```sql
select created_at, operation, resource_type, status, substr(result_summary,1,300)
from sandbox_audit_logs
where user_id = '<user>' or instance_id = '<instance>'
order by created_at desc
limit 50;
```

## Diagnose By Stage

- No `scheduled_task_runs`: scheduling scope/config/window did not match, service was down, lock/tick did not run, or wrong environment was inspected.
- `scheduled_task_runs` skipped: inspect skip reason; distinguish no market, duplicate claim, disabled schedule, no content, or cooldown.
- Task succeeded but no `push_jobs`: generation completed but push was intentionally suppressed or not enqueued.
- `push_jobs` queued/stuck: worker/process/channel issue.
- `push_jobs` failed with WeChat ret code: delivery issue; inspect WeChat login/session, message size, account status, and SDK result.
- Message sent but user did not see it: check channel binding, recipient identity, portal mirror, and duplicate local/production environments.

## Rule Inspection Notes

- Rule inspection is service-owned and deterministic.
- Default rule inspection is interval based, not the same as market-watch fixed windows.
- Do not reinterpret rule inspection as “intraday touched high” or close-confirmation semantics unless the user explicitly redesigns it.
- When rule pushes only appear at market-watch windows, compare independent scheduler tick logs, `scheduled_task_runs`, and rule cooldown/priority gates before changing behavior.

## Verification Commands

Use the smallest command that matches the changed or suspected area:

```bash
npm run build
npm run smoke:stage1-scheduler
npm run smoke:stage2-watch-rules
npm run smoke:review-push-summary
npm run smoke:weixin-complex-ack
npm run smoke:customer-output
```

For local controlled triggering, use the testing scheduler API described in `references/stage1-runbook.md` and verify DB rows afterward.

## Report Shape

Report in this order:

1. Whether the task was scheduled.
2. Whether it ran.
3. Whether content was generated.
4. Whether a push job was created.
5. Whether WeChat/portal accepted delivery.
6. Root cause or most likely gap.
7. Suggested fix or next verification.
