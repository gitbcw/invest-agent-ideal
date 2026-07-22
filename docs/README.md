# Invest Agent Docs

This directory keeps current, agent-useful knowledge small and navigable. Historical plans, experiments, test records, migration notes, and superseded decisions live in [archive/](./archive/) and should not guide new implementation unless a current document explicitly points there.

## Read These First

If you only have 10 minutes, read these three:

| Order | Document | Use It For |
| --- | --- | --- |
| 1 | [../AGENTS.md](../AGENTS.md) | Operating principles, product red lines, investment-output discipline, and strategy-plan confirmation gates |
| 2 | [../CLAUDE.md](../CLAUDE.md) | Commands, runtime details, key files, APIs, database notes, and local service operations |
| 3 | [system-overview.md](./system-overview.md) | One-page architecture map: WeChat/web -> workspace ACP -> MCP service tools -> deterministic core |

After that, use the task-based map below instead of reading every file.

## Current Consensus

- Invest Agent is a WeChat-first investment assistant where one user maps to one assistant and one workspace. `instanceId` remains an internal compatibility/isolation key.
- Normal WeChat messages go directly through the workspace-scoped ACP backend, normally Codex, with only minimal channel context.
- Do not restore service-level triage, fast-lane classification, onboarding short-circuiting, review intent detection, or context-packet wrapping for normal WeChat messages.
- The service owns deterministic execution: SQLite, market data, Platform APIs, WeChat bridge, scheduler, alert push, sandbox, audit, confirmations, portal connector, and canonical conversation log.
- Skills and workspace AGENTS.md own investment judgment workflows: review structure, screening reasoning, evidence rules, cautious language, and confirmation discipline.
- Codex ACP is the default runtime backend. Hermes remains compatibility/experimental only.
- ACP model tier defaults to `complex`. `simple` tier is opt-in via `ACP_SIMPLE_MODEL_ENABLED=true` after stability debugging.
- Codex ACP sessions get the service-owned `invest-agent-service-tools` stdio MCP server. It is the only deterministic service capability surface exposed to workspace Agents; HTTP remains for non-Agent adapters.
- Onboarding uses service-owned drafts: each confirmed step remains a draft until the final frozen snapshot is asynchronously validated and applied to the workspace.
- Workspace artifacts carry user-specific investment state; table-level exceptions are defined in [table-ownership.md](./table-ownership.md).
- Platform is an internal administration surface. Owners may perform authorized administration; Partners receive read-only, anonymized operating and quality views without customer investment content or raw conversations.
- User portal is a separate cloud entrance, not a Platform rewrite. The local connector and `conversation_sessions` / `conversation_messages` remain the source of truth.
- Local reliable data service comes first, AI external search second, explicit data gap last. Do not invent missing market facts.
- Historical docs in [archive/](./archive/) are archaeology unless linked from this README or another current source-of-truth doc.
- `main` is the only maintained integration and production-release baseline. Volcano snapshots, frozen tags, and reconciliation branches are read-only evidence; normal releases come from a clean worktree at a reviewed `main` commit and never replace production runtime data.

## Read By Task

### Product And Investment Method

| Document | Use It For |
| --- | --- |
| [02-investment-methodology.md](./02-investment-methodology.md) | User investment methodology reference |
| [04-core-workflows.md](./04-core-workflows.md) | Core loops across monitoring, alerts, reviews, screening, and feedback |
| [investment-model-design.md](./investment-model-design.md) | Investment model as user-facing configuration center |
| [trading-strategy-design.md](./trading-strategy-design.md) | Trading strategy entity, strategy-to-plan flow, and two-gate confirmation |
| [personas/README.md](./personas/README.md) | Persona index |
| [personas/lao-zhang.md](./personas/lao-zhang.md) | User empathy and product judgment aid |

### Runtime, Workspace, And Security

| Document | Use It For |
| --- | --- |
| [system-overview.md](./system-overview.md) | Fast architecture map and ownership boundaries |
| [service-tools-mcp.md](./service-tools-mcp.md) | Codex ACP service-tools MCP contract, tool list, and smoke verification |
| [table-ownership.md](./table-ownership.md) | SQLite table ownership: service / workspace / discard |
| [23-multi-user-sandbox-design.md](./23-multi-user-sandbox-design.md) | Sandbox token, permission, audit, and isolation model |
| [composite-indicator-system.md](./composite-indicator-system.md) | L1 operators / L2 signals / L3a rule tree / L3b sandbox script architecture |
| [market-data-service-design.md](./market-data-service-design.md) | Market data facade, MCP tool contract, and non-Agent HTTP adapter |
| [onboarding-draft-commit-design.md](./onboarding-draft-commit-design.md) | Draft confirmation, frozen commit, retry, and completion-notification contract |
| [normal-chat-context-optimization-design.md](./normal-chat-context-optimization-design.md) | Direct workspace ACP message contract and prohibited service-side context wrapping |
| [workspace-compatibility.md](./workspace-compatibility.md) | Read-only preflight, managed-asset ownership, backup, migration and rollback contract for existing user Workspaces |

### Watch Runtime And Scheduler

