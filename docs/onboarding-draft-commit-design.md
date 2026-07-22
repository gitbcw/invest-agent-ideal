# Onboarding 草稿确认与统一提交设计

## 1. 背景

当前 Onboarding 将“用户确认某一步”和“把该步写入 Workspace”绑定在同一轮：持仓确认后立即写持仓与状态，投资风格确认后立即写策略与状态，复盘、盘中简报和通知偏好也分别写入。用户每次确认都要等待 ACP 调用工具、读取文件、合并、写入、校验和更新状态。

这造成两个产品问题：

1. 引导中最简单的“确认”反而成为慢响应，每一步都打断对话节奏。
2. 用户后续修改前面已经确认的内容时，正式配置被反复覆盖，容易形成半完成状态和额外写入。

目标流程不是取消逐项引导或逐项确认，而是把确认对象改为 Onboarding 草稿。中间确认只让某一节草稿定稿；全部信息确认后，再冻结草稿版本并统一落实正式配置。

## 2. 设计结论

采用三层状态，明确区分：

1. **对话草稿**：Agent 整理并展示当前步骤内容。
2. **已确认草稿**：用户确认后，服务只记录该步骤、草稿版本和确认消息，不修改 Workspace 正式配置。
3. **正式配置**：所有必需步骤确认后，后台任务基于一个冻结快照统一生成、校验并写入 Workspace；成功后再完成 Onboarding。

流程示意：

```text
收集当前步骤信息
  -> 展示步骤草案并登记待确认版本
  -> 用户确认
  -> 轻量记录“该草稿版本已确认”
  -> 立即进入下一步骤
  -> ...
  -> 最后一步确认
  -> 冻结完整草稿版本并排队提交
  -> 立即告知用户正在统一配置
  -> 后台集中读取、合并、写入、校验
  -> 通过原会话/微信推送完成或失败结果
```

不再采用“每确认一步就写正式文件”的流程，也不要求额外回复“确认完成”。

## 3. 目标

- 保留自然、连续、逐项引导的 Onboarding 体验。
- 每一项仍然展示草案并接受普通语言确认。
- 中间确认不写 `portfolio.yaml`、`strategy.yaml`、`schedules.yaml`、`notification.yaml`、`watch.yaml` 或 `onboarding_state.yaml`。
- 用户可在最终提交前修改任意草稿步骤；修改只产生新草稿版本。
- 最终提交时，每个目标文件最多读取一次、写入一次。
- 最后一步确认后快速回复“信息已全部确认，正在统一完成初始配置”，无需等待全部文件写完才收到第一条回复。
- 提交成功后自动通知用户并直接进入正常使用状态。
- 草稿、确认、提交、正式文件和审计证据可相互核对。
- 提交失败不伪装成完成，并支持安全重试。

## 4. 非目标

- 不改变 Onboarding 当前步骤的业务内容和顺序。
- 不把普通微信消息重新分流到服务层，不恢复 onboarding 短路。
- 不把投资判断或自然语言引导逻辑搬到服务代码。
- 不重新启用已经废弃的通用 `conversation_tasks` 草稿系统。
- 不把所有问题合并成一张长表，也不强迫用户一次提交全部信息。
- 不取消明确规则、预案等高影响动作原有的显式确认要求。
- 不要求跨 Workspace 的多文件数据库级强原子事务；通过冻结快照、幂等写入、校验和恢复保证最终一致。

## 5. 用户流程

### 5.1 首次进入

助手继续说明自己是投资助手，正在协助完成简短初始配置。持仓、现金和观察仓仍可通过文字或截图提供。

第一步草案展示后，助手说明“确认后先加入初始配置草稿，全部信息确认后再统一保存”，避免用户误以为已经写入正式配置。

### 5.2 中间步骤确认

用户确认某一步后：

- 服务验证确认确实晚于被展示的草稿，并且 payload 与草稿版本一致。
- 服务把该步骤标记为 `accepted`，记录确认消息和时间。
- 不调用任何 Workspace writer。
- Agent 在同一轮承接下一步骤，不说“已保存到配置”，应说“这部分已加入草稿”。

