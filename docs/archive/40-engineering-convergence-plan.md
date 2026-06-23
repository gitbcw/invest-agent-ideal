# Engineering Convergence Plan

> Created: 2026-06-12

## Purpose

This plan turns the recent five-step engineering review into an execution plan. It now follows a strict document deletion posture: keep only current agent-useful docs in `docs/`; archive the rest.

The goal is to reduce architectural drift, remove obsolete responsibilities, and converge the project around the current core direction:

- Codex ACP is the primary intelligent backend in the current phase.
- Skills are the core methodology and workflow assets.
- Strategy Skill owns protected skeleton and instance expansion.
- Profile is compatibility summary and routing residue only.
- Service owns deterministic execution, persistence, sandbox, audit, WeChat, scheduler, push, and Workbench APIs.
- WeChat is the lightweight entry and confirmation channel.
- Investment Workbench is the value display surface.
- LangChain/LangGraph remain reference designs and optional future runtime adapters.

## Convergence Principles

1. Do not optimize a path before deciding it should exist.
2. Do not expand runtime abstraction before stable workflows are known.
3. Do not add methodology responsibility back to Profile.
4. Do not make Hermes structurally required.
5. Do not treat WeChat as the full report reader.
6. Do not let docs preserve old architecture as if it were current.
7. Keep security and product semantics in the platform service, not in a model framework.

## Phase 0: Freeze The Current Consensus

Goal: make the current architecture easy to find and hard to accidentally contradict.

| Task | Action | Output |
| --- | --- | --- |
| Confirm source of truth | Keep `AGENTS.md`, `docs/README.md`, `docs/38-runtime-skill-evolution-strategy.md`, and `docs/39-invest-agent-ui-workbench-strategy.md` as current entry points | Current consensus is discoverable |
| Mark old assumptions | Identify docs that still describe Profile as methodology source or Hermes as central backend | Doc cleanup list |
| Protect main path | Document that first phase uses Codex ACP as primary backend | Avoid premature multi-backend work |
| Preserve build health | Run `npm run build` after each convergence slice | No accidental code breakage |

## Phase 1: Delete Or Downgrade Obsolete Responsibilities

Goal: remove responsibilities that are now duplicated or misleading.

| Target | Five-step diagnosis | Action |
| --- | --- | --- |
| Profile as methodology source | Not necessary; superseded by Strategy Skill | Downgrade to compatibility summary in docs and prompts |
| Multi-backend runtime abstraction | Premature abstraction | Do not expand; keep Codex ACP main path |
| Hermes as required backend | Historical experiment path | Keep optional; avoid new product dependency |
| JR document workspace as runtime | Duplicate persistence model | Keep only as method reference |
| WeChat full report delivery | Wrong UI surface | Use summaries in WeChat, full reports in Workbench |
| Old Runtime docs | Historical, not current | Keep in archive only, not source-of-truth |

## Phase 2: Simplify The Necessary Core

Goal: make the necessary architecture smaller and clearer.

| Core Area | Simplification |
| --- | --- |
| Context assembly | Extract or document a `Context Builder`: project context, sandbox, skill bundle, strategy skill, pending tasks, recent memory, runtime config |
| Tool access | All model-facing tools wrap `/api/sandbox/*`; no naked userId or instanceId from AI |
| Strategy evolution | Route long-term method changes into instance expansion candidates first |
| Dashboard | Reframe as Investment Workbench; keep existing CRUD while adding value views |
| Runtime | Treat backend as execution adapter only, not product semantics |
| Docs | One small index, only current agent-useful docs in root, everything else archived |

## Phase 3: Accelerate Feedback Loops

Goal: speed up learning only after obsolete paths are removed or downgraded.

| Loop | Acceleration |
| --- | --- |
| WeChat behavior | Use `/api/testing/weixin-simulate` for repeatable semi-automated tests |
| Instance expansion | Add smoke for: user preference -> pending task -> confirm -> candidate record |
| Skill iteration | Capture real good/bad replies as examples and anti-examples |
| Workbench design | Prototype review reader and viewpoint tracker before redesigning all Dashboard pages |
| Complex research | Let Codex handle uncertain cases, then extract repeated patterns into Skills/tools |
| Documentation | Add a doc audit checklist so old assumptions are caught during future edits |

## Phase 4: Automate Stable Checks

Goal: automate only after the flow is necessary and simple.

| Candidate Automation | Why |
| --- | --- |
| Build check | Keeps convergence safe |
| Sandbox token smoke | Security boundary must not regress |
| Instance expansion smoke | Prevents "口头写入" from returning |
| Profile responsibility scan | Prevents old methodology-source language from returning |
| Skill structure validation | Ensures Strategy Skill skeleton/instance references exist |
| WeChat simulate suite | Provides fast feedback for assistant experience |
| Workbench API health check | Ensures review, alerts, viewpoints, and method candidates are available to UI |

## Immediate Execution Plan

### P0: Documentation Convergence

