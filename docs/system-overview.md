# System Overview

> **分支提示（2026-08-14）**：本文描述 **main 基线**的 ACP/Workspace 运行时架构。在 `feat/mastra-migration` 候选分支上，ACP/Codex 内核与 Workspace 运行时已被 Mastra + service-owned 投影替代，本文的 Runtime Flow / Workspace Boundary 章节不适用；候选分支的架构事实与已确认方向见 [mastra-architecture-baseline.md](./mastra-architecture-baseline.md)。

This page is the 10-minute map for Invest Agent. It explains the current runtime shape, ownership boundaries, and where to read next.

## What This System Is

Invest Agent is a WeChat-first AI investment assistant. In the current product semantics, one user maps to one investment assistant and one workspace. `instanceId` still exists in code and SQLite as an internal compatibility and isolation key, but the user-facing product should not present a multi-instance selector.

The current main path is intentionally simple:

```text
WeChat message
  -> WeChat bridge resolves user / assistant / workspace
  -> workspace-scoped ACP backend, normally Codex
  -> Codex reads workspace AGENTS.md + .codex/skills
  -> Codex calls named invest-agent-service-tools MCP tools when deterministic data or mutation is needed
  -> response returns to WeChat
```

The service remains running because it owns durable state, scheduling, local APIs, push delivery, and operational surfaces. The workspace ACP backend owns reasoning, tool selection, and investment judgment.

### Local HTTP Access

The runtime binds to `127.0.0.1` by default. Other than the minimal `/health` and discovery endpoints, local HTTP APIs require `Authorization: Bearer <INVEST_AGENT_API_TOKEN>` (or `x-invest-agent-token`). Platform supports account/password login with an `HttpOnly` session cookie; the service token remains an owner-level operational credential, and HTTP Basic with username `invest-agent` remains a local compatibility path. Production must set the service token explicitly. Sandbox APIs retain their separate short-lived sandbox-token authentication. The cloud portal must use the authenticated connector protocol rather than reach these local routes from a browser.

The default Codex ACP model is selected by configuration (`CODEX_MODEL`, with legacy fallback to `CODEX_COMPLEX_MODEL`). The normal runtime path does not split traffic into simple/complex tiers; changing the model should be a configuration or instance/channel policy choice, not a hard-coded branch.

## Runtime Flow

```text
User channel
  WeChat
  Web portal

Runtime entry
  src/channels/weixin-message-bridge.ts
  src/routes/portal.ts
  src/portal/connector.ts

Reasoning
  src/acp/agent.ts
  src/acp/stdio-agent.ts
  workspace AGENTS.md
  workspace .codex/skills

Deterministic service APIs
  Platform APIs
  sandbox APIs
  watch-rule APIs
  review APIs
  market data services

State
  SQLite service tables
  user workspace yaml/jsonl/md files
  review artifacts under reviews/
```

## Service Boundary

The service is the machine room. Keep these responsibilities in code and SQLite/local runtime state:

- Platform operations.
- WeChat login, listener, and push queue.
- Scheduler, scheduled market-watch briefs, reviews, data-quality jobs, and deterministic rule inspection.
- Market data fetching, source telemetry, and source-quality reporting.
- Sandbox tokens, permissions, confirmations, and audit.
- Shared onboarding service contract used by both MCP and compatibility HTTP adapters, so state progression and durable writes have one implementation.
- Onboarding drafts, confirmation binding, frozen commit snapshots, retryable background application, and completion notifications. Workspace onboarding files change only after the final draft commit succeeds.
- Local HTTP APIs used by Platform, portal connector, operations, and compatibility callers. They are not exposed in workspace prompts or skills.
- `invest-agent-service-tools` MCP server is the only **service-owned** surface exposed to Codex ACP sessions — it carries confirmed writes (portfolio changes, onboarding, watchlist add, plan set, method-change proposals, review save, watch-rule creation) and service state reads. Write tools require explicit user confirmation and are audited by the service. In addition, the MCP registry (WP1) can assemble **trusted external read-only MCP servers** (such as `market-data-tool`, WP2) into ACP sessions for open-ended research; ACP discovers their tools dynamically via `tools/list`. The service retains admission, scope, credentials, and write boundaries.
- Canonical conversation log for user-visible web and WeChat history.

Do not reintroduce service-level triage, fast-lane classification, onboarding short-circuiting, review intent detection, or context-packet wrapping for normal WeChat messages. Those behaviors belong in workspace AGENTS.md, skills, and user config.

## Workspace Boundary

The workspace is the product-level isolation unit. User-specific investment artifacts should live there unless a source-of-truth document explicitly says they remain service-owned.

Typical workspace-owned artifacts:

- `AGENTS.md` and all `.codex/skills`, including copies originally seeded from the product template.
- Portfolio, watchlist, and stock plans.
- Investment model and trading strategies.
- Method notes and review viewpoints.
- Behavior events and method-change candidates.
- User-created composite indicator YAML or sandbox scripts.
- Review artifacts and generated reports.

The template is a seed and an optional update catalog, not the authority for an existing Workspace. Compatibility checks may report that a newer template version exists, but they do not replace user-evolved Skills. Hard guarantees such as scope, confirmation, audit, scheduler gates, and push behavior are enforced by the service/MCP layer.

This does not mean every user-owned Workspace file needs its own MCP tool. After an exact draft and a later explicit confirmation, the Agent may maintain user-owned methods, Skills, knowledge, ordinary reports, and research scripts inside its Workspace. Named domain tools are reserved for deterministic state consumed or executed by the service, such as portfolio allocation, rules, schedules, onboarding state, and publication contracts.

