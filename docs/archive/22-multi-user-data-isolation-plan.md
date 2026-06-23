# Multi-User Data Isolation Plan

## Background / Intent

The current Hermes WeChat bypass proved that the message path can be isolated from the main Codex path while still sharing the same business database. This is useful for backend comparison, but it also exposes the next product requirement: Invest Agent needs to support multiple human users without mixing holdings, watchlists, plans, alerts, reviews, conversations, or push state.

The current system is still largely single-user:

- `watchlist.stock_code` is the primary key.
- `stock_plans.stock_code` is the primary key.
- `alert_signal_states.signal_key` is the primary key.
- Most business queries read global tables without a user filter.
- WeChat state stores the assistant/bot account and one `lastConversationId`, not a durable human-user identity model.
- Dashboard APIs aggregate all rows as if they belong to one person.

The next phase should convert Invest Agent from a single-user workbench into a multi-user workbench with explicit identity, ownership, and query boundaries.

## Goals

1. Introduce a durable user identity model.
2. Separate channel identity from business user identity.
3. Make core business tables user-scoped.
4. Ensure all reads/writes use a `userId` context.
5. Let main Codex and Hermes bypass share the same multi-user model without sharing conversation/session state.
6. Keep market data, indicator definitions, and methodology assets shared where appropriate.
7. Provide a migration path for the existing single-user data into one default owner.
8. Make Dashboard usable for selecting or inspecting a user context.

## Non-Goals

- Do not build public account management, billing, permissions, or team collaboration yet.
- Do not split into multiple SQLite files unless a later privacy requirement demands hard physical isolation.
- Do not change the investment methodology or review/screening skill content in this phase.
- Do not attempt automatic trading or broker account integration.
- Do not make Hermes the production default; it remains a backend option behind explicit routing.

## Key Design Decision

Use one SQLite database with row-level ownership via `user_id`.

This is the right MVP shape because:

- It supports shared market data and shared system definitions.
- It allows one service process to run scheduling and WeChat handling for multiple users.
- It keeps Dashboard and local development simple.
- It allows later migration to a server database or tenant-separated storage if needed.

Hard isolation through one DB per user should remain a future option, but it is too heavy for the current Experimental MVP.

## Identity Model

Add these concepts:

- `users`: the human investor profile.
- `channel_accounts`: logged-in assistant/bot accounts, such as a WeChat bot session for main path or bypass path.
- `channel_identities`: external user identities seen through a channel, such as a WeChat conversation/openid, mapped to one `users.id`.
- `agent_sessions`: optional durable mapping from `(backend, channel, conversation_id, user_id)` to ACP session metadata.

Important distinction:

- The current `accountId` from QR login is the assistant/bot account, not necessarily the human investor.
- The incoming `conversationId` is closer to the external human contact identity.
- Business data should belong to the human `user_id`, not to the assistant/bot account.

Proposed tables:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE channel_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  backend TEXT NOT NULL DEFAULT 'codex',
  external_account_id TEXT NOT NULL,
  state_dir TEXT,
  display_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(channel, backend, external_account_id)
);

CREATE TABLE channel_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  backend TEXT,
  external_user_id TEXT NOT NULL,
  external_account_id TEXT,
  last_conversation_id TEXT,
  last_context_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(channel, external_user_id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);
