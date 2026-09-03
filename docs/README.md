# Invest Agent Docs

This directory keeps current, agent-useful knowledge small and navigable. Historical plans, experiments, test records, migration notes, and superseded decisions live in [archive/](./archive/) and should not guide new implementation unless a current document explicitly points there.

## Read By Domain

### Mastra Production Branch

领域 Profile：本仓治理执行口径是 [ai-system-governance-principles.md](./ai-system-governance-principles.md)（Invest Agent Profile）；Personal OS 域适用其仓库自己的 tailoring 领域 Profile（`ai-app-complex-systems-tailoring`，v1.1）；[AI应用复杂系统管理落地方案.md](./AI应用复杂系统管理落地方案.md) 是两域共同的方法论素材，不是执行规范（已加 ⚠️ 非规范性标注）。

| Document | Use It For |
| --- | --- |
| [ai-system-governance-principles.md](./ai-system-governance-principles.md) | Invest Agent AI 系统治理上位原则：评估反馈、服务护栏、韧性、观测、灰度发布和回滚边界 |
| [next-direction-governance-analysis-2026-08-22.md](./next-direction-governance-analysis-2026-08-22.md) | 基于治理上位原则的项目成熟度评估、证据缺口和治理计划起点；不创建产品执行任务 |
| [governance-assessment-matrix.md](./governance-assessment-matrix.md) | G1–G5、L1–L4 治理证据矩阵与复核规则 |
| [evaluation-assets-registry.md](./evaluation-assets-registry.md) | 第一批版本化评估资产目录及 executable/candidate 数量口径 |
| [customer-friction-signal-collection-design.md](./customer-friction-signal-collection-design.md) | 客户体验受阻信号自动采集机制设计（草案，T-442）：六类信号源、受阻点数据模型、日/周/月三级产出与落地分期 |
| [evaluation-deepening-plan.md](./evaluation-deepening-plan.md) | 评估深化方案（草案）：程序性+AI 效果两层、行业前沿实践对照、ED-P1 错误分析例行化→ED-P2 产出 rubric→ED-P3 judge 按需启用的摩擦驱动路线 |
| [evaluation-rubric-industry-review.md](./evaluation-rubric-industry-review.md) | ED-P2 试点一：行业复盘 17 列产出的人工评分 rubric（五维+四硬门槛，评分兼作 judge 校准样本） |
| [evaluation-rubric-intraday-watch.md](./evaluation-rubric-intraday-watch.md) | ED-P2 试点二：盘中盯盘微信简报的人工评分 rubric（五维+三硬门槛，含幽灵个股回归哨兵） |
| [failure-taxonomy.md](./failure-taxonomy.md) | 失败分类法 v1（ED-P1 产出）：调度/投递/模型/数据/产品语义五层 14 类，失败知识的单一入口，新签名先归类再处理 |
| [ai-application-operating-loop.md](./ai-application-operating-loop.md) | **运营环方法论文档 v0.1（T-460，本目录上位框架）**：REALITY→PRODUCTION 九段环，双职（操作手册+实验对象，项目稳定文档收敛即为方法论）；逐段现状/目标/缺口、双速环主攻方向、实践→文档维护纪律、既有计划挂环映射 |
| [model-evaluation-2026-08-27-glm-qwen.md](./model-evaluation-2026-08-27-glm-qwen.md) | 共创期首轮模型评测论文：glm-5.3-flash×3 档 vs qwen3.7-flash×思考开关的双层对照（120 层1 样本 + 2 类自动化任务），含路由建议、成本模型、完整复现指南与两次误诊翻案记录 |
| [model-routing-and-context-governance-roadmap.md](./model-routing-and-context-governance-roadmap.md) | 现行指导：模型路由与上下文治理演进规划——对照前沿共识（四旋钮/三阶段路由/eval-driven/escalation）的现状定位、P1-P5 摩擦驱动路线图与不做清单 |
| [strategy-indicator-roadmap.md](./strategy-indicator-roadmap.md) | 现行指导：客户策略指标化统一路标（T-419 落地件）——终局（策略资产化/数据系统化/序列可复现/信号自动化）、现状盘点（取代 7-27 调研现状结论）、S0-S3 阶段与待验证项；按 9-02 裁决按需推进 |
| [evaluation-gap-enumeration-2026-08-24.md](./evaluation-gap-enumeration-2026-08-24.md) | 工具面×失败模式盲区地图：已覆盖/待盘点标注与 candidate 优先级队列 |
| [bad-case-record-template.md](./bad-case-record-template.md) | Bad Case 证据、归因、修复、回归和回滚记录模板 |
| [bad-cases/BC-20260821-001-long-conversation-coherence-latency.md](./bad-cases/BC-20260821-001-long-conversation-coherence-latency.md) | 首次治理演练：长会话逻辑已修复但性能与 Trace 证据未过放行门 |
| [bad-cases/BC-20260823-001-chips-snapshot-premature-gap.md](./bad-cases/BC-20260823-001-chips-snapshot-premature-gap.md) | 筹码集中度查询缓存未命中即宣告缺口：归因 L1 工具学说缺证据穷尽规则，修复为指令补行，回归样例 EV-013 |
| [bad-cases/BC-20260824-001-phantom-attachment-attribution.md](./bad-cases/BC-20260824-001-phantom-attachment-attribution.md) | 附件引用被冒称已读：真实工具数据（portfolio_read）被表述为「截图识别」，两轮回放复现，回归样例 EV-009 |
| [run-diagnostic-view-contract.md](./run-diagnostic-view-contract.md) | 从 traceId 串起对话、工具、审计、调度、产物和投递的最小诊断契约 |
| [release-governance-evidence-template.md](./release-governance-evidence-template.md) | 变更影响、验证、灰度、观测、回滚和 go/no-go 记录模板 |
| [release-record-20260824-dd072a15.md](./release-record-20260824-dd072a15.md) | 真实发布记录：T-357 治理执行线（WP0–WP5）上线，含验收九项与 known-good 标记 |
| [isolated-fault-drill-matrix.md](./isolated-fault-drill-matrix.md) | 四类隔离故障演练的注入点、终态、副作用和通过门槛 |
| [AI应用复杂系统管理落地方案.md](./AI应用复杂系统管理落地方案.md) | 方法论来源（非执行规范，2026-08-24 起带 ⚠️ 非规范性标注）：复杂系统评估/护栏/韧性/演化/可观测性的通用方法论素材；固定数字、工具栈与团队规模仅为示例，执行口径以 [ai-system-governance-principles.md](./ai-system-governance-principles.md) 为准 |
| [mastra-architecture-baseline.md](./mastra-architecture-baseline.md) | Candidate architecture baseline: verified topology, layering, data architecture, capability surface inventory, UX contracts, confirmed directions, and the layer-by-layer review agenda |
| [context-and-prompt-architecture.md](./context-and-prompt-architecture.md) | Context/prompt layering for the Mastra runtime: persistent instructions, per-turn state injection, multi-turn history from the authoritative conversation table, and user-evolvable methodology skills |
| [go-live-beta-test-checklist.md](./go-live-beta-test-checklist.md) | Pre-go-live dense test checklist (user-journey scenarios, expected behaviors, go-live actions, Monday scheduler first-run verification) |
| [go-live-cutover-runbook-2026-08-17.md](./go-live-cutover-runbook-2026-08-17.md) | 正式上线切换执行手册（8-17 早 8:00-9:30，Agent/owner 分工、逐步命令与核验点、回滚） |
| [open-work-items.md](./open-work-items.md) | owner 口述工作项台账（W1 自动模型路由、W2 模型选择器信息升级、W3 使用统计页等；新增工作从此追加） |
| [preset-system-design.md](./preset-system-design.md) | Preset object system design (draft): system provides generic capabilities; packs like the low-disturbance review mode are preset configuration data |
| [scheduled-flows-to-automation-design.md](./scheduled-flows-to-automation-design.md) | Review/market-watch to automation-task unification design (draft): task model extensions, preference field mapping, migration phases |
| [mastra-main-parity-verification.md](./mastra-main-parity-verification.md) | Capability parity verification against `main`: four-layer framework, G1-G23 gap ledger, and per-gap evidence |
| [cost-statistics-design.md](./cost-statistics-design.md) | Cost-statistics rebuild design (draft): per-model pricing registry, price-at-trace-write, backfill, admin cost view server-side rework |
| [mastra-workspace-exit-mapping.md](./mastra-workspace-exit-mapping.md) | Current Mastra candidate work package, technical evidence, H1 boundary, isolated topology, and next actions |
| [mastra-workspace-exit-mapping_acceptance_review.md](./mastra-workspace-exit-mapping_acceptance_review.md) | Independent acceptance status: WP0-WP7 evidence, unresolved H1, and release exclusions |
| [mastra-long-work-package.md](./mastra-long-work-package.md) | Scope, work-package stages, ownership and user gates for the candidate branch |
| [mastra-real-data-migration-plan.md](./mastra-real-data-migration-plan.md) | Backup-copy-only migration validation; never a production migration command |
| [mastra-real-data-migration-validation-2026-08-15.md](./mastra-real-data-migration-validation-2026-08-15.md) | Executed real-data migration validation: phases, evidence, findings F1-F3, E4/E8 gate unlock |
| [mastra-main-sync.md](./mastra-main-sync.md) | Rules for selectively porting `main` behavior without restoring ACP runtime code |