Research and market-evidence instructions describe the facts and quality needed rather than maintaining MCP read-tool inventories. The Agent discovers current read capabilities from MCP descriptions and schemas. Transactional workflows such as onboarding, confirmed writes, explicit-rule creation, and review publication retain precise service contracts until their multi-step state machines can be discovered with equal reliability.

The table-level split is defined in [table-ownership.md](./table-ownership.md).

## Scheduler Boundary

The scheduler is service-owned. It scans workspace schedules and watch configuration, then invokes the workspace-scoped ACP backend or deterministic rule inspection as needed. Per WP4, the scheduler only triggers and delivers — it does not pre-orchestrate research (legacy pre-aggregation, tool allowlists, and forced fallback briefs are behind `SCHEDULED_*_LEGACY_ORCH` flags, default off).

There are two different runtime lines:

- `market-watch`: scheduled brief/summary work that may return `NO_PUSH` (precise `NO_PUSH` → no delivery; no forced fallback brief in the new path).
- `rule-alert-check`: deterministic rule inspection. Per WP5/WP6/WP8, `price_cross` is the only active rule type and uses the narrow `getRulePrices` fact interface (batched per tick); the 8 non-price rule types (ma/macd/kdj/rsi/boll/wr/volume/near_plan) are retired (deprecated, creation blocked). `market_watch_snapshots` writes are frozen (WP7); historical rows are retained.

Rule inspection does not read legacy `alerts` rows, does not mean "intraday touched high", and does not imply close-confirmation semantics. It evaluates the facts available at the scheduler tick, records audit/event state, and pushes according to priority and cooldown. If `market-watch` and `rule-alert-check` hit in the same scheduler tick, rule inspection still records events but suppresses the separate rule push to avoid duplicate WeChat noise.

The current watch runtime source is [watch-runtime-phased-implementation.md](./watch-runtime-phased-implementation.md). Historical stage briefs and design notes are archived and are not current implementation inputs.

## Portal Boundary

The user portal is a separate cloud entrance. It is not a Platform rewrite.

```text
Browser
  -> cloud portal login/chat/history
  -> cloud Relay
  <-> local portal connector
  -> local canonical conversation log
  -> workspace-scoped ACP
```

This repository owns the local side:

- `GET /api/portal/health`
- `GET /api/portal/conversations`
- `GET /api/portal/conversations/:conversationId`
- `POST /api/portal/conversations/:conversationId/messages`
- `npm run portal:connector`
- `conversation_sessions` and `conversation_messages` as the local authority

The cloud portal may mirror conversation history for UX, but it must not become the source of truth, read local files, access workspace state directly, or expose Platform management commands.

### File retention & library governance

Portal file lifecycle is service-owned and deterministic. User uploads (Portal/WeChat images and documents) keep bytes for 7 days via the authoritative `conversation_attachments.expires_at` column, then only metadata remains. Ordinary AI chat artifacts are written under `deliveries/**` and remain 7-day `transient_generated` until the user explicitly saves them. `reviews.save` output and `artifacts.publish` calls with `saveToMyFiles=true` are promoted to permanent `durable_library` when their MIME is allowlisted and size is `<= 1 MiB`; supported formal files are registered in `user_assets`, so they appear in “我的文件”. Workspace `reports/**` is reserved for Workspace-native reports rather than ordinary Portal delivery. During the internal development phase, scoped conversation artifacts may also expose the user's raw `config/**` files, including the automatically published `config/portfolio.yaml`; these files are conversation-only and do not enter the curated library. The model never decides importance — the service layer enforces the retention result from explicit publication intent, source, size, and MIME. Raw `memory/*.jsonl`, `financials/companies/**`, Skills, audit/task/alerts and the full Workspace filesystem remain outside the artifact delivery surface.

The daily attachment-cleanup and 30-day trash-purge jobs run through the scheduler with `scheduled_task_runs` locks. The first real production cleanup is gated behind `FILE_RETENTION_CLEANUP_ENABLED=true` plus a backup + dry-run + explicit operator confirmation. See `package.json` for `retention:*` commands; the original implementation work package is archived under `docs/archive/portal/2026-07/`.

## Platform Boundary

Platform is the internal operations surface for assistant/workspace management, holdings/watchlist/plans/reviews read-only summaries, rule inspection, source quality, audit, and connector-related admin workflows. It has two preset roles: `owner` has authorized administrative access; `partner` is read-only and sees only anonymized operating and quality summaries, never raw conversations or customer investment content. The legacy local Dashboard page was retired on 2026-07-16; `/dashboard` now 301-redirects to `/platform`.

Platform is not the public user portal.

## Data Source Policy

Use local reliable data services first, AI external search second, and explicit data gap last. MVP should not assume expensive paid financial data. If a market fact cannot be obtained from a reliable source, say what is missing instead of filling the gap.

The accepted decision is [data-source-policy-decision.md](./data-source-policy-decision.md).

## Read Next

- New contributor: [../AGENTS.md](../AGENTS.md), then choose a task channel in [README.md](./README.md).
- Runtime work: [watch-runtime-phased-implementation.md](./watch-runtime-phased-implementation.md), [table-ownership.md](./table-ownership.md), [23-multi-user-sandbox-design.md](./23-multi-user-sandbox-design.md).
- Portal current contract: [user-portal.md](./user-portal.md). Exact connector schemas: [user-portal-protocol.md](./user-portal-protocol.md). Initial design and acceptance documents are archived and provide historical context only.
- Platform work: [platform-partner-admin-design.md](./platform-partner-admin-design.md).
- Onboarding work: [onboarding-draft-commit-design.md](./onboarding-draft-commit-design.md), [service-tools-mcp.md](./service-tools-mcp.md).
- Investment workflow work: [investment-model-design.md](./investment-model-design.md), [trading-strategy-design.md](./trading-strategy-design.md), [04-core-workflows.md](./04-core-workflows.md).
