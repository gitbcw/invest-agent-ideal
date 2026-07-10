---
name: onboarding-flow-eval
description: "Use when running or auditing the Invest Agent onboarding journey: create a fresh eval user, conduct a natural onboarding conversation, inspect conversation logs, sandbox audit, ACP traces, workspace config, identify issues, and decide whether to fix prompt, skill, service, deterministic contract, or docs."
---

# Onboarding Flow Eval

Use this project-only skill for end-to-end onboarding audit. It owns onboarding quality standards and audit practice; `invest-eval` remains the general entry point.

## Purpose

Onboarding is a continuous user journey, not a set of isolated prompts. The main quality question is whether a fresh user can naturally move through the assistant's guidance in one conversation and end with correct workspace state.

This skill runs and audits:

- New eval user and workspace creation.
- Continuous WeChat-simulated conversation.
- Deterministic workspace expectations.
- Conversation quality and confirmation discipline.
- Sandbox audit, ACP traces, and service logs needed for root cause analysis.

## Read First

- `references/standards.md` for onboarding quality standards.
- `references/audit-checklist.md` for the exact audit sequence.
- `references/failure-modes.md` when classifying issues.
- `references/workflow-map.md` for the direct execution path and evidence map.

## Direct Run

Generate a timestamped `runId`, `userId`, and `conversationId`. Create a fresh Invest Agent instance for that user, obtain its `WeixinMobileManager` with `projectWeixinManagerForInstance(instanceId)`, and conduct the smallest natural onboarding conversation needed to inspect the behavior under change. Keep one `conversationId` and a dedicated account ID. Record every input, returned text, elapsed time, and generated IDs directly in the Codex conversation.

Wrap the complete run and audit in `try`/`finally`. After the evidence is inspected and recorded, call `deleteInvestAgentInstance(instanceId)` in `finally`, whether the evaluation passes, fails, or throws. This service-owned deletion disposes ACP, clears the instance and user-scoped records, and removes the workspace directory. Do not use `disposeAcpForWorkspace(workspacePath)` alone and do not hand-delete individual records. If cleanup fails, retain the IDs and report the cleanup failure as an open finding.

This is deliberately a Skill-directed operation, not an npm runner: do not write `eval-reports`, create a review queue, or apply string-based static verdicts in place of semantic review.

## Audit Workflow

1. Create the fresh user/instance and run the natural onboarding exchange using the direct-run procedure above.
3. Record the generated `userId`, `instanceId`, `conversationId`, `workspacePath`, and every actual output in the Codex conversation.
4. Inspect service-owned logs for that run:

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

5. Inspect workspace files:

```bash
sed -n '1,220p' <workspacePath>/config/onboarding_state.yaml
sed -n '1,220p' <workspacePath>/config/portfolio.yaml
sed -n '1,220p' <workspacePath>/config/strategy.yaml
sed -n '1,220p' <workspacePath>/config/schedules.yaml
sed -n '1,220p' <workspacePath>/config/notification.yaml
sed -n '1,220p' <workspacePath>/config/watch.yaml
```

6. Compare the actual workspace outcome with the quality standards and user-provided choices; treat it as deterministic evidence, not a substitute for reviewing the conversation.
7. Classify each issue using `references/failure-modes.md`.
8. Recommend one action per issue:
   - fix workspace onboarding skill/prompt;
   - fix service API or confirm-step writer;
   - add or improve a deterministic contract;
   - update this skill's standards/checklist;
   - archive as observation.
9. If fixing code or prompts, run the smallest relevant verification afterward.
10. In a `finally` block, delete the temporary evaluation instance with `deleteInvestAgentInstance(instanceId)` after recording the evidence required for this report.

## Output Format

Report in Chinese:

- What was run: user intent, run id, generated user, and conversation ID.
- Evidence read: actual turn outputs, DB logs, audit logs, traces, workspace files.
- Passes: key things that worked.
- Findings: ordered by severity, with evidence and root cause.
- Fix plan: prompt/skill/service/contract/docs.
- Follow-up verification: exact command to rerun.

Do not use a Platform human-review flow or `eval-reports` as the closure mechanism. Platform can display materials, but the closure is this conversation: run, inspect, fix, rerun.
