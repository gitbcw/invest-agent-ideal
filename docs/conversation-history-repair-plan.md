# 对话历史修复计划

> 来源：T-187《对话记录历史规则核验》  
> 依据：`docs/archive/conversation-history-rule-audit-report.md`
> 计划日期：2026-07-27  
> 状态：待执行

## 1. 背景与修复目标

T-187 已确认当前对话历史同时存在三类问题：Portal 镜像与分页的确定性缺陷、legacy 会话跨 scope 的数据与身份键问题、微信长期单会话导致的可见历史边界问题。

本计划的目标是先恢复“权威日志与用户可见历史一致、重试不重复、归档可恢复、scope 隔离可证明”，再单独决定微信历史如何分段。修复不得改变普通微信消息直达 workspace ACP 的主链路，也不得把 Portal mirror 提升为权威源。

## 2. 设计原则

1. Runtime 的 `conversation_sessions` / `conversation_messages` 继续是唯一权威日志；Portal 只做可重建镜像和用户视图状态。
2. 正确性优先于增量优化。MVP 数据规模下允许先做完整、幂等的分页同步，后续再优化为增量协议。
3. scope 必须由已认证 connector session 注入，客户端提交的 `userId`、`assistantId`、`instanceId` 不作为授权依据。
4. 重命名、置顶、归档、删除继续只属于 Portal 用户视图，不回写 Runtime。
5. 微信可见历史分段与 ACP 上下文边界是两个决策。没有产品确认前，不自动切断 ACP 上下文。
6. 生产数据迁移必须遵守项目 `db-migration` 与 `volcano-ops` 门禁：先备份、dry-run、逐项计数、迁移、验收、保留回滚路径。

## 3. 范围

### 包含

- Portal 会话摘要全量分页同步。
- Portal 会话详情的幂等补齐、稳定分页和长对话完整加载。
- Portal 失败重试的稳定幂等语义。
- 归档列表与恢复入口。
- Runtime 与 Portal 会话键的 scope 化迁移。
- 两个已知 legacy 跨 scope 会话的拆分、摘要重建和计数修复。
- 微信 channel identity 将 `externalAccountId` 纳入身份唯一键。
- 微信可见会话边界的独立产品决策包。

### 不包含

- 服务层主题分类、onboarding 分流、复盘意图检测或普通消息快车道。
- 自动交易、投资方法或 workspace Strategy Skills 的改造。
- 未经确认的语义分段、自动摘要标题算法或 ACP context 截断。
- 用 Portal 数据覆盖 Runtime 权威日志。

## 4. 总体执行顺序

| 阶段 | 工作包 | 可独立发布 | 前置门禁 |
| --- | --- | --- | --- |
| A | Portal 历史正确性修复 | 是 | 双仓 contract 固定、Portal dirty worktree 隔离 |
| B | scope 键与 legacy 数据迁移 | 是，必须单独发布 | 阶段 A 验收、生产备份、迁移 dry-run、人工确认 |
| C | 微信可见会话边界设计 | 只产出设计，不直接发布 | 用户确认期望行为 |

阶段 A 不依赖阶段 C，应优先执行。阶段 B 不得与普通 Portal 功能发布混包。阶段 C 的结论如果需要新增 display thread，应作为后续独立实现任务。

## 5. 阶段 A：Portal 历史正确性

### A1. 固定同步契约

涉及仓库：`invest-agent-ideal`、`invest-agent-portal`。

- 在协议测试中固定 Runtime `conversation.list/get` 的 scope、排序、`nextCursor` 和幂等 message ID 语义。
- Portal list 同步必须持续消费 Runtime `nextCursor`，直到结束；不得固定只取 50 条。
- 设置显式安全上限和错误结果，例如最大页数或最大条数。触发上限时返回“同步未完成”状态并记录结构化日志，不能静默把部分数据当成完整历史。
- mirror upsert 只更新 Runtime 拥有的标题、摘要、权威消息数和时间字段，不覆盖 `title_override`、`pinned_at`、`archived_at`、`deleted_at`。
- Connector 离线时继续允许读取已有 mirror，并明确标记数据可能未同步；不得删除或清空缓存。

