---
name: screening-flow-eval
description: "Run and audit Invest Agent screening and observation-pool journeys. Use when evaluating industry/theme/company screening, candidate risk scans, custom selection criteria, observation-pool writes, or candidate-to-watchlist conversion; determine whether a finding belongs to workspace/template, service/data source/runtime, or customer-output handling."
---

# Screening Flow Eval

Evaluate the product journey from a user asking for candidates to a cautious, auditable observation-pool or watchlist outcome. The product is not a direct stock-recommendation engine and must not be evaluated as one.

## Read First

- `references/standards.md` for product expectations and remediation boundary.
- `references/audit-checklist.md` for scenarios and evidence.
- `references/failure-modes.md` when classifying findings.
- `references/workflow-map.md` for current skills, durable state, and service boundaries.

## Remediation Boundary

During evaluation, a temporary workspace may receive the same confirmed business writes a real user would receive. Retain it by default after evidence collection so the user can inspect Platform logs, ACP traces, audits, and workspace artifacts. Use `eval-instance-cleanup` only after the user explicitly asks to remove that exact run.

Do not edit a workspace, workspace template, selection prompt, observation-pool Skill, or workspace configuration as a response to an evaluation finding. If the cause is in those layers, report the evidence, root cause, and recommended change only.

Repair the issue in the same task when evidence places it outside the workspace/template boundary: service data source, deterministic contract, runtime context injection, routing, customer-output sanitation, or another service-owned defect. Run the smallest relevant regression after the repair. Do not deploy unless the user asks.

## Direct Run

Create a fresh, explicitly named evaluation user and instance. Keep one conversation ID and drive the interaction through `projectWeixinManagerForInstance(instanceId)`, one actual turn at a time. Read each reply before choosing the next user message; do not submit a detached batch of confirmations.

Run the smallest scenario set that covers the changed behavior. For a general screening assessment, run the four scenarios in `references/audit-checklist.md`: theme screening, custom criteria, direct-buy boundary, and candidate-to-watchlist confirmation.

Keep one long-lived evaluation controller for creation, conversation, and evidence capture. Before creating the run, record `retention=retain` (default) or `retention=cleanup` (only when the user explicitly requests immediate cleanup). In retain mode, record the IDs and leave the complete instance intact. In cleanup mode, call `deleteInvestAgentInstance(instanceId)` in `finally` and verify deletion. Do not hand-delete database rows or workspace files.

## Audit Workflow

1. Record `runId`, `userId`, `instanceId`, `conversationId`, workspace path, scenario, inputs, replies, and elapsed time in the Codex conversation.
2. Inspect `conversation_messages`, `sandbox_audit_logs`, `codex_acp_traces`, relevant workspace artifacts, and any resulting watchlist write.
3. Compare the actual result with the standards: candidate evidence, risk and exclusion logic, waiting conditions, data freshness, custom criteria, recommendation boundary, and confirmation discipline.
4. Classify each finding using `references/failure-modes.md` and the remediation boundary above.
5. Repair only service/runtime/data/output findings. Rerun the narrowest failed scenario after repair.
6. Report whether the instance is retained for review or has been explicitly cleaned. For retained runs, give the exact `eval-instance-cleanup` inspection and deletion commands.

## Output Format

Report in Chinese:

- What was run: scenario, temporary identity, inputs, outputs, and elapsed time.
- Evidence inspected: conversation, trace, audit, market metadata, and durable writes.
- Passes and findings, ordered by severity.
- Root cause classification: workspace/template report-only, or service/runtime/data/output repair required.
- For report-only workspace/template findings: recommended change without modifying it.
- For repaired service/runtime/data/output findings: change and exact regression evidence.
- Retention status, inspection command, cleanup command, and rerun command.
