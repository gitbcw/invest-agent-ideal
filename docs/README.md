# Invest Agent Docs

This directory keeps current, agent-useful knowledge small and navigable. Historical plans, experiments, test records, migration notes, and superseded decisions live in [archive/](./archive/) and should not guide new implementation unless a current document explicitly points there.

## Read By Domain

### Mastra Candidate Branch

| Document | Use It For |
| --- | --- |
| [mastra-workspace-exit-mapping.md](./mastra-workspace-exit-mapping.md) | Current Mastra candidate work package, technical evidence, H1 boundary, isolated topology, and next actions |
| [mastra-workspace-exit-mapping_acceptance_review.md](./mastra-workspace-exit-mapping_acceptance_review.md) | Independent acceptance status: WP0-WP7 evidence, unresolved H1, and release exclusions |
| [mastra-long-work-package.md](./mastra-long-work-package.md) | Scope, work-package stages, ownership and user gates for the candidate branch |
| [mastra-real-data-migration-plan.md](./mastra-real-data-migration-plan.md) | Backup-copy-only migration validation; never a production migration command |
| [mastra-main-sync.md](./mastra-main-sync.md) | Rules for selectively porting `main` behavior without restoring ACP runtime code |

The Mastra candidate is deliberately not a production release: runtime `23656`,
Portal `23657`, Relay `23658`, and `data/mastra-portal-local/` are isolated from
the production baseline. Do not use these documents to authorize deployment,
production data writes, real WeChat reconnects, or a branch merge.

### Product And Investment Method

| Document | Use It For |
| --- | --- |
| [02-investment-methodology.md](./02-investment-methodology.md) | User investment methodology reference |
| [04-core-workflows.md](./04-core-workflows.md) | Core loops across monitoring, alerts, reviews, screening, and feedback |
| [best-effort-answering-design.md](./best-effort-answering-design.md) | Accepted default-data and evidence-bounded answering principle: graceful degradation, explicit methodology, strict-request boundary, capability-gap handling, and rollout acceptance |
| [default-data-methodology-implementation-brief.md](./default-data-methodology-implementation-brief.md) | Execution brief for default usable data and explicit methodology across chat, reports, files, automations, and Portal |
| [investment-model-design.md](./investment-model-design.md) | Investment model as user-facing configuration center |
| [trading-strategy-design.md](./trading-strategy-design.md) | Implemented strategy entity and plan linkage, two-gate confirmation, and explicit unimplemented workflow boundary |
| [personas/README.md](./personas/README.md) | Persona index |
| [personas/lao-zhang.md](./personas/lao-zhang.md) | User empathy and product judgment aid |

### Runtime, Workspace, And Security

| Document | Use It For |
| --- | --- |
| [system-overview.md](./system-overview.md) | Fast architecture map and ownership boundaries |
| [service-tools-mcp.md](./service-tools-mcp.md) | Codex ACP service-tools MCP contract, tool list, and smoke verification |
| [table-ownership.md](./table-ownership.md) | SQLite table ownership: service / workspace / discard |
| [23-multi-user-sandbox-design.md](./23-multi-user-sandbox-design.md) | Sandbox token, permission, audit, and isolation model |
| [composite-indicator-system.md](./composite-indicator-system.md) | Implemented L1, L3a and L3b indicator contracts, acknowledgement gate, and runtime red lines |
| [onboarding-draft-commit-design.md](./onboarding-draft-commit-design.md) | Draft confirmation, frozen commit, retry, and completion-notification contract |
| [normal-chat-context-optimization-design.md](./normal-chat-context-optimization-design.md) | Direct workspace ACP message contract and prohibited service-side context wrapping |
| [workspace-compatibility.md](./workspace-compatibility.md) | Read-only preflight, managed-asset ownership, backup, migration and rollback contract for existing user Workspaces |
| [version-snapshot-and-assisted-rollback-plan.md](./version-snapshot-and-assisted-rollback-plan.md) | Release snapshot, known-good retention, standard deploy/code rollback, and audited AI-assisted Workspace recovery |
| [t194-maintenance-window-handoff.md](./t194-maintenance-window-handoff.md) | Current T-194 release/rollback demonstration, evidence capture, human gate, and Personal OS completion handoff |

### Watch Runtime And Scheduler

| Document | Use It For |
| --- | --- |
| [watch-runtime-phased-implementation.md](./watch-runtime-phased-implementation.md) | Current watch runtime source: scheduler, market-watch, rule catalog/API, independent rule-alert-check |
| [scheduled-message-retry-and-expiry-plan.md](./scheduled-message-retry-and-expiry-plan.md) | Implementation plan for generation retry, delivery retry, message expiry, idempotency, and recovery without stale-message disturbance |

For scheduled-task or push-delivery operations, use the project-only skill `.codex/skills/scheduler-push-debug`.

已完成的 2026-07-23 生产修复收敛与 scheduler 验收记录见 [production-reconciliation-release-gate.md](./archive/production-reconciliation-release-gate.md)；当前火山云代码发布、真实 Workspace 迁移和回滚基线见 [workspace-compatibility.md](./workspace-compatibility.md)。

### User Portal

