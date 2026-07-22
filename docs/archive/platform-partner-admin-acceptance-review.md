# Platform 合伙人后台验收报告

> 说明：本文前半部分保留了 2026-07-18 Phase 0 的历史验收记录，用于说明设计如何从“仅有方案”演进到本地实现。后续的“Phase 1 实施 Review”和“Phase 2 页面验收”是当前有效结论；不要把历史段落中的“尚未实现”理解为当前代码状态。

## 当前有效结论（2026-07-18）

本地 Owner/Partner 登录、首次改密、服务端 RBAC、Partner 脱敏聚合接口、只读 Partner 页面、迁移幂等与回滚开关均已落地并有 smoke/浏览器证据。Partner 不读取原始对话、持仓明细、成本、策略正文、规则条件、微信身份或管理接口。

公网入口的产品决策为 `http://<火山云固定公网IP>:22646`，不配置域名或 HTTPS；本轮没有部署该入口，也没有修改火山云冻结版本。runtime 仍保持 `127.0.0.1:22655`，后续部署必须使用独立 listener 或路径白名单反代，不能把 22655 直接改为公网监听。因此整体结论是：**本地实现通过；公网部署验收未完成（按当前范围刻意留待部署阶段）。**

本轮收口修正了两处本地边界：回滚开关下远程 `/platform` 仍只返回 `401` 登录壳，loopback 才保留旧 Owner 兼容页；Partner 客户列表会消费 `nextCursor` 并提供“加载更多”，不会在超过 50 个客户时静默截断。

## Acceptance Verdict

Status: Pass with caveats for Phase 0; Partial/Unknown for the full implementation.

`docs/platform-partner-admin-design.md` 已完成 Phase 0 的主干方向：Owner/Partner 角色、Partner 全客户只读边界、成本隔离、`22646` 公网 IP/HTTP 入口和安全残余、现有 Platform 路由处置表、新 Partner API 方向、迁移/回滚/验证门槛。但独立验收指出，当前文档还缺少可执行级别的字段 allowlist/denylist、脱敏算法、Partner API response schema、统计口径和部分高风险接口逐字段剥离要求。因此 Phase 0 尚不能判 Pass。

