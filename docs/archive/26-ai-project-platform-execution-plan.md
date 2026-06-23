# 多 AI 项目运行平台执行计划

## 背景

当前系统从投资助手 Experimental MVP 演进出了 Codex ACP 主链路、Hermes 可选后端链路、sandbox token、push queue、audit、trace、多用户/实例隔离等平台能力。新的共识是：长期目标不是“投资助手多用户化”，而是建设一个 **多 AI 项目运行平台**。

投资助手继续作为第一个 project type 和验证样板存在，但平台要能承载更多 AI 项目，例如饮食管理、会议纪要、个人知识库、客服等。

本计划用于把 [24-ai-instance-platform-architecture.md](./24-ai-instance-platform-architecture.md) 和 [25-ai-project-registry-and-manifest.md](./25-ai-project-registry-and-manifest.md) 转成后续可执行路线。

## 总目标

建立一个微信优先、可扩展、可审计、可隔离的 AI 项目运行平台。

最终形态：

```text
Channel Connector
  -> Platform Service
  -> AI Project Router
  -> Sandbox Context
  -> Agent Backend
  -> Project Skill Bundle
  -> Authorized Tools
  -> Project-scoped Resources
  -> Push / Reply
```

## 核心原则

1. AI 项目是产品层面的隔离单位。
2. 当前 `instance_id` 短期继续作为具体 AI Project 的工程隔离字段。
3. 投资助手是第一个 project type，不是平台本身。
4. Skills 定义项目的思考方式和工作流。
5. Tools 是确定性能力，由平台或项目工具服务提供。
6. AI 不可信任身份参数；项目 scope 必须由服务端路由或 sandbox token 决定。
7. 当前投资闭环不能被平台化改造打断。

## 非目标

短期不做：

- 不拆多个仓库。
- 不做完整插件系统。
- 不把所有投资业务表立刻改名为通用资源表。
- 不把 Dashboard 一次性重做成完整平台后台。
- 不支持任意第三方项目动态安装。
- 不开放远程公网多租户后台。

## 当前状态

已经具备：

- Codex ACP 主链路与 Hermes 可选后端链路。
- 项目微信绑定页。
- `ai_projects / ai_instances / channel_identity_instances` 雏形。
- sandbox token 带 `projectId / instanceId / userId / permissions`。
- sandbox audit。
- pending confirmation。
- push_jobs 可靠推送队列。
- ACP trace 脱敏。
- 投资业务核心表已按 `user_id + instance_id` 隔离。
- Dashboard 和 sandbox 主要读写路径已按实例隔离。
- 投资助手 project dashboard 已可用。

主要缺口：

- 当前 registry 命名与目标语义不一致。
- 还没有 Project Type Manifest 常量。
- 还没有统一 Project Registry helper。
- Dashboard 还不是平台后台。
- Tool registry / tool permission 还没有抽象。
- 部分旧 handler 仍偏 `userId` 思维。
- 投资业务资源尚未显式携带长期 `project_id`。

## 执行路线

### Phase 0：文档语义冻结

状态：已完成。

交付物：

- [24-ai-instance-platform-architecture.md](./24-ai-instance-platform-architecture.md)
- [25-ai-project-registry-and-manifest.md](./25-ai-project-registry-and-manifest.md)

验收：

- 文档明确 AI 项目是长期产品隔离单位。
- 文档明确 `instance_id` 是当前工程兼容字段。
- 文档明确 skills / tools / platform / project dashboard 的边界。

### Phase 1：Project Type Manifest 常量

目标：让投资助手从“写死在各处的业务”变成第一个明确 project type。

任务：

1. 新增 `src/platform/project-types.ts`。
2. 定义 `ProjectTypeManifest` 类型。
3. 定义 `invest-agent` manifest。
4. Manifest 至少包含：
   - `id`
   - `displayName`
   - `defaultSkillBundleId`
   - `defaultHermesProfile`
   - `dashboardType`
   - `allowedTools`
   - `defaultPermissions`
   - `resourceTypes`
5. Dashboard API 返回当前 project type manifest 摘要。
6. sandbox token 创建上下文时可以读取 skill bundle / permission 默认值。

建议文件：

