# Service Tools MCP

`invest-agent-service-tools` is the service-owned stdio MCP server attached to Codex ACP sessions. It is the only **service-owned** capability surface exposed to workspace Agents — it carries confirmed writes and service state reads. HTTP remains an adapter for Dashboard, Platform, Portal, operations, and compatibility callers, but workspace prompts and skills must not instruct Agents to call it.

> **WP2/WP3 update**: ACP sessions can now also assemble **trusted external read-only MCP servers** (such as `market-data-tool`) via the MCP registry. ACP discovers their tools dynamically via `tools/list`; service tools and external MCPs coexist. Service tools are **not** the only ACP data source for open-ended research.
>
> **External MCP registration supports declarative stdio and HTTP transports.** Stdio launch values use generic `<env:NAME>` tokens in `command`/`args`; HTTP servers declare a URL and explicitly mapped credential headers. Both transports resolve from environment references without shell execution or per-tool adapters. Key guarantees:
>
> - **Per-server activation, default disabled.** `market-data-tool` is enabled by `INVEST_AGENT_MCP_MARKET_DATA_ENABLED=true`; the legacy `INVEST_AGENT_MCP_EXTERNAL_ENABLED=true` remains a compatibility alias for `market-data-tool` only and is **not** inherited by future external servers.
> - **Required references gate connection.** Any missing `requiredEnvRefs` value makes only that external server unavailable (skipped); the service-owned server still starts. Failure of the service-owned server remains blocking.
> - **Secret isolation.** External stdio children receive only declared `envRefs`; HTTP credentials are passed only as declared request headers. Neither transport receives service scope (`DB_PATH`, Workspace paths, user/instance identity, sandbox secrets, service credentials), and resolved credential values never enter manifests, config fingerprints, or logs.
> - **HTTP is capability-gated.** HTTP MCP is assembled only when the ACP initialize response advertises `mcp_capabilities.http=true`; otherwise it is skipped fail closed. Resolved URL and headers are never written to the manifest or logs.
>
> **qsse-qlib quant screening** is registered as a separate external read-only Streamable HTTP MCP and remains disabled by default. Set `INVEST_AGENT_MCP_QSSE_ENABLED=true`, `QSSE_MCP_URL` to the remote `/mcp` endpoint, and `QSSE_MCP_TOKEN` to its Bearer credential to enable it. The token is injected into ACP as an `Authorization: Bearer` header and never enters the manifest or logs. The server is interactive-only in the first release: it is excluded from scheduled and evaluation sessions to protect the two-request screening concurrency limit. ACP discovers its `quant_*` tools dynamically; Invest Agent does not maintain per-tool adapters.
>
> **market-data-tool** is also an external read-only Streamable HTTP MCP and remains disabled by default. Set `INVEST_AGENT_MCP_MARKET_DATA_ENABLED=true`, `MARKET_DATA_MCP_URL`, and `MARKET_DATA_MCP_TOKEN`. It remains available to interactive and scheduled-read sessions, but is excluded from evaluation sessions.
>
> **WP6/WP8 update**: Only `price_cross` remains an active watch-rule type. The 8 non-price rule types (ma/macd/kdj/rsi/boll/wr/volume/near_plan) are retired — `watch_rules.create` rejects them; future indicator-based screening will use an external quant tool.
>
> **WP7 update**: `market_watch_snapshots` writes are frozen; `market_watch.snapshot` reads historical rows only.
>
> **2026-08-28 update**: `market_watch.snapshot` is fully retired (unregistered from the manifest, allowlists, and classification table; the service-core branch now returns `MARKET_WATCH_SNAPSHOT_RETIRED`). Reason: the frozen table stopped at 2026-07-31 and the tool kept feeding stale facts to intraday tasks. Intraday market facts must come from the external `market-data-tool` MCP. Historical `market_watch_snapshots` rows remain in the database for audit only.

Implementation:

- Runtime wiring: `src/mastra/tools/registry.ts`
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