本次验收没有把未实现的账号、RBAC、浏览器页面和真实 403 穿透测试判定为通过；这些属于 Phase 1+ 的实施验收项。

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Scope | Phase 0 只完成角色、权限、数据范围和 API 清单，不重写页面 | Pass | `docs/platform-partner-admin-design.md` lines 3, 428；`git diff --check -- docs/platform-partner-admin-design.md` 通过 | 当前只修改方案文档，未实施 UI 或 runtime 代码。 |
| Roles | 第一版只保留 Owner / Partner 两类角色 | Pass | `docs/platform-partner-admin-design.md` lines 41-49, 72-77 | 避免过早建设任意权限编排器。 |
| Partner Capability | Partner 只读、可看全部客户经营聚合，但字段受限 | Pass | `docs/platform-partner-admin-design.md` lines 100-102, 348-365 | 明确无写权限、无管理操作。 |
| Partner Sensitive Boundary | Partner 不看原始对话、持仓明细、成本、资金、策略正文、规则条件、微信身份 | Pass | `docs/platform-partner-admin-design.md` lines 180, 380-388 | 已把成本从 Partner 范围移除，成本页为 Owner-only。 |
| Entry | 公网 IP + `22646` + 账号密码；不要求 HTTPS/域名 | Pass | `docs/platform-partner-admin-design.md` lines 108-125, 481-485 | 记录了 HTTP 残余风险和缓解措施。 |
| Security Residual | HTTP 登录凭据风险被明确记录 | Pass | `docs/platform-partner-admin-design.md` lines 114-117, 491-495 | 明确“不能把固定 IP 或非标准端口当作加密替代品”。 |
| Current API Inventory | 现有 Platform API 已标注 Partner/Owner 处置 | Partial | `docs/platform-partner-admin-design.md` lines 390-410；`rg` 路由扫描覆盖 `src/routes/platform.ts` lines 715-978 | 路径覆盖完整，但字段级剥离还不足。 |
| Existing Risk Recognition | 当前接口含敏感字段和高风险操作 | Pass | `src/routes/platform.ts` lines 149-164, 377-392, 840-864, 877-895, 941-963, 1040-1056 | 审计、投资状态、Portal 凭据、删除/重置/微信操作均不能直接给 Partner。 |
| Proposed Partner APIs | 新增只读脱敏聚合 API 契约 | Partial | `docs/platform-partner-admin-design.md` lines 412-424 | 只有接口名称和返回边界，缺少 response schema、字段 allowlist、分页/筛选/时间窗/错误码。 |
| Statistics | 核心统计口径可复核 | Partial | `docs/platform-partner-admin-design.md` lines 371-378, 418-422 | 列了指标名称，但缺少来源表、去重键、时间窗、时区、状态枚举、缺失语义。 |
| Migration Plan | DB 变更需进入 Phase 1，且 additive / rollback 清晰 | Pass | `docs/platform-partner-admin-design.md` lines 294-302, 426-433 | Phase 0 无 DB 迁移；Phase 1 才建后台账号/session/audit 表。 |
| Server-side Authz | 授权必须服务端执行 | Pass as design / Not implemented | `docs/platform-partner-admin-design.md` lines 55-58, 317-330, 431 | 设计明确，但当前代码尚无 Partner RBAC。 |
| Unauthenticated Access Rejection | 未登录访问被拒绝 | Partial | 当前 `src/server.ts` lines 84-94；`src/routes/platform.ts` lines 715-721 | 现有远程请求会被 service token 拦截；本机 `/platform` 会自动发 session，不等于新后台账号登录。Phase 1 需真实验证。 |
| Partner 403 Penetration | Partner 直接调用高风险 API 返回 403 | Unknown / Future gate | `docs/platform-partner-admin-design.md` lines 431-432 | Phase 0 只定义门槛；尚未实现 Partner 账号与权限中间件，不能测试通过。 |
| Admin Audit | 敏感查看和高风险操作有管理员审计 | Pass as design / Not implemented | `docs/platform-partner-admin-design.md` lines 128-137, 323-328, 359-365 | 需要 Phase 1 表结构和中间件实现后验收。 |
| Browser Evidence | Partner 页面不显示成本/日志正文/管理按钮 | Unknown / Future gate | `docs/platform-partner-admin-design.md` lines 142, 431-432；当前 `src/admin/platform-page.ts` lines 238-270, 1301-1437 | 当前页面仍是 Owner 运维面，含成本、审计、创建、删除、微信等按钮；Phase 0 已明确不能复用给 Partner。 |
| Runtime Isolation | 不影响微信、scheduler、MCP、用户 Portal | Pass as design / Not executed | `docs/platform-partner-admin-design.md` lines 433, 486 | 本次只改文档，因此没有运行时影响；实施阶段仍需 smoke/browser 证据。 |

## Findings

- [Medium] Partner API 契约不够可执行：目前只有接口名称和文字边界，缺少 response schema、字段 allowlist/denylist、分页/筛选、时间窗、时区、缺失语义和错误码。
- [Medium] 当前实例摘要风险未逐字段落表：`summarizeInstance` 实际返回 workspace 路径、identity、allowedTools/config、owner id/displayName、channelBindings/externalAccountId/externalUserIdSuffix、recentTraces.userText 等，Phase 0 表格只概括为“实例/owner/workspace/channel binding/recent traces”，需要逐字段剥离要求。
- [Medium] 微信状态脱敏不足：`GET /api/platform/instances/:id/weixin/status` 当前可能包含二维码、session、stateDir、accountId、lastConversationId 等运行时细节；Partner 契约必须明确只返回绑定/可触达/最近入站出站/失败分类。
- [Medium] 数据源质量脱敏不足：`GET /api/platform/source-quality` 当前返回 `sourceQualityDir` 内部路径和原始 reports/alerts，Partner 只能看健康摘要和失败分类。
- [Medium] 规则巡检契约不足：`GET /api/platform/rule-alerts` 当前直接返回 rules/events/tasks；Partner 只能看规则数量、启用数量、运行次数、命中数量、失败分类，不能看到 ticker、阈值、规则条件或事件上下文。
- [Medium] Full implementation is not complete: Account/password login, platform users/roles/sessions/admin audit tables, RBAC middleware, Partner sanitized APIs, and browser UI have not been implemented yet.
- [Low] The acceptance criteria in the design document include future runtime behavior such as 401/403, browser evidence, and admin audit. These are valid gates for Phase 1+, but should not be treated as already proven by Phase 0.