推荐表达：

> 好的，这部分已加入初始配置草稿。接下来确定复盘时间，这会决定你通常什么时候收到盘后总结。你希望沿用工作日 19:00，还是换一个时间？

### 5.3 修改已确认草稿

最终提交前，用户可以说“把通知偏好改成积极盯盘”或“现金比例改成 30%”。

- 对应步骤生成新 revision，并把旧 revision 标记为 `superseded`。
- 修改后的精确草案仍需再确认一次，因为确认必须绑定具体内容。
- 其他已经确认且没有变化的步骤保持有效，不重新询问。
- 修改期间仍不写正式 Workspace。

### 5.4 最后一步确认

最后一个必需步骤确认后，不再询问“确认完成”。系统冻结完整草稿快照并创建提交任务，Agent 立即回复：

> 信息已全部确认。我现在会统一完成初始配置，这可能需要一点时间；完成后我会通知你。

这条回复必须在后台 Workspace 写入之前返回给用户。要实现该体验，最终提交必须由服务层异步任务执行，而不是让当前 ACP 回合同步完成所有写入。

### 5.5 完成通知

成功后发送：

> 初始配置已经完成：持仓与观察仓、投资方法、复盘安排、盘中简报和通知偏好均已生效。你现在可以直接说“今日复盘”或“看看我的持仓风险”。

不展示内部文件名、任务 ID、MCP、审计或运行时信息。

## 6. 状态模型

### 6.1 草稿生命周期

```text
collecting
  -> ready_to_commit
  -> queued
  -> applying
  -> completed

queued/applying
  -> failed_retryable
  -> queued

collecting/ready_to_commit
  -> cancelled
```

状态含义：

- `collecting`：仍有必需步骤未确认，或存在修改后待重新确认的步骤。
- `ready_to_commit`：必需步骤均有当前 revision 的有效确认。
- `queued`：完整快照已经冻结，等待后台 worker 领取。
- `applying`：正在生成、写入和校验正式配置。
- `completed`：正式配置校验通过，Onboarding 已完成。
- `failed_retryable`：提交失败，草稿与冻结快照保留，可幂等重试。
- `cancelled`：用户明确放弃当前草稿；不得影响既有正式配置。

### 6.2 步骤状态

每个步骤使用以下状态：

- `empty`
- `drafted`
- `awaiting_confirmation`
- `accepted`
- `superseded`
- `skipped`，仅用于业务允许跳过的步骤，例如明确规则

当前 Onboarding 步骤保持：

1. `portfolio`
2. `style`
3. `review_schedule`
4. `market_watch_schedule`
5. `notification`
6. `watch_rules`

`welcome` 是体验入口，不作为需要单独确认的业务草稿。最终成功时，正式 `onboarding_state.yaml` 可一次性把 `welcome` 和所有已完成步骤标为完成。

## 7. 草稿存储

新增 Onboarding 专用的服务层草稿存储，不使用 Workspace 正式文件，也不复活通用 `conversation_tasks`。

推荐新增 `onboarding_drafts` SQLite 表，一条活动记录承载一个用户实例的当前 Onboarding 草稿：

| 字段 | 用途 |
| --- | --- |
| `id` | 草稿 ID |
| `user_id` / `instance_id` | 隔离范围；同一实例最多一个活动草稿 |
| `conversation_id` | 最近承接草稿的会话，用于确认绑定与完成通知 |
| `revision` | 完整草稿版本号 |
| `status` | 草稿生命周期状态 |
| `steps_json` | 各步骤 payload、revision、状态和确认引用 |
| `commit_snapshot_json` | 排队时冻结的完整不可变快照 |
| `commit_key` | 幂等键，建议为 `draft_id:revision` |
| `attempts` | 后台提交尝试次数 |
| `last_error` | 面向运维的失败摘要，不直接展示给客户 |
| `queued_at` / `started_at` / `completed_at` | 提交生命周期时间 |
| `created_at` / `updated_at` | 通用时间 |

