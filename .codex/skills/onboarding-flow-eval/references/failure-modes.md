# Onboarding Failure Classification

Apply severity after grading the related `ONB-*` standard. Cite the specific standard and evidence instead of repeating its full wording.

## P0: Integrity Or Safety Failure

- `ONB-03`: unconfirmed durable write, confirmation consumed without the intended write, or false success claim.
- `ONB-04`: authoritative state contradicts customer copy; sensitive/internal/runtime text leaks; completion is falsely claimed.
- `ONB-05`: concrete rules are created without explicit inputs and confirmation, or periodic observation is promised as continuous/guaranteed detection.

## P1: Journey Or Contract Failure

- `ONB-01`: identity/setup framing is absent or a start-only gate blocks entry.
- `ONB-02`: progression stalls, loops, mixes decisions, or depends on unnatural continuation commands.
- `ONB-03`: an ordinary confirmation is ignored or repeated, even if no incorrect write occurs.
- `ONB-04`: user choices are lost, security ambiguity is silently guessed, or stale evidence is presented as fresh.
- `ONB-05`: explicit-rule and scheduled-observation semantics are unclear, or branch evidence is not verified.
- `ONB-06`: redundant completion confirmation, incomplete terminal state, pending confirmation, or unusable handoff.

## P2: Quality Or Evaluation Weakness

- Correct but unnecessarily verbose or mildly inconsistent customer copy.
- Evidence is insufficient for fast diagnosis, expected prose is brittle, or a regression record is missing.
- Evaluation uses a detached message batch, omits required branch coverage, exits before terminal checks, or leaves a child process behind.

## Ownership

- **Workspace prompt/Skill:** state is available but guidance, language, or reasoning is wrong.
- **Service/state transition:** durable data, step progression, or completion behavior is wrong.
- **MCP/sandbox contract:** confirmation binding, validation, or audit semantics are weak.
- **Customer-output sanitizer:** internal diagnostics reach customer copy.
- **Evaluation asset:** evidence collection, standard, severity, or regression routing is stale.
- **Observation:** behavior is real but not yet repeated or actionable; archive it with evidence rather than enlarging the core standard.
