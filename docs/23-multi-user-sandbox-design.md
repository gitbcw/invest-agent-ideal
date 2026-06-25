# 多用户沙箱机制设计与执行计划

## 背景与意图

当前系统已经从单用户投资助手演进出可复用的平台沙箱能力。早期 Hermes 旁路验证了微信后端链路、可靠推送和 trace 能力；当前主路径应理解为 Codex ACP + sandbox token。业务数据正在从单用户模型迁移到多用户/多 AI Project 模型，系统已经具备 `users`、`channel_identities`、多张业务表的 `user_id` 字段，以及微信会话到业务用户的自动映射。

但这还不是完整沙箱。真正的沙箱目标不是让 AI “记得传正确 userId”，而是让服务端强制保证：AI 即使幻觉、误调用、伪造参数，也只能影响当前微信用户自己的数据，不能读写其他用户，也不能修改全局运行配置。

## 当前状态评估

### 已具备的隔离能力

- 微信消息进入时会通过 `channel_identities` 映射到内部 `userId`。
- `watchlist`、`portfolio`、`stock_plans`、`daily_plans`、`alert_events`、`alert_signal_states`、`indicator_results`、`codex_acp_traces` 等核心业务表已具备 `user_id`。
- Dashboard 聚合查询、持仓、自选、预案、复盘、巡检等路径已经部分按 `userId` 过滤。
- Codex ACP、微信通道和 Dashboard/Workbench 之间已经形成了通道概念。

### 尚未具备的沙箱能力

- API 仍然信任请求体、query 或 header 中的裸 `userId`。
- 微信/AI 链路依赖 prompt 约束：“调用 API 必须传 userId=xxx”。这是软约束，不是安全边界。
- 部分 API 仍然是全局能力，或者用户隔离未完成：提醒规则 CRUD、信号配置、巡检间隔、用户列表、微信连接管理、测试推送等。
- `pendingAlerts` 是全局数组，不按用户隔离，旧 `/acp/alerts` 轮询路径可能串消息。
- Dashboard 当前是管理面，可以切换用户；微信用户不应该拥有这种能力。
- 缺少统一审计表记录 AI 发起的确定性写操作。

## 威胁模型

需要防的不是恶意黑客优先，而是以下产品内风险：

1. AI 幻觉错误 `userId`，读写其他用户数据。
2. AI 调用管理接口，改了全局信号、巡检间隔、微信连接状态。
3. AI 根据用户自然语言误删、误改当前用户数据。
4. 多个微信用户共享同一服务时，提醒推送或复盘结果串到别人的会话。
5. 未来 Dashboard 开给多人后，普通用户通过浏览器参数切换到其他用户。

## 设计原则

1. 身份由服务端决定，不由 AI 决定。
2. API 从可信上下文解析 `userId`，不信任裸 `userId` 参数。
3. 微信用户、Dashboard 管理员、内部 scheduler、测试端点使用不同权限域。
4. 用户态 API 默认只能访问当前用户资源。
5. 全局配置和连接管理只能由 admin 权限调用。
6. 写操作必须审计；危险操作需要确认或降级为建议。
7. 先补硬隔离漏洞，再做完整 token 沙箱。

## 核心设计

### 1. SandboxContext

新增服务端统一上下文对象：

