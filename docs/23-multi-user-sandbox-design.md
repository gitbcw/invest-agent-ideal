# 多用户沙箱机制设计与执行计划

## 背景与意图

当前系统已经从单用户投资助手演进出可复用的平台沙箱能力。当前 Agent 主路径是 workspace-scoped ACP backend + service-owned MCP；sandbox token 与 HTTP 路由保留给非 Agent 适配器、兼容调用和工程诊断。2026-06-30 后默认 backend 是 Codex ACP，Hermes 仅作为兼容/实验 backend。业务数据正在从单用户模型迁移到多用户/多 AI Project 模型，系统已经具备 `users`、`channel_identities`、多张业务表的 `user_id` 字段，以及微信会话到业务用户的自动映射。

但这还不是完整沙箱。真正的沙箱目标不是让 AI “记得传正确 userId”，而是让服务端强制保证：AI 即使幻觉、误调用、伪造参数，也只能影响当前微信用户自己的数据，不能读写其他用户，也不能修改全局运行配置。

## 当前状态评估

### Workspace 文件写权限现状（2026-07-25）

Portal 与 AI 的文件权限必须分开判断：Portal 已通过 `workspace.file.list/get` 收敛为只读工程文件视图，connector 不再 advertise 或处理网页文件删除；但 Codex ACP 当前仍以 `sandbox_mode="workspace-write"`、`approval_policy="never"` 在用户 workspace 中运行。现有 `AGENTS.md`、Skills、具名 MCP、确认和审计能约束标准业务流程，却不能构成文件系统级允许列表。

在不破坏真实 Workspace 已演化 Skills 和现有报告生成路径的前提下，目标迁移如下：

1. 定义服务层文件写能力，只允许用户拥有的 `reports/`、`knowledge/`、`.codex/skills/`、受控 `config/` 和明确的 memory append 目标；禁止 `.env*`、凭据、数据库、日志、缓存、运行状态、`.git`、`.state` 和隐藏回收区。
2. 覆盖 create/update/append/rename/delete 的逐操作 schema、路径校验、symlink/TOCTOU 防护、大小/MIME 上限、scope、checksum、审计和确认规则；删除必须先生成精确草案并在后续用户确认后执行。
3. 迁移模板与逐用户真实 Workspace 的写入工作流，使报告、策略方法和 Skill 演化只走具名服务能力；真实 Workspace 资产仍需逐用户选择和备份，普通发布不得覆盖。
4. 真实工作流全部验收后，才把 Codex ACP 从整个 workspace 可写切到只读/受限模式。迁移完成前，文档和客户输出不得声称 AI 已具备文件级硬白名单。

领域状态与普通 Workspace 内容不应混为一谈。持仓、规则、调度和 onboarding 等由服务持续消费或执行的状态使用领域级 MCP 事务；用户自有的方法、Skill、知识、普通报告和研究脚本不按文件类型拆成大量 MCP，而是在精确草案和后续明确确认后由 Workspace Agent 维护。未来的通用文件写能力只负责统一路径、checksum、备份和审计，不承载每种业务语义。

Portal 扩大只读可见范围不依赖这项迁移，也不能反向授予任何写权限。

### 已具备的隔离能力

- 微信消息进入时会通过 `channel_identities` 映射到内部 `userId`。
- `watchlist`、`portfolio`、`stock_plans`、`daily_plans`、`alert_events`、`alert_signal_states`、`indicator_results`、`codex_acp_traces` 等核心业务表已具备 `user_id`，调度与推送链路的实际运行 scope 已进一步收敛到 `user_id + instance_id`。
- Platform 投资状态摘要、持仓、自选、预案、复盘、巡检等路径已经按 `userId` + `instanceId` 过滤(Dashboard 页面与专属 API 已于 2026-07-16 退役)。
- workspace ACP backend、微信通道和 Platform 之间已经形成了通道概念。

### 尚未具备的沙箱能力