`steps_json` 每一步至少包含：

```json
{
  "status": "accepted",
  "revision": 3,
  "payload": {},
  "confirmation_id": "...",
  "confirmed_message_id": "...",
  "confirmed_at": "..."
}
```

草稿只保存配置所需的结构化字段，不复制附件二进制、完整对话或模型推理。截图提取结果进入结构化 payload；原附件继续由现有附件与对话机制管理。

## 8. 确认契约

### 8.1 登记草案

继续复用 `pending_sandbox_confirmations` 的“精确 payload 绑定”能力，但新增 Onboarding 草稿操作，而不是登记正式写入操作：

- `onboarding.draft.request_confirmation`
- 目标包括 `draftId`、`step`、`stepRevision` 和精确 payload。

登记发生在展示草案之前，仍可预先验证证券代码、时间格式、通知偏好枚举和规则可执行性。

### 8.2 接受草案

新增轻量工具：

- `onboarding.draft.accept_step`

它只做以下动作：

1. 验证最新用户消息是普通明确确认。
2. 验证 confirmation、step revision 和 payload 完全一致。
3. 消费对应 pending confirmation。
4. 在 SQLite 中把该步骤标记为 `accepted`。
5. 写一条轻量审计记录。
6. 返回下一个未完成步骤或 `ready_to_commit=true`。

它禁止读取或写入 Workspace 文件。服务端目标是一次短 SQLite 事务完成，避免确认后出现当前的长等待。

### 8.3 修改草案

新增或更新步骤草案时：

- step revision 加一；
- 旧 confirmation 变为 `superseded`；
- 旧 accepted revision 保留作审计，但不再算作当前有效确认；
- 新 payload 必须重新展示和确认。

### 8.4 提交授权

所有必需步骤分别经过确认后，已经构成完整提交授权，不再要求一次无内容的总确认。`watch_rules=skipped` 必须有用户明确跳过的消息证据；配置规则则必须有每条精确规则草案的确认。

## 9. MCP 工具设计

建议提供以下命名能力，具体 schema 在实现阶段由 `service-api-change` 约束：

| 工具 | 作用 | 是否写 Workspace |
| --- | --- | --- |
| `onboarding.draft.get` | 获取当前活动草稿和下一个步骤 | 否 |
| `onboarding.draft.upsert_step` | 新建或修订某一步草稿并预校验 | 否 |
| `onboarding.draft.request_confirmation` | 绑定当前 revision，返回 confirmation ID | 否 |
| `onboarding.draft.accept_step` | 消费确认并将该 revision 定稿 | 否 |
| `onboarding.draft.enqueue_commit` | 冻结完整快照并排队 | 否 |
| `onboarding.draft.commit_status` | 查询提交状态，供恢复或用户追问 | 否 |

后台 worker 调用内部服务函数，不向 Workspace Agent 暴露任意文件写入接口。

现有 `onboarding.confirm_portfolio`、`onboarding.confirm_step` 和 `onboarding.complete_watch_setup` 在迁移期保留兼容，但新版模板不得再在草稿流程中调用它们。待新模板和现有用户迁移稳定后，再决定是否删除旧操作。

## 10. 统一提交执行

### 10.1 冻结与领取

`enqueue_commit` 必须在单个 SQLite 事务中：

1. 确认所有必需步骤的当前 revision 已接受。
2. 确认没有仍待确认的当前规则草案。
3. 生成不可变 `commit_snapshot_json`。
4. 生成唯一 `commit_key=draft_id:revision`。
5. 将状态改为 `queued`。

后台 worker 通过条件更新从 `queued` 原子领取为 `applying`，避免重复执行。

### 10.2 一次读取、一次合并

提交器必须复用现有 onboarding 校验和规范化函数，但不能按旧步骤逐个调用 writer。它应：

1. 一次读取现有 portfolio、strategy、schedules、notification、watch 和 onboarding state。
2. 在内存中将完整冻结草稿投影为最终配置。
3. 合并复盘时间、盘中简报和通知偏好对 `schedules.yaml` 的共同影响。
4. 在写入前验证最终对象，不只验证单步 payload。
5. 每个目标文件最多写入一次。