主要模块：

- Runtime：`src/services/conversation-log.ts`、`src/portal/connector.ts`、Portal protocol types。
- Portal：`src/app/api/conversations/route.ts`、`src/lib/db/conversations.ts`、`src/lib/relay/server.ts`。

### A2. 修复详情补齐与长对话加载

- 删除“mirror 只要已有任意消息就不访问 Runtime”的短路条件。
- 抽出单一的 server-side `syncConversationDetail(scope, conversationId)`：循环消费 Runtime offset cursor，按 `messageId` 幂等 upsert，只有整轮同步成功后才更新该会话的同步完成标记。
- 第一版采用从 offset 0 开始的完整 reconciliation，避免把可变 offset 错当成持久增量 cursor。数据规模扩大后，再单独设计稳定增量协议。
- `GET /api/conversations/:id` 负责 scope 校验、触发同步并返回会话元数据与第一页；后续页面使用唯一的消息分页接口，避免两个详情路由维护不同逻辑。
- Chat 客户端必须消费消息 `nextCursor`，直到完整加载或用户主动停止；不能把第一页当作全部历史。
- 本地 mirror 消息分页改为稳定复合游标 `(created_at, message_id)`，排序也使用 `created_at ASC, message_id ASC`。游标采用版本化、URL-safe 编码，并对非法 cursor 返回 400。
- 同步完成后校验 mirror 成功消息集合与 Runtime 返回集合一致；Portal 本地 failed/pending 消息作为用户视图状态单独统计，不伪装成 Runtime 权威消息。

主要模块：

- Portal：`src/app/api/conversations/[id]/route.ts`、`src/app/api/conversations/[id]/messages/route.ts`、`src/lib/db/conversations.ts`、`src/components/chat/api.ts`、`src/components/chat/ChatShell.tsx`。
- Runtime：`src/services/conversation-log.ts` 仅在 contract 测试或协议字段确有缺口时修改。

### A3. 修复失败重试

- 将一次用户发送定义为稳定 turn：首次生成 `userMessageId/idempotencyKey` 后，失败重试必须复用该键，不再创建新的用户消息。
- UI 重试时原位把 failed 用户消息切回 pending，并替换 failed assistant 占位；禁止保留旧用户消息后再次 append 同一正文。
- Portal API 和 Runtime 均按 `scope + conversationId + idempotencyKey` 幂等。若 Runtime 已保存用户消息但助手回复失败，重试应复用该用户消息并恢复/重新取得助手结果，不重复执行已经成功的持久化步骤。
- 为“请求未到 Runtime”“用户消息已落但助手失败”“助手已完成但 Portal 超时”三种状态分别定义恢复结果和 UI 文案。

主要模块：

- Portal：`src/components/chat/ChatShell.tsx`、`src/app/api/conversations/[id]/messages/route.ts`、`src/lib/db/conversations.ts`。
- Runtime：`src/services/conversation-log.ts` 的 idempotency 查询与 assistant request 恢复路径。

### A4. 补归档入口

- Sidebar 增加活动/已归档视图切换；已归档列表使用现有 `archived=true` API。
- 已归档条目只提供“恢复”和“删除”，恢复后返回活动列表且不自动置顶。
- 空态、离线态和恢复失败必须可见；归档/恢复不得修改 Runtime。
- 保留现有重命名、置顶和删除语义，不在本工作包增加批量操作。

### A5. 阶段 A 测试与验收

Portal contract 测试至少覆盖：

1. 空 mirror 从 Runtime 同步 56 个会话，最终可发现 56 个且无重复。
2. 部分 mirror 会话从 44 条补齐到 191 条；重复同步结果不变。
3. 205 条长对话完整加载，跨页顺序稳定。
4. 3 条相同时间戳消息、页大小 2，结果为 2 + 1，无漏项或重复。
5. Connector 中途离线时保留旧 mirror，并暴露未完成状态；恢复后可补齐。
6. failed turn 连续重试两次，Portal 与 Runtime 均只有一条用户消息，助手结果至多一条成功记录。
7. 归档条目从活动列表消失、在归档列表出现、恢复后重新出现，Runtime 数据不变。
8. 不同 portal user / assistant / instance 使用相同外部 `conversationId` 时互不可读写。