- API 仍然信任请求体、query 或 header 中的裸 `userId`。
- 微信/AI 链路依赖 prompt 约束：“调用 API 必须传 userId=xxx”。这是软约束，不是安全边界。
- Platform/admin 与普通 sandbox token 的认证边界仍需继续收紧；全局微信管理 API 和旧 Dashboard CRUD 已删除，实例级微信管理只存在于 Platform 管理面。
- `pendingAlerts` 是全局数组，不按用户隔离，旧 `/acp/alerts` 轮询路径可能串消息。
- Platform 当前是管理面，可以切换用户；微信用户不应该拥有这种能力(Dashboard 已退役,功能合并到 Platform)。
- 缺少统一审计表记录 AI 发起的确定性写操作。

## 威胁模型

需要防的不是恶意黑客优先，而是以下产品内风险：

1. AI 幻觉错误 `userId`，读写其他用户数据。
2. AI 调用管理接口，改了全局信号、巡检间隔、微信连接状态。
3. AI 根据用户自然语言误删、误改当前用户数据。
4. 多个微信用户共享同一服务时，提醒推送或复盘结果串到别人的会话。
5. 未来 Platform 开给多人后，普通用户通过浏览器参数切换到其他用户。

## 设计原则

1. 身份由服务端决定，不由 AI 决定。
2. API 从可信上下文解析 `userId`，不信任裸 `userId` 参数。
3. 微信用户、Platform 管理员、内部 scheduler、测试端点使用不同权限域。
4. 用户态 API 默认只能访问当前用户资源。
5. 全局配置和连接管理只能由 admin 权限调用。
6. 写操作必须审计；危险操作需要确认或降级为建议。
7. 先补硬隔离漏洞，再做完整 token 沙箱。

## 核心设计

### 1. SandboxContext

新增服务端统一上下文对象：

```ts
type SandboxRole = "admin" | "user" | "system" | "test";
type SandboxChannel = "weixin-mobile" | "scheduler" | "api";

type SandboxPermission =
  | "read:self"
  | "write:self"
  | "review:self"
  | "alert:self"
  | "push:self"
  | "admin:users"
  | "admin:global-settings"
  | "admin:weixin"
  | "admin:debug";

interface SandboxContext {
  userId: string;
  role: SandboxRole;
  channel: SandboxChannel;
  backend?: "codex" | "hermes";
  conversationId?: string;
  externalUserId?: string;
  channelAccountId?: string;
  permissions: SandboxPermission[];
  tokenId?: string;
  expiresAt?: string;
}
```

### 2. Sandbox Token

新增短期 token，用于 AI/微信链路调用本地服务 API。

Token 内容绑定：

- `userId`
- `role=user`
- `channel=weixin-mobile`
- `backend=codex`（Hermes 仅兼容/实验）
- `conversationId`
- `externalUserId`
- `permissions`
- `expiresAt`
- `nonce/jti`

推荐实现：HMAC 签名的 compact token，不需要先上 OAuth。生产密钥从 `INVEST_AGENT_SANDBOX_SECRET` 读取；本地开发若未配置,使用 `data/.sandbox-secret` 作为持久 secret,避免服务进程和评测进程各自生成临时密钥导致验签失败。

请求方式：

```http
Authorization: Bearer <sandboxToken>
```

服务端解析 token 后得到 `SandboxContext`，请求体里的 `userId` 对用户态 API 无效。

### 3. API 分层

#### 用户态 API

当前用户态 HTTP API 使用 `/api/sandbox/*`，保留给受控兼容调用和工程诊断；workspace Agent 不直接发现或调用这些路由，而是使用具名 MCP 工具。

常用能力：

- `GET /api/sandbox/me`
- `GET /api/sandbox/snapshot`（权限 `invest.snapshot.read`）
- `GET /api/sandbox/onboarding/state`
- `POST /api/sandbox/onboarding/confirm-portfolio`
- `POST /api/sandbox/onboarding/confirm-step`
- `POST /api/sandbox/watchlist/add`
- `POST /api/sandbox/watchlist/remove`
- `POST /api/sandbox/plans/set`
- `POST /api/sandbox/plans/remove`
- `POST /api/sandbox/reviews/context`
- `POST /api/sandbox/reviews/save`
- `POST /api/sandbox/reviews/daily`
- `POST /api/sandbox/alerts/check`
- `POST /api/sandbox/alerts/check-and-push`

