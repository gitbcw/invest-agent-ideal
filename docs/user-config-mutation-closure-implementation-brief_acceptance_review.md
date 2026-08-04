# 用户配置变更闭环补全验收报告

验收日期：2026-08-04

验收依据：`docs/user-config-mutation-closure-implementation-brief.md`

## Acceptance Verdict

Status: Pass with caveats

核心闭环已完成：普通会话可见的 `method_changes.apply` 和 `preferences.apply` 已注册，确认 payload、后续用户确认、revision 校验、策略/偏好写入、回读、审计、change log 和 artifact 均有实现及测试证据。跨存储后置步骤现在以确认 ID 幂等，失败后保留主状态和 pending confirmation，重试可补齐剩余步骤；必需 artifact 发布失败会明确报错，不会返回成功。配置审计矩阵已覆盖任务书列出的资源。交易策略实体、盯盘规则更新/删除和投资模型运行时写入仍是明确的后续产品决策，不属于本次完成范围。

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 工具可见性 | 普通 Portal/微信会话可获得新增领域工具 | Pass | `src/mcp/invest-agent-service-tools.ts`、`src/mcp/service-tool-classification.ts`、`tests/service-tool-grant.test.ts` | `method_changes.apply`、`preferences.apply` 已注册并纳入交互会话授权。 |
| 策略采用 | 候选经第二次确认后正式写入策略并回读 | Pass | `src/mcp/service-tools-core.ts`、`tests/method-change-apply.test.ts` | 正常路径覆盖候选状态、revision、payload 篡改、后续用户确认、回读和重复调用拒绝。 |
| Scope 隔离 | 方法候选按 userId + instanceId 隔离 | Pass | `src/lib/method-change-backend.ts`、`tests/method-change-apply.test.ts` | `get/list` 已增加实例过滤，并保留 maxAgeDays 过滤。 |
| 偏好修改 | onboarding 后可修改复盘、盘中简报和通知偏好 | Pass | `src/services/user-preferences.ts`、`src/mcp/service-tools-core.ts`、`tests/preferences-apply.test.ts` | 正常路径支持语义化 patch、revision、回读和多文件 artifact。 |
| 确认绑定 | confirmation 绑定实际语义 payload 且不可复用 | Pass | `src/mcp/service-tools-core.ts`、聚焦测试 | `summary`/`decisionNote` 被作为非语义元数据剥离，候选、patch 和 revision 保持绑定。 |
| 失败补偿 | 跨 YAML、候选、确认单、日志和审计失败时可恢复 | Pass | `src/mcp/service-tools-core.ts`、`src/lib/workspace-store.ts`、新增故障注入测试 | 主状态携带 confirmation ID；后置步骤失败保留 pending confirmation，重试跳过重复写入并补齐剩余步骤。资源锁保证同一用户资源串行。 |
| Artifact 契约 | 成功响应必须包含真实修改文件 artifact | Pass | `src/mcp/service-tools-core.ts`、新增 artifact 故障注入测试 | 新增两个 apply 工具将 artifact 发布视为必需条件；发布失败抛错，不返回 `ok: true`。 |
| 失败注入测试 | 覆盖回读、候选决定、artifact 等关键失败点 | Pass | `tests/method-change-apply.test.ts`、`tests/preferences-apply.test.ts` | 覆盖候选决定失败回滚、change log 失败重试、artifact 失败重试以及偏好写入后的恢复。 |
| 闭环矩阵 | 覆盖任务书列出的全部用户配置资源 | Pass | `docs/user-config-mutation-closure-audit.md` | 已补充 `config/style_packs.yaml` 和 `config/observation_pool.yaml`，并明确当前没有普通会话 MCP 写入闭环。 |
| 能力边界 | 区分 MCP、隐藏 HTTP、底层 Store 和明确不支持 | Pass | `docs/user-config-mutation-closure-audit.md`、`docs/service-tools-mcp.md` | 交易策略、投资模型和盯盘规则 update/delete 的边界说明基本清晰。 |
| 任意文件 CRUD | 不新增通用 YAML 编辑器或隐藏 HTTP 绕过 | Pass | 代码审查 | 新增工具均为领域语义工具。 |
| 文档与 Agent 行为 | 明确 propose/apply 区别和偏好确认流程 | Pass | `templates/workspace/AGENTS.md`、`docs/service-tools-mcp.md` | 正常路径说明完整。 |
| 生产安全 | 验收阶段不修改生产数据或真实 Workspace | Pass | 本次操作记录 | 未执行生产命令、release 命令或真实 Workspace 写入。 |

