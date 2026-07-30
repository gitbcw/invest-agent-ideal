# T-187 对话记录历史规则核验报告

> 归档说明（2026-07-28）：本文保留已完成核验的证据；未解决问题的当前执行入口是 `docs/conversation-history-repair-plan.md`。

> 核验日期：2026-07-27  
> 任务：Personal OS `T-187`  
> 结论：现状存在需要继续处理的问题；不建议直接关闭归档

## 1. 执行摘要

当前 Portal 左侧历史不是按主题或时间自动分流。Web 端每次点击“创建新聊天”后首次发送会生成新的 `web_<random>` 会话；打开已有 Web 会话后继续发送则沿用原 ID。微信端主要沿用 SDK 提供的外部会话 ID，同一微信联系人会长期复用一个会话，因此 onboarding、持仓讨论、复盘、研究问答等不同主题会出现在同一历史条目中。

生产环境确认存在以下问题：

1. **P1：微信会话长期聚合，历史条目不能代表单一主题。** 当前抽查用户唯一的微信会话跨 21 天，Portal 标题被重命名为某一类复盘，但打开后包含 onboarding、方法配置、日常问答和复盘等多类内容。
2. **P1：Portal 详情镜像不持续补齐，历史明显不完整。** 生产 Portal 的 36 个未删除镜像会话中，10 个活动会话存在 Runtime 消息未镜像；其中 7 个已有部分 mirror 消息，按当前逻辑不会再从 Runtime 补齐，另外 3 个为空镜像、首次打开时仍可尝试补齐。10 个会话合计缺 223 条权威消息。抽查的微信会话 Portal 仅缓存 44 条，而 Runtime 当前 scope 下有 191 条，缺 147 条。
3. **P1（安全敏感的数据完整性问题）：Runtime 存在 2 个 legacy 会话 ID 跨 scope 复用。** 当前代码会拒绝新的跨 scope 复用，且本轮没有发现 Portal 正在展示其他用户正文；但 session 总数按同一 `conversationId` 聚合所有 scope，历史数据已经产生错误计数，后续必须单独清理并收紧身份键。
4. **P2：归档历史在当前 UI 中不可见且无法恢复。** 当前抽查账号有 1 个归档会话，API 支持读取归档，但 Sidebar 没有归档入口或恢复操作。
5. **P2：Portal 消息游标在相同时间戳下会漏消息。** 隔离测试构造 3 条同时间戳消息、每页 2 条，第二页返回 0 条，确定丢失 1 条。
6. **P2：失败重试会在 Portal 镜像重复追加用户问题。** 生产已有 5 条 failed 用户消息，其中 3 条在 10 分钟窗口内存在相同正文重复；Runtime 仅保留一份，说明重复发生在 Portal 用户视图。

没有发现当前 Portal 助手之间的会话列表串用户：5 个已接入 Portal 的助手，其 Runtime 会话摘要均完整出现在各自 Portal mirror 中。Runtime 现有 18 个未进入 Portal 的会话属于其他尚未接入 Portal 的助手，不是本轮的“历史丢失”。

## 2. 核验边界与基线

### 仓库与环境

| 对象 | 基线 |
| --- | --- |
| 本地 Runtime | `invest-agent-ideal`，commit `6e7e1fa8090dafc14ba831c7b71a14809bdbd377` |
| 本地 Portal | `invest-agent-portal`，commit `db82a3a88865e75ec76f72c662061186363b4ea1` |
| 生产 Portal | `http://118.145.115.197:22649`，`/api/health` 正常 |
| 生产 Runtime | `127.0.0.1:22655` 经本机 SSH tunnel，`/health` 正常 |
| 生产代码版本 | 发布目录不包含 `.git`，无法从服务器独立取得 commit；以当前部署文件和数据库为准 |

Portal 本地仓库已有用户未提交改动，本轮未修改该仓库。生产数据库均通过 `better-sqlite3` 的 `readonly + fileMustExist` 模式读取；未执行写 SQL、部署、重启、发送消息或会话状态操作。

### 生产数据规模

| 存储 | 会话 | 消息 | 用户/助手实例 | 渠道 |
| --- | ---: | ---: | ---: | --- |
| Runtime 权威库 | 57 | 852 | 16 / 16 | Web 41，微信 16 |
| Portal mirror | 39 | 395 | 5 / 5 | Web 33，微信 6 |

