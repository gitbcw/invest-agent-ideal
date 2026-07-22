---
name: onboarding-flow-eval
description: "Use when running or auditing the Invest Agent onboarding journey: create a fresh eval user, conduct a natural onboarding conversation, inspect conversation logs, sandbox audit, ACP traces, workspace config, identify issues, and decide whether to fix prompt, skill, service, deterministic contract, or docs."
---

# Onboarding Flow Eval

Audit onboarding as one guided user journey. Use `invest-eval` for general product evaluation; use this Skill for onboarding-specific execution and judgment.

## References

- Read [standards.md](references/standards.md) before grading; it defines `ONB-01` through `ONB-06`.
- Read [audit-checklist.md](references/audit-checklist.md) when collecting conversation and deterministic evidence.
- Read [workflow-map.md](references/workflow-map.md) when creating the evaluation scope, querying evidence, or cleaning up.
- Read [failure-modes.md](references/failure-modes.md) when assigning severity and ownership.
- Read [regressions.md](references/regressions.md) when the changed behavior overlaps a known incident or when adding a new recurring case.

## Run

1. Generate a timestamped `runId`, `userId`, and `conversationId`, then create a fresh Invest Agent instance and record all generated IDs.
2. Set `retention=retain|cleanup` before creation. Default to `retain`; cleanup requires an explicit user request.
3. Keep one long-lived controller for the simulated conversation, ACP session, evidence collection, and its `finally` block.
4. Send one natural user turn at a time. Read the actual reply before choosing the next input; never replay a detached batch of confirmations.
5. Exercise the smallest path that covers the changed behavior. If first-time rule setup changed, cover both branches unless scope was explicitly limited:
   - `skip`: explicitly decline rules and finish with no scoped rule.
   - `configured`: provide one executable catalog-supported condition, confirm its draft separately, and verify the created rule.
6. Record every input, actual reply, elapsed time, and controller outcome in the Codex conversation.
7. Collect the conversation, audit, trace, workspace, rule, and pending-confirmation evidence described in the audit checklist.
8. Grade every standard `pass`, `partial`, or `fail`; classify each finding and recommend one owner/action.
9. Retain the instance for inspection, or invoke `eval-instance-cleanup` after evidence capture when cleanup was explicitly requested.

Do not create `eval-reports`, a review queue, or string-matching verdicts. The evaluator performs semantic judgment; deterministic checks only establish hard facts.

## Completion Conditions

Before declaring a run complete, verify:

- `config/onboarding_state.yaml` has `status=completed` and `current_step=completed`.
- Intended onboarding writes have successful scoped audit evidence.
- No pending confirmation remains for the evaluation user and instance.
- The selected branch has the expected scoped rule result.
- Customer-visible text contains no internal diagnostics or implementation details.

Treat a turn at or above 45 seconds as a performance observation. Treat a timeout or avoidable user-facing wait at or above 120 seconds as a finding.

## Report

Report in Chinese:

- Scope: intent, run ID, user, instance, conversation, branch, and retention.
- Evidence: actual turns, DB/audit/trace records, workspace files, rules, pending confirmations, and quote freshness when relevant.
- Standards: `ONB-01` through `ONB-06`, each graded `pass / partial / fail` with concise evidence.
- Latency: every turn, with threshold observations.
- Findings: severity, evidence, root cause, owner, and smallest corrective action.
- Closure: verification or rerun needed, retained IDs, and cleanup route when applicable.

Do not end at “人工待审”. Close each finding with a fix, a deterministic contract, a regression record, or an explicitly archived observation.