典型正式写入集合：

- `config/portfolio.yaml`
- `config/strategy.yaml`
- `config/schedules.yaml`
- `config/notification.yaml`
- `config/watch.yaml`
- `config/onboarding_state.yaml`
- 可选的服务层 `watch_rules`
- `memory/change_log.jsonl` 中一条统一提交记录

### 10.3 写入顺序

推荐顺序：

1. 对所有最终对象做完整预校验。
2. 保存目标文件提交前快照，供失败恢复。
3. 写 portfolio、strategy、schedules、notification、watch。
4. 在幂等事务中创建或核对可选 watch rules。
5. 回读并校验所有正式结果。
6. 最后写 `onboarding_state.yaml` 为 `completed`。
7. 记录统一成功审计和 change log。
8. 将草稿标记为 `completed` 并创建唯一完成通知。

`onboarding_state.yaml` 必须最后完成，避免其他配置只写了一部分却对外显示 Onboarding 已结束。

### 10.4 幂等与恢复

- 同一 `commit_key` 不得产生重复规则、重复 change log 或重复完成通知。
- 文件写入采用“从冻结快照生成目标状态”的覆盖式幂等语义，不依赖上一次执行停在哪一步。
- 中途失败时，优先恢复提交前文件快照；若恢复也失败，保留 `failed_retryable` 和明确审计，不将状态标为完成。
- 重试必须继续使用原冻结快照；用户若要修改，应先取消失败任务并生成新 revision。
- 服务重启后自动扫描 `queued`，并回收超过执行租约的 `applying` 任务。

## 11. 异步完成通知

提交成功或失败都应通过服务已有的权威会话与推送链路发送，而不是依赖原 ACP 回合继续存活。

- 成功消息写入 `conversation_messages`，并按用户当前渠道进入推送队列。
- 微信上下文暂不可用时沿用现有 `awaiting_user` 恢复机制，不丢失完成结果。
- Portal connector 在线时同步同一条权威消息。
- 使用 `commit_key` 作为通知幂等键，禁止 worker 重试造成重复通知。
- 失败消息只说“初始配置暂未完成，我保留了已确认草稿，会继续重试或请你稍后再试”，不暴露内部路径和异常堆栈。

## 12. Skill 与提示词调整

`templates/workspace/skills/wechat-onboarding/prompt.md` 应改为：

- 不再把 `config/onboarding_state.yaml.current_step` 作为草稿期的唯一进度来源。
- Onboarding 未完成时，先读取 `onboarding.draft.get`；有活动草稿则从草稿的下一步骤恢复。
- 每一步明确区分“已加入草稿”和“已保存生效”。
- 中间确认后调用 `accept_step`，不得调用正式配置写入工具。
- 用户提前提供后续信息时写入对应未确认草稿，不重复询问。
- 最后一步接受后调用 `enqueue_commit`，返回等待提示，不再同步写文件。
- `commit_status=completed` 后正常退出 Onboarding；`failed_retryable` 时诚实说明仍未生效。

`skill.md` 与 manifest 输出也应从旧的 `onboarding.confirm_*` 改为 draft 工具集合。

## 13. Platform 与审计

Platform 的 Onboarding 审计视图应能区分：

- 正在收集草稿；
- 某一步已确认但尚未生效；
- 正在统一提交；
- 已完成；
- 提交失败待重试。

不得把 `accepted` 展示成“已写入”。建议显示草稿 revision、已确认步骤、排队/开始/完成时间和最后错误摘要。客户界面无需暴露这些内部字段。

审计至少记录：

- `onboarding.draft.upsert_step`
- `onboarding.draft.accept_step`
- `onboarding.draft.enqueue_commit`
- `onboarding.commit.started`
- `onboarding.commit.completed`
- `onboarding.commit.failed`

## 14. 实施范围