Portal mirror 的消息数是缓存量，不是权威消息总数。会话摘要覆盖应按助手逐一比较，而不能直接比较全库总数。

## 3. 当前规则

### 3.1 规则链路

| 层 | 当前职责和规则 | 证据 |
| --- | --- | --- |
| Web UI | `activeId` 为空时首次发送生成 `web_<nanoid>`；选择已有会话后沿用该 ID | Portal `ChatShell.tsx:283-289` |
| 微信入口 | 使用 SDK `request.conversationId`；为空时才退回 `weixin-mobile-<accountId>` | Runtime `weixin-message-bridge.ts:183-198` |
| 微信身份 | 现有身份按 `channel + externalUserId` 查找，未把 `externalAccountId` 纳入查询键 | Runtime `user-identity.ts:47-66`；DB 唯一索引 `channel + external_user_id` |
| Runtime session | `conversation_id` 是单列主键；创建后校验 user/project/instance/assistant scope | Runtime `conversation-log.ts:143-175` |
| Runtime summary | 标题取第一条用户消息；摘要、计数和 `updated_at` 随消息刷新 | Runtime `conversation-log.ts:178-205` |
| Runtime list | 按 `userId + instanceId` 过滤，`updatedAt DESC`，offset cursor | Runtime `conversation-log.ts:399-436` |
| Runtime detail | 按 `conversationId + userId + instanceId` 过滤，`createdAt ASC, rowid ASC` | Runtime `conversation-log.ts:439-495` |
| Connector | 从已认证 connector session 注入 scope，转发 list/get/chat | Runtime `portal/connector.ts:175-209` |
| Portal list sync | 每次只向 Runtime 请求最多 50 个摘要，不继续消费 remote cursor | Portal `api/conversations/route.ts:42-69` |
| Portal user view | mirror 按 portal user + assistant + instance 隔离；置顶优先，再按更新时间降序 | Portal `db/conversations.ts:299-344` |
| Portal detail sync | mirror 已有任意消息时直接返回；只有完全为空才向 Runtime 拉一次 | Portal `api/conversations/[id]/route.ts:43-84` |
| Sidebar | 每次加载 20 个会话；标题、相对时间、`ceil(messageCount/2)` 和最后摘要 | Portal `Sidebar.tsx:183-243,457-470` |

### 3.2 权威与镜像

- Runtime `conversation_sessions` / `conversation_messages` 是权威日志。
- Portal `conversation_mirror` / `conversation_message_mirror` 是离线缓存和用户视图。
- 重命名、置顶、归档、删除只写 Portal mirror，不修改 Runtime 权威记录。
- Portal 登录用户 ID 与 Runtime user ID 属于不同身份命名空间；二者字符串不同本身不是越权证据。跨层关联依赖受认证 Portal account -> assistant/instance -> connector scope。

## 4. 实测结果

### 4.1 生产页面只读观察

当前登录账号 Sidebar 显示 5 个活动会话，其中 1 个置顶。数据库中该助手共有 6 个 mirror 会话：Web 5 个、微信 1 个；其中 1 个 Web 会话已归档，因此不会出现在当前 UI。

打开已有微信历史条目后确认：

- Sidebar 的条数指标显示 22；该指标由 mirror 中 44 条消息按 `ceil(messageCount / 2)` 折算，并不等同于经过校验的 22 个完整问答轮次。
- 该条目跨 21 天，标题是用户重命名后的单一主题名称。
- 实际详情混合了 onboarding、投资方法配置、持仓相关问答、研究和复盘等多种主题。
- Runtime 当前 scope 下有 191 条消息；Portal mirror 只有 44 条，缺 147 条。

这证明“该分的没分”和“历史不完整”都是真实问题，不只是用户主观感受。

### 4.2 生产数据库一致性

#### 会话摘要覆盖

- Portal 中 5 个助手分别有 6、6、6、8、13 个会话。
- 对应 Runtime 的会话数完全一致，没有助手级摘要缺失。
- Runtime-only 的 18 个会话全部属于另外 11 个未接入 Portal 的用户/实例。
- 因此当前生产尚未触发“单助手超过 50 个会话导致旧摘要无法首次同步”的边界，但代码中该边界客观存在。

#### 消息镜像完整性

使用 `role + created_at + content hash` 比较，不输出正文：