1. Create a document inventory.
2. Classify each root doc as current, needs update, archive, or superseded.
3. Update `docs/README.md` so current docs are clearly separated from historical docs.
4. Move obsolete experiment/test docs into `docs/archive/` or mark them as superseded.
5. Fix remaining Profile/Hermes/Runtime wording that contradicts current consensus.

### P0: Main Path Convergence

1. Keep Codex ACP as the main intelligent backend.
2. Keep Hermes optional.
3. Avoid adding LangChain/LangGraph dependencies.
4. Keep extracting stable behavior from Codex into Skills, service APIs, and confirmations.

### P0: Skill And Method Evolution Convergence

1. Keep Strategy Skill as methodology carrier.
2. Route long-term user behavior changes to instance expansion candidates.
3. Add smoke coverage for instance expansion candidate flow.
4. Stop adding methodology fields or behavior to Profile.

### P1: Workbench Convergence

1. Reframe Dashboard as Investment Workbench in docs and UI copy.
2. Prioritize review reader and viewpoint tracker.
3. Add method candidate visibility.
4. Add alert/signal quality views after review visibility is improved.

### P1: Context Builder Convergence

Status: first slice completed.

1. Audited prompt/context assembly in `mobile-prompt`, `weixin-mobile`, `agent`, and `server`.
2. Extracted `src/acp/prompt-context-builder.ts` as the named context-building module.
3. Centralized sandbox token creation, runtime profile compatibility context, Strategy Skill context, compact review context, and prompt construction.
4. Kept backend-specific code responsible only for when/how to call the backend, not how to assemble methodology context.

## Document Convergence Plan

### Current Root Docs

After the aggressive cleanup, root `docs/` intentionally keeps only:

- `README.md`
- `02-investment-methodology.md`
- `04-core-workflows.md`
- `11-server-deployment.md`
- `23-multi-user-sandbox-design.md`
- `38-runtime-skill-evolution-strategy.md`
- `39-invest-agent-ui-workbench-strategy.md`
- `40-engineering-convergence-plan.md`
- `ideal-refactor-plan.md` (added 2026-06-21: current master plan for workspace + Codex + DeepSeek refactor, supersedes the historical roadmap as the iteration entry point)
- `table-ownership.md` (added 2026-06-21: SQLite table three-tier ownership, used by work packages 0/3/4/5 to decide handler vs workspace writes)

Everything else is historical and belongs in `docs/archive/`.

### Document Cleanup Rules

1. Do not delete useful history immediately; archive it.
2. Keep root docs only for current agent decisions.
3. Every root doc must answer: "Will an agent use this this week?"
4. If the answer is no, archive it.
5. Do not preserve old architecture by repeatedly editing obsolete docs.
6. Keep `docs/README.md` as the small navigation source.

## Suggested New/Updated Docs

| Need | Document |
| --- | --- |
| This convergence plan | `docs/40-engineering-convergence-plan.md` |
| Strategy Skill instance expansion tests | `scripts/strategy-instance-expansion-smoke.mjs` and `npm run smoke:strategy-expansion` |
| Profile/Hermes responsibility scan | `scripts/convergence-responsibility-scan.mjs` and `npm run scan:convergence` |
| Strategy Skill structure scan | `scripts/strategy-skill-structure-scan.mjs` and `npm run scan:strategy-skill` |
| Workbench health check | `scripts/workbench-health-check.mjs` and `npm run health:workbench` |
| WeChat readonly simulate smoke | `scripts/weixin-readonly-smoke.mjs` and `npm run smoke:weixin-readonly` |
| Review viewpoint smoke | `scripts/review-viewpoint-smoke.mjs` and `npm run smoke:review-viewpoint` |
| Convergence verification gate | `scripts/verify-convergence.mjs` and `npm run verify:convergence` |
| Codex ACP real-use acceptance | Future `docs/41-codex-acp-weixin-acceptance-checklist.md` |
| Workbench implementation plan | Future `docs/42-investment-workbench-implementation-plan.md` |

## Acceptance Criteria

Convergence is successful when:

- current source-of-truth docs no longer contradict Strategy Skill as methodology carrier;
- Profile is consistently described as compatibility summary;
- Hermes is consistently optional;
- Codex ACP remains the current main path;
- old Runtime docs are only in archive;
- UI direction clearly separates WeChat and Investment Workbench;
- instance expansion candidate flow is covered by smoke;
- review viewpoint extraction and Workbench exposure are covered by smoke;
- Profile/Hermes responsibility regressions are covered by `npm run scan:convergence`;
- core convergence checks are covered by `npm run verify:convergence`;
- new agents can read `AGENTS.md` and `docs/README.md` without being pulled into obsolete architecture.

## First Execution Slice

Recommended first slice:

1. Update `docs/README.md` to add this plan.
2. Update `AGENTS.md` if needed to mention document convergence.
3. Create a doc inventory table in this plan or a follow-up doc.
4. Archive or mark `31`, `32`, `33` as historical/superseded. Done in first cleanup slice.
5. Update `30` only if it still serves active JR testing; otherwise archive it too. Done: kept as active method-reference test plan.
6. Add a smoke script for instance expansion candidate flow. Done: `npm run smoke:strategy-expansion`.
7. Run `npm run build`.
