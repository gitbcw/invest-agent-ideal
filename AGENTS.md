# Invest Agent Project Context

## Project Role

Invest Agent is the main investment assistant project. It is a WeChat-first AI investment decision assistant for one primary user in the current Experimental MVP stage.

The current architecture is evolving into a multi AI Project runtime platform. Invest Agent is the first project type and validation sample, not the whole platform. The product-level isolation unit is an AI Project; the current engineering scope field is still `instance_id`, with a long-term direction toward `project_id` semantics.

The product has three long-term core capabilities:

1. 巡检: monitor holdings, watchlist, alerts, signals, plans, and intraday events.
2. 复盘: generate daily, weekly, and monthly reviews that turn market data and alerts into an auditable decision loop.
3. 选股问答: answer industry/theme/company screening questions and convert good candidates into watchlist entries.

Current code already implements much of the runtime, database, dashboard, WeChat bridge, alert checking, and basic review/screening handlers. The next design direction is to move investment methodology and output discipline into workspace skills, so the system can improve through prompt/workflow assets without excessive code churn.

## Operating Principle

Prefer the "AGENTS.md + .codex/skills" workflow for investment reasoning:

- Use code for deterministic execution: data collection, DB reads/writes, stock resolving, alert checks, scheduling, and dashboard APIs.
- Use skills for investment judgment workflows: review structure, screening reasoning, evidence requirements, risk language, and user-specific decision discipline.
- Keep the long-running service for GUI, WeChat connection, scheduler, alert push, and local HTTP APIs.
- Let Codex invoke deterministic service capabilities through skills, usually by calling the local `invest-agent` HTTP API.
- Keep investment conclusions auditable: facts, inference, action, and future validation signals should be separated.
- Do not promise returns or imply automatic trading.
- If data is unavailable, say exactly what is missing instead of filling gaps with invented detail.

## Runtime Evolution Principle

In the current phase, keep Codex ACP as the primary intelligent backend. Do not expand a full multi-backend runtime abstraction unless the user explicitly asks for that work.

The durable product assets are Skills, sandbox/tool protocols, deterministic service APIs, context building, confirmation workflows, audit, and saved artifacts. Backend choices such as Codex ACP, LangChain, LangGraph, or a future self-built runtime are execution options, not product semantics.

> **Hermes 已退出主链路**（2026-06-21 工作包 2）：Codex 一律兜底，Hermes 不再作为产品语义的一部分。`/api/hermes/*` 实验路由和 `src/acp/hermes-stdio-agent.ts` 仅作考古保留，不要在主链路重新引入依赖。后续工作包规划见 `docs/ideal-refactor-plan.md`。

Use Codex as the first-phase complex-reasoning fallback and edge-case absorber. As repeated patterns become clear, move them into Strategy Skills, service tools, sandbox confirmations, evaluation examples, and deterministic fast paths.

Profile should remain a runtime compatibility summary or routing/config residue. Do not add new methodology responsibilities to Profile; investment method should live in Strategy Skills: protected skeleton plus instance expansion.

## Engineering Convergence Principle

Use the five-step engineering method for the current convergence phase: question the need, delete obsolete responsibilities, simplify the necessary core, speed up feedback loops, then automate stable checks.

Documentation convergence is part of engineering convergence. Keep only current, agent-useful docs in `docs/`; move historical plans, experiments, test records, migration notes, and superseded decisions to `docs/archive/`. Current source-of-truth docs should describe Codex ACP as the sole main path (Hermes has exited the main path), Profile as compatibility summary, and Strategy Skills as the methodology carrier.

## Source Of Truth

Use these files first:

- `CLAUDE.md`: current runtime architecture, commands, key files, and tool surface.
- `docs/README.md`: small current document index and project-level consensus.
- `docs/ideal-refactor-plan.md`: **current** master plan for ideal-shape refactor (workspace model + Codex fallback + DeepSeek triage). Supersedes the historical runtime/convergence/UI strategy docs (now in `docs/archive/`).
- `docs/table-ownership.md`: SQLite table three-tier ownership (service / workspace / discard).
- `docs/23-multi-user-sandbox-design.md`: sandbox token, permission, audit, and isolation model.
- `docs/composite-indicator-system.md`: composite indicator system RFC (5 layers: L1 operators / L2 signals / L3a rule tree / L3b sandbox script) with main-force-control as first use case.
- `docs/02-investment-methodology.md`: user's investment methodology.
- `docs/04-core-workflows.md`: business workflows across screening, review, alerts, and feedback.

## Current Review Direction

The existing TypeScript review handler works, but its review quality is too shallow compared with the review practice in `jr-backend`.

The preferred direction is:

- Keep `src/handlers/review.ts` as the deterministic data collector and runtime integration point.
- Move review method into `.codex/skills/*review`.
- Save full review artifacts under `reviews/`.
- Make daily reviews feed weekly reviews, and weekly reviews feed monthly reviews.
- Include a viewpoint tracking table or equivalent audit trail so future reviews can judge whether earlier views were right, wrong, or unverified.
- Tie all action suggestions to existing plans, alerts, holdings, watchlist status, and user methodology.

## Current Screening Direction

The existing `src/handlers/screening.ts` is a useful first version, but screening should also become skill-driven.

The preferred direction is:

- The handler gathers the user's query and any available deterministic context.
- The screening skill defines the research workflow, report structure, evidence rules, watchlist conversion rules, and anti-hallucination constraints.
- Candidate stocks should include observation conditions, not only bullish reasons.
- The output should make it easy for the user to say which candidates to add to the watchlist.

## Service And Skill Boundary

The service should keep running because it owns stateful and time-based responsibilities:

- Dashboard GUI.
- WeChat login and listener.
- Active alert push.
- Scheduler and intraday inspection.
- SQLite persistence.
- Market data fetching.
- Local HTTP APIs.

Skills should own how Codex uses these capabilities:

- Which API to call for each user intent.
- How to interpret API results.
- How to produce cautious investment language.
- How to decide whether a deterministic action needs confirmation.

In short: the service is the machine room; skills are the operating manual Codex uses to run it.

## Style

Write investment outputs in Chinese unless the user asks otherwise. Be direct, operational, and cautious. The product should feel like a disciplined investment workbench, not a generic chatbot.
