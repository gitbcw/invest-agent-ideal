# Onboarding Evidence Matrix

Use the generated user, instance, and conversation IDs to scope every check. Conversation evidence establishes experience quality; deterministic evidence establishes what actually happened.

| Standard | Conversation evidence | Deterministic evidence |
| --- | --- | --- |
| `ONB-01` | First incomplete turn identifies the assistant, frames initial setup, asks only for current inputs, accepts text/screenshots, and promises draft-before-save without a start gate. | Initial onboarding state is incomplete; no durable onboarding write precedes the user's portfolio confirmation. |
| `ONB-02` | Each accepted draft step bridges into one clear next question; clarifications are local; accepted steps are not replayed; every simulated user input is a natural response to the actual preceding reply. | Draft step status advances monotonically; conversation timestamps show one adaptive turn sequence rather than a detached batch. |
| `ONB-03` | Draft and saved state are clearly distinguished; one ordinary confirmation is enough; the final wait and failures are stated honestly. | `onboarding.draft.accept_step` records exact accepted revisions. Before queueing, formal Workspace files remain unchanged. `enqueue_commit` freezes a snapshot; commit audits prove one verified final write. |
| `ONB-04` | Reply reflects the user's actual choices, resolves or asks about ambiguous securities, retains supplied weights/cash ratio, and contains no internal or diagnostic text. | Draft, confirmation, audit, frozen snapshot, `onboarding_state.yaml`, portfolio/strategy/schedule/notification/watch files, and pending confirmations agree. `strategy.yaml.last_confirmed_at` and confirmed strategy content are present only after commit. |
| `ONB-05` | Assistant distinguishes explicit rule inspection from scheduled observation and makes no real-time guarantee. Configured rules have executable inputs and a separate confirmation; skip is explicit. | Each configured rule has successful `watch_rules.create` evidence and a returned scoped rule ID. Dry-run facts match rule shape and disclose stale quote timestamps. Skip produces zero scoped rules. |
| `ONB-06` | After explicit skip or final rule-draft confirmation, the assistant immediately says it is completing configuration and never asks for “确认完成”; a later completion notification offers immediate next actions. | Finalization uses `onboarding.draft.enqueue_commit` with an immutable snapshot. Final state is completed only after verified commit and no active pending confirmation remains. |

## Run Evidence

Record:

- `runId`, `userId`, `instanceId`, `conversationId`, and `workspacePath`.
- Selected branch and, for configured runs, the exact executable rule input.
- Every actual input/output pair, elapsed time, controller exit status, and retention decision.
- Quote timestamp/freshness when a rule is dry-run.

## Evidence Sources

Inspect the scoped rows in:

- `conversation_messages`: authoritative customer-visible turn history.
- `sandbox_audit_logs`: operation, request, status, and result.
- `codex_acp_traces`: execution status and sanitized output.
- `alert_rules`: exact configured branch outcome.
- `pending_sandbox_confirmations`: active, consumed, or superseded confirmation state.
- `onboarding_drafts`: draft revisions, accepted confirmations, frozen snapshot, commit lifecycle, and retry reason.

Inspect:

- `config/onboarding_state.yaml`
- `config/portfolio.yaml`
- `config/strategy.yaml`
- `config/schedules.yaml`
- `config/notification.yaml`
- `config/watch.yaml`
- `memory/change_log.jsonl` when write history is relevant

Scan both conversation messages and sanitized traces for diagnostics joined to normal prose, not only standalone diagnostic lines.

## Finding Closure

For each failure or partial result, record the evidence, root cause, owner, smallest fix, and rerun scope. Choose among workspace prompt/Skill, service writer/state transition, MCP or sandbox contract, customer-output sanitizer, regression catalog, or evaluation guidance.

Retain by default. For explicit cleanup, use `eval-instance-cleanup` after evidence collection and verify removal of the workspace, scoped records, and ACP runtime; disposing ACP alone is not deletion.
