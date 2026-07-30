# Service Tools MCP

`invest-agent-service-tools` is the service-owned stdio MCP server attached to Codex ACP sessions. It is the only service capability surface exposed to workspace Agents. HTTP remains an adapter for Dashboard, Platform, Portal, operations, and compatibility callers, but workspace prompts and skills must not instruct Agents to call it.

Implementation:

- ACP wiring: `src/acp/stdio-agent.ts`
- MCP entrypoint: `src/mcp/invest-agent-service-tools.ts`
- Tool core: `src/mcp/service-tools-core.ts`
- Smoke: `npm run smoke:mcp-service-tools`

Codex ACP receives an explicit MCP child-process environment. The wiring must carry the resolved database, Workspace root/template, backend mode, runtime-data root, reviews root, and sandbox-secret configuration together with the trusted user/instance/conversation scope. The child must not fall back to repository defaults, because local isolation and Volcano production use non-default state roots. Credentials stay in the child environment and must never be logged or returned in tool/customer output.

## Tool Policy

- Do not add a generic HTTP proxy tool.
- Add named tools that wrap service-owned functions or backends.
- Read tools may run directly.
- Before asking the user to confirm a durable write, call `confirmations.request` with the exact operation and payload.
- `confirmations.request` pre-validates onboarding drafts, so an invalid style or portfolio payload is rejected before the user is asked to confirm it.
- After a later user turn explicitly confirms that draft, call the write tool with its `confirmationId` and `confirmedByUser: true`.
- The service binds confirmations to user, project, instance, conversation, operation, and payload; confirmations expire and can be consumed only once.
- A confirmation is consumed only after the durable write succeeds. Failed validation or state progression remains auditable and leaves the confirmation pending instead of forcing the user to confirm the same draft again.
- Write tools must record service audit.
- ACP sessions may set a service-owned MCP allowlist for an isolated task phase. When present, the stdio server registers only those named tools; the scheduled review publication probe uses this boundary to expose only `reviews.save`.
- Holding removal and watchlist transition are exposed only as part of the revision-bound `portfolio.apply_changes` transaction. Other deletion, disabling, active push, and forced scheduler triggers are not exposed in the first write batch.
- When a required MCP capability is unavailable, the Agent reports the capability or data gap. It must not discover or call hidden HTTP routes, tokens, ports, or local files as a fallback.
- MCP and HTTP adapters reuse the same deterministic service functions; neither adapter owns independent product semantics.
- Core workspace mutations use a cross-process resource lock shared by MCP child processes, the onboarding worker, compatibility HTTP adapters, and Platform admin write routes (`/api/watch-rules` create/update/delete). The lock covers confirmation/revision validation through durable write and audit, while unrelated resources and read-only research remain concurrent. Portfolio, watchlist, and stock-plan writes currently share one `portfolio` resource because they are physically stored in the same workspace YAML file.

## Current Tools

Read tools:

- `market.snapshot`
- `market_watch.snapshot`（当前 user/instance 最近一次 scheduler 盘中快照及有效变化标记；定时简报可将其作为审计/比较输入，而非唯一行情来源）
- `market.quote`
- `market.kline`
- `market.fundamentals`
- `research.news_search`：当结构化服务数据或个股证据不足时，按关键词检索公开财经新闻；返回媒体、发布时间、链接、抓取时间和 warning，仅作为二级证据，不能填充缺失行情或财报字段。
- `research.web_search`：通用公开网页检索，用于专业数据和财经新闻工具未覆盖的长尾问题；返回排名、标题、摘要、URL、provider、抓取时间和 warning。摘要只用于发现来源，必须继续读取原文核验。provider 链按确定性顺序：配置 `DOUBAO_SEARCH_API_KEY`（且未用 `DOUBAO_SEARCH_ENABLED=false` 关闭）时优先使用豆包搜索 Custom，无可用结果或失败时回退到自建 SearXNG JSON 后端（`EXTERNAL_WEB_SEARCH_SEARXNG_URL`）；两者都未配置时使用低置信度搜狗结果页。回退只用于发现来源，不表示 SearXNG “验证”或“修正”了豆包结果；MCP 输出、审计和遥测中始终保留实际命中的 provider 身份。
- `research.web_read`：读取搜索所得的公开 HTTP(S) 页面并返回清洗正文；拒绝凭据 URL、本机/内网/保留地址和非文本内容，逐跳校验重定向，并限制超时、响应大小和最大字符数。它不是任意 HTTP 代理或文件下载器。
- `market.indices`
- `market.capital_flow`
- `market.sector_theme`
- `market.calendar`
- `market.health`
- `market.stock_info`
- `market.resolve`
- `portfolio.read`
- `watchlist.read`
- `plans.read`
- `conversation.history`
- `confirmations.pending`
- `watch_rules.catalog`
- `watch_rules.list`
- `watch_rules.validate`
- `watch_rules.dry_run`

Confirmation workflow tool:

- `confirmations.request`

Onboarding workflow completion tool:

- `onboarding.complete_watch_setup`

Draft-first onboarding tools:

- `onboarding.draft.get`
- `onboarding.draft.upsert_step`
- `onboarding.draft.request_confirmation`
- `onboarding.draft.accept_step`
- `onboarding.draft.skip_watch_rules`
- `onboarding.draft.enqueue_commit`
- `onboarding.draft.commit_status`

New workspace onboarding flows use these tools instead of `onboarding.confirm_portfolio` / `onboarding.confirm_step`: intermediate confirmations only accept a service-owned draft revision. The sole exception is the optional final rule step: `skip_watch_rules` accepts only an explicit latest-user skip and makes no Workspace write. When every section is accepted, `enqueue_commit` freezes that revision. The service worker waits for the initiating assistant reply to be durably recorded, using its message ID rather than parsing customer wording, then writes and verifies the Workspace configuration once before marking onboarding complete and notifying the user.

This tool closes the final watch-setup step without another user confirmation. The service accepts only an explicit skip in the latest user message, or scoped rule IDs with successful `watch_rules.create` audit evidence from the current conversation and no active pending rule drafts.

Confirmed write tools:

- `portfolio.apply_changes`
- `onboarding.confirm_portfolio`
- `onboarding.confirm_step`
- `watchlist.add`
- `plans.set`
- `plans.watch_conditions`
- `method_changes.propose`
- `reviews.save`
- `watch_rules.create`

`portfolio.apply_changes` is a portfolio-domain transaction, not a file-field CRUD surface. The Agent first reads the current portfolio revision, resolves all holding identities, decides every watched-stock keep/remove action with the user, and supplies an explicit cash ratio when known weights would otherwise stop totaling 100%. `confirmations.request` previews and validates the exact change set before a confirmation is created. A later confirmed call rejects stale revisions, writes the complete portfolio once, preserves completed onboarding state, appends the change log, records service audit, and returns the saved state for read-back verification.

User-owned Workspace methods, Skills, knowledge, ordinary reports, and research scripts do not each require a named domain MCP tool. They remain Agent-maintained Workspace assets and require an exact draft plus later explicit user confirmation. Service-consumed deterministic state and runtime capabilities still require named service contracts so scope, schema, audit, and execution guarantees are not delegated to prompt text.

`reviews.save` is the only current write exception: a scheduled daily-review conversation may publish without an interactive confirmation record. The Agent owns the report content and calls the tool with full Markdown `content` plus an independent WeChat `pushBrief`; optional `decisionRecords` and `sourceEvents` are appended to workspace memory. The service preserves the content, mirrors/indexes the artifact, records audit, and never derives the full report from the final customer reply. Manual durable saves still require `confirmedByUser=true`.

Artifact publication tool:

- `artifacts.publish`

`artifacts.publish` registers an already-created file under the scoped workspace `reports/` directory and returns a first-class artifact descriptor for Portal message metadata. An explicitly requested standalone webpage report uses `reports/html/<timestamp>-<slug>.html` and must be published in the same Agent turn; semantic daily, weekly, monthly and company reports keep their existing directories even when rendered as HTML. The Agent must not claim that a report is available unless publication succeeds. The tool rejects absolute paths, parent traversal, escaping symlinks, unsupported or forged MIME content, oversized files, unsafe SVG, and cross-scope reads. It does not create or edit the report file and cannot select another user scope.

## Verification

Run locally or on Volcano:

```bash
npm run smoke:mcp-service-tools
```

For a no-push, fixed-content publication probe against an explicitly authorized test scope:

```bash
npm run smoke:scheduled-review-publication -- <userId> <instanceId> <YYYY-MM-DD>
```

The probe does not collect market data or enqueue a push. It opens an isolated scheduled ACP session with only `reviews.save`, verifies the exact user/instance publication artifact, and retries at most once.

Expected checks:

- TypeScript build passes.
- Core tools can read portfolio, watchlist, plans, conversation history, pending confirmations, market snapshot, quotes, K-lines, indices, market calendar, market health, and watch-rule catalog/list/validate.
- Stdio MCP protocol exposes all required read/write tools.
- A restricted stdio MCP session exposes only its allowlisted tools.
- `market.snapshot` returns usable holdings/watchlist/plan facts without relying on shell network access.
- General web tools are discoverable through MCP, page reads cannot reach local/private addresses, and search/page results preserve final URL, fetch time, provider and warnings.
- Durable writes reject missing, expired, replayed, cross-scope, payload-mismatched, or stale-revision confirmations. Portfolio writes also reject unresolved watchlist transitions and complete allocations that do not total 100%.
- Scheduled `reviews.save` accepts only the trusted scheduler conversation scope, preserves full report and push brief separately, appends optional decision/source records, and keeps manual unconfirmed saves rejected.
- `artifacts.publish` accepts only allowlisted `reports/` files and returns a scoped descriptor whose payload checksum matches the workspace bytes.
- Final onboarding watch setup completes after an explicit skip or verified confirmed-rule creation without a redundant completion-only confirmation.