- 39 个 mirror 会话中有 11 个存在差异，其中 1 个已删除。
- 10 个活动会话合计缺少 223 条 Runtime 权威消息；其中 7 个已有部分 mirror 消息，3 个 mirror 详情为空。
- 缺失最严重的两个活动微信会话分别缺 147 条和 61 条。
- 3 个新/短会话在 Portal 只有摘要，没有任何详情消息；因为 mirror session 已存在，详情路由仍可在首次打开时补齐，这部分属于尚未访问状态，不单独判为缺陷。
- 已有部分消息的微信会话不会再向 Runtime 增量同步，属于确定性缺陷。

#### legacy 跨 scope 会话

忽略仅 channel 不同的情况后，Runtime 有 2 个会话 ID 包含多个 user/instance/assistant scope：

| 脱敏会话 | 全部消息 | 当前 session scope 消息 | Portal 状态 |
| --- | ---: | ---: | --- |
| `1bd4d17a37` | 86 | 44 | 未镜像 |
| `00b4f71618` | 209 | 191 | 已镜像；Portal 缓存 44 |

当前两条 session 的最后消息都属于当前 session owner，摘要也与最后消息一致，本轮没有证明正在泄露其他用户正文。但 `refreshSession()` 的计数按裸 `conversation_id` 统计，因此总数已跨 scope 聚合。项目代码中也明确存在“legacy external conversation ID may have been incorrectly shared by another scope”的兼容注释。

### 4.3 隔离环境 contract 实测

所有写入都发生在 `/tmp/invest-agent-t187-*` 临时目录。

| 场景 | 结果 |
| --- | --- |
| Runtime 基础会话日志 smoke | 通过；幂等用户消息只保存一次，顺序为 user -> assistant |
| 不同 scope 复用相同 `conversationId` | 当前代码正确抛出 `ConversationScopeError` |
| 不同用户列表隔离 | 通过；另一 scope 返回 0 个会话 |
| Runtime 56 个会话分页 | 50 + 6，去重后 56，无丢失 |
| Runtime 205 条同时间戳消息分页 | 200 + 5；依靠 `rowid` 保持顺序 |
| Portal 60 个会话本地分页 | 50 + 10，去重后 60，无丢失 |
| Portal 3 条同时间戳消息分页，每页 2 条 | 2 + 0，确定丢失 1 条 |

Portal 消息分页只使用 `created_at > cursor`，没有以 `message_id/rowid` 作为并列游标，因此相同时间戳下后续消息被跳过。

### 4.4 中断与失败重试

Portal 在发送前先写 pending 用户消息；失败后将它标成 failed。点击重试会删除 failed assistant 占位，但保留原用户消息，然后调用 `handleSend(userText)` 生成新的本地 message ID 和 idempotency key。

生产已有 5 条 failed 用户消息：

- 其中 3 条在同一会话的 10 分钟窗口内存在 Portal 相同正文重复。
- 对应 Runtime 在该窗口只有一份相同正文。
- 说明重复至少已经发生在 Portal 用户视图；本轮没有证明 Runtime 重复执行了请求。

## 5. Findings

### P1-1 微信历史没有可用的主题边界

**现象**：同一微信联系人长期使用一个外部会话 ID，Portal 只产生一个微信历史条目。用户重命名后，标题只代表其中一个阶段，而内容覆盖多类主题。

**影响**：用户无法从左侧历史定位一次独立讨论；标题、搜索和“继续此前讨论”的心智都不可靠。

**归类**：产品规则不符合当前 Portal 历史体验预期，不是简单排序 bug。

**建议路由**：创建“微信可见会话边界设计”任务，单独决定按显式新会话、时间段、任务/主题还是其他方式生成 Portal thread；不得直接改变 ACP context scope。

### P1-2 Portal 详情镜像长期不完整

**现象**：mirror 只要已有一条消息，详情 API 就不再访问 Runtime；首次拉取也受 50/100 条限制，ChatShell 不消费详情 `nextCursor`。

**影响**：侧栏计数、打开后的消息数和 Runtime 权威记录长期不一致；微信历史尤其严重。

**建议路由**：创建确定性修复任务，定义增量 sync cursor、权威 message count、详情向前/向后分页和离线策略。修复前不要把 mirror 行数当作总消息数。

### P1-3 legacy `conversationId` 跨 scope 数据需清理

**现象**：生产有 2 个 legacy 会话 ID 含多个 scope 的消息；session 主键仍是裸 `conversation_id`，计数也按裸 ID 聚合。

**影响**：当前已造成错误计数；若未来出现错误回填或 mirror 迁移，存在安全敏感风险。

