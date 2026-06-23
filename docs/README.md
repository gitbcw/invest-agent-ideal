# Invest Agent Docs

This directory is intentionally small.

Most historical plans, experiments, test records, and design drafts have been moved to `docs/archive/`. They are preserved for archaeology, but they are not source-of-truth for new agent work.

## Current Source Of Truth

Read these first, in this order:

| Document | Why It Exists |
| --- | --- |
| [../AGENTS.md](../AGENTS.md) | Project operating instructions for agents |
| [ideal-refactor-plan.md](./ideal-refactor-plan.md) | **Current master plan** (2026-06-21): workspace model, Codex fallback, DeepSeek triage, 7 work packages with milestone roadmap. Supersedes historical runtime/convergence/UI strategy docs |
| [table-ownership.md](./table-ownership.md) | SQLite table three-tier ownership (service / workspace / discard), the truth source for workspace migration boundaries |
| [23-multi-user-sandbox-design.md](./23-multi-user-sandbox-design.md) | Sandbox token, permission, audit, and isolation model. Kept in root because table-ownership only covers table boundaries, not the underlying sandbox security model |
| [composite-indicator-system.md](./composite-indicator-system.md) | Composite indicator system RFC (2026-06-22): L1 operators / L2 signals / L3a rule tree / L3b sandbox script, with main-force-control as first use case |
| [trading-strategy-design.md](./trading-strategy-design.md) | Trading strategy entity v1 (2026-06-23): first-class strategy in workspace yaml, strategy→plan one-way generation with two-gate confirmation, three trigger scenarios, review boundary |
| [04-core-workflows.md](./04-core-workflows.md) | Core product loops: monitoring, alerts, reviews, screening, feedback |
| [02-investment-methodology.md](./02-investment-methodology.md) | User investment methodology reference |
| [11-server-deployment.md](./11-server-deployment.md) | Local service, deployment, and operational notes |

## Current Consensus

- The product is a WeChat-first AI investment decision assistant and the first AI Project type in a broader runtime platform.
- The durable product assets are Skills, Strategy Skill skeleton plus instance expansion, sandbox/tool protocols, deterministic service APIs, context building, confirmation workflows, audit, and saved artifacts.
- Codex ACP is the current primary intelligent backend.
- Hermes is optional: useful for experiments, comparison, and fallback validation, but not product semantics.
- Profile is a runtime compatibility summary and routing residue only. Do not add methodology responsibility to Profile.
- Investment method lives in Strategy Skills: protected skeleton plus instance expansion candidates.
- The service owns deterministic execution: SQLite, market data, dashboard/workbench APIs, WeChat bridge, scheduler, alert push, sandbox, audit, and confirmation.
- Skills own investment judgment workflows: review structure, screening reasoning, evidence rules, cautious language, and confirmation discipline.
- WeChat is a lightweight entry for reminders, confirmations, summaries, and short Q&A.
- Full reviews, viewpoint validation, statistics, method candidates, and visible system value belong in the Investment Workbench.
- Historical docs in `docs/archive/` should not steer new implementation unless a current source-of-truth doc explicitly points to them.
- **Workspace model is the keystone** (2026-06-21 master plan): each user gets a copy of `templates/workspace/`, all private artifacts land in workspace yaml/jsonl/md, SQLite only keeps platform-level system responsibilities. Table-level boundaries are defined in [table-ownership.md](./table-ownership.md).
- **DeepSeek triage layer is planned** (work package 1, not yet shipped): DeepSeek light classifies intent before Codex; deterministic / light_chat / complex three-way routing with multi-provider fallback. See [ideal-refactor-plan.md](./ideal-refactor-plan.md) section IV for details.
- **Composite indicator system 5-layer architecture is shipped** (2026-06-22): L1 operators / L2 signals / L3a rule tree (YAML) / L3b sandbox script (isolated-vm) / acknowledgement gate. Main-force-control (ZZLKP) is the first customer use case end-to-end verified. See [composite-indicator-system.md](./composite-indicator-system.md) for the RFC.

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

The following root docs were moved to `docs/archive/` because their content is fully covered by `ideal-refactor-plan.md`:

- `38-runtime-skill-evolution-strategy.md` — Codex ACP main path decision, now restated in ideal-refactor-plan.md section I
- `39-invest-agent-ui-workbench-strategy.md` — Dashboard → Investment Workbench product vision, not yet started; preserved as future UI reference
- `40-engineering-convergence-plan.md` — pre-refactor 5-step convergence plan, superseded by ideal-refactor-plan.md work packages 0-6