The pre-cutover candidate description in the Mastra documents is historical.
The active production baseline branch is `main` (promoted from
`feat/mastra-migration` on 2026-08-28; the pre-mastra system line is archived
as `legacy/pre-mastra`): PM2 `invest-agent-mastra`, runtime
`/home/claude/invest-agent-mastra`, port `23655`, with `mastra-portal` on
`23657/23658`. Use the current production facts above for deployment and
diagnosis; preserve production `.env`, SQLite, Workspaces, reviews, state, and
WeChat bindings.

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

### P-17 Convergence Decisions (2026-08)

> ⚠️ 项目身份标注（2026-09-02 owner 裁决）：P-17（旧投研助手）已于 2026-08-28 归档，用户与数据全部迁入 P-33（mastra 重构线）。P-33 走**现役深化**路线：主线 = 产品稳定 + 好用（服务客户在产品内打磨投资策略），选股产品化只是其中一部分而非单点主线；配合客户商业化是后续阶段，当前不启动。本组 P-17 决策书仅作历史决策与证据参照——其定位声明描述的客户与核心循环仍大体成立，但 **M1-M4 里程碑与 10 月外推门槛不作为 P-33 的现行路线图**（P-33 方向记录见 Personal OS 任务 T-419；顶层目标=以本项目为样本验证 AI 应用开发方法论，抽取沉淀由 P-35 承载）。

| Document | Use It For |
| --- | --- |
| [p17-convergence-positioning-2026-08.md](./p17-convergence-positioning-2026-08.md) | 收敛决策①（T-303，定稿）：下一阶段定位=明光哥流水线车间、双渠道排序、唯一指标、10 月外推门槛、三用户使用证据 |
| [p17-convergence-mg-core-loop-2026-08.md](./p17-convergence-mg-core-loop-2026-08.md) | 收敛决策②（T-305，定稿）：mg 四个时刻、策略资产盘点、复盘流水线规格、痛点证据→T-315/317/318 映射、承接路径 |
| [p17-convergence-execution-draft-2026-08.md](./p17-convergence-execution-draft-2026-08.md) | 收敛决策③（T-304/306/307，定稿；人岗对应 08-21 周五补）：功能取舍裁决尺与三堆初分、分工归口三问、M1-M4 里程碑与 go/no-go |
| [p17-weekly-meeting-2026-08-22-slides.html](./p17-weekly-meeting-2026-08-22-slides.html) | 08-22 周会团队内部场幻灯片（T-308 产物）：架构、项目情况、使用数据、定位与里程碑 |

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