| Document | Use It For |
| --- | --- |
| [user-portal.md](./user-portal.md) | Current ownership, workspace browser, interaction, HTTP and deployment contract |
| [user-portal-protocol.md](./user-portal-protocol.md) | Exact current relay envelope, commands, payloads, scope rules, attachments, artifacts, and workspace file protocol |
| [user-asset-library-and-general-automation-design.md](./user-asset-library-and-general-automation-design.md) | Proposed user asset-library and general-automation product/system design |
| [user-asset-library-and-general-automation-tasks.md](./user-asset-library-and-general-automation-tasks.md) | Execution-ready work packages and acceptance handoff for the asset-library/automation design |
| [automation-portal-list-template-management-design.md](./automation-portal-list-template-management-design.md) | Portal task/run views, search, templates, batch lifecycle actions, responsive behavior, and API increments |

Initial Portal design, completed work packages and acceptance records are under `archive/portal/2026-07/` and are not implementation inputs.

### Platform Administration

| Document | Use It For |
| --- | --- |
| [platform-partner-admin-design.md](./platform-partner-admin-design.md) | Implemented Owner/Partner roles, authentication, Partner allowlist APIs, page boundary, and deployment limitation |

### Data Sources

| Document | Use It For |
| --- | --- |
| [data-source-policy-decision.md](./data-source-policy-decision.md) | Accepted data-source policy and cost posture |
| [data-provider-cost-evaluation.md](./data-provider-cost-evaluation.md) | Provider cost bands and build-vs-buy decision support |
| [doubao-search-integration-plan.md](./doubao-search-integration-plan.md) | Proposed Doubao Search Custom primary / SearXNG fallback implementation plan |
| [mcp-registry-and-agent-tooling-refactor-plan.md](./mcp-registry-and-agent-tooling-refactor-plan.md) | MCP registration, Agent-owned research, scheduler simplification, and narrow deterministic rule facts (WP0-WP8 completed) |
| [mcp-refactor-wp0-baseline.md](./mcp-refactor-wp0-baseline.md) | Refactor WP0 baseline: consumer matrix, conflict-item status table, test baseline |
| [mcp-refactor-wp6-rule-decision.md](./mcp-refactor-wp6-rule-decision.md) | WP6 non-price rule retirement decision and rationale |
| [mg-screening-timeout-recovery-plan.md](./mg-screening-timeout-recovery-plan.md) | mg 选股超时的预算、批量历史数据、终态收敛、超时层级与 Portal 消息协调修复方案 |
| [custom-formula-historical-screening-research.md](./custom-formula-historical-screening-research.md) | User-defined formula, point-in-time A-share screening requirements, evidence, scope, and phased delivery boundary |

> **Note**: The superseded capability-plane extraction plan and its execution records have been moved to [archive/](./archive/) for audit. Its capability contracts and fixture runners remain in use and are inherited by the refactor plan.

### Operations

Repeatable operational actions are kept as project-only skills under `.codex/skills/`, not global skills:

- `.codex/skills/volcano-ops`: Volcano Cloud deploy, rollback, production health, and runtime migration operations.
- `.codex/skills/scheduler-push-debug`: scheduled reviews, market-watch, rule inspection, push queue, and WeChat delivery diagnosis.
- `.codex/skills/service-api-change`: sandbox, portal, MCP, Platform, and deterministic service API changes.
- `.codex/skills/db-migration`: SQLite schema, table ownership, migration, backfill, and production DB rollout safety.
- `.codex/skills/invest-eval`: audit-driven evaluation, evidence review, and issue classification.
- `.codex/skills/audit-driven-diagnosis`: read-only diagnosis across a specified time range, with case evidence, problem clustering, root-cause confidence, and human review handoff.
- `.codex/skills/onboarding-flow-eval`: onboarding continuous workflow run, log audit, workspace state audit, and issue classification.
- `.codex/skills/screening-flow-eval`: screening, candidate risk scan, observation-pool write, and watchlist-conversion evaluation.
- `.codex/skills/eval-instance-cleanup`: retained evaluation user/workspace inspection and permanent cleanup after a completed run.
- `.codex/skills/local-runtime-restart`: restart and verify the PM2-managed local runtime on port `22655`.

Long runbooks that were formerly under `docs/` have been moved into the corresponding skill `references/` directory so the execution path and detailed operating notes stay together.

火山云当前操作入口是 `.codex/skills/volcano-ops/references/server-deployment.md`。普通版本只走代码发布；真实 Workspace 的模板差异只读报告，不自动覆盖。明确采用具体模板资产时，需同时遵循 [workspace-compatibility.md](./workspace-compatibility.md) 的逐用户、逐文件确认、备份和单点验收。

### User Evidence And Acceptance

| Document | Use It For |
|---|---|
| [mg-data-capability-gap-statistics.md](./mg-data-capability-gap-statistics.md) | 火山云 mg 用户对话提取出的平台数据能力缺口、证据索引和优先级 |
| [mg-platform-capability-gap-test-cases.md](./mg-platform-capability-gap-test-cases.md) | 针对数据服务、来源质量、回测和送达闭环的可验收平台测试 |
| [mg-classic-user-requirement-test-cases.md](./mg-classic-user-requirement-test-cases.md) | 从 mg 经典自然语言需求抽取的端到端用户场景测试 |

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

Archive material can explain how a decision emerged, but the current decision must live in `AGENTS.md`, this README, or one of the current source-of-truth documents above.

## Keep Or Archive Rule

A document may stay outside `docs/archive/` only if it helps an agent make current implementation, verification, operation, or product-boundary decisions.

Archive it if it is historical, superseded, mainly a dated record, or useful only as background. When in doubt, archive the long record and keep the current decision in a short current document.

Retired service-owned market-data source code and historical design docs are archived under [archive/service-market-data-retirement-2026-07-31](./archive/service-market-data-retirement-2026-07-31/). Current ACP market facts should come from the external `market-data-tool` MCP.
