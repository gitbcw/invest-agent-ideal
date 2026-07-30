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
- Treat `main` as the sole maintained release baseline. Snapshot/freeze/reconciliation branches are evidence and rollback references, not long-lived production development branches.
- Production ACP paths, models, and credentials belong to the server `.env`, not PM2's retained process environment. If PM2 still carries old `CODEX_*` overrides, delete and recreate the process from a clean shell before acceptance.

## Mandatory Deployment Mode Rule

**普通版本发布默认只能走代码发布路径。** For code, prompt, Skill, template, or compiled-runtime changes, use `scripts/deploy-volcano.sh` from a clean, reviewed production release tree or tag. This path must preserve the remote `.env`, database, `workspaces/`, `reviews/`, `.state/`, and other runtime assets.

Do **not** call `scripts/package-volcano-runtime.sh` or `scripts/apply-volcano-runtime.sh` for an ordinary version release. Those scripts are a separate, high-risk runtime-data migration path and may replace the production database and Workspace files.

Use the runtime-data migration path only when the user explicitly requests one of: migrating user data, restoring a runtime snapshot, replacing the production database, replacing production Workspaces, or disaster recovery. Before doing so, state that data will be replaced, obtain explicit confirmation, verify the package SHA and target directory, and preserve a rollback backup.

If the requested change could be handled either as a code release or a runtime migration, choose the code-only path and do not infer permission to replace user data.

## Read First

- `references/server-deployment.md` for current deployment shape, env, PM2/process ops, checks, and known limits.
- `references/volcano-runtime-migration-plan.md` only before explicit runtime-data migration, recovery, or rollback that touches data.

Only read detailed sections needed for the task. Do not load archive docs unless a current doc points to them.

## Common Commands

Local build and optional runtime-data scripts:

```bash
npm run build
npm run release:snapshot -- create
npm run release:deploy -- <releaseId>
npm run release:rollback -- <releaseId> --confirm=rollback-code-v1
npm run release:workspace-rollback -- plan <releaseId>
npm run volcano:package-runtime
npm run volcano:configure-portal
```

`volcano:package-runtime` and `volcano:apply-runtime` are **not** part of normal code deployment. `volcano:apply-runtime` replaces the runtime database and Workspaces; run it only under the explicit migration rule above, after computing the package SHA256 and explicitly setting `CONFIRM_RUNTIME_APPLY=replace-runtime-and-data`, `EXPECTED_REMOTE_APP_DIR`, and `EXPECTED_PACKAGE_SHA256`.

The `release:*` commands are the snapshot/deploy/rollback workflow for a normal code release. They preserve production runtime data; use the deployment reference for authorization gates and exact acceptance steps.

Production smoke and health commands to consider after deploy:

```bash
npm run smoke:mcp-service-tools
npm run smoke:stage1-scheduler
npm run smoke:portal-conversation-log
curl http://127.0.0.1:<PORT>/health
```

Use the exact port and process manager from the production environment; do not assume the local port.

## Deployment Workflow

1. Identify target environment, current branch/commit, production process name, app port, workspace root, DB path, and portal connector status.
2. Inspect local diff and scripts relevant to the deployment. Do not package unrelated work accidentally.
3. Run local `npm run build` and any smoke tests tied to changed areas.
4. Select the deployment mode before touching the target:
   - Normal code release: use `scripts/deploy-volcano.sh` from the reviewed production release tree/tag; do not package or apply runtime data.
   - Explicit data migration/recovery: stop writes, use the package/apply scripts, verify backup and SHA, and record the replacement scope.
5. Restart or reload the production process according to the documented process manager.
6. Verify PM2 has not retained ACP/model overrides that shadow `.env`; never print the secret-bearing environment while checking.
7. Verify `/health`, Platform tunnel access if applicable, WeChat status, portal connector if enabled, active push jobs, and logs since the new process uptime.
8. Run the smallest authorized real-process ACP acceptance for the changed capability. Do not send a real WeChat test message unless the user explicitly authorized it.
9. Report what changed, what was verified, residual risk, and rollback path.

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