- Service-owned `market.*` facade tools are retired and archived under `docs/archive/service-market-data-retirement-2026-07-31/`. ACP market/provider facts should come from the external `market-data-tool` MCP discovered through the normal MCP manifest.
- `market_watch.snapshot` 已于 2026-08-28 摘除：快照表冻结在 2026-07-31，工具只会返回过期事实并被盘中任务误用作行情来源。历史行仅存数据库供审计，无工具读取入口。
- `research.news_search`：当结构化服务数据或个股证据不足时，按关键词检索公开财经新闻；返回媒体、发布时间、链接、抓取时间和 warning，仅作为二级证据，不能填充缺失行情或财报字段。
- `research.web_search`：通用公开网页检索，用于专业数据和财经新闻工具未覆盖的长尾问题；返回排名、标题、摘要、URL、provider、抓取时间和 warning。摘要只用于发现来源，必须继续读取原文核验。provider 链按确定性顺序：配置 `DOUBAO_SEARCH_API_KEY`（且未用 `DOUBAO_SEARCH_ENABLED=false` 关闭）时优先使用豆包搜索 Custom，无可用结果或失败时回退到自建 SearXNG JSON 后端（`EXTERNAL_WEB_SEARCH_SEARXNG_URL`）；两者都未配置时使用低置信度搜狗结果页。回退只用于发现来源，不表示 SearXNG “验证”或“修正”了豆包结果；MCP 输出、审计和遥测中始终保留实际命中的 provider 身份。
- `research.web_read`：读取搜索所得的公开 HTTP(S) 页面并返回清洗正文；拒绝凭据 URL、本机/内网/保留地址和非文本内容，逐跳校验重定向，并限制超时、响应大小和最大字符数。它不是任意 HTTP 代理或文件下载器。
- `file.parse`（T-235）：把用户上传的文档附件（PDF/Word/PPT/Excel/CSV/图片）解析为 Markdown 文本。传入附件上下文里的 `attachment_id`；文件上传到 MinerU 云端解析后返回 `markdown`。需配置 `MINERU_API_TOKEN`，未配置则工具拒绝并提示 AI 如实告知限制。替代 AI 现场写解析代码。
- `portfolio.read`
- `watchlist.read`
- `plans.read`
- `conversation.history`
- `assets.list`：列出当前 user/project/instance scope 下可用的用户产物描述；不返回本地路径。
- `automation.list`：读取当前 scope 的自动化任务列表和状态，用于任务管理及目标消歧。
- `automation.get`：读取当前 scope 内指定自动化任务的完整定义与状态。
- `confirmations.pending`
- `watch_rules.catalog`
- `watch_rules.list`
- `watch_rules.validate`
- `watch_rules.dry_run`
- `assets.version.read`：按当前服务 scope 读取任意同 scope 用户产物的当前或指定不可变版本；返回受控字节和 descriptor，不返回 Workspace 路径。

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

Write tools:

- `portfolio.apply_changes`
- `onboarding.confirm_portfolio`
- `onboarding.confirm_step`
- `watchlist.add`
- `plans.set`
- `plans.watch_conditions`
- `method_changes.propose`
- `method_changes.apply`
- `preferences.apply`
- `reviews.save`
- `watch_rules.create`
- `assets.version.commit`：普通对话可直接提交同 scope 既有产物的新版本；`expectedVersionId` 仍强制 compare-and-swap、并校验 checksum、MIME 和幂等键。受控自动化 run 仅能写入绑定 output。
- `assets.conversation.save`：普通对话可直接保存生成物为同 scope 产物（或向指定资产追加版本）；受控自动化 run 仅能写入绑定 output。
- `assets.attachment.save`：用户明确要求保存当前聊天附件、或基于它创建自动化任务时，将同 scope、未过期附件提升为“我的文件”资产；返回的 `assetId` 可绑定自动化任务。服务端读取受控附件字节，不接受 Agent 传入的附件路径或 base64。
- `assets.rename`：普通对话可直接重命名同 scope 产物。
- `assets.archive`：普通对话可直接归档同 scope 产物；归档保留内容和版本但禁止后续提交。
- `assets.delete`：永久删除同 scope 产物及版本，始终需要 `confirmations.request` 建立的显式确认。
- `automation.create`：创建通用自动化任务并默认直接启用；只有显式传入暂停状态时保持暂停。该工具不要求交互确认，服务仍强制 scope、schema、资产绑定和审计。
- `automation.update`：创建新的任务 revision；已启用任务默认保持启用，除非明确要求暂停。该工具不要求交互确认，并检查 expected revision（如提供）。
- `automation.activate`：在当前 scope 内启用任务，不要求交互确认；历史和资产保留。
- `automation.pause`：在当前 scope 内暂停任务，不要求交互确认；历史和资产保留。

`portfolio.apply_changes` is a portfolio-domain transaction, not a file-field CRUD surface. The Agent first reads the current portfolio revision, resolves all holding identities, decides every watched-stock keep/remove action with the user, and supplies an explicit cash ratio when known weights would otherwise stop totaling 100%. `confirmations.request` previews and validates the exact change set before a confirmation is created. A later confirmed call rejects stale revisions, writes the complete portfolio once, preserves completed onboarding state, appends the change log, records service audit, and returns the saved state for read-back verification.

