# Invest Agent Docs

This directory is intentionally small.

Most historical plans, experiments, test records, and design drafts have been moved to `docs/archive/`. They are preserved for archaeology, but they are not source-of-truth for new agent work.

## Current Source Of Truth

Read these first, in this order:

| Document | Why It Exists |
| --- | --- |
| [../AGENTS.md](../AGENTS.md) | Project operating instructions for agents |
| [table-ownership.md](./table-ownership.md) | SQLite table three-tier ownership (service / workspace / discard), the truth source for workspace migration boundaries |
| [23-multi-user-sandbox-design.md](./23-multi-user-sandbox-design.md) | Sandbox token, permission, audit, and isolation model. Kept in root because table-ownership only covers table boundaries, not the underlying sandbox security model |
| [composite-indicator-system.md](./composite-indicator-system.md) | Composite indicator system RFC (2026-06-22): L1 operators / L2 signals / L3a rule tree / L3b sandbox script, with main-force-control as first use case |
| [watch-runtime-design-note.md](./watch-runtime-design-note.md) | Earlier discussion note (2026-06-26). Useful as background, but some workspace-rule ideas were superseded by the stage 2 API-first direction |
| [watch-runtime-phased-implementation.md](./watch-runtime-phased-implementation.md) | Current source for staged watch runtime delivery: stage 1 accepted, stage 2 service-owned rule catalog/API plus independent rule-alert-check, stage 3 news/event rough filter + Agent judgment |
| [watch-runtime-stage1-implementation-brief.md](./watch-runtime-stage1-implementation-brief.md) | Stage 1 implementation brief (2026-06-28): current scheduler/review/push status, gaps, smoke tests, observability, and acceptance checklist |
| [watch-runtime-stage1-runbook.md](./watch-runtime-stage1-runbook.md) | Stage 1 manual acceptance runbook for the primary user investment assistant instance |
| [market-data-service-design.md](./market-data-service-design.md) | Market data service facade design and follow-up TODOs for Codex sandbox access, source metadata, freshness, cache, and fallback behavior |
| [data-source-policy-decision.md](./data-source-policy-decision.md) | Accepted data-source policy: service-owned reliable data first, AI external search second, explicit data gap last; no expensive paid data dependency in MVP |
| [data-provider-cost-evaluation.md](./data-provider-cost-evaluation.md) | Paid/free market data provider cost bands and build-vs-buy decision support for the reliable-data-source service |
| [quality/evaluation-system-design.md](./quality/evaluation-system-design.md) | Current evaluation system design: L1 programmatic checks, L2 AI semantic judging, and L3 human review boundaries |
| [quality/golden-test-set.md](./quality/golden-test-set.md) | Conversation semantic case library and golden/regression case guidance under the evaluation system |
| [user-portal-design.md](./user-portal-design.md) | Cloud user portal and relay design: keep local invest-agent as runtime, expose a server-hosted login/history/chat entrance for users |
| [user-portal-goal-and-acceptance.md](./user-portal-goal-and-acceptance.md) | Goal, acceptance, loop validation, and exit criteria contract for the first user portal delivery |
| [investment-model-design.md](./investment-model-design.md) | Investment model v1: user-facing container for selection, trading, risk, review, and exit loops |
| [trading-strategy-design.md](./trading-strategy-design.md) | Trading strategy entity v1 (2026-06-23): first-class strategy in workspace yaml, strategy→plan one-way generation with two-gate confirmation, three trigger scenarios, review boundary |
| [04-core-workflows.md](./04-core-workflows.md) | Core product loops: monitoring, alerts, reviews, screening, feedback |
| [02-investment-methodology.md](./02-investment-methodology.md) | User investment methodology reference |
| [11-server-deployment.md](./11-server-deployment.md) | Local service, deployment, and operational notes |

## Current Consensus

