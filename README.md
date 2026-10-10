# Invest Agent

Invest Agent is a Portal-first investment decision assistant with WeChat as a push and lightweight conversation channel. Each user has one assistant scope carrying holdings, watchlist, strategy, plans, review artifacts, and investment-method Skills.

The runtime deliberately separates reasoning from deterministic execution:

```text
WeChat or web message
  -> Mastra runtime resolves user, conversation, and Agent context
  -> registered Skills and current user method context
  -> service-owned tools for deterministic capabilities
  -> shared deterministic services, SQLite, market data, scheduler, and push
```

Agents do not call local HTTP routes, handle service tokens, or edit service-owned state directly. HTTP remains an adapter for Platform, Portal, operations, and compatibility callers; service tools and HTTP adapters share the same service logic.

## Current Production Runtime

The active production codebase is the `main` branch. Production runs PM2 `invest-agent-mastra` from
`/home/claude/invest-agent-mastra` on runtime port `23655`; `mastra-portal`
serves the Portal/relay on `23657/23658`. Production `.env`, SQLite, real
Workspaces, reviews, state, and WeChat bindings are server-owned assets and
must be preserved during code-only releases.

The historical isolated-candidate documents below describe the pre-cutover
state and are retained for audit context; they are not current deployment
instructions.

## Local Development

Portal/Agent 用户工作流测试默认使用[本地镜像测试手册](./docs/agent-space-execution/local-mirror-test-playbook-20261005.md)：在仓库根目录运行 `node scripts/agent-space/p0/start-local-mirror.mjs`，访问 `http://127.0.0.1:3120/chat`。该入口自动读取并接入生产的两个只读数据 MCP，需要可用的 SSH 登录；`npm run dev` 不等价于完整数据能力的镜像测试环境。

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
- [docs/current-state.md](./docs/current-state.md): current phase, active priorities, and graduation gates.
- [docs/system-overview.md](./docs/system-overview.md): current architecture and ownership map.

## Product Boundary

The assistant supports investment research, monitoring, reviews, screening, plans, and risk management. It does not promise returns, place trades, or turn unconfirmed suggestions into durable rules.
