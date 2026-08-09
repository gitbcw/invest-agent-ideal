---
name: audit-driven-diagnosis
description: "Diagnose Invest Agent behavior from audit evidence over a specified time range. Use when Codex needs to investigate real user/session problems, scan conversation messages, ACP traces, sandbox audits, scheduler or delivery records, correlate cases across users or workflows, identify evidence-backed failure stages and likely root causes, and write a human-reviewable diagnosis report. This skill is read-only: it does not decide product correctness where standards are undefined, change production state, replay jobs, deploy fixes, or modify user Workspaces."
---

# Audit-Driven Diagnosis

Use this skill as the production-evidence diagnosis layer. The task is to explain what happened, what may be wrong, how confident that conclusion is, and what should be verified or fixed. Do not turn an observed interaction into a product defect without an applicable product contract, Skill/workspace rule, deterministic service contract, or explicit user expectation.

## Input Contract

Require or establish before scanning:

- An explicit time range (`start` and `end`) and timezone. Use an absolute range when possible; never silently interpret “recently”.
- Environment (`local`, staging, or production) and the evidence scope.
- Optional filters: user, instance, conversation, workflow/capability, channel, release window, or symptom.
- Whether the report is exploratory, incident-focused, or a post-change comparison.

If the range or environment is missing, ask for it unless it can be derived unambiguously from the request. Start read-only and do not expose secrets, tokens, or unnecessary personal content.

## Diagnostic Workflow

1. **Define the question and baseline.** State what behavior is being diagnosed and which current contract, Skill, workspace rule, or user expectation is the comparison baseline. If no baseline exists, record that as an evaluation gap rather than inventing one.
2. **Collect evidence.** Inspect the smallest relevant set of `conversation_messages`, `codex_acp_traces`, `sandbox_audit_logs`, scheduler/delivery records, application logs, and workspace artifacts. Preserve IDs and exact timestamps (with timezone), but redact secrets and minimize user content in the report.
3. **Build case records.** For every candidate anomaly, record the user intent, observed behavior, expected behavior if known, evidence references, affected scope, and an initial classification: service defect, Skill/prompt gap, deterministic-contract gap, configuration/data issue, delivery/operations issue, documentation gap, normal behavior, or insufficient evidence.
4. **Separate facts from interpretation.** Keep observed facts, applicable standard, inference, and missing evidence in distinct fields. Do not infer a root cause from a single error string when the trace does not establish the failing stage.
5. **Cluster related cases.** Group cases with the same failure signature or causal chain across users and workflows. Keep every case linked to one or more problem-cluster IDs. Do not merge merely because the user-visible symptom has the same wording.
6. **Diagnose each cluster.** Reconstruct the chain from request to orchestration, tool/service call, persistence, scheduling, and delivery as applicable. Mark the root-cause status `confirmed`, `probable`, or `unknown`; include the evidence that would change the status.
7. **Prioritize.** Rank by severity, user impact, frequency, recurrence, breadth, and confidence. Escalate safety, isolation, data-integrity, or broad-availability issues immediately; batch ordinary P2/P3 findings for the range-level report.
8. **Propose remediation and verification.** Give one recommended action per cluster at the correct ownership layer (service, Skill/prompt, deterministic contract, configuration/data, operations, or documentation). Include a concrete rerun, regression test, query, or acceptance check. Do not execute the action in this Skill.
9. **Write the report and review queue.** Use the structure in `references/diagnosis-report.md`. End with explicit human-review decisions: accepted diagnosis, rejected diagnosis, needs more evidence, or standards gap.

## Judgment Guardrails

- Diagnose behavior, not model intent. A plausible answer is not evidence that the interaction was correct or incorrect.
- Treat missing or ambiguous product standards as a first-class finding. Phrase the result as “cannot determine correctness under the current contract” and propose the smallest clarification or deterministic check.
- Preserve case-level evidence while making remediation cluster-level. Avoid one fix task per user when cases share a causal chain.
- Do not force every case into a common cluster. Keep isolated cases separate when their stages, evidence, or ownership differ.
- Distinguish user-specific configuration/data problems from shared product defects.
- Do not silently widen the requested time range or scope. Record query boundaries and any evidence that could not be inspected.
- Do not modify production databases, Workspaces, schedules, push status, code, or deployment state. Hand off confirmed actions to the appropriate project Skill after explicit authorization.

## Existing Skill Handoffs

- Use `invest-eval` when the user wants a deliberate evaluation of a specific product behavior or interaction.
- Use `scheduler-push-debug` for a cluster that specifically concerns scheduler decisions, job execution, or WeChat/portal delivery.
- Use `volcano-ops` for authorized production health, deployment, rollback, or runtime inspection.
- Use `service-api-change`, `db-migration`, or another implementation Skill only after the human accepts the diagnosis and requests a change.

## Output Requirements

Report in Chinese by default. Always include:

- Scope: time range, timezone, environment, filters, and evidence sources.
- Executive summary: counts and the highest-impact findings.
- Problem clusters with linked cases, impact, failure stage, root-cause confidence, and ownership layer.
- Evidence and missing evidence for every non-trivial conclusion.
- Recommended remediation and an exact verification plan.
- Human review queue and unresolved standards/evaluation gaps.

For an exploratory scan with no confirmed defect, say so plainly. “No confirmed defect” is a valid result; do not fill the report with speculative fixes.

See `references/diagnosis-report.md` for the report template and field definitions.