**缓解现状**：当前 `ensureSession` 会拒绝新的跨 scope 写入；Runtime 详情按 user + instance 过滤；本轮未发现 Portal 展示其他用户正文。

**建议路由**：创建数据修复/身份键任务。先备份并审计两条 legacy 会话，再决定拆分 ID、重建 session summary 及将 `externalAccountId` 纳入微信身份键；该任务需遵守 DB migration 和生产数据门禁。

### P2-1 归档会话没有用户入口

**现象**：API 与数据库支持归档，但 Sidebar 只提供重命名、置顶和删除，列表始终请求 `archived=false`。

**影响**：已归档记录对当前用户不可发现、不可恢复。生产抽查账号已有 1 条此类记录。

**建议路由**：补归档列表/恢复入口，或在确认不需要该能力后迁移现有归档状态并退役 API。

### P2-2 消息时间游标会漏同时间戳记录

**现象**：Portal 使用 `created_at > cursor`；同时间戳超过页大小时后续记录永远不可达。

**建议路由**：改为稳定复合游标，例如 `(created_at, message_id)`，并补同时间戳 contract 测试。

### P2-3 失败重试产生重复用户消息

**现象**：重试保留 failed 用户消息并以新 ID 再发送同一正文。

**建议路由**：复用原请求的稳定 idempotency key，或原位更新 failed turn；同时定义“远端已落用户消息但助手失败”的恢复语义。

### P2-4 Portal 会话首次同步最多 50 个摘要

**现象**：Portal list API 固定向 Runtime 请求 `limit: 50`，忽略 remote `nextCursor`。

**当前影响**：当前 5 个 Portal 助手最多 13 个会话，尚未触发。

**建议路由**：与 P1-2 的 sync 机制一起修复并增加超过 50 个会话的空镜像 contract。

## 6. 已排除或降级的问题

- **未发现当前 Portal 助手之间串列表。** Portal mirror 按 portal user + assistant + instance 过滤，生产 5 个助手的摘要覆盖一致。
- **Runtime 当前新写入有 scope 门禁。** 隔离测试证明同一 ID 跨 scope 会被拒绝。
- **Runtime 自身分页可用。** 56 会话和 205 同时间戳消息均能完整分页；消息分页缺陷位于 Portal mirror。
- **Runtime-only 18 个会话不是当前 Portal 丢失。** 它们属于未接入 Portal 的其他实例。
- **Portal user ID 与 Runtime user ID 不同不是问题。** 两侧是不同身份命名空间，不能直接按字符串相等判断。

## 7. 证据缺口与残余风险

- 两个生产发布目录均不包含 `.git`，因此无法独立证明生产文件与本地 commit 完全一致；本报告的代码行号用于解释本地当前实现，生产行为结论以页面观察和数据库只读审计为准。
- 本轮没有发送生产测试消息，失败重试结论来自当前代码路径和既有 failed 记录对照；它证明 Portal 用户视图发生重复，但不能证明 Runtime 曾重复执行 ACP 请求。
- 本轮未对 legacy 跨 scope 会话做数据修复演练，也没有读取其他用户消息正文；因此只确认错误计数和潜在风险，不把它上升为已发生的正文泄露。
- 首次同步超过 50 个会话的边界由代码和隔离测试确认，生产每个已接入助手最多 13 个会话，尚无生产触发证据。
- 微信可见会话如何分段仍是产品决策。长时间跨度和多主题混合能证明当前历史定位体验有问题，但不能单独决定 ACP 上下文是否也应拆分。

## 8. 最终判断与下一步

T-187 的核验目标已经达到：当前历史规则确实有问题，而且同时包含产品边界和确定性实现缺陷。

建议将后续拆成三个任务，而不是用一个“对话分流改造”笼统处理：

1. **先修 P1-2/P2-2/P2-3/P2-4：Portal 历史同步与分页正确性。** 这是确定性工程问题，不需要等待产品设计。
2. **单独处理 P1-3：legacy 会话 scope 清理与微信身份键。** 涉及生产数据，必须走备份、迁移和人工门禁。
3. **再设计 P1-1：微信可见会话如何分段。** 只改变 Portal 历史组织还是真正改变 ACP 会话上下文，需要产品决策，不能在 bug 修复中顺带决定。

本任务没有修改产品代码、数据库、生产配置或真实用户会话状态。下一步应由用户确认上述路由，再创建对应任务；T-187 可在用户验收本报告后完成。
