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
| [watch-runtime-design-note.md](./watch-runtime-design-note.md) | Discussion note (2026-06-26): service-owned scheduler + workspace executable watch rules/scripts; not yet an implementation decision |
| [investment-model-design.md](./investment-model-design.md) | Investment model v1: user-facing container for selection, trading, risk, review, and exit loops |
| [trading-strategy-design.md](./trading-strategy-design.md) | Trading strategy entity v1 (2026-06-23): first-class strategy in workspace yaml, strategy→plan one-way generation with two-gate confirmation, three trigger scenarios, review boundary |
| [04-core-workflows.md](./04-core-workflows.md) | Core product loops: monitoring, alerts, reviews, screening, feedback |
| [02-investment-methodology.md](./02-investment-methodology.md) | User investment methodology reference |
| [11-server-deployment.md](./11-server-deployment.md) | Local service, deployment, and operational notes |

## Current Consensus

- The product is a WeChat-first AI investment decision assistant and the first AI Project type in a broader runtime platform.
- The durable product assets are Skills, Strategy Skill skeleton plus instance expansion, sandbox/tool protocols, deterministic service APIs, context building, confirmation workflows, audit, and saved artifacts.
- WeChat user messages now follow the direct workspace path: WeChat bridge resolves user/project/instance/workspace, then forwards the raw user message plus minimal channel context to Hermes stdio ACP running with that workspace as cwd.
- The service must not classify normal WeChat messages into review/onboarding/fast-lane intents. Those behaviors belong in the workspace template, AGENTS.md, skills, and user config.
- Hermes stdio ACP is the unified runtime backend. Codex is no longer registered as an invest-agent runtime backend; historical `codex_acp_traces` storage names are compatibility residue only.
- Profile is a runtime compatibility summary and routing residue only. Do not add methodology responsibility to Profile.
- Investment method lives in Strategy Skills: protected skeleton plus instance expansion candidates.
- The service owns deterministic execution: SQLite, market data, dashboard/workbench APIs, WeChat bridge, scheduler, alert push, sandbox, audit, and confirmation.
- Skills own investment judgment workflows: review structure, screening reasoning, evidence rules, cautious language, and confirmation discipline.
- WeChat is a lightweight entry for reminders, confirmations, summaries, and short Q&A.
- Full reviews, viewpoint validation, statistics, method candidates, and visible system value belong in the Investment Workbench.
- Historical docs in `docs/archive/` should not steer new implementation unless a current source-of-truth doc explicitly points to them.
- **Workspace model is the keystone** (2026-06-21 master plan): each user gets a copy of `templates/workspace/`, all private artifacts land in workspace yaml/jsonl/md, SQLite only keeps platform-level system responsibilities. Table-level boundaries are defined in [table-ownership.md](./table-ownership.md).
- **Composite indicator system 5-layer architecture is shipped** (2026-06-22): L1 operators / L2 signals / L3a rule tree (YAML) / L3b sandbox script (isolated-vm) / acknowledgement gate. Main-force-control (ZZLKP) is the first customer use case end-to-end verified. See [composite-indicator-system.md](./composite-indicator-system.md) for the RFC.
- **Investment model is the user-facing configuration center** (2026-06-24): onboarding should converge from scattered "style / methodology / trading strategy" setup to "configure your investment model". Each user has a default model; methods and trading strategies are components inside that model. See [investment-model-design.md](./investment-model-design.md).
- **Scheduled tasks remain service-owned**: the scheduler scans workspace `config/watch.yaml` / `config/schedules.yaml` every minute, invokes workspace-scoped Hermes for market-watch and review tasks, then pushes concise results when configured.

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
