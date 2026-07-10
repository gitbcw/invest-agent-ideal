# Onboarding Failure Modes

## P0

- Writes durable portfolio/style/schedule/notification/watch state before user confirmation.
- Exposes token, local path, API path, localhost, raw curl, Codex/ACP internals, sandbox details, or workspace path in user-facing reply.
- Confirms saved state that contradicts `sandbox_audit_logs` or workspace files.
- Fails to complete onboarding workspace state while claiming completion.
- Creates concrete watch rules in onboarding without explicit user request.

## P1

- Main flow requires unnatural "下一步继续" style prompts rather than using assistant guidance.
- Mixes review schedule, market-watch fixed windows, and notification preference.
- Shows P0/P1/P2 or other internal priority labels to the user.
- Drops user-provided weights/cash ratio after accepting them.
- Resolves ambiguous securities without asking or documenting assumption.
- Loops back to an earlier step after a successful confirmation.
- Static workflow passes but the conversation would confuse a normal WeChat user.

## P2

- Reply is too verbose for WeChat but still correct.
- Minor wording inconsistency that does not affect state or user action.
- Report lacks enough evidence for fast debugging.
- Workflow expected text is too brittle and should be relaxed.

## Root Cause Mapping

- Prompt/skill issue: assistant knows the state but says the wrong thing, leaks internals, or guides poorly.
- Service issue: confirm API writes wrong config, misses fields, or advances wrong step.
- Workflow issue: user input or expected checks do not represent desired real journey.
- Case issue: single-turn case conflicts with workflow semantics or should become regression.
- Tooling issue: report lacks logs/workspace evidence needed for audit.
- Documentation/standards issue: repeated judgment requires updating this skill's references.

