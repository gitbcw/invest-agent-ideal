---
name: volcano-ops
description: "Use when operating the Invest Agent Volcano Cloud production runtime: deploy, package, apply runtime, configure portal env, restart, rollback, inspect production topology, check WeChat/portal health, or diagnose production-only deployment issues."
---

# Volcano Ops

Use this skill from the repo root for production or staging work on the Volcano Cloud runtime.

## Guardrails

- Treat Volcano Cloud as production unless the user explicitly says otherwise.
- Do not run destructive remote commands, overwrite production data, switch WeChat bindings, or cut traffic without explicit user confirmation.
- Never print secrets, sandbox tokens, portal tokens, QR login state, or `.env` values.
- Prefer read-only inspection before deployment or rollback.
- Keep local/dev and production ports separate. Local Platform is usually `localhost:22655`; production may use SSH tunnel or cloud-side process ports.

## Read First

- `references/server-deployment.md` for current deployment shape, env, PM2/process ops, checks, and known limits.
- `references/volcano-runtime-migration-plan.md` for Volcano topology, migration phases, cutover, and rollback.
- `CLAUDE.md` for current commands, runtime boundaries, API notes, and database/workspace paths.

Only read detailed sections needed for the task. Do not load archive docs unless a current doc points to them.

## Common Commands

Local packaging and runtime scripts:

```bash
npm run build
npm run volcano:package-runtime
npm run volcano:configure-portal
```

`volcano:apply-runtime` replaces the runtime database and workspaces. Run it only after computing the package SHA256 and explicitly setting `CONFIRM_RUNTIME_APPLY=replace-runtime-and-data`, `EXPECTED_REMOTE_APP_DIR`, and `EXPECTED_PACKAGE_SHA256`; the script rejects missing or mismatched values before touching the target.

Production smoke and health commands to consider after deploy:

```bash
npm run smoke:mcp-service-tools
npm run smoke:stage1-scheduler
npm run smoke:weixin-complex-ack
npm run smoke:portal-conversation-log
curl http://127.0.0.1:<PORT>/health
```

Use the exact port and process manager from the production environment; do not assume the local port.

## Deployment Workflow

1. Identify target environment, current branch/commit, production process name, app port, workspace root, DB path, and portal connector status.
2. Inspect local diff and scripts relevant to the deployment. Do not package unrelated work accidentally.
3. Run local `npm run build` and any smoke tests tied to changed areas.
4. Package/apply using the project scripts or the current production runbook.
5. Restart or reload the production process according to the documented process manager.
6. Verify `/health`, Platform tunnel access if applicable, WeChat status, portal connector if enabled, and recent logs.
7. Report what changed, what was verified, residual risk, and rollback path.

## Rollback Workflow

1. Confirm rollback target: previous package, previous git commit, or pre-migration snapshot.
2. Back up current production DB/workspace if the rollback touches data or schema.
3. Stop or drain the affected process if needed.
4. Apply the rollback artifact or redeploy the previous known-good runtime.
5. Restart, then verify health, scheduler, WeChat, portal connector, and push queue state.
6. Summarize user-visible impact and whether delayed jobs need manual replay or cancellation.

## Production Diagnosis Checklist

For “production did not send/reply/run” issues, gather:

- Process health and restart history.
- Latest app logs and error logs.
- `scheduled_task_runs`, `push_jobs`, `conversation_messages`, `codex_acp_traces`, and `sandbox_audit_logs` rows for the affected user/instance/time.
- WeChat login/session state and send result codes.
- Workspace path and config files for the affected user.
- Whether local and production are accidentally sharing or diverging on DB/workspace/state.

If the issue is specifically scheduler/push behavior, also use the `scheduler-push-debug` skill.