## Verification Performed

- Read `docs/platform-partner-admin-design.md` and extracted roles, Partner boundary, entry/security, Phase 0 matrix, API inventory, migration/rollback and acceptance gates.
- Scanned current Platform route inventory with `rg -n "app\\.(get|post|delete|put|patch)(<[^>]+>)?\\(\\\"/" src/routes/platform.ts`; confirmed 17 Platform routes are covered by the Phase 0 API table.
- Scanned high-risk fields/actions in `src/routes/platform.ts`; confirmed current API risk includes raw text, prompt/reply, cost, holdings, watchlist, plans, Portal credentials, delete/reset, workspace ensure and WeChat control.
- Scanned current Platform page actions in `src/admin/platform-page.ts`; confirmed current UI remains an Owner/operations surface and cannot be exposed to Partner.
- Reviewed current auth/session path in `src/lib/platform-session.ts`, `src/server.ts`, and `src/routes/platform.ts`; confirmed current local session/service-token behavior is not the proposed account/password RBAC model.
- Ran `git diff --check -- docs/platform-partner-admin-design.md`; no whitespace errors.
- Spawned an independent read-only reviewer; it returned Partial and identified missing schema/field/metric contracts.

## Follow-Up Checklist

- [ ] Add Phase 0 executable contract appendix: route-to-permission-to-audit matrix, Partner API schemas, field allowlist/denylist, customerKey anonymization, metric definitions, and route-specific scrub rules.
- [ ] Phase 1: implement additive DB tables for `platform_users`, roles, sessions, login events, and admin audit using `db-migration`.
- [ ] Phase 1: implement server-side Platform authz middleware using `service-api-change`; no route may rely on hidden frontend buttons.
- [ ] Phase 1: add permission tests proving unauthenticated 401 and Partner 403 on every high-risk old endpoint.
- [ ] Phase 2: build Partner-safe shell/navigation and sanitized Partner APIs; verify in browser that Partner cannot see cost, raw audit, sensitive investment fields, or management buttons.
- [ ] Phase 2+: collect real browser evidence, API penetration evidence, admin audit records, migration/rollback evidence, and smoke evidence for WeChat, scheduler, MCP, and user Portal.

## Re-review 2026-07-18

### Verdict

Phase 0 design artifact: **Pass with caveats**.

The design was updated after the independent review. The new Phase 0.5 contract now covers:

- HMAC-based, non-enumerable customerKey generation, secret storage, rotation compatibility, and collision handling.
- Explicit Partner response allowlists for overview, customers, customer operations, quality, and runtime health.
- Field-level stripping for instance summaries, audit traces, rule alerts, source quality, WeChat status, and investment state.
- Metric source, time window, timezone, deduplication key, sample threshold, and missing-data semantics.
- Route-to-permission-to-audit-event mapping and explicit 403 behavior for Partner writes/high-risk reads.
- 22646 listener/reverse-proxy boundary without exposing 22655, ACP, Portal, sandbox, MCP, or scheduler internals.

Remaining caveats:

- The response contract is still a design-level allowlist, not committed JSON Schema with generated validators and typed error envelopes.
- No runtime account/RBAC implementation exists yet; current code still uses loopback auto-session or the global service token.
- No real 401/403 penetration, browser, admin-audit, migration, or rollback evidence exists. These are intentionally deferred to Phase 1+ because Phase 0 explicitly does not change code or deploy.

### Independent Evidence

The independent read-only reviewer rechecked the updated document and changed the Phase 0 document verdict from Partial to Pass with caveats. It independently confirmed that the current implementation remains unmodified and that behavior-level acceptance is still future work.

## Phase 1 Implementation Review 2026-07-18

### Verdict

Status: Partial overall; Auth/RBAC, data boundary, and local API/DB evidence pass with caveats.

### Evidence