验证命令：Portal `npm test && npm run typecheck && npm run build`；Runtime 执行相关单测、`npm run build` 和 `npm run smoke:portal-conversation-log`。浏览器验收使用 mock/测试账号，不向真实用户发送消息。

阶段 A 发布后，对生产做只读复核：会话摘要覆盖数一致；7 个部分镜像会话可以补齐；同时间戳分页无漏项；已有用户视图字段保持不变。未达到任一项则回滚 Portal 代码版本，mirror 数据无需反向覆盖 Runtime。

## 6. 阶段 B：scope 键与 legacy 数据迁移

### B1. 目标模型

推荐保留对外 `conversationId`，把存储主键改为 scope 化复合键，避免为了修历史数据改变用户可见 ID：

- Runtime session 唯一键：`(user_id, instance_id, conversation_id)`；所有 summary 刷新、计数、查询和删除同时带 scope。
- Runtime message 与 session 的关联也使用上述 scope；不能只按裸 `conversation_id` 聚合。
- Portal conversation mirror 唯一键至少包含 `(user_id, assistant_id, instance_id, conversation_id)`；所有 `get/update/delete/listMessages` 方法必须接收已认证 scope。
- Portal message mirror 的唯一性与父会话关联同样 scope 化，不能依赖全局唯一的外部 ID 假设。
- `channel_identities` 唯一键改为 `(channel, external_account_id, external_user_id)`；查询与 upsert 使用同一键，禁止不同微信账号下的同名外部用户互相覆盖。

最终 schema 细节由执行者按 SQLite 能力形成 migration design，但不得用字符串拼接 scope 作为唯一安全边界，也不得移除 connector 的 scope 注入与服务端鉴权。

### B2. 迁移步骤

1. 写只读 preflight：统计跨 scope conversation、孤儿消息、session/message scope 不一致、身份键冲突和 Portal mirror 冲突；输出计数与哈希，不输出正文或用户标识。
2. 在生产 DB 副本上完成 SQLite table rebuild dry-run，验证外键、索引、行数、摘要和最近消息一致性。
3. 对每个 distinct message scope 重建一条 session；标题取该 scope 第一条用户消息或旧标题，摘要与更新时间取该 scope 最后一条消息，`message_count` 只统计该 scope。
4. 已知两条 legacy 会话应分别得到每个 scope 的独立 session summary；迁移后错误聚合计数归零。
5. Portal mirror schema 同步迁移，保留 title override、置顶、归档和删除状态；冲突数据不得静默覆盖，必须输出冲突清单并人工决定保留策略。
6. 更新所有 Runtime/Portal repository 查询和清理逻辑，使 scope 成为必填参数；补负向测试证明漏 scope 的调用无法编译或明确失败。
7. 更新 channel identity 查询与唯一索引；迁移前若 `(channel, account, user)` 映射冲突，停止发布并人工处理。
8. 生产发布前分别备份 Runtime 与 Portal SQLite、记录校验和并验证可恢复；先发布兼容代码，再执行迁移，最后启动服务并只读验收。

### B3. 迁移验收与回滚

- session/message 总行数与 dry-run 预期一致，无孤儿记录。
- 每条 session 的 count、preview、updated_at 都只来自自身 scope。
- 同一 `conversationId` 可在两个 scope 下安全存在，列表和详情互不可见。
- 两条 legacy 会话不再跨 scope 聚合，Portal 不展示其他 scope 正文。
- 微信多账号下相同 `externalUserId` 能映射到不同 identity，原有单账号绑定不变。
- Runtime 和 Portal 健康检查、connector 注册、会话列表/详情 smoke 全部通过。

任何行数、scope 或摘要校验失败时立即停止，不启动写流量；使用发布前 DB 备份与上一代码版本整体回滚，不执行手工局部删改。

## 7. 阶段 C：微信可见会话边界决策

该阶段先产出设计，不直接实现。需要用户确认以下问题：