这些接口统一从 `SandboxContext.userId` 取用户，不接受 `userId` 覆盖。

#### 管理态 API

历史 Dashboard API 已于 2026-07-16 整体退役。当前 Platform 仅保留只读摘要与运维入口;保留的 admin 面端点如下:

- `/api/platform/*`(Platform 管理面)
- `/api/watch-rules*`(领域 HTTP adapter,写操作带 `source.kind=platform_api` 审计)
- `/api/platform/instances/:instanceId/weixin/*`(唯一的管理端微信连接与手动探测入口)
- `/api/sandbox/onboarding/*`、`/api/sandbox/strategies/*` 等非 Agent 兼容适配器
- 测试推送、mock 推送、backend debug test

普通微信 sandbox token 不允许调用管理面端点。

#### 系统态 API/函数

scheduler 不走 HTTP token，可直接创建 `SandboxContext{role:"system"}` 或直接调用 handler，但必须显式传 `userId + instanceId`。scheduler 的 scope 枚举来自 `users`、`ai_instances`、`channel_identity_instances` 和启用中的 stage2 watch_rules(`alert_rules`);legacy `alerts` 表已于 2026-07-16 DROP(详见 `docs/table-ownership.md` 与 `drop_legacy_alerts_table_v1` 迁移记录)。

### 4. Agent 调用方式

- workspace Agent 只使用 `invest-agent-service-tools` 的具名 MCP 工具。
- workspace prompt 和 skill 不包含 HTTP 路由、curl、端口、token 或本地文件兜底说明。
- MCP 工具从可信会话上下文取得用户和实例 scope，Agent 不传裸 `userId`。
- 能力缺失时明确报告缺口，不发现隐藏接口或绕过服务层。
- 微信客户回复仍不得暴露工具名或内部组件。

### 5. 写操作审计

新增表 `sandbox_audit_logs`：

- `id`
- `user_id`
- `role`
- `channel`
- `backend`
- `conversation_id`
- `operation`
- `resource_type`
- `resource_id`
- `request_body`
- `result_summary`
- `status`
- `created_at`

所有 sandbox 写操作必须记录审计。

### 6. 确认机制

首版规则：

- 添加自选、创建/更新预案：如果用户明确表达“添加/设置/改成”，可直接执行。
- 删除自选、删除预案、关闭提醒：需要服务端生成 pending confirmation；用户在后续消息明确确认后，必须用同一 `userId + conversationId + operation + resource` 的 `confirmationId` 执行。
- 全局配置、用户管理、微信连接管理：微信用户不可执行。

确认状态由 `pending_sandbox_confirmations` 承载。旧的裸 `confirm=true` 不应被用户态 sandbox API 接受。

## 当前必须优先修补的漏洞

### A. 已退役的旧 HTTP 漏洞面

旧 `/api/alerts/set|toggle|remove`、legacy `alerts` 表和 `/api/reviews/query` 已随 Dashboard 清理删除，不再作为待修的多用户入口。当前规则写入使用 `watch_rules.*` MCP 确认流程或受管理端保护的 `/api/watch-rules*` adapter；复盘产物由 MCP `reviews.save` 保存。

### C. `pendingAlerts` 全局队列

如果仍保留 `/acp/alerts`，应改为按 user/channel 维度，或标记为 legacy 主线专用，不给任何多用户后端路径使用。

### D. Agent 能力面已收敛为 MCP-only

workspace prompt 和 skills 不再包含 HTTP、端口、token 或 curl。`invest-agent-service-tools` 从可信 session context 取得 scope；缺失能力必须显式报告，不能绕过服务层。