```ts
type SandboxRole = "admin" | "user" | "system" | "test";
type SandboxChannel = "dashboard" | "weixin-mobile" | "scheduler" | "api";

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
  backend?: "codex";
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
- `backend=codex`
- `conversationId`
- `externalUserId`
- `permissions`
- `expiresAt`
- `nonce/jti`

推荐实现：HMAC 签名的 compact token，不需要先上 OAuth。密钥从环境变量读取，例如 `INVEST_AGENT_SANDBOX_SECRET`，没有则启动时生成临时密钥并记录 warning。

请求方式：

```http
Authorization: Bearer <sandboxToken>
```

服务端解析 token 后得到 `SandboxContext`，请求体里的 `userId` 对用户态 API 无效。

### 3. API 分层

#### 用户态 API

建议新增 `/api/sandbox/*` 或 `/api/user/*`，专供微信/AI 调用。

首批能力：

- `GET /api/sandbox/dashboard`
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

现有 Dashboard API 暂时保留，但应归类为 admin 面：

- `/api/users*`
- `/api/signals/update`
- `/api/interval/set`
- `/api/weixin/*`
- `/api/indicators*`
- 测试推送、mock 推送、backend debug test

这些后续需要 admin token 或至少只绑定 localhost 管理面。普通微信 sandbox token 不允许调用。

#### 系统态 API/函数

scheduler 不走 HTTP token，可直接创建 `SandboxContext{role:"system"}` 或直接调用 handler，但必须显式传 `userId`。scheduler 的用户枚举来自 `users/channel_identities`，不是 AI 输入。

### 4. AI 调用方式调整

当前 prompt 说“调用 API 时必须传 userId”。应改为：

- 服务端在构造移动端 prompt 时提供 `sandboxToken`，而不是要求 AI 传 `userId`。
- skill 文档中的 curl 示例改为使用 `Authorization: Bearer $INVEST_AGENT_SANDBOX_TOKEN`。
- 微信客户回复仍不得暴露 token、API、端口、内部组件。

Prompt 里不再鼓励 AI 自己拼 `userId`。

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

### A. 提醒规则 CRUD 未完整 user-scoped

当前 `/api/alerts/set`、`toggle`、`remove` 未通过 `userIdFromRequest` 限定查询和更新，存在跨用户污染风险。

必须改为：

- `set` 按 `userId + stockCode + indicator` 查找/写入。
- `toggle/remove` 必须先按 `id + userId` 查找，不能只按 `id`。
- mirrored `alert_rules` 同步函数必须接受 `userId`。

### B. `/api/reviews/query` 仍走旧 review tool

应支持 `userId`，并按 `reviews/<userId>/<date>.md` 或 `daily_plans.user_id` 查询。

### C. `pendingAlerts` 全局队列

如果仍保留 `/acp/alerts`，应改为按 user/channel 维度，或标记为 legacy 主线专用，不给任何多用户后端路径使用。

### D. AI 服务工具 skill 仍默认 22648 且不使用 token

应更新 `.codex/skills/invest-agent-service-tools/SKILL.md`：

- 微信/ACP 场景使用 sandbox token。
- 不传 `userId`。
- 后端服务优先读环境或上下文，不写死单一路径或端口。

## 执行计划

### 当前进度

- Phase 0 已完成第一轮硬隔离补洞：提醒规则 CRUD 和 mirrored `alert_rules` 已按 `userId` 隔离，复盘查询已支持用户目录。
- Phase 1 已完成 token 基础工具：`SandboxContext`、HMAC sandbox token 生成/验证、过期/篡改 smoke 测试已落地。
- Phase 2 已完成首批用户态 HTTP API：`/api/sandbox/me`、dashboard、自选、预案、复盘、巡检接口已接入 Bearer token，并验证请求体伪造 `userId` 不生效。
- 微信/backend prompt 和 service skill 已开始切换到 Bearer token 方式，不再要求 AI 传裸 `userId`。
- Phase 4 已完成会话级 pending confirmation 第一版：sandbox 写操作已记录到 `sandbox_audit_logs`，删除自选/删除预案需要 `pending_sandbox_confirmations.confirmationId`，未确认/错误确认操作会记录 denied 审计。
- 尚未完成：alert rule mutation sandbox endpoint、Dashboard/admin token 分离、批量/关闭类操作统一接入 confirmation。

### Phase 0：硬隔离补洞

目标：在 token 沙箱完成前，先消除已知跨用户写入漏洞。

任务：

1. 修复 `/api/alerts/set|toggle|remove` 的 user scope。
2. 修复 alert rule mirror 函数签名，所有 mirrored alert rule 写入必须带 `userId`。
3. 修复 `/api/reviews/query` 用户隔离。
4. 标记或限制 `/api/users`、`/api/signals/update`、`/api/interval/set` 为 admin-only 计划项；短期至少不要在微信 skill 中暴露。
5. 增加针对 A/B 用户的回归测试脚本或 smoke：同一股票同一指标在不同用户下互不影响。

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
   - admin mode 暂时可允许 localhost + Dashboard header，后续再加强。
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
5. Dashboard 原有 API 暂时保留为 admin 面，不给 AI skill 使用。

验收：

- 微信链路调用 sandbox API 不需要也不能指定 `userId`。
- A token 操作不会影响 B 数据。
- 所有 sandbox 写操作有审计记录。

### Phase 3：微信/AI 链路切换到 token

目标：AI 不再靠 prompt 自觉传 userId。

任务：

1. 在 `buildMobilePrompt` 中加入 sandbox token 的内部执行说明。
2. 修改 `.codex/skills/invest-agent-service-tools/SKILL.md`，所有微信/ACP 示例使用 Bearer token。
3. 从 prompt 中删除“调用 API 必须传 userId=xxx”的表述，改为“使用提供的 sandbox token；不要传 userId”。
4. Codex ACP 链路生成对应 token。
5. trace 记录 sandbox token id、userId、permissions。

验收：

- AI 工具调用样例不再包含 `userId`。
- 即使 AI 在 body 中幻觉 `userId=primary`，sandbox API 仍使用 token 用户。
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

目标：Dashboard 管理能力和普通微信用户能力彻底分离。

任务：

1. Dashboard API 标记 admin-only。
2. 增加 admin session 或本机管理 token。
3. 用户列表、信号配置、巡检间隔、微信连接管理都要求 admin context。
4. Dashboard 切用户只在 admin context 可用。

验收：

- 普通 sandbox token 访问 admin API 返回 403。
- Dashboard 管理面仍可切用户调试。
- 微信用户无法创建测试用户或改全局信号。

## 建议优先级

最高优先级：Phase 0 + Phase 1 + Phase 2 的只读/常用写接口。

原因：这三步完成后，AI 幻觉 `userId` 的风险基本被服务端挡住。后面的确认机制和 admin 安全属于把产品从“可控内测”推向“多人长期使用”。

## 风险与缓解

- 风险：token 泄漏到客户回复。
  - 缓解：customer sanitizer 增加 token 模式清洗；trace 只存 token id。

- 风险：旧 Dashboard API 与新 sandbox API 并存导致混用。
  - 缓解：skill 文档只暴露 sandbox API；旧 API 标注 admin-only。

- 风险：scheduler 和微信推送仍有全局遗留队列。
  - 缓解：scheduler 内部直接按 userId 调 handler；废弃或 user-scope `/acp/alerts`。

- 风险：多用户共享全局信号配置是否合理。
  - 缓解：短期全局信号只允许 admin 修改；长期可增加 user-level override。

## 非目标

- 不在第一阶段做完整公网登录认证。
- 不在第一阶段开放普通用户 Dashboard 登录。
- 不在第一阶段重构全部旧 API。
- 不让 AI 直接访问 SQLite 或绕过服务。

## 开放问题

1. Dashboard 后续是纯管理员工具，还是普通用户也会登录？这会影响 admin token 设计。
2. 多用户是否需要各自独立的信号配置和巡检间隔？短期建议全局 admin-only。
3. sandbox token 有效期采用每轮消息生成，还是一次微信会话保持？建议先每轮生成，简单安全。
4. 删除类操作是否全部需要二次确认？建议先是。

## Executor Prompt

请按 `docs/23-multi-user-sandbox-design.md` 执行实现。先做 Phase 0 和 Phase 1，不要扩大到完整 Dashboard 登录系统。所有用户态读写必须由服务端上下文决定 userId，不得信任请求体、query 或 header 中的裸 userId。实现后运行 `npm run build`，并用两个测试用户验证同一股票/提醒/复盘不会串数据。

## Reviewer Prompt

请按 `docs/23-multi-user-sandbox-design.md` 做验收审查。重点检查：是否仍有用户态 API 信任裸 userId；alert rule CRUD 是否跨用户；sandbox token 是否可伪造或被请求体覆盖；微信/AI skill 是否仍指导 AI 传 userId；写操作是否有审计或明确的后续任务。