| Document | Use It For |
| --- | --- |
| [watch-runtime-phased-implementation.md](./watch-runtime-phased-implementation.md) | Current watch runtime source: scheduler, market-watch, rule catalog/API, independent rule-alert-check |
| [watch-runtime-design-note.md](./watch-runtime-design-note.md) | Background note; useful context, but partly superseded by API-first stage 2 direction |
| [watch-runtime-stage1-implementation-brief.md](./watch-runtime-stage1-implementation-brief.md) | Implementation/acceptance support for stage 1; not the primary watch design entry |

For scheduled-task or push-delivery operations, use the project-only skill `.codex/skills/scheduler-push-debug`.

已完成的 2026-07-23 生产修复收敛与 scheduler 验收记录见 [production-reconciliation-release-gate.md](./archive/production-reconciliation-release-gate.md)；当前火山云代码发布、真实 Workspace 迁移和回滚基线见 [workspace-compatibility.md](./workspace-compatibility.md)。

### User Portal

| Document | Use It For |
| --- | --- |
| [user-portal-design.md](./user-portal-design.md) | Cloud user portal and relay design; local invest-agent remains runtime |
| [user-portal-goal-and-acceptance.md](./user-portal-goal-and-acceptance.md) | First delivery goal, acceptance criteria, and loop validation contract |
| [user-portal-protocol.md](./user-portal-protocol.md) | Relay protocol and local connector contract, including mock scenarios |

### Platform Administration

| Document | Use It For |
| --- | --- |
| [platform-partner-admin-design.md](./platform-partner-admin-design.md) | Internal Platform roles, Partner data boundary, authentication posture, and rollout constraints |
| [platform-partner-admin-phase1-implementation.md](./platform-partner-admin-phase1-implementation.md) | Phase 1 implementation scope and verification surface |

### Data Sources

| Document | Use It For |
| --- | --- |
| [data-source-policy-decision.md](./data-source-policy-decision.md) | Accepted data-source policy and cost posture |
| [data-provider-cost-evaluation.md](./data-provider-cost-evaluation.md) | Provider cost bands and build-vs-buy decision support |

### Operations

Repeatable operational actions are kept as project-only skills under `.codex/skills/`, not global skills:

- `.codex/skills/volcano-ops`: Volcano Cloud deploy, rollback, production health, and runtime migration operations.
- `.codex/skills/scheduler-push-debug`: scheduled reviews, market-watch, rule inspection, push queue, and WeChat delivery diagnosis.
- `.codex/skills/service-api-change`: sandbox, portal, MCP, Platform, and deterministic service API changes.
- `.codex/skills/db-migration`: SQLite schema, table ownership, migration, backfill, and production DB rollout safety.
- `.codex/skills/invest-eval`: audit-driven evaluation, evidence review, and issue classification.
- `.codex/skills/onboarding-flow-eval`: onboarding continuous workflow run, log audit, workspace state audit, and issue classification.
- `.codex/skills/screening-flow-eval`: screening, candidate risk scan, observation-pool write, and watchlist-conversion evaluation.
- `.codex/skills/eval-instance-cleanup`: retained evaluation user/workspace inspection and permanent cleanup after a completed run.
- `.codex/skills/local-runtime-restart`: restart and verify the PM2-managed local runtime on port `22655`.

Long runbooks that were formerly under `docs/` have been moved into the corresponding skill `references/` directory so the execution path and detailed operating notes stay together.

火山云当前操作入口是 `.codex/skills/volcano-ops/references/server-deployment.md`。普通版本只走代码发布；真实 Workspace 升级需同时遵循 [workspace-compatibility.md](./workspace-compatibility.md) 的逐用户预检、备份、迁移和单点验收。

### Intent Pack

[project-intent-pack/](./project-intent-pack/) is a reusable product/architecture intent pack for downstream agents. Use it when another agent needs to understand what the project is trying to preserve, not when you need line-by-line implementation instructions.

## Directory Grouping

Current files are still mostly flat to avoid breaking many existing links. Conceptually, read them as these groups, and use the target directory names if a future cleanup physically moves files:

| Group | Target Directory | Current Location |
| --- | --- | --- |
| Product | `docs/product/` | `02-*`, `04-*`, `investment-model-*`, `trading-strategy-*`, `personas/` |
| Runtime | `docs/runtime/` | `system-overview.md`, `table-ownership.md`, `23-*`, `composite-*`, `market-data-*`, `watch-runtime-*` |
| Portal | `docs/portal/` | `user-portal-*` |
| Operations | `.codex/skills/` | project-only operational skills with optional `references/` runbooks |
| Quality | `docs/quality/` | `quality/` |
| Intent Pack | `docs/project-intent-pack/` | `project-intent-pack/` |
| Archive | `docs/archive/` | `archive/` |

If the docs are physically moved later, preserve compatibility links or update every reference in the same change.

## Do Not Read Unless Archaeology

Avoid [archive/](./archive/) for current implementation. It contains:

- historical execution plans;
- dated test records;
- old architecture proposals;
- superseded migration plans;
- detailed experiments;
- previous runtime, platform, and triage directions.

Archive material can explain how a decision emerged, but the current decision must live in `AGENTS.md`, `CLAUDE.md`, this README, or one of the current source-of-truth documents above.

## Keep Or Archive Rule

A document may stay outside `docs/archive/` only if it helps an agent make current implementation, verification, operation, or product-boundary decisions.

Archive it if it is historical, superseded, mainly a dated record, or useful only as background. When in doubt, archive the long record and keep the current decision in a short current document.
