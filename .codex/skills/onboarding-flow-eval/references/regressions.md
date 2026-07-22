# Onboarding Regression Catalog

Regression records preserve concrete incidents without turning expected prose into a script. Match semantics and state transitions, not exact wording.

## REG-01 Missing Investment-Assistant Identity

- **Symptom:** First reply describes capabilities but never says it is the user's investment assistant.
- **Invariant:** `ONB-01` requires explicit role identity during the first incomplete onboarding turn.
- **Inspect:** First customer-visible reply and initial onboarding state.
- **Deterministic owner:** None; semantic evaluation owns this check.

## REG-02 Abrupt “Most Important Step” Opening

- **Symptom:** Greeting jumps directly to “先从最关键的一步开始” without explaining initial setup or draft-before-save behavior.
- **Invariant:** `ONB-01` requires setup framing before requesting current-step inputs.
- **Inspect:** First reply for journey context, requested fields, accepted input forms, and confirmation promise.
- **Deterministic owner:** None; semantic evaluation owns this check.

## REG-03 Accepted Draft Without Guided Continuation

- **Symptom:** A draft step is accepted, but the reply only acknowledges it or waits for the user to ask what comes next.
- **Invariant:** `ONB-02` requires completion acknowledgement, next-step value, and one concrete next question in the same reply.
- **Inspect:** Every assistant reply immediately following a successful onboarding write and the next actual user turn.
- **Deterministic owner:** Draft acceptance audit ordering can prove the state transition; semantic evaluation owns transition quality.

## REG-04 Repeated Style Confirmation

- **Symptom:** After the user confirms a displayed style draft, the assistant asks for “确认” again, potentially repeatedly.
- **Invariant:** `ONB-03` requires one bound ordinary confirmation for the exact draft revision and no Workspace write before final commit.
- **Inspect:** Draft revision, confirming message, `onboarding.draft.accept_step` audit, pending confirmation status, strategy file before/after commit, and subsequent reply.
- **Deterministic owner:** `scripts/onboarding-draft-commit-smoke.mjs`.

## REG-05 Redundant Completion Confirmation

- **Symptom:** Rules are verified or explicitly skipped, then the assistant asks for an additional “确认完成” that carries no new decision.
- **Invariant:** `ONB-06` completes directly from the user's skip or verified configured-rule outcome.
- **Inspect:** Final rule/skip turn, `onboarding.draft.enqueue_commit` audit, rule IDs or zero-rule state, pending confirmations, completion notification, and final onboarding state.
- **Deterministic owner:** `scripts/onboarding-draft-commit-smoke.mjs`.

## Adding A Regression

Add a record only for a concrete incident worth preventing. Include symptom, linked invariant, evidence to inspect, and deterministic owner when one exists. Do not copy full standards, prescribe fixed dialogue, or add one-off wording preferences that have no durable product invariant.
