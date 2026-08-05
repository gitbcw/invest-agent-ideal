# 用户自动化任务交互设计

## 背景与目标

本设计新增独立的用户自动化任务能力，不改变现有日、周、月复盘及其 `reviews.save`、推送和留存契约。

目标用户可以在 Portal 创建一项任务：上传或选择一个任务文件，描述希望 AI 如何维护它，设置每天/每周的执行时间，先真实运行一次确认结果，再启用定时执行。典型例子是“每天 07:30 根据我的规则维护这张投资跟踪表”。

本设计重点解决两种运行入口的体验差异：用户点击“立即运行一次”时可以与助手继续互动；计划自动运行时可以查到完整、可信的历史，但不会把普通会话列表淹没。

## 范围

首期包含：

- Portal 中的任务创建、编辑、暂停、启用、立即运行和运行历史。
- 时间触发：每日、工作日、每周指定日期和时区。
- 任务专属的长期输入与工作产物目录。
- 一个普通文件/表格维护任务的受控写入。
- 手动运行的可继续对话，以及自动运行的运行详情。

首期不包含：

- 修改当前日/周/月复盘、推送或报告保存路径。
- 事件触发、任意 cron 表达式、任意 shell 命令、第三方 API 动作。
- 持仓、规则、策略、服务配置等确定性状态写入。
- 自动任务的微信通知、多人协作、任务之间的编排。
- 加密、带宏、外部连接或复杂跨表公式的 Excel 工作簿维护。

## 核心决定

### 任务与文件的归属

- 数据库是任务定义、启停状态、调度版本、下一次运行时间、运行状态、幂等键、审计和错误信息的权威来源。
- Workspace 是用户提供的长期文件和任务产生的长期文件的权威位置。
- 创建任务时，Portal 上传的附件必须从短期附件提升为 Workspace 任务资产；不能让定时任务引用 `conversation_attachments`。后者的文件字节只有 7 天保留期。
- 任务定义不可被一次聊天的后续自然语言静默改变。编辑任务会创建新版本；下一次运行使用新版本。

每个任务使用固定目录：

```text
automations/
  <task-id>/
    source/
      original.xlsx
    working/
      maintained.xlsx
```

`source/` 是不可由任务覆盖的上传原件；任务只维护 `working/` 中的副本。服务为每次成功写入记录输出校验和，保留可恢复的有限版本或可验证的运行产物引用。

### 不向用户展示“校验/预演”

创建或编辑表单提交时，服务仍会执行格式、作用域、文件类型、文件大小、时间与写入许可验证，但 UI 不把它包装为单独工作流。

“立即运行一次”是一次真实执行：它会读取正式任务定义，并实际更新工作文件。用户用真实结果判断任务是否符合预期，而不是先理解 dry-run 概念。

## 信息架构

Portal 增加一级入口“自动化”。

- **任务列表**：任务名、状态、触发时间、下次运行、最近一次结果和快捷操作。
- **任务编辑页**：名称、时间、时区、任务说明、输入文件、工作文件、暂停/启用状态。
- **任务详情页**：概览、文件、运行历史三个标签；“立即运行一次”始终可见。
- **运行详情抽屉/页面**：一条运行的结果、文件变化、错误与继续操作。

Excel/CSV 不依赖当前 Workspace 浏览器展示。自动化详情直接提供任务资产的受限下载；CSV 表格预览和 XLSX 在线预览可后续增加。

## 创建与启用流程

1. 用户填写任务名称、执行时间和任务说明，上传一份文件。
2. 用户点击“创建任务”。服务创建 `paused` 的任务版本，持久化到数据库，并将上传附件复制到任务目录的 `source/` 与 `working/`。
3. Portal 进入任务详情页。用户可以点击“立即运行一次”。
4. 实际运行成功后，Portal 显示工作文件、修改摘要与本次会话入口。用户确认结果符合预期后点击“启用定时执行”。
5. 启用后的自动运行不需要每次再次确认；编辑任务后生成新版本，并要求用户重新启用该版本。

失败并不自动启用任务。任务详情明确显示失败原因和“再次立即运行”的入口。

## 手动运行：执行会话

点击“立即运行一次”必须创建一个新的 Portal 会话，而不是在当前聊天或某个隐藏后台会话中执行。

- 会话标题：`自动化：<任务名称> - 手动运行`。
- 会话 metadata 绑定 `taskId`、`taskRevision`、`runId`、`origin=automation_manual`。
- 首条可见消息说明这是一次用户主动的实际运行，并附任务说明、输入文件与目标工作文件的简洁描述。
- 助手在此会话中执行任务，回复本次结果、已更新文件和可继续处理的事项。文件产物以卡片或下载入口附在助手结果上。
- 用户可以在该会话继续问结果、要求解释、要求调整当前工作文件；但“修改定时任务的规则、时间、文件绑定或启停”必须回到任务编辑页，生成新的任务版本，不能从聊天文本自动生效。

