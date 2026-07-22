---
name: eval-instance-cleanup
description: "Inspect or permanently remove retained Invest Agent evaluation users and workspaces. Use after onboarding, screening, audit, scheduler, or other scoped evaluations when a user asks to review retained eval instances, clean a completed run, remove stale eval data, or verify that evaluation cleanup completed."
---

# Eval Instance Cleanup

Use this project-only skill to manage evaluation fixtures after their evidence has been reviewed. Evaluation and cleanup are separate operations.

## Safety Rules

- Operate only on instances whose owner user ID begins with `eval-`.
- Select one exact `userId` or `instanceId`; never delete by display name, loose keyword, or a normal user ID.
- Inspect before deleting. Report the conversation, trace, audit, durable-write, and workspace counts that will be removed.
- Delete only after the user explicitly requests cleanup. `--confirm` is mandatory.
- Call `deleteInvestAgentInstance(instanceId)` through the script. Do not delete SQLite rows or workspace files by hand.

## Inspect

List retained evaluation instances:

```bash
npx tsx .codex/skills/eval-instance-cleanup/scripts/manage-eval-instance.ts list
```

Inspect one exact evaluation user or instance:

```bash
npx tsx .codex/skills/eval-instance-cleanup/scripts/manage-eval-instance.ts inspect <eval-user-id-or-instance-id>
```

Use the resulting IDs and counts in the evaluation report. A retained instance remains available for Platform audit views and manual inspection.

## Delete

After the user has completed review, delete exactly one retained instance:

```bash
npx tsx .codex/skills/eval-instance-cleanup/scripts/manage-eval-instance.ts delete <eval-user-id-or-instance-id> --confirm
```

The script verifies that the instance, user, scoped messages, traces, audits, and workspace have gone. Treat any nonzero remaining count as a cleanup failure and report the IDs; do not attempt manual cleanup.

## Reporting

Report in Chinese: selected identity, pre-delete evidence counts, explicit cleanup request, deletion result, and post-delete verification. For `list` or `inspect`, report that the instance is retained and ready for manual review.