- The product is a WeChat-first AI investment decision assistant centered on workspace-backed user assistants. In the current product semantics, one user maps to one user assistant and one workspace; `instanceId` remains an internal compatibility key.
- The durable product assets are Skills, Strategy Skill skeleton plus instance expansion, sandbox/tool protocols, deterministic service APIs, context building, confirmation workflows, audit, and saved artifacts.
- WeChat user messages now follow the direct workspace path: WeChat bridge resolves user/instance/workspace, then forwards the raw user message plus minimal channel context to the active ACP backend, normally Codex, running with that workspace as cwd.
- The service must not classify normal WeChat messages into review/onboarding/fast-lane intents. Those behaviors belong in the workspace template, AGENTS.md, skills, and user config.
- Codex ACP is the default runtime backend. Hermes remains only as a compatibility/experimental backend; historical `codex_acp_traces` storage names are compatibility residue only.
- Profile is a runtime compatibility summary and routing residue only. Do not add methodology responsibility to Profile.
- Investment method lives in Strategy Skills: protected skeleton plus instance expansion candidates.
- The service owns deterministic execution: SQLite, market data, dashboard/workbench APIs, WeChat bridge, scheduler, alert push, sandbox, audit, and confirmation.
- Skills own investment judgment workflows: review structure, screening reasoning, evidence rules, cautious language, and confirmation discipline.
- WeChat is a lightweight entry for reminders, confirmations, summaries, and short Q&A.
- Full reviews, viewpoint validation, statistics, method candidates, and visible system value belong in the Investment Workbench.
- Historical docs in `docs/archive/` should not steer new implementation unless a current source-of-truth doc explicitly points to them.
- **Workspace model is the keystone** (2026-06-21 master plan): each user gets a copy of `templates/workspace/`, all private artifacts land in workspace yaml/jsonl/md, SQLite only keeps platform-level system responsibilities. Table-level boundaries are defined in [table-ownership.md](./table-ownership.md).
- **Workspace path note**: SQLite stays at repo-local `./data/invest-agent.db`, but workspace root does not default to repo-local `./data/workspaces`. Unless `WORKSPACE_ROOT` is set, runtime workspaces are created under `../../my-data/projects/invest-agent-ideal/workspaces` relative to the repo root.
- **Composite indicator system 5-layer architecture is shipped** (2026-06-22): L1 operators / L2 signals / L3a rule tree (YAML) / L3b sandbox script (isolated-vm) / acknowledgement gate. Main-force-control (ZZLKP) is the first customer use case end-to-end verified. See [composite-indicator-system.md](./composite-indicator-system.md) for the RFC.
- **Investment model is the user-facing configuration center** (2026-06-24): onboarding should converge from scattered "style / methodology / trading strategy" setup to "configure your investment model". Each user has a default model; methods and trading strategies are components inside that model. See [investment-model-design.md](./investment-model-design.md).
- **Scheduled tasks remain service-owned**: the scheduler scans workspace `config/watch.yaml` / `config/schedules.yaml` every minute, invokes the workspace-scoped ACP backend for market-watch and review tasks, then pushes concise results when configured.
- **Stage 1 acceptance should use the controllable scheduler trigger**: manual acceptance for the primary investment assistant instance should use `POST /api/testing/scheduler/trigger` on `localhost:22655`, not "edit to next minute and wait". A first real acceptance pass was completed on 2026-06-28: `daily-review` reached the primary user's phone, and `market-watch` correctly returned `NO_PUSH` without sending noise.
- **Stage 2 now prefers service-owned watch rule APIs over workspace schema churn**: rule capability discovery, validation, CRUD, dry-run, scheduler execution, dedupe, and event recording should stay service-owned; Workspace skill should discover capabilities through API and call them instead of relying on frequent `watch.yaml` schema changes.
- **Rule inspection is independent from scheduled market-watch briefs** (2026-07-02): `rule-alert-check` runs as a deterministic scheduler task using `alert_check_interval_minutes` (default 5 minutes), evaluates only the sampled current/latest facts, and writes rule/event audit state. It is not an "intraday touched high" detector and not a close-confirmation workflow.
- **Watch-rule catalog has expanded beyond the first three primitives** (2026-07-02): current service support includes `price_cross`, `ma_cross`, `macd_cross`, `kdj_cross`, `rsi_threshold`, `boll_break`, `wr_threshold`, `volume_ratio`, and `near_plan_level`. Smoke command: `npm run smoke:stage2-watch-rules`.
- **Platform has dedicated operations pages for rule inspection and data-source quality**: `/platform#rule-alerts` reads `GET /api/platform/rule-alerts`; `/platform#source-quality` reads `GET /api/platform/source-quality`. Rule inspection should not be mixed into generic log audit.
- **Data-source policy is accepted** (2026-07-02): local reliable data service first, AI external search second, explicit data gap last. MVP should not depend on expensive paid financial data; source telemetry and quality reports are service/platform assets under `data/source-telemetry/` and `data/source-quality/`, not workspace files.
- **User portal is a separate cloud entrance, not a Dashboard/Platform rewrite** (2026-07-04): keep the local invest-agent service as the runtime for workspace, ACP, SQLite, WeChat, scheduler, and deterministic APIs. The server-hosted portal should handle login, conversation history, and web chat through a cloud relay plus local connector. See [user-portal-design.md](./user-portal-design.md).
- **User portal delivery should be loop-verifiable**: use [user-portal-goal-and-acceptance.md](./user-portal-goal-and-acceptance.md) as the completion contract for implementation and review loops, separate from the design document.

## Keep Or Archive Rule

A document may stay in `docs/` only if it helps an agent make current implementation decisions.

Archive it if it is:

- a historical execution plan;
- a dated test record;
- an old architecture proposal;
- a superseded migration plan;
- a detailed experiment record;
- useful only as background but not needed for current work.

When in doubt, archive it and keep the current decision in `AGENTS.md`, this README, or one of the small source-of-truth docs above.

## Archived Material

Historical docs live under [archive/](./archive/). They are intentionally excluded from the normal handoff path.

### 2026-06-22 WP6 doc convergence

The following root docs were moved to `docs/archive/` during the earlier WP6 convergence:

- `38-runtime-skill-evolution-strategy.md` — historical Codex ACP main path decision
- `39-invest-agent-ui-workbench-strategy.md` — Dashboard → Investment Workbench product vision, not yet started; preserved as future UI reference
- `40-engineering-convergence-plan.md` — pre-refactor 5-step convergence plan

### 2026-06-23 scope contraction

`scope-contraction-plan.md` was archived after WP A1/A2/A3/C completed. The deletions (diet product line, BypassWeixinMobileBridge, conversation-task draft system, platform multi-project framework flattening) are summarized in `CLAUDE.md` and `AGENTS.md`; the detailed plan is preserved only as archaeology.

### 2026-06-25 direct workspace cleanup

`ideal-refactor-plan.md` and `ai-tool-planner-design.md` were archived after the experimental branch converged on the simpler direct workspace path. The previous DeepSeek triage, fast lane, shared context packet, and service-level tool planner direction is now historical only.
