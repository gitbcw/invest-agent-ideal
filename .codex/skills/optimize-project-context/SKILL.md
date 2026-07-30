---
name: optimize-project-context
description: Diagnose and optimize a project's Agent context through an evidence-based, staged cleanup. Invoke only when the user explicitly names `$optimize-project-context`; never trigger implicitly for ordinary development, documentation, cleanup, performance, or testing requests.
---

# Optimize Project Context

Help the user periodically inspect whether project context has become slow, noisy, duplicated, stale, or difficult for Agents to navigate. Diagnose first, agree on the root cause and scope, then plan; edit only after explicit approval.

## Operating Rules

- Treat context management as information architecture, not task classification. Do not enumerate every possible task or teach the Agent generic reasoning it already has.
- Start read-only. Preserve the dirty worktree and do not touch production data, real user Workspaces, global Agent configuration, or external systems.
- Inspect progressively. Inventory paths, sizes, references, commands, and loading relationships first; read file contents only when evidence makes them relevant. Do not preload every document.
- Separate context problems from runtime, test, tool, network, or model problems. Measure each suspected cause before attributing slowness to context.
- Distinguish guidance from enforcement. Put facts in one canonical source, situational procedures in Skills, deterministic checks in scripts/CI, and history outside the active context surface.
- Prefer deletion or consolidation over new indexes, registries, guardrails, or governance layers. Do not add protection against an artifact or behavior that no longer exists.

## Workflow

### 1. Establish The Baseline

Confirm the repository and the user's observed friction. Read applicable root instructions and inspect worktree state. Record the current entry points, active documentation, project Skills, verification commands, and any automatic context-loading surfaces.

Use lightweight evidence where useful: file and line counts, approximate token size, reference searches, command existence, orphan entry points, validation duration, and a representative task replay. Do not produce a maturity score.

### 2. Map Context By Loading Cost

Classify relevant material into four groups:

- **Always loaded:** short, stable principles and red lines required for nearly every task.
- **On demand:** domain facts, procedures, examples, and operational detail discoverable through a small navigation surface or Skill metadata.
- **Historical:** completed plans, experiments, migration records, and superseded decisions kept only for archaeology.
- **Enforced:** permissions, safety boundaries, schemas, and deterministic contracts implemented by code, tools, or CI rather than prose.

Identify duplicated authority, contradictions, stale references, oversized entry files, premature full reads, task/tool catalogs, historical material in active paths, and prose that pretends to enforce behavior.

### 3. Report The Diagnosis

Present problems before remedies. For each material problem, provide evidence, the affected context layer, likely impact, and confidence. Explicitly state suspected causes that evidence did not support.

Stop after the diagnosis when the root cause or appropriate layer still needs discussion. Do not turn an uncertain diagnosis into a cleanup plan.

### 4. Produce A Staged Plan

After the user accepts the diagnosis and scope, propose the smallest effective rounds. Each round must address one coherent problem and state:

- exact files or surfaces in scope;
- what will be deleted, consolidated, moved, or kept;
- why that layer owns the information;
- expected reduction in default context or execution friction;
- verification and rollback conditions;
- explicit exclusions.

Do not mix context cleanup with unrelated architecture, product, or infrastructure redesign.

### 5. Execute Only After Approval

Apply one approved round at a time. Preserve useful contracts before deleting their old carrier. Update active references in the same change, but do not rewrite historical archives merely to match the present.

After each round, run the smallest relevant checks and compare the baseline. At completion, run the repository's canonical verification command when available, validate active links and commands, and report measurable changes plus remaining uncertainty.

## Completion Standard

The cleanup is successful only when:

- a new Agent can find the right context without reading the whole project;
- always-loaded instructions are short, stable, and broadly applicable;
- each current fact or procedure has one clear owner;
- historical material cannot silently override current decisions;
- deleted or renamed entry points leave no active references;
- verification remains at least as strong and is isolated from real user or production state;
- before-and-after evidence shows lower context or execution friction without hiding unresolved risk.