## 执行计划

### 当前进度

- Phase 0 的旧 alerts/reviews HTTP 漏洞面已通过端点退役和 legacy 表删除彻底关闭。
- Phase 1 已完成 token 基础工具：`SandboxContext`、HMAC sandbox token 生成/验证、过期/篡改 smoke 测试已落地。本地开发使用 `data/.sandbox-secret` 兜底持久化,生产应设置 `INVEST_AGENT_SANDBOX_SECRET`。
- Phase 2 已完成首批用户态 HTTP API：`/api/sandbox/me`、`/api/sandbox/snapshot`、onboarding、策略、自选、预案、复盘、巡检接口已接入 Bearer token，并验证请求体伪造 `userId` 不生效。
- workspace prompt 和 skills 已收敛为 MCP-only，不再暴露 Bearer token、HTTP 路由或裸 `userId`。
- Phase 4 已完成会话级 pending confirmation 第一版：sandbox 写操作已记录到 `sandbox_audit_logs`，删除自选/删除预案需要 `pending_sandbox_confirmations.confirmationId`，未确认/错误确认操作会记录 denied 审计。
- 尚未完成:Platform/admin token 分离、批量/关闭类操作统一接入 confirmation(Dashboard 已退役,管理面入口是 Platform)。

### Phase 0：硬隔离补洞

目标：在 token 沙箱完成前，先消除已知跨用户写入漏洞。

任务：

1. 退役 `/api/alerts/set|toggle|remove` 和 legacy `alerts` 表。（已完成）
2. 退役旧 `/api/reviews/query` 与其他 Dashboard 聚合端点。（已完成）
3. 保证当前 `alert_rules`、复盘产物和所有 MCP 写入按 `userId + instanceId` 隔离。
4. 将 Platform 管理面与普通 sandbox token 的认证边界继续收紧。

验收：

- A 用户不能 toggle/remove B 用户 alert id。
- A/B 同股票同指标提醒规则互不覆盖。
- A/B 复盘查询只返回自己的记录。
- `npm run build` 通过。

### Phase 1：SandboxContext 与 token 基础设施

目标：服务端生成并验证 sandbox token，提供统一身份上下文。

任务：

1. 新增 `src/lib/sandbox-context.ts`。
2. 实现 `createSandboxToken(context)`、`verifySandboxToken(token)`。
3. 新增 `sandboxContextFromRequest(request, mode)`：
   - user mode 必须有 Bearer token。
   - admin mode 暂时可允许 localhost + Platform session cookie,后续再加强。
   - system mode 由内部调用构造。
4. token 过期时间建议 30-120 分钟；微信每轮消息可生成一个新 token。
5. token 不写入客户回复，不进入 sanitized reply；trace 可只记录 tokenId，不记录完整 token。

验收：

- 无 token 调用户态 sandbox API 返回 401。
- 篡改 token 返回 401。
- 过期 token 返回 401。
- token 中 userId=A，请求体传 userId=B，实际仍操作 A。

### Phase 2：用户态 sandbox API

目标：给 AI/微信提供一组不能越权的确定性 API。

任务：

1. 新增 `src/routes/sandbox.ts`。
2. 实现首批 `/api/sandbox/*` 用户态接口。
3. 这些接口全部从 `SandboxContext.userId` 取用户。
4. 写操作记录 `sandbox_audit_logs`。
5. Dashboard 原有 API 已于 2026-07-16 退役;当前管理面入口是 Platform,且不给 AI skill 使用。

验收：

- 微信链路调用 sandbox API 不需要也不能指定 `userId`。
- A token 操作不会影响 B 数据。
- 所有 sandbox 写操作有审计记录。

### Phase 3：微信/AI 链路切换到 MCP

目标：Agent 不再靠 prompt 自觉传 userId，也不直接持有 HTTP token。

任务：