Portal 可以展示少量确定性执行状态，例如“正在读取文件”“正在生成更新”“已写入工作文件”“运行失败”。不得把模型的内部推理、完整工具调用、token 或服务路径当作聊天内容展示。

手动会话的价值是互动，而不是充当任务的永久记忆。每次用户点击“立即运行一次”都创建新会话，保证结果能绑定到单一的输入文件版本和任务版本。

## 自动运行：运行历史，不创建普通会话

计划触发的运行应写入任务运行历史，但默认不在 Portal 普通会话列表中创建一条新对话。

每条运行记录至少包含：

- 运行 ID、任务 ID、任务版本、触发来源（计划/手动）、计划时间、开始/完成时间与状态。
- 输入文件与输出文件的路径、校验和、大小和下载引用。
- 面向用户的结果摘要或错误摘要。
- 可审计的 ACP trace、工具/写入事件和幂等键引用，仅作为受权限保护的运行诊断信息。

任务详情的“运行历史”按时间倒序展示。点击某条记录打开运行详情，而不是直接进入一个历史聊天。运行详情提供“下载本次工作文件”“使用当前任务再次运行”“在对话中继续”三个入口。

“在对话中继续”创建一个新的普通 Portal 会话，首条消息带入该次运行的摘要、任务版本和产物引用。它不是恢复后台调度上下文，也不会自动再次写文件。用户在对话中明确要求后才进行新的互动操作。

## 为什么不让每次自动运行都成为聊天会话

自动任务可能每天长期执行。将每一次后台执行都保存成普通对话会造成：

- 普通聊天列表被大量机器运行记录占满。
- 同一会话累积过期上下文，下一次运行容易被旧结果和用户讨论污染。
- 用户难以区分“查看一次历史执行”与“继续对话并可能产生新副作用”。
- 后台最小权限会话与交互式会话的权限边界变得模糊。

因此推荐的映射是：**一次手动运行对应一个可对话会话；一次自动运行对应一条可展开的运行记录。** 两者均绑定同一个 `runId`，互相可跳转，但不是同一种对象。

## 运行状态

任务状态：`paused`、`active`、`needs_attention`、`archived`。

运行状态：`queued`、`running`、`succeeded`、`failed`、`skipped`、`cancelled`。

状态规则：

- 创建和编辑后的新版本默认 `paused`。
- 手动运行可以在 `paused` 状态执行；成功不自动将任务改为 `active`。
- 同一任务同一计划窗口只允许一个成功的运行；重试沿用该运行的幂等键。
- 连续可恢复失败达到阈值后任务进入 `needs_attention`，停止继续产生噪音，等待用户处理。
- 任务暂停不会删除历史、源文件或工作文件。

## 服务与 Portal 边界

Cloud Portal 只负责交互，不能直接访问本地 Workspace 或充当任务权威。需要通过 Portal connector 新增受 scope 保护的命令：

- `automation.list` / `automation.get`
- `automation.create` / `automation.update` / `automation.activate` / `automation.pause`
- `automation.run_now` / `automation.runs.list` / `automation.run.get`
- `automation.asset.get`
- `automation.continue_in_chat`

本地服务负责验证当前用户、项目、实例与 Workspace 的一致性，保存定义与运行状态，执行调度，并在任务启动时建立最小权限 ACP 会话。通用任务不得因为 task type 未知而继承当前互动会话的写入工具。

对于表格文件，执行器使用结构化表格读写能力并原子替换 `working/` 文件；不能把 `.xlsx` 当纯文本直接生成或拼接。输入不支持时必须在任务详情给出可操作错误。

## 验收标准

- 用户能创建一个处于暂停状态的每日文件维护任务，且任务、文件引用和任务版本可在数据库中按 user/instance scope 查到。
- 用户点击“立即运行一次”后，Portal 打开新的任务执行会话；该会话与唯一 `runId` 绑定，并显示真实执行结果。
- 成功手动运行会更新 `automations/<task-id>/working/`，但不会改写 `source/` 原件。
- 用户可在该会话继续讨论结果；要求修改任务定义时不会静默生效，而是进入任务编辑版本流。
- 用户启用任务后，计划执行生成一条运行历史，不生成普通聊天会话。
- 用户可从任一自动运行记录查看状态、摘要、文件输出和错误，并能显式创建一个新会话继续讨论。
- 附件在 7 天后被清理不影响已创建任务的源文件和工作文件。
- 用户 A 不能列出、下载、运行、继续或查看用户 B 的任务、文件、会话或运行记录。
- 现有日/周/月复盘与其推送、保存、历史查询行为保持不变。

## 未决事项

- 首期是否只支持一份输入表格和一份工作表格，还是允许一个任务有多个受控文件。
- 工作文件的历史版本保留数量和保存期限。
- 手动执行会话中允许的“调整当前工作文件”范围，以及是否必须再次显式确认覆盖操作。
- XLSX 首期支持的工作簿特性和单文件大小上限。