实现 Agent 应先核对并修改以下边界，避免在 workspace prompt 中手写服务行为：

- `src/db/schema.ts`、`src/db/index.ts`：新增专用草稿存储及索引。
- `src/services/onboarding.ts`：拆分“规范化/合并最终配置”和“实际写入”，增加统一提交器。
- `src/mcp/service-tools-core.ts`：新增草稿读取、修订、确认和排队工具。
- `src/mcp/invest-agent-service-tools.ts`：暴露严格 schema。
- 后台调度/任务模块：领取、重试和恢复 Onboarding commit。
- `src/services/push-queue.ts` 及权威会话日志入口：发送幂等完成通知。
- `templates/workspace/skills/wechat-onboarding/*`：切换到草稿语义。
- `.codex/skills/onboarding-flow-eval/*`：把质量标准从“每步成功写入后继续”更新为“每步草稿接受后继续，最终统一写入”。
- `docs/service-tools-mcp.md`、`docs/system-overview.md`、`docs/table-ownership.md`：同步当前契约和所有权。

这是数据库与 MCP 契约变更。实施时必须同时遵循项目 `db-migration`、`service-api-change`；生产部署再遵循 `volcano-ops`。

## 15. 实施顺序

### 阶段 A：草稿契约与同步统一提交

1. 增加专用草稿表和 repository/service。
2. 增加 upsert、request、accept、get 工具。
3. 抽取一次读取、一次合并、一次写入的统一提交器。
4. 先提供同步 commit 测试入口，验证正式配置结果与现有流程一致。

阶段 A 不切换模板，避免未验证的新流程影响用户。

### 阶段 B：异步提交与通知

1. 增加冻结快照、领取租约、重试和恢复。
2. 增加成功/失败权威消息和幂等推送。
3. 验证服务重启、微信上下文过期和 Portal 在线/离线场景。

### 阶段 C：模板切换与兼容

1. 更新 Onboarding skill 使用 draft 工具。
2. 保留旧 confirmed-write 工具供冻结用户兼容。
3. 对新用户运行完整真实 Onboarding 评测。
4. 对已有未完成 Onboarding 用户采用“读取正式完成步骤 + 创建缺失草稿”的兼容迁移，不回退已经生效的配置。

### 阶段 D：收敛

1. 观察草稿接受耗时、提交成功率、重复确认率和恢复率。
2. 稳定后停止新版模板调用旧 `onboarding.confirm_*`。
3. 是否删除旧 API 另行决策，不在首次交付中扩大范围。

## 16. 验收标准

### 16.1 用户体验

- 每一步确认后，回复明确说“已加入草稿”，并自然进入下一步。
- 任一中间确认后，正式 Workspace 文件内容和 `onboarding_state.yaml` 均不变化。
- 用户修改已确认步骤时，只使该步骤新 revision 待确认，不重问其他步骤。
- 最后一步确认后，不出现“确认完成”。
- 用户先收到统一配置中的等待提示，随后收到独立完成通知。
- 客户回复中不出现 MCP、SQLite、文件路径、revision、job 或错误堆栈。

### 16.2 确定性契约

- 每个 accepted step 都能关联精确 payload、confirmation ID 和确认消息。
- 过期、跨用户、跨实例、跨会话或 payload 不一致的确认不能接受。
- 未全部确认时不能 enqueue。
- enqueue 后修改活动草稿不能改变已冻结的 commit snapshot。
- 同一 commit key 重试不会重复创建规则、日志或通知。
- 只有所有正式配置回读校验成功后，`onboarding_state.yaml.status` 才能变为 `completed`。
- 失败任务保留草稿和错误审计，不声称配置已经生效。

### 16.3 性能与可靠性

- `accept_step` 服务端不读取或写入 Workspace，正常情况下只执行一次短 SQLite 事务。
- 最终提交对每个目标 Workspace 文件最多读取一次、写入一次。
- 最后一步确认后的等待提示不依赖提交任务完成。
- 服务在 queued/applying 状态重启后可以继续或安全重试。
- 完成通知在微信暂不可达时进入现有恢复队列，不被静默丢弃。