1. 在 ACP session 中挂载 `invest-agent-service-tools`。
2. workspace prompts 和 skills 只引用具名 MCP 工具。
3. MCP 从可信 session context 获取 `userId + instanceId + conversationId`。
4. HTTP token 留在非 Agent 适配器内部，不进入 workspace context。
5. trace 和 audit 记录 scope 与 operation，不记录凭据。

验收：

- Agent 工具调用样例不包含 `userId`、HTTP 路由或 token。
- 即使 Agent 在 payload 中幻觉 scope，服务工具仍使用可信 MCP context。
- 复盘、自选、预案、巡检在微信链路正常工作。

### Phase 4：权限分级与危险操作确认

目标：减少当前用户沙箱内的误操作。

任务：

1. 定义权限矩阵：read/write/review/alert/push/admin。
2. 删除类、关闭类、批量类操作加入确认机制。
3. 新增 `pending_sandbox_confirmations` 或等效内存/DB 表。
4. 用户确认时必须匹配同一 `userId + conversationId + operation + resource`。

验收：

- 用户一句“清空自选”不会立即执行。
- 用户确认后只影响当前用户。
- 过期确认不可执行。

### Phase 5：管理面安全边界

目标：Platform 管理能力和普通微信用户能力彻底分离。

任务：

1. Platform API 标记 admin-only。
2. 增加 admin session 或本机管理 token。
3. 用户列表、信号配置、巡检间隔、微信连接管理都要求 admin context。
4. Platform 切用户只在 admin context 可用。

验收：

- 普通 sandbox token 访问 admin API 返回 403。
- Platform 管理面仍可切实例调试。
- 微信用户无法创建测试用户或改全局信号。

## 建议优先级

最高优先级：Phase 0 + Phase 1 + Phase 2 的只读/常用写接口。

原因：这三步完成后，AI 幻觉 `userId` 的风险基本被服务端挡住。后面的确认机制和 admin 安全属于把产品从“可控内测”推向“多人长期使用”。

## 风险与缓解

- 风险：token 泄漏到客户回复。
  - 缓解：customer sanitizer 增加 token 模式清洗；trace 只存 token id。

- 风险：HTTP 与 MCP 适配器并存导致业务逻辑漂移。
  - 缓解：workspace skill 只暴露 MCP；两个适配器共用服务层函数，HTTP 标注为非 Agent 入口。

- 风险：scheduler 和微信推送仍有全局遗留队列。
  - 缓解：scheduler 内部直接按 `userId + instanceId` 调 handler；废弃或 user-scope `/acp/alerts`。

- 风险：多用户共享全局信号配置是否合理。
  - 缓解：短期全局信号只允许 admin 修改；长期可增加 user-level override。

## 非目标

- 不在第一阶段做完整公网登录认证。
- 不在第一阶段开放普通用户 Platform 登录。
- 不在第一阶段重构全部旧 API。
- 不让 AI 直接访问 SQLite 或绕过服务。

## 开放问题

1. Platform 后续是纯管理员工具，还是普通用户也会登录？这会影响 admin token 设计。
2. 多用户是否需要各自独立的信号配置和巡检间隔？短期建议全局 admin-only。
3. sandbox token 有效期采用每轮消息生成，还是一次微信会话保持？建议先每轮生成，简单安全。
4. 删除类操作是否全部需要二次确认？建议先是。

## Executor Prompt

请按 `docs/23-multi-user-sandbox-design.md` 执行实现。先做 Phase 0 和 Phase 1，不要扩大到完整 Platform 登录系统。所有用户态读写必须由服务端上下文决定 userId，不得信任请求体、query 或 header 中的裸 userId。实现后运行 `npm run build`，并用两个测试用户验证同一股票/提醒/复盘不会串数据。

## Reviewer Prompt

请按 `docs/23-multi-user-sandbox-design.md` 做验收审查。重点检查：是否仍有用户态 API 信任裸 userId；alert rule CRUD 是否跨用户；sandbox token 是否可伪造或被请求体覆盖；微信/AI skill 是否仍指导 AI 传 userId；写操作是否有审计或明确的后续任务。