## 执行交接

Executor prompt:

Implement the automation-task capability described in this document. Preserve the current review scheduler and publication contract. Make the database task/run records, Portal connector contract, task-owned Workspace asset lifecycle, run-now conversation bridge, and scheduled-run history agree on one `taskId`, version, and `runId`. Treat every cross-user or path escape as a hard failure. Add contract tests for the acceptance criteria.

Reviewer prompt:

Review the implementation against this document. Verify especially that manual runs open a bound interactive conversation while scheduled runs only create run history, task assets survive attachment cleanup, task definition changes are versioned and explicit, and existing review scheduling remains unchanged.

### 验收 v1 · 2026-08-05
- 验收范围：本设计“验收标准”的全部九项，以及其声明的首期边界。
- 逐条判定：
  - [auto] 创建暂停任务、版本、文件与 scope：通过。证据：`node --import tsx --test tests/automation-tasks.test.ts tests/automation-portal-contract.test.ts tests/sandbox-context.test.ts` exit 0（12/12）；任务、版本、资产分别落在 `automation_tasks`、`automation_task_revisions`、`automation_task_assets`，并按 `user_id + project_id + instance_id` 查询。
  - [checklist] “立即运行一次”创建绑定唯一 `runId` 的会话并显示真实结果：不通过。会话和绑定已实现（`src/services/automation-runner.ts:143-190`），但 ACP 失败在 `src/acp/agent.ts:137-162` 被转换成普通文本响应；运行器只要 executor 未抛异常便在 `src/services/automation-runner.ts:164-176` 写为 `succeeded`。因此超时、模型或工具失败可显示为成功结果。
  - [checklist] 成功手动运行只更新 `working/`，不改写 `source/`：不通过。受控 staging、源文件隔离及服务侧写回逻辑存在，且注入式执行器测试通过；但上述 ACP 失败会仍然提交未被实际维护的工作文件并标为成功，不能证明“成功运行”确实完成了文件维护。
  - [checklist] 手动会话可继续讨论，任务定义修改不静默生效：无法判定。任务编辑已产生新版本并暂停，且测试覆盖版本冲突；但会话后续经普通 `chatViaConversationLog` 处理（`src/services/conversation-log.ts:526-554`），没有把会话 metadata 重新强制为任务资产 scope，也没有端到端证据证明继续对话只可调整该任务工作文件。
  - [auto] 启用后计划执行只产生运行历史、不产生普通会话：不通过。注入式运行测试证明一次正常执行符合该映射；但 scheduler 仅以进程内 `Set` 去重（`src/scheduler/automation.ts:5-30`），运行记录也没有租约或过期恢复。进程在 `running` 状态终止后，后续相同幂等键只能取回旧记录，任务可永久卡住，不能可靠完成后续计划执行。
  - [checklist] 自动运行记录可查看状态、摘要、文件输出、错误，并显式创建新会话：无法判定。connector/service 命令已实现且单元测试覆盖部分合同；本工作区没有 Cloud Portal 的任务列表、详情、运行历史或新会话 UI，无法验证用户实际可完成这些操作。
  - [auto] 附件 7 天清理不影响任务资产：通过。自动化资产位于 `automations/<task-id>/source|working/`；`tests/automation-tasks.test.ts` 的 attachment-cleanup 场景在本次 12/12 测试中通过。
  - [checklist] 跨用户隔离：通过（服务层）。任务、资产、运行读取与继续入口均经 scope 查询；任务和 connector 合同测试证明用户 B 不能列出或读取用户 A 的资产，静态复核显示运行与继续入口同样先按 scope 查询。仍缺少覆盖全部 Portal 命令的跨用户集成测试。
  - [auto] 原有日/周/月复盘、推送、保存和历史查询保持不变：通过。`npm test` exit 0（351 passed），`npm run test:boundary` exit 0（7 suites），`npm run build` exit 0；自动化调度使用独立的任务和运行表，未复用旧复盘运行记录。
- 结论：不通过。
- 路由建议：执行问题→修复后重跑验收。必须让 ACP 失败显式结束为 `failed` 且不提交工作文件；为运行记录增加租约、超时回收或可重试恢复，并以任务级写锁串行化手动与计划运行；将自动化会话的后续交互重新置于任务资产与审计边界；补齐真实 ACP 的 CSV/XLSX 端到端测试。交付问题→在对应 Cloud Portal 仓库实现并浏览器验证自动化任务列表、编辑、运行历史与详情 UI，然后重新验收。
- 备注：本次实际执行的测试均通过，但它们使用注入式 executor，未证明真实 ACP 能以结构化方式维护 CSV/XLSX。实现目前没有专门的表格执行器或 XLSX 产物校验；这一点与“不能把 `.xlsx` 当纯文本拼接”的首期边界不相符。