- `src/platform/project-types.ts`
- `src/lib/sandbox-context.ts`
- `src/routes/dashboard.ts`

验收：

- `npm run build` 通过。
- `/api/dashboard` 返回当前实例对应的 project type 摘要。
- 当前投资 Dashboard 行为不变。
- 现有 sandbox token 仍兼容。

### Phase 2：Project Registry Helper

目标：把散落的 `DEFAULT_PROJECT_ID / DEFAULT_INSTANCE_ID / ai_instances` 访问收束到统一项目上下文。

任务：

1. 新增 `src/platform/project-registry.ts`。
2. 定义 `AiProjectRuntimeContext`。
3. 从当前 `ai_instances.id` 构造长期语义的 `projectId`。
4. 从当前 `ai_instances.project_id` 解释 `projectType`。
5. 合并 Project Type Manifest 默认值和实例自身配置。
6. 提供：
   - `getProjectRuntimeContext(projectIdOrInstanceId)`
   - `ensureDefaultProjectForUser(userId, backend)`
   - `listProjectRuntimeContexts()`
7. 逐步让 Dashboard / sandbox / ACP prompt 使用该 helper。

建议文件：

- `src/platform/project-registry.ts`
- `src/lib/user-identity.ts`
- `src/acp/agent.ts`
- `src/routes/dashboard.ts`
- `src/routes/sandbox.ts`

验收：

- 不再在新代码中手动拼 `invest-agent-${userId}`。
- Dashboard 当前实例信息来自 `AiProjectRuntimeContext`。
- sandbox context 能带出 `projectType`、`skillBundleId`、`permissions`。
- 旧数据仍可正常读取。

### Phase 3：平台项目列表 API

目标：提供最小平台后台数据源，先不重做 UI。

任务：

1. 新增 `/api/platform/projects`。
2. 新增 `/api/platform/projects/:projectId`。
3. 返回所有具体 AI Project 的运行摘要：
   - projectId
   - projectType
   - owner
   - backend
   - skillBundleId
   - status
   - channel bindings
   - recent trace count
   - push queue summary
   - audit summary
4. 明确这些接口是 admin/platform scope，暂时只作为 localhost 管理能力。

建议文件：

- `src/routes/platform.ts`
- `src/server.ts`
- `src/platform/project-registry.ts`

验收：

- `GET /api/platform/projects` 能看到主投资项目、微信用户项目、测试项目。
- 不返回投资持仓/自选等业务明细。
- 不影响 `/dashboard`。

### Phase 4：Platform Dashboard 雏形

目标：把“平台后台”和“投资助手看板”分开。

任务：

1. 新增 `/platform` 页面。
2. 展示 AI 项目列表。
3. 每个项目展示：
   - 名称 / 类型 / owner
   - backend
   - channel 绑定
   - 最近错误
   - push queue 状态
   - audit 入口
4. 提供跳转到对应 Project Dashboard 的入口。
5. 当前 `/dashboard` 保持投资助手业务看板。

建议文件：

- `src/admin/platform-page.ts`
- `src/routes/platform.ts`
- `src/server.ts`

验收：

- 浏览器打开 `/platform` 能看到所有 AI 项目。
- 平台页不展示投资业务细节。
- 投资 Dashboard 仍正常。

### Phase 5：Tool Registry 与权限收束

目标：把“AI 能调用哪些 API”从 prompt 约束升级为服务端权限模型。

任务：

1. 新增 `src/platform/tool-registry.ts`。
2. 定义 tool id 命名规范：
   - `invest.watchlist.read`
   - `invest.watchlist.write`
   - `invest.plan.write`
   - `invest.alert.check`
   - `push.weixin.send`
3. Project Type Manifest 引用 tool ids。
4. sandbox route 将权限检查从粗粒度 `read:self/write:self` 逐步补充 tool-level 检查。
5. 危险操作仍走 pending confirmation。

验收：

- 未授权 project type 不能调用投资工具。
- sandbox token 缺少权限时返回 403。
- 删除/关闭类操作仍需要 confirmation。

### Phase 6：旧 Handler Project Scope 收敛

目标：清理仍只按 `userId` 工作的传统 handler。

任务：

1. 梳理所有 handler：
   - watchlist
   - portfolio
   - plan
   - alert
   - alert-rules
   - review
   - scheduler
