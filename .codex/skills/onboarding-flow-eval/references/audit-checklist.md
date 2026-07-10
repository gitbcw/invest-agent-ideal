# Onboarding Audit Checklist

## 1. Run Evidence

Collect:

- Workflow material path and run id.
- Actual turn inputs/outputs retained in the Codex conversation.
- Generated `userId`, `instanceId`, `conversationId`, `workspacePath`.
- Exit code and static verdict.

## 2. Conversation Review

For every turn:

- Did the assistant answer the current user input?
- Did it naturally invite the next expected user reply?
- Did it avoid overlong setup or unrelated explanation?
- Did it avoid internal implementation details?
- Did it clearly distinguish draft, confirmation, and saved state?
- Did the next user input make sense as a response to the previous assistant output?

## 3. Deterministic Write Review

Check `sandbox_audit_logs`:

- `onboarding.confirm_portfolio` appears only after user confirmation.
- `onboarding.confirm_step` appears for style, review schedule, market-watch schedule, notification, and watch rules.
- Request bodies include structured fields, not only summaries.
- Audit result advances `current_step` as expected.

## 4. Workspace Review

Check:

- `config/onboarding_state.yaml`
- `config/portfolio.yaml`
- `config/strategy.yaml`
- `config/style_packs.yaml` if relevant
- `config/schedules.yaml`
- `config/notification.yaml`
- `config/watch.yaml`
- `memory/change_log.jsonl`

Compare the resulting files with the choices recorded in the evaluated conversation and the deterministic expectations in `references/standards.md`.

## 5. Trace Review

Check `codex_acp_traces`:

- Each turn has a trace or explainable absence.
- User text and sanitized reply align with `conversation_messages`.
- Errors/timeouts are captured.
- No sanitized user reply contains internal paths, localhost, API paths, token, or tool-debug narrative.

## 6. Root Cause Review

For each issue decide the owner:

- Workflow input/expected is unrealistic.
- Workspace onboarding prompt/skill is underspecified.
- Service API writer or state transition is wrong.
- MCP/sandbox tool contract is wrong.
- Customer-output sanitizer missed leakage.
- Golden case should be added for incident regression.
- This skill's standards/checklist need improvement.

## 7. Closure

For every issue:

- Name the evidence.
- Name the root cause.
- Propose one fix.
- Name the rerun command.

Do not leave "人工待审" as the end state. Human review can inform the decision, but closure is a concrete fix, case update, standards update, or archived observation.

## 8. Temporary Identity Cleanup

After all required evidence is recorded, the run must call `deleteInvestAgentInstance(instanceId)` from a `finally` block. Verify that it completed successfully. This removes the temporary user, instance, associated records, workspace, and ACP runtime; `disposeAcpForWorkspace` by itself is insufficient.
