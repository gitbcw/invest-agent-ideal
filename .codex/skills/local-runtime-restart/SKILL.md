---
name: local-runtime-restart
description: Restart and verify the local Invest Agent runtime on port 22655. Use when the user asks to start, restart, refresh, or recover the local Platform/Dashboard service, when port 22655 is occupied, or when a code change requires the PM2-managed local service to reload.
---

# Local Runtime Restart

Operate the local development runtime only. The managed process is normally PM2 application `invest-agent-codex`, with working directory `/Users/combo/MyFile/projects/invest-agent-ideal` and HTTP port `22655`.

## Guardrails

- Treat this as local-only. Do not apply these commands to Volcano Cloud or another host.
- Do not print `.env`, tokens, connector URLs, or raw logs that may include credentials.
- Do not kill a `node` listener repeatedly: PM2 will recreate it. Identify the parent process first.
- Do not stop unrelated PM2 applications.

## Restart Workflow

1. Confirm the listener and owner:

```bash
lsof -nP -iTCP:22655 -sTCP:LISTEN
pm2 describe invest-agent-codex
```

2. When source changes are not already compiled, run:

```bash
npm run build
```

3. Restart the managed service and refresh its environment:

```bash
pm2 restart invest-agent-codex --update-env
```

4. Verify the new process owns the port and the service is healthy:

```bash
curl -fsS http://127.0.0.1:22655/health
lsof -nP -iTCP:22655 -sTCP:LISTEN
pm2 list
```

5. On failure, inspect a short log tail without relaying sensitive content:

```bash
pm2 logs invest-agent-codex --lines 20 --nostream
```

Report the PM2 application state, health response, listening port, and any actionable error category.

## Port Conflict

If `npm start` returns `EADDRINUSE` for port `22655`, do not retry it. Inspect the listener's parent process:

```bash
ps -p <listener-pid> -o pid=,ppid=,command=
ps -p <parent-pid> -o pid=,ppid=,command=
pm2 list
```

If the chain belongs to `invest-agent-codex`, use the PM2 restart workflow. If it belongs to another application, stop and report the owner rather than killing it.

## Direct Start Exception

Use `npm start` only when port `22655` is free and `invest-agent-codex` is intentionally not PM2-managed. Keep the process supervised for startup output, then verify `/health`.