2. 为仍缺失的函数补 `projectId/instanceId` 可选参数。
3. 新调用路径统一传 `AiProjectRuntimeContext`。
4. 老调用路径默认落到主项目，保持兼容。

验收：

- `rg "eq\\(.*userId"` 检查后，业务数据查询都有 project/instance scope 或明确注释说明是全局。
- 主项目和测试项目互不串数据。
- `npm run build` 通过。

### Phase 7：历史数据归位

目标：处理旧测试数据默认落入主实例的问题。

任务：

1. 查询所有带 `user_id + instance_id` 的表。
2. 对非 `primary` 但 `instance_id=invest-agent-primary` 的行做归位计划。
3. 按 `defaultInstanceIdForUser(userId)` 回填。
4. 仅迁移明确属于测试/用户自身的数据。
5. 迁移前备份数据库。

验收：

- 非 primary 用户数据不再落在 `invest-agent-primary`。
- primary 数据保持不动。
- Dashboard A/B 测试用户仍隔离。

### Phase 8：Project ID 字段收敛

目标：从工程兼容的 `instance_id` 逐步收敛到长期语义的 `project_id`。

建议短期不做，等 Phase 1-7 稳定后再评估。

可选方案：

- 保守方案：继续保留 `instance_id`，只通过 helper 映射语义。
- 中期方案：业务表新增 `project_id`，从 `instance_id` 回填，再逐步迁移查询。
- 长期方案：新增真正 `project_types / ai_projects / channel_project_bindings`，旧表迁移归档。

验收：

- 不破坏现有投资助手。
- 所有新平台 API 使用长期 `projectId` 语义。

## 推荐近期顺序

近期建议按下面顺序走：

1. Phase 1：Project Type Manifest 常量。
2. Phase 2：Project Registry Helper。
3. Phase 3：平台项目列表 API。
4. Phase 6：旧 handler project scope 收敛。
5. Phase 7：历史数据归位。
6. Phase 4：Platform Dashboard 雏形。
7. Phase 5：Tool Registry 与权限收束。

原因：

- 先有 manifest 和 registry，后续所有代码才有统一项目上下文。
- 先有平台项目 API，再做平台 UI。
- handler scope 和历史数据归位是隔离可靠性的基础。
- tool registry 可以在 sandbox 路径稳定后逐步加严。

## 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 命名重构过早 | 破坏当前 Codex ACP 主链路、Hermes 可选后端链路和投资闭环 | 短期保留现有表名，通过 helper 统一语义 |
| 平台化范围膨胀 | 投资助手核心体验停滞 | 每期只做一个平台地基，不同时重做业务 |
| `project_id` 与 `instance_id` 混用 | 后续代码难维护 | 新代码只通过 `AiProjectRuntimeContext` 取 scope |
| 权限过松 | AI 项目可误调用其他项目工具 | Phase 5 引入 tool registry 和 token 权限校验 |
| 历史数据误迁移 | 主用户数据受影响 | 迁移前备份，只迁移非 primary 且可归属数据 |

## 验收总标准

阶段性完成后，应满足：

1. 平台能列出所有 AI 项目。
2. 每个 AI 项目能明确知道自己的 project type、skill bundle、backend、owner。
3. sandbox token 能携带并校验项目 scope。
4. 投资助手项目数据不与其他项目串。
5. 当前投资 Dashboard 和项目微信连接继续可用。
6. 新项目类型可以通过 manifest 描述其 skills、tools 和资源类型。

## Executor Prompt

按本文档执行下一阶段时，请优先从 Phase 1 开始。不要重命名现有数据库表，不要拆仓库，不要重做 Dashboard。先新增 Project Type Manifest 常量，并让现有 Dashboard/sandbox 能读取统一项目类型信息。每完成一个 phase，都运行 `npm run build`，并用当前本地服务做最小 API smoke test；涉及 backend adapter 的变更再补跑 Hermes 专项 smoke。

## Reviewer Prompt

审查执行结果时，请对照本文档的阶段验收标准。重点检查是否破坏 Codex ACP 主链路、是否误伤 Hermes 可选后端链路、是否让投资业务数据跨项目串读写、是否引入了新的裸 `userId` 身份信任路径。