1. 用户是否需要在微信中显式说“新对话”，还是只要求 Portal 把一条长期微信上下文按主题/日期组织展示。
2. Portal 展示分段后，继续某段历史是否应恢复当时 ACP context，还是仍进入当前长期微信上下文。
3. 时间间隔、主题变化或任务完成能否自动产生 display thread；误分与漏分哪个成本更高。
4. 重命名、搜索、复盘引用和 workspace artifact 应绑定权威 conversation、display thread 还是二者关联。

默认建议是先引入纯展示层 `display thread` 或显式“新会话”能力，保持 Runtime 权威消息和 ACP context 不变；只有真实交互评测证明长期上下文带来错误推理时，再另行设计 ACP 会话切分。禁止通过服务层意图分类自动切换普通微信消息。

阶段 C 的交付物应包含用户流程、状态模型、历史数据映射、搜索/重命名语义、回滚方式和至少 5 个微信真实场景验收脚本。

## 8. 交付物

- 阶段 A：Portal 与必要 Runtime contract 改动、单元/contract/browser 验收记录、生产只读复核报告。
- 阶段 B：schema migration、preflight/dry-run 工具、备份与回滚记录、生产迁移验收报告。
- 阶段 C：微信可见会话边界设计文档；未确认前不提交实现。
- 完成后更新当前 `docs/user-portal.md`、`docs/user-portal-protocol.md` 和必要的项目 Skill；阶段性执行记录验收后移入 `docs/archive/portal/`。

## 9. 风险与控制

| 风险 | 控制 |
| --- | --- |
| 全量详情同步延迟增加 | 设置页数/条数上限与结构化状态；先保证完整性，再设计稳定增量 cursor |
| mirror 同步覆盖用户视图状态 | repository 分离 Runtime 字段与 Portal-only 字段，并做回归测试 |
| offset cursor 在同步时发生插入导致漂移 | 第一版完整 reconciliation 后校验 message ID 集合；后续协议再改稳定 cursor |
| scope schema 迁移破坏历史 | DB 副本 dry-run、双库备份、行数与 scope 校验、独立发布窗口 |
| legacy 冲突被静默合并 | 冲突即停止，输出脱敏清单并人工决定 |
| 微信分段误改 ACP 上下文 | 阶段 C 独立门禁，默认只做展示层，不引入服务层意图分流 |
| Portal 仓库已有未提交改动 | 执行前从已确认基线创建短生命周期 `codex/*` 分支或独立 worktree，不覆盖现有改动 |

## 10. 完成定义

只有同时满足以下条件，修复计划才算整体完成：

- Portal 可完整发现并读取 Runtime 权威历史，分页不重不漏，离线状态不伪装成已同步。
- 同一发送失败后反复重试不会产生重复用户消息或重复 ACP 执行。
- 用户可以查看并恢复归档会话。
- Runtime 与 Portal 的会话/消息访问均以认证 scope 为键，legacy 错误计数已修复。
- 生产迁移有可验证备份和回滚记录，未修改真实 Workspace 用户资产。
- 微信历史边界已由用户明确决策；若尚未决策，阶段 A/B 可以完成，但不得宣称“对话分流”已经完成。

## 11. 执行与验收交接

Executor prompt:

> 按 `docs/conversation-history-repair-plan.md` 执行。先只完成阶段 A，并在独立分支或 worktree 中保护 Portal 现有未提交改动。不得顺带实施阶段 B/C。阶段 A 验收通过后，阶段 B 必须重新读取项目 `db-migration` 与 `volcano-ops` skill，并取得生产迁移确认。每一步报告测试命令、退出码和产物路径；遇到 scope 冲突不得自动合并。

Reviewer prompt:

> 独立对照 `docs/conversation-history-repair-plan.md` 验收执行结果。优先检查跨用户/助手/实例隔离、部分 mirror 补齐、长对话与同时间戳分页、失败重试幂等、Portal-only 状态保留、生产迁移备份与回滚证据。不得用“测试通过”代替数据计数和真实交互证据，也不得把阶段 C 的未决产品问题算作阶段 A/B 缺陷。