```

## Data Ownership Scope

User-scoped tables:

- `watchlist`
- `portfolio`
- `alerts`
- `alert_rules`
- `stock_plans`
- `chat_history`
- `daily_plans`
- `alert_events`
- `alert_signal_states`
- `trade_actions`
- `codex_acp_traces`
- `agent_traces` if retained
- user-level settings such as review push time or signal preferences

Shared/system tables:

- `indicator_definitions`, with current `owner` retained for system/custom distinction.
- Market quote and external data caches, if added later.
- Global app settings that truly apply to all users.

Needs review:

- `settings` currently stores global settings. Split into:
  - `settings` for app-global settings.
  - `user_settings` for per-user settings.

## Schema Changes

### Simple User Columns

Add `user_id TEXT` to these tables and backfill with a default user:

- `portfolio`
- `alerts`
- `alert_rules`
- `chat_history`
- `daily_plans`
- `alert_events`
- `trade_actions`
- `codex_acp_traces`
- `agent_traces`

### Tables Requiring Primary Key Rebuild

These cannot support multi-user correctly with only `ADD COLUMN` because current primary keys are global:

1. `watchlist`
   - Current primary key: `stock_code`
   - Target: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `user_id TEXT NOT NULL`, unique `(user_id, stock_code)`

2. `stock_plans`
   - Current primary key: `stock_code`
   - Target: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `user_id TEXT NOT NULL`, unique `(user_id, stock_code)`

3. `alert_signal_states`
   - Current primary key: `signal_key`
   - Target: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `user_id TEXT NOT NULL`, unique `(user_id, signal_key)`

SQLite requires table rebuild migrations for these. Do not try to fake this with indexes while keeping the old global primary keys.

### Recommended Indexes

Create indexes for common user-scoped reads:

- `idx_watchlist_user_stock(user_id, stock_code)`
- `idx_portfolio_user_status(user_id, status)`
- `idx_portfolio_user_stock_open(user_id, stock_code, sell_date)`
- `idx_stock_plans_user_stock(user_id, stock_code)`
- `idx_alert_events_user_date_code(user_id, event_date, stock_code)`
- `idx_alert_rules_user_stock_enabled(user_id, stock_code, enabled)`
- `idx_codex_acp_traces_user_conversation(user_id, conversation_id, created_at)`
- `idx_daily_plans_user_date(user_id, plan_date)`

## Runtime Context

Add a central `UserContext` type:

```ts
export type UserContext = {
  userId: string;
  channel?: 'weixin-mobile' | 'dashboard' | 'api';
  backend?: 'codex' | 'hermes';
  conversationId?: string;
  externalUserId?: string;
  channelAccountId?: string;
};
```

All business handlers should accept this context explicitly:

- `handlePortfolioTool(ctx, args)`
- `handleWatchlistTool(ctx, args)`
- `handleAlertTool(ctx, args)`
- `buildDailyReviewContext(ctx)`
- `runAlertCheck(ctx?)`
- Dashboard mutating APIs should require or resolve a user context.

Avoid implicit global user reads inside handlers. If a handler lacks context, it should fail fast in production paths and only use a default user in explicitly marked development/test paths.

## User Resolution Flow

### WeChat Incoming Message

1. `weixin-agent-sdk` receives a message.
2. `WeixinMobileManager` knows the logged-in assistant account.
3. Bridge receives `conversationId`.
4. Resolve `(channel='weixin', external_user_id=conversationId)` in `channel_identities`.
5. If no mapping exists:
   - MVP option: auto-create a user with display name derived from the conversation id.
   - Safer option: create a pending user and require Dashboard confirmation before writes.
6. Pass `UserContext` into Codex/Hermes prompt and deterministic service calls.

### Dashboard

1. Add user selector in Dashboard.
2. Store selected `userId` in the browser query string or local storage.
3. All Dashboard APIs accept `?userId=...`.
4. Mutating APIs must reject missing/unknown `userId`.

### Local API / Tests

1. Support `X-Invest-User-Id` header or `userId` body/query parameter.
2. Default to the migrated primary user only for local smoke tests.

## Agent / Skill Boundary Changes

Main and bypass agents should both be told the active user context:

- user id
- channel
- backend
- conversation id
- whether the user is newly created or known

The service tool skill should document that all local HTTP API calls must include `userId`.

The mobile prompt should include a short runtime note:

```text
当前用户上下文 userId=...。所有持仓、自选、预案、提醒和复盘查询都必须限定在该用户。
```

No investment reasoning skill should infer data for another user.

## Scheduler And Push Strategy

The scheduler must become user-aware.

Phase 1:

- Run alert checks for the default user only.
- Keep current behavior stable.

Phase 2:

- Add `listActiveUsersForScheduler()`.
- For each user, run:
  - alert checks
  - pre-market reminders
  - daily review scheduling
- Push results to that user's latest channel identity.

Required changes:

- `registerPush` should accept `(userId, message)` instead of only `message`.
- `weixinMobileManager.pushText` should accept `userId` or `conversationId`, not rely on a single global last conversation.
- Alert dedupe must include `user_id` to avoid one user's event suppressing another user's alert.

## Dashboard Changes

Required Dashboard updates:

1. User selector in the sidebar/header.
2. `/api/dashboard?userId=...` filters all user-scoped tables.
3. Add a lightweight user admin view:
   - list users
   - create test user
   - map/unmap WeChat conversation identity
   - inspect last conversation / push readiness
4. Conversation table should show user and backend/channel filters.
5. Hermes bypass page should show which resolved user is active after first inbound message.

## Migration Plan

1. Create default user:
   - id: `primary`
   - display name: `主用户`

2. Backfill all existing user-scoped rows to `primary`.

3. Rebuild primary-key-limited tables:
   - `watchlist`
   - `stock_plans`
   - `alert_signal_states`

4. Add user-scoped indexes.

5. Add a `schema_migrations` table if not already present, so the rebuild is idempotent.

6. Add migration verification:
   - row counts before/after match.
   - current Dashboard for `primary` shows same counts as before migration.
   - adding the same stock to two different users is possible.

## Execution Plan

### Phase 0: Safety Baseline

- Add tests or smoke scripts that capture current counts for holdings, watchlist, plans, alerts, and recent reviews.
- Confirm current primary user Dashboard behavior before migration.
- Do not change runtime routing yet.

### Phase 1: Schema And Migration

- Add user identity tables.
- Add `user_id` to simple tables.
- Rebuild `watchlist`, `stock_plans`, and `alert_signal_states`.
- Backfill existing data to `primary`.
- Add indexes.
- Update Drizzle schema and `initDb()` migration logic.

### Phase 2: Data Access Context

- Add `src/lib/user-context.ts`.
- Add helpers:
  - `resolveDefaultUser()`
  - `resolveUserFromWeixinConversation()`
  - `requireUserContext()`
- Update handlers to accept `UserContext`.
- Add query helper patterns for user-scoped filters.

### Phase 3: Handler Filtering

Update these modules first:

- `src/handlers/portfolio.ts`
- `src/handlers/watchlist.ts`
- `src/handlers/plan.ts`
- `src/handlers/alert.ts`
- `src/handlers/plan-conditions.ts`
- `src/handlers/review.ts`
- `src/scheduler/alert-check.ts`
- `src/scheduler/pre-market.ts`
- `src/scheduler/review.ts`

Every select/update/delete/insert against a user-scoped table must include `userId`.

### Phase 4: Channel Resolution

- Update `src/channels/weixin-mobile.ts` to resolve `UserContext` from incoming conversation.
- Store last conversation/context token in `channel_identities`, not the bot account JSON alone.
- Keep separate main/bypass state dirs for QR login tokens.
- Pass context into Codex and Hermes prompts.

### Phase 5: Dashboard User Context

- Add `/api/users` endpoints.
- Add Dashboard user selector.
- Require `userId` for Dashboard APIs.
- Add user identity mapping view.

### Phase 6: Scheduler Multi-User Loop

- Make alert/review scheduler iterate active users.
- Push per-user output through that user's most recent channel identity.
- Add per-user scheduler settings.

### Phase 7: Bypass Validation

- Use main path and Hermes path with two different test users.
- Confirm same stock can exist in both users' watchlists with different reasons/plans.
- Confirm main path cannot see Hermes test user's data unless same `userId` is selected.

## Acceptance Criteria

- Existing single-user data appears under `primary` after migration.
- Two users can both have the same `stock_code` in watchlist.
- Two users can both have different `stock_plans` for the same `stock_code`.
- Dashboard counts change when switching users.
- WeChat inbound message resolves to a specific `userId`.
- Codex and Hermes traces include `user_id`.
- Alert events and dedupe are user-scoped.
- Daily review context only includes the active user's holdings, watchlist, plans, and alerts.
- `npm run build` passes.
- Smoke tests cover:
  - primary user migration
  - second user watchlist add
  - same-stock-per-two-users
  - Dashboard aggregate filtering
  - WeChat conversation-to-user resolution

## Risks And Mitigations

- Risk: missing a query filter leaks another user's data.
  - Mitigation: centralize user context and add code review checklist; grep for user-scoped tables without `userId`.

- Risk: SQLite table rebuild loses data.
  - Mitigation: write migration with backup tables, row count checks, and rollback notes.

- Risk: scheduler duplicate pushes during transition.
  - Mitigation: keep scheduler single-user in Phase 1; enable multi-user scheduling only after push routing is user-aware.

- Risk: WeChat `conversationId` is not stable enough as a human identity.
  - Mitigation: store observed identifiers, expose Dashboard mapping, and allow manual merge/remap.

- Risk: Dashboard APIs accidentally default to `primary` in production.
  - Mitigation: allow default only under explicit dev/test flag.

## Open Questions

1. Should new WeChat conversations auto-create users, or should they stay pending until manually approved?
2. Is one assistant/bot account expected to serve many human users, or will each user scan/login a separate assistant account?
3. Should Hermes bypass create separate test users by default, or should it share the same resolved user as main path for A/B quality comparison?
4. Should traces be visible across all users to the operator, or filtered by selected user by default?
5. Do we need a user merge flow for duplicate WeChat identities?

## Recommended First Implementation Slice

The first slice should be intentionally small:

1. Add `users`, `channel_identities`, and `user_id` to core tables.
2. Rebuild `watchlist` and `stock_plans` so duplicate stock codes across users work.
3. Backfill current data to `primary`.
4. Update watchlist and plan handlers only.
5. Add a Dashboard user selector and prove:
   - user A and user B can each add `300750`.
   - user A cannot see user B's reason/plan.

Do not start with scheduler or full review migration; those touch too much surface area.

## Executor Prompt

Use `docs/archive/22-multi-user-data-isolation-plan.md` to implement the first multi-user data isolation slice. Start with schema/migration, user context helpers, watchlist and stock plan filtering, and Dashboard user selector. Preserve current `primary` user behavior. Do not expand into scheduler or full review migration until the first slice passes its acceptance criteria.

## Reviewer Prompt

Review the implementation against `docs/archive/22-multi-user-data-isolation-plan.md`. Focus on data leakage risks, missing `userId` filters, migration safety, duplicate-stock support across users, and whether current single-user behavior remains intact under the `primary` user.