### 16.4 回归

- 第一轮仍明确“我是你的投资助手”和初始配置语境。
- 持仓、现金和观察仓仍支持文字与截图。
- 通知偏好仍然只在低打扰、积极盯盘、晚间汇总三者中选择一个。
- 规则仍需明确、可执行、单独确认；跳过规则不会创建任何规则。
- 普通微信消息仍走 workspace ACP 直通路径。

## 17. 测试与评测建议

确定性测试至少覆盖：

1. 草稿步骤创建、修订、确认、过期和跨 scope 拒绝。
2. 中间确认后六个正式配置文件零变化。
3. 完整草稿统一提交后的最终文件内容。
4. 三个步骤共同修改 `schedules.yaml` 时只产生一次最终合并写入。
5. 提交中途失败、快照保留和幂等重试。
6. 重启时 queued/applying 恢复。
7. watch rule skip/configured 两条分支。
8. 完成通知去重及 `awaiting_user` 恢复。
9. 已有部分完成用户的兼容迁移。

语义评测使用 `onboarding-flow-eval` 运行至少三个真实旅程：默认偏好、用户中途修改已确认内容、提交期间微信暂不可达。评测必须同时检查客户对话、草稿记录、确认记录、审计、最终 Workspace 和通知结果。

## 18. 风险与缓解

### 草稿和正式状态出现双重来源

草稿期以 `onboarding_drafts` 为唯一进度来源；正式 `onboarding_state.yaml` 只描述已生效状态。模板必须明确读取优先级，Platform 必须分别标注“草稿”和“已生效”。

### 异步任务增加系统复杂度

限制为 Onboarding 专用任务，不恢复通用 conversation task 框架。使用单表状态机、唯一 commit key、有限重试和现有 push queue，避免建设通用工作流引擎。

### 用户在提交中继续修改

queued 后的 snapshot 不可变。用户的新修改进入下一 revision，不能悄悄改变正在提交的版本；首次提交完成后再按普通配置修改流程处理。

### 多文件写入部分成功

状态文件最后写，提交前保存快照，目标状态从冻结 payload 幂等重建，失败时回滚或重试。绝不以“部分文件写过”作为完成依据。

### 完成通知无法及时触达

写入权威会话日志并进入现有推送恢复队列。用户再次发消息时可以恢复通知，也可以通过 `commit_status` 主动查询。

## 19. 待实现时确认的问题

以下问题不影响总体方向，但实现前应在代码核对后定稿：

1. 完成通知是否已有可直接复用的幂等键字段；若没有，应在 push queue 增加最小唯一约束还是由 onboarding draft 记录 `notified_at`。
2. WorkspaceStore 当前 writer 是否已经采用临时文件加原子 rename；若没有，统一提交器需要补充最小原子写保障。
3. 现有未完成用户是否存在已写正式文件但 onboarding state 未推进的异常数据，需要部署前审计并制定逐用户迁移规则。

## 20. 执行 Agent 交接提示

> 按 `docs/onboarding-draft-commit-design.md` 实现 Onboarding 草稿确认与统一提交。先使用 `db-migration` 和 `service-api-change` 核对数据库及 MCP 契约；不要恢复普通消息服务层分流，也不要复活通用 `conversation_tasks`。先完成草稿状态、确认绑定和同步统一提交的确定性测试，再实现异步 worker 与幂等完成通知，最后切换 workspace onboarding skill。实施后提供迁移、回滚和真实 Onboarding 评测证据。

## 21. 验收 Agent 交接提示

> 独立验收 `docs/onboarding-draft-commit-design.md`。重点证明：中间确认不改任何正式 Workspace 文件；修改草稿只废弃对应 revision；最后一步后先返回等待提示；后台只按冻结快照提交；所有文件校验成功后才完成 onboarding；重试不产生重复规则或通知。结合对话日志、draft/confirmation/audit 记录、Workspace 文件和推送结果给出 pass/partial/fail，不以单元测试通过代替真实旅程证据。