## Findings

- [Low] artifact 重试在首次部分发布后可能产生新的 artifact 记录：当前 required publication 会保证不误报成功，重试会重新发布文件；这不影响用户可见结果，但后续可以增加按确认 ID 的 artifact 幂等键。
- [Low] `config/style_packs.yaml` 与 `config/observation_pool.yaml` 已明确列为当前不支持/待产品决策，不能在普通对话中宣称已修改；若未来开放，应单独定义领域 MCP 闭环。

## Verification Performed

- 静态审查：实施任务书、核心 dispatch、确认绑定、策略采用、偏好写入、候选后端、资源锁、工具注册、文档和测试。
- `node --import tsx --test --test-concurrency=1 tests/method-change-apply.test.ts tests/preferences-apply.test.ts tests/service-tool-grant.test.ts`：14 tests passed，0 failed。
- `npm run verify`：339 tests passed，0 failed；Agent context 通过；build 通过；7 个 boundary suite 通过。
- `git diff --check`：通过。
- 本轮未执行生产发布：当前任务是修复验收报告中的问题；生产发布需另行通过干净提交和 release snapshot 流程。

## Follow-Up Checklist

- [ ] 后续可为 artifact 发布增加按 confirmation ID 的幂等键，避免重试产生重复 artifact 记录。
- [ ] 产品确认后，单独实现交易策略实体、盯盘规则 update/delete 或投资模型的普通会话闭环。
- [ ] 通过独立发布任务提交当前改动、创建干净 release snapshot，并执行生产只读验收。

## 修复后复核（2026-08-04）

Status: Pass with caveats

已修复本报告中唯一的实现级遗留项：自动 artifact 发布现在使用“确认 ID + 相对路径”的幂等键，并在数据库建立用户/实例范围的唯一约束。首次发布已经写入 artifact 行、但后续审计或其他步骤失败时，重试会返回原 artifact descriptor，不会产生重复记录；同一幂等键对应不同文件内容或作用域时会明确拒绝。交易策略实体、盯盘规则 update/delete、投资模型运行时写入以及 style pack/observation pool 仍保持任务书定义的产品决策边界，不作为本次验收失败。

### 修复证据

| Area | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Artifact 重试幂等 | Pass | `src/services/conversation-artifacts.ts`、`src/db/index.ts`、`tests/conversation-artifacts.test.ts` | 存储层按 user/instance/idempotency key 唯一；内容或 scope 不一致时拒绝。 |
| `method_changes.apply` 部分发布恢复 | Pass | `src/mcp/service-tools-core.ts`、`tests/method-change-apply.test.ts` | 注入“artifact 已落库后失败”，重试后 artifact 记录数仍为 1。 |
| `preferences.apply` artifact 契约 | Pass | `src/mcp/service-tools-core.ts`、`tests/preferences-apply.test.ts` | 每个配置文件使用确认 ID + 路径键，发布失败不返回成功。 |
| 数据库升级兼容 | Pass | `src/db/index.ts`、`tests/file-retention.test.ts` | 旧库通过 `ensureColumn` 增加列，并重复初始化验证唯一索引。 |

### 本轮验证

- `npm run typecheck`：通过。
- `node --import tsx --test --test-concurrency=1 tests/conversation-artifacts.test.ts tests/method-change-apply.test.ts tests/preferences-apply.test.ts`：43 tests passed。
- `npm test`：340 tests passed，0 failed。
- `npm run build`：通过。
- `npm run test:boundary`：7 个 boundary suites passed。
- `git diff --check`：通过。

### 当前剩余边界

- `config/trading_strategies.yaml`、已有盯盘规则 update/delete、`config/investment_models.yaml`、`config/style_packs.yaml` 和 `config/observation_pool.yaml` 仍按审计矩阵标记为后续产品决策或设计阶段；本任务不伪造普通对话写入能力。
- 本轮修改尚未单独发布生产；此前已部署的 `1a651d3` 快照不包含本次 artifact 幂等修复，生产发布需另行走干净快照和只读验收流程。
