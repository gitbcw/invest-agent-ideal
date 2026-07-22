---
name: invest-eval
description: Run and summarize Invest Agent audit-driven product evaluations. Use when the user asks to evaluate a business domain, inspect real outputs and logs, review an interaction, summarize evidence, or decide whether to fix the system, improve a skill, add a deterministic contract, or archive an observation.
---

# Invest Eval

Use this skill to evaluate real Invest Agent behavior from the repo root.

The current product model is:

- Skills, workspace context, and accumulated engineering experience are the long-lived quality baseline.
- Codex is the default semantic evaluator because it has project context and can read actual interaction evidence.
- Conversation logs, sandbox audit logs, ACP traces, workspace artifacts, and deterministic contract results are the evidence base.
- External AI judges, golden-case libraries, evaluation workbenches, and report queues are not part of the evaluation loop.

Also use this skill when a real incident should become a Skill/prompt improvement, a deterministic contract, an audit checklist addition, or an archived observation.

## Default Workflow

1. State the product behavior or risk being evaluated.
2. Choose the smallest real interaction that exercises it. Use a fresh, explicitly named user/workspace when state is involved; do not reuse `primary`, a shared workspace, or a fixed default port. Treat the fresh identity as a retained evaluation fixture by default so its evidence remains available for human review.
3. Retain the actual inputs, outputs, identity IDs, and conversation ID in the Codex conversation.
4. Inspect `conversation_messages`, `sandbox_audit_logs`, `codex_acp_traces`, and relevant workspace artifacts.
5. Judge behavior against `AGENTS.md`, the relevant workspace Skills, and the user's stated intent.
6. Classify the outcome as a service defect, Skill/prompt gap, missing deterministic contract, documentation gap, or archived observation.

For onboarding continuous-flow evaluation, use the dedicated `onboarding-flow-eval` skill. This skill remains the general entry point; flow-specific standards, audit checklists, and failure-mode learning live in that dedicated skill.

## Running Workflow

For onboarding continuous-flow evaluation, use `onboarding-flow-eval`. For every other evaluation, perform the smallest relevant real interaction and inspect its audit evidence. Do not batch unrelated prompts or manufacture a static score.

## Evaluation Fixture Lifecycle

When an evaluation creates a user or workspace, record `runId`, `userId`, `instanceId`, `conversationId`, workspace path, and `retention=retain|cleanup` before executing. Default to `retain`; the user may inspect the complete Platform logs, ACP traces, audits, and workspace artifacts after the run.

Only delete when the user explicitly asks to clean the exact run or asks for immediate cleanup before it starts. Use `eval-instance-cleanup`, which calls `deleteInvestAgentInstance(instanceId)` and verifies that the instance, user-scoped records, and workspace are gone. Do not delete individual tables or workspace files by hand. If cleanup fails, report the IDs and failure explicitly.

## Reporting Style

Report in Chinese by default.

Keep the summary operational:

- Interaction and evidence inspected.
- What worked and what violated the intended behavior.
- Root cause and one recommended action per finding.
- The exact rerun or contract verification required after a fix.

Do not introduce an external AI judge, golden cases, report queues, or a Platform evaluation workbench. If the result conflicts with product intent, say whether the likely issue is the service, a Skill/prompt, a deterministic contract, or missing documentation.
