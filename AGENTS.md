# Invest Agent Project Context

## Project Role

Invest Agent is the main investment assistant project. It is a WeChat-first AI investment decision assistant for one primary user in the current Experimental MVP stage.

The current experimental architecture is intentionally simple: WeChat resolves the user/instance/workspace, then forwards the user's message directly to the active ACP backend, normally Codex, running inside that user's workspace. The product-level isolation unit is the workspace-backed investment assistant instance.

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
- Let the active ACP backend invoke deterministic service capabilities through skills, usually by calling the local `invest-agent` HTTP API.
- Keep investment conclusions auditable: facts, inference, action, and future validation signals should be separated.
- Do not promise returns or imply automatic trading.
- If data is unavailable, say exactly what is missing instead of filling gaps with invented detail.

## Runtime Evolution Principle

In the current phase, normal WeChat user messages should use the direct workspace ACP path in `src/acp/agent.ts` and `src/acp/stdio-agent.ts`. The service may pass only minimal channel context: that the message came from WeChat, which workspace it belongs to, and that the final text will be sent back to WeChat.

Do not reintroduce service-level triage, fast-lane classification, onboarding short-circuiting, review intent detection, or context-packet wrapping for normal WeChat messages. If behavior needs to change, update the workspace template, AGENTS.md, skills, or workspace config instead.

The durable product assets are workspace templates, Skills, sandbox/tool protocols, deterministic service APIs, confirmation workflows, audit, scheduler behavior, and saved artifacts. Codex ACP is the preferred current backend; backend choice is runtime plumbing, not product semantics.

> **运行时语义纠正(2026-06-30)**:Codex ACP 是当前默认 invest-agent workspace 后端。Hermes 仅保留为兼容/实验 backend；历史 `codex_acp_traces` 表名仅作为兼容存储保留。

Use the workspace-scoped ACP backend as the complex-reasoning and edge-case absorber. As repeated patterns become clear, move them into workspace skills, service APIs, sandbox confirmations, golden tests, and scheduled ACP tasks.

Profile should remain a runtime compatibility summary or routing/config residue. Do not add new methodology responsibilities to Profile; investment method should live in Strategy Skills: protected skeleton plus instance expansion.

## Engineering Convergence Principle

Use the five-step engineering method for the current convergence phase: question the need, delete obsolete responsibilities, simplify the necessary core, speed up feedback loops, then automate stable checks.

Documentation convergence is part of engineering convergence. Keep only current, agent-useful docs in `docs/`; move historical plans, experiments, test records, migration notes, and superseded decisions to `docs/archive/`. Current source-of-truth docs should describe the direct WeChat → workspace ACP path, the service-owned scheduler/push/sandbox/API responsibilities, Profile as compatibility summary, and Strategy Skills as the methodology carrier.

## Source Of Truth

Use these files first:

- `CLAUDE.md`: current runtime architecture, commands, key files, and tool surface.
- `docs/README.md`: small current document index and project-level consensus.
- `docs/table-ownership.md`: SQLite table three-tier ownership (service / workspace / discard).
- `docs/23-multi-user-sandbox-design.md`: sandbox token, permission, audit, and isolation model.
- `docs/composite-indicator-system.md`: composite indicator system RFC (5 layers: L1 operators / L2 signals / L3a rule tree / L3b sandbox script) with main-force-control as first use case.
- `docs/trading-strategy-design.md`: trading strategy entity v1 (2026-06-23): first-class strategy in workspace yaml, strategy→plan one-way generation with two-gate confirmation.
- `docs/02-investment-methodology.md`: user's investment methodology.
- `docs/04-core-workflows.md`: business workflows across screening, review, alerts, and feedback.

## Current Review Direction

The existing TypeScript review handler works, but its review quality is too shallow compared with the review practice in `jr-backend`.

The preferred direction is:

- Keep `src/handlers/review.ts` as the deterministic data collector and runtime integration point.
- Move review method into workspace skills.
- Save full review artifacts under `reviews/`.
- Make daily reviews feed weekly reviews, and weekly reviews feed monthly reviews.
- Include a viewpoint tracking table or equivalent audit trail so future reviews can judge whether earlier views were right, wrong, or unverified.
- Tie all action suggestions to existing plans, alerts, holdings, watchlist status, and user methodology.

## Current Screening Direction

Screening should be workspace skill-driven.

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

Skills should own how Hermes uses these capabilities:

- Which API to call for each user intent.
- How to interpret API results.
- How to produce cautious investment language.
- How to decide whether a deterministic action needs confirmation.

In short: the service is the machine room; skills are the operating manual Hermes uses to run it.

## Strategy Plan Drafting (硬约束)

涉及"用 X 策略给 Y 股票出预案""按 X 策略起草计划""出预案"等请求时,**必须**走下方两道闸门流程:

1. **第一道闸门(策略匹配)**:确认策略 + 解释为什么该策略匹配这只股票(2-3 句),邀请用户确认。**不能在同一回复里继续起草预案**。
2. **等用户回复确认**(如"确认""可以""就用这个")。
3. **第二道闸门(预案起草)**:输出 support/resistance/target/stopLoss/notes 草案,**等用户确认才落库**。

**禁止**:

- ❌ 跳过第一道闸门,一次回复内直接起草预案(即使用户已指定策略名)
- ❌ 在草案里包含仓位上限/持仓金额/持股数量/时间约束(系统不存这些字段)
- ❌ 承诺收益、胜率或精确时间

如果用户指定的策略在 `trading_strategies.yaml` 里不存在,**不要**用"通用版本"代替起草。先告知用户该策略未找到,询问是否:
(a) 让我按你的口述新建该策略,或
(b) 改用其他已存在的策略。

## Style

Write investment outputs in Chinese unless the user asks otherwise. Be direct, operational, and cautious. The product should feel like a disciplined investment workbench, not a generic chatbot.