- npm run smoke:platform-partner-auth passed with no-cookie login, first-login 428, password change, Partner overview/quality/runtime-health/operations, 16 high-risk Partner denials, Owner audit access, allowed/denied audit rows, and post-logout 401.
- npm run smoke:platform-partner-migration passed fresh creation, double-init idempotency, platform_auth_v1, Owner/Partner seed rows, and rollback mode (oldRoute=200, new Partner/login routes 404).
- npm run smoke:security-boundary and npm run smoke:route-uniqueness passed, preserving service-token/legacy-local compatibility and route registration.
- src/routes/platform.ts constructs Partner responses from allowlists, HMAC customer keys, Shanghai natural-day windows, source-quality aggregates, timeout-aware success rates, repeat-confirmation counts and opaque cursor pagination.

### Remaining Acceptance Gaps

- The current /platform page is still the legacy local Owner page; loopback unauthenticated access intentionally creates a legacy session for compatibility. Remote unauthenticated access is rejected, but the Partner browser shell is not implemented.
- The 22646 listener/reverse proxy has not been deployed or browser-tested; runtime remains local 127.0.0.1:22655. No Volcano Cloud changes were made.
- Login success/failure is recorded in platform_login_events; business API authorization/denial is recorded in platform_admin_audit_logs. Unauthenticated requests have no actor and are represented by HTTP 401 rather than an admin audit row.
- The local smoke does not replace a real browser permission-penetration run through the future Partner UI.

### Final Phase 1 Re-review

The independent reviewer rechecked the latest implementation after the metric and rollback fixes. The final split verdict is:

- Auth/RBAC, Partner field boundary, 16-route denial coverage, active/previous HMAC handling, startup collision detection, additive/idempotent migration, and actual rollback requests: **Pass with caveats**.
- Partner aggregate statistics: **Pass with caveats**; Shanghai natural-day windows, timeout/pending exclusion, source-quality status, repeat-confirmation affected customers, and opaque pagination are now implemented. Source-quality alert aggregation remains bounded to the latest 10,000 alerts.
- Full Platform Phase 1: **Partial**, because the Partner browser shell, real browser permission penetration, and public 22646 listener/reverse-proxy evidence are intentionally deferred. The loopback legacy /platform session remains an explicit Owner compatibility exception.

## Phase 2 页面验收 2026-07-18

### 实际浏览器证据

使用 `scripts/platform-partner-browser-fixture.mjs` 启动隔离临时数据库和临时本地 listener `22657`，通过非 loopback 地址访问 `/platform` 完成真实浏览器旅程：

- 未登录 `/platform` 返回 HTTP 401，响应体只显示账号、密码和登录按钮；未加载经营数据。
- Partner 登录成功后，导航仅为“经营总览、客户与助手、产品质量、运行与触达”。
- 经营总览展示客户数、活跃数、初始配置、对话、响应分位数、复盘覆盖、推送送达和异常聚合。
- 客户页仅显示 HMAC 客户标识、配置状态、健康度、通知偏好、对话/推送计数，并可展开运营摘要。
- 质量页和运行页实际加载 Partner 聚合接口；运行页保留 `partial` 数据源状态，没有把缺失数据伪装成正常。
- 浏览器正文未出现“成本统计、日志审计、规则巡检、数据源质量、持仓、成本价、原始对话、创建用户助手、删除实例、测试推送”等敏感或管理入口。
- Partner 页面只调用 `/api/platform/partner/*`；服务端旧高风险 API 的 403 和响应字段脱敏由 `npm run smoke:platform-partner-auth` 独立证明。

### Verdict

- Partner 页面登录壳、角色导航和只读经营视图：**Pass**（真实浏览器证据）。
- 页面级敏感字段/管理入口隔离：**Pass with caveats**（页面证据 + 服务端 403；仍需未来公网入口穿透）。
- 首次改密：**Pass**（页面已提供当前密码/新密码表单；Owner 和 Partner 均先经过改密壳，服务端仍强制 `428` 门槛）。
- `22646` 公网 listener/反代：**未验收**。本次没有启动、修改或部署火山云；本地 runtime 仍为 `127.0.0.1:22655`。

Phase 2 页面实现总体：**Partial**。本地页面和权限边界已落地，公网 `22646` 运行拓扑和真实公网穿透留在明确的部署阶段。