`method_changes.propose` and `method_changes.apply` are a two-stage methodology-change flow. The first tool records a candidate only and does not change `config/strategy.yaml`. After the Agent presents the exact structured strategy patch and the user confirms in a later turn, `confirmations.request` registers the `method_changes.apply` payload. The apply tool checks the expected strategy revision, writes and reads back `config/strategy.yaml`, marks the candidate `confirmed`, records the confirmation metadata, change log, and audit, consumes the confirmation once, and publishes the raw strategy file artifact for the current conversation. The candidate and strategy confirmation metadata form an idempotency marker: if a post-write step fails, the same pending confirmation can retry and complete the remaining log/audit/artifact/consumption steps without reapplying the strategy. Automatic artifact publication uses a confirmation-and-path idempotency key, so a retry after the file row was already persisted returns the original artifact descriptor instead of creating a duplicate row; a changed file or scope under the same key is rejected. Required artifact publication failure is an error, not a successful response. A stale, replayed, payload-mismatched, cross-scope, or unrelated already-decided candidate is rejected.

`preferences.apply` updates only named post-onboarding preference domains: review schedule, intraday brief schedule, and notification mode. It requires an exact confirmation payload and optional expected revision, preserves unrelated schedule fields, writes and reads back the affected files, records a change log and audit, consumes the confirmation once, and publishes each changed config file. The confirmation ID is persisted in every affected configuration file so post-write failures can be retried idempotently while the confirmation remains pending. Each automatic artifact publication also uses the confirmation-and-path idempotency key, so partially completed publication retries do not duplicate artifact records. Required artifact publication failure is an error, not a successful response. It is not an arbitrary workspace YAML editor.

User-owned Workspace methods, Skills, knowledge, ordinary reports, and research scripts do not each require a named domain MCP tool. They remain Agent-maintained Workspace assets and require an exact draft plus later explicit user confirmation. User automation task lifecycle is the narrow exception: named `automation.*` tools may create/update/activate/pause directly when the request is clear. The Agent must ask only for missing execution-critical details such as schedule, instruction scope, or an ambiguous update target. Service-consumed deterministic state and runtime capabilities still require named service contracts so scope, schema, audit, and execution guarantees are not delegated to prompt text.

`reviews.save` is the only current write exception: a scheduled daily-review conversation may publish without an interactive confirmation record. The Agent owns the report content and calls the tool with full Markdown `content` plus an independent WeChat `pushBrief`; optional `decisionRecords` and `sourceEvents` are appended to workspace memory. The service preserves the content, mirrors/indexes the artifact, records audit, and never derives the full report from the final customer reply. Manual durable saves still require `confirmedByUser=true`.

Artifact publication tool:

- `artifacts.publish`

`artifacts.publish` registers an already-created scoped workspace file and returns a first-class artifact descriptor for Portal message metadata. Ordinary Portal delivery uses `deliveries/` and remains temporary; set `saveToMyFiles=true` only after the user explicitly asks for a formal report or asks to retain the file. `reports/` is reserved for Workspace-native reports, while `config/` remains a development-phase raw workspace delivery surface. Config artifacts are conversation-only and are not promoted into the user library. A successful `portfolio.apply_changes` also publishes `config/portfolio.yaml` automatically in the same turn. The Agent must not claim that a file is available unless publication succeeds. The tool rejects absolute paths, parent traversal, escaping symlinks, unsupported or forged MIME content, oversized files, unsafe SVG, and cross-scope reads. It does not create or edit the file and cannot select another user scope.

## Verification

Run locally or on Volcano:

```bash
npm run smoke:mcp-service-tools
```

The retired ACP-era publication probe (no-push, fixed-content `reviews.save` check against an explicitly authorized test scope) was removed with the ACP runtime; scheduled publication behavior is now covered by `tests/scheduled-daily-review-contract.test.ts`.

Expected checks:

- TypeScript build passes.
- Core tools can read portfolio, watchlist, plans, conversation history, pending confirmations, historical market-watch snapshots, research evidence, and watch-rule catalog/list/validate.
- Stdio MCP protocol exposes all required read/write tools.
- A restricted stdio MCP session exposes only its allowlisted tools.
- General web tools are discoverable through MCP, page reads cannot reach local/private addresses, and search/page results preserve final URL, fetch time, provider and warnings.
- Durable writes reject missing, expired, replayed, cross-scope, payload-mismatched, or stale-revision confirmations. Portfolio writes also reject unresolved watchlist transitions and complete allocations that do not total 100%.
- Scheduled `reviews.save` accepts only the trusted scheduler conversation scope, preserves full report and push brief separately, appends optional decision/source records, and keeps manual unconfirmed saves rejected.
- `artifacts.publish` accepts allowlisted `deliveries/`, `reports/`, and development-phase `config/` files, and returns a scoped descriptor whose payload checksum matches the workspace bytes.
- Final onboarding watch setup completes after an explicit skip or verified confirmed-rule creation without a redundant completion-only confirmation.
