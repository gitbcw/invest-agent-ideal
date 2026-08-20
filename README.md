# Invest Agent

Invest Agent is a WeChat-first investment decision assistant for a small number of users. Each user has one assistant workspace that carries their holdings, watchlist, strategy, plans, review artifacts, and investment-method skills.

The runtime deliberately separates reasoning from deterministic execution:

```text
WeChat or web message
  -> workspace-scoped ACP backend (normally Codex)
  -> workspace AGENTS.md and skills
  -> named invest-agent-service-tools MCP capabilities
  -> shared deterministic services, SQLite, market data, scheduler, and push
```

Workspace Agents do not call local HTTP routes, handle service tokens, or edit service-owned state directly. HTTP remains an adapter for Platform, Portal, operations, and compatibility callers; MCP and HTTP adapters share the same service logic.

## Current Production Runtime

The active production codebase is this branch (`feat/mastra-migration`). The
legacy `main` runtime is stopped and must not be treated as the live release
target. Production runs PM2 `invest-agent-mastra` from
`/home/claude/invest-agent-mastra` on runtime port `23655`; `mastra-portal`
serves the Portal/relay on `23657/23658`. Production `.env`, SQLite, real
Workspaces, reviews, state, and WeChat bindings are server-owned assets and
must be preserved during code-only releases.

The historical isolated-candidate documents below describe the pre-cutover
state and are retained for audit context; they are not current deployment
instructions.

## Local Development

Prerequisites: Node.js 22 and npm.

```bash
npm ci
cp .env.example .env
npm run dev
```

The local development service defaults to port `22655`:

- Platform: `http://localhost:22655/platform`
- Health: `http://localhost:22655/health`

Run the standard verification gate before handing off changes:

```bash
npm run verify
```

## Read Next

- [AGENTS.md](./AGENTS.md): development Agent global red lines and task-start rules.
- [docs/README.md](./docs/README.md): task-based context map with must-read material and verification.
- [docs/system-overview.md](./docs/system-overview.md): current architecture and ownership map.

## Product Boundary

The assistant supports investment research, monitoring, reviews, screening, plans, and risk management. It does not promise returns, place trades, or turn unconfirmed suggestions into durable rules.
