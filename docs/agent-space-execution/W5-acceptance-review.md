# W5 独立验收与返工单

日期：2026-09-20；复核提交 `9c604d0`，依据 [W5 执行稿](./W5-tasks-state-commitments.md) 及已通过的 W1–W4 契约。

## Acceptance Verdict

Status: **Partial — 不放行 W6/W7，先完成 W5 的窄返工。**

W5 已交付可用的状态对象读模型、按会话/任务/Agent 收窄的基本包、版本钉住的 run-basis、结果时间线和两期承诺夹具。隔离域测试 33/33 可重复通过。但执行稿明确要求的“过期/停用有记录”与“起始检索和补查共用硬预算”尚未实现为可验证语义；此外 outcome 记录没有绑定可信事实来源，无法把 `delivery_succeeded`、`user_read` 等称为观察到的事实。故不接受“闭环已完成”的结论。

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 作用域 State Packet | 会话/任务仅纳入自身与执行 Agent 状态；草稿/拒绝不生效；冲突/去重/预算有解释 | Partial | `src/services/agent-space/state.ts:520`；W5 域测试 | owner 过滤、counterexample、去重与 budget-exhausted 已有实证；expired/disabled 无解释记录，见 R1。 |
| W4 run-basis 集成 | 状态版本固定、可按 versionId 重读、状态不扩大 skills/methods/assets | Pass | `assembly.ts:573`、`agent-space-context.ts` 状态注入；W5 域测试 | basis 只记录引用和检索信息；注入按冻结 versionId 读取。 |
| 补查与硬预算 | 起始检索与补查共享硬预算、分页不能越过已裁剪集合 | Partial | `buildScopedStatePacket` | 同一 budget+offset 不会越过裁剪集合；但没有 page size/continuation 语义，且每次调用都能另传 budget，见 R2。 |
| 分层运行事实 | 执行、产物、投递、阅读分别记录、可审计且事实来源可信 | Partial | `tasks.ts:444`；W5 域测试 | append-only、scope、幂等、时间线均通过；任意 actor 与任意 detail 可自报任意 kind，见 R3。 |
| 承诺闭环 | 两期履约、投递失败、暂停授权恢复、关闭学习不取消任务 | Pass | `state.ts:671`、`:771`；W5 域测试 | recurring 保持 active，pause/resume 走既有授权；履约与 run scope 绑定。 |
| 验证 | 隔离域验证 | Pass | `node --import tsx --test --test-force-exit tests/agent-space-domain.test.ts` | 本轮独立执行：33/33 通过。全仓 723/723 与 build/tsc 为执行方报告，未作为独立结论。 |

## Findings

### R1 [P1] expired / disabled 被静默过滤，违反“有记录”验收项

`listEffectiveState` 在 `state.ts:448` 的 SQL 直接限制 `status='active'` 且未过期；`buildScopedStatePacket` 只遍历该结果。因此草稿、rejected、expired、disabled 的对象既不进入 entries，也不进入 exclusions，run-basis 无从解释“为什么本轮没有加载它”。现有 W5 测试只断言 rejected 不出现，未断言 rejected/expired/disabled 的理由。

通过标准：检索可继续只注入有效对象，但需以 scope 内候选/状态清单产出可审计 exclusion（至少 `inactive-status` / `expired`，包含 objectId 与状态）；这些原因进入冻结 run-basis 和最终注入说明。补 rejected、disabled、expired 三个反例，确认不会注入、会留解释、跨 scope 仍不可被枚举。

### R2 [P1] 所谓“补查分页共享硬预算”没有续页契约

`buildScopedStatePacket` 的 `page = budgeted.slice(offset)` 没有 page size，所以第一页已返回预算内所有条目且 `hasMore` 正常总是 false；传入 offset 只是手动跳过前缀。更关键的是调用方每次可提供新的 `budgetChars`，没有将首次总预算、已使用量或 continuation token 固定到同一查询/同一 run-basis。现有 tiny/offset 测试只验证“两次都传 1”时无法绕过，并不能验证补查共享同一预算。

通过标准：定义最小 continuation 契约（例如 run/basis 绑定的 cursor 与不可增大的总预算，或明确的 retrieval session）；首包与续页的选取、usedChars、剩余额、去重/冲突排除共享同一冻结集合。`hasMore` 必须在存在下一页时为 true。测试至少覆盖：三条可纳入状态 + page size 1、续页拿到下一条、以更大 budget 或伪 cursor 试图拿回首次被 budget 排除项被拒绝/仍排除。

### R3 [P1] outcome 是可伪造声明，不是分层事实记录

`recordRunOutcome` 只验证 run 同 scope；`kind`、`detail` 和 `actor` 都由调用者任意填写。任何能够调用该服务的 Agent 路径都能把不存在的 artifact、delivery_succeeded 或 user_read 记录为既成事实，审计只复述同一个 actor 字符串。没有 artifact/delivery/read 的可信 source reference 或服务侧写入入口校验。

通过标准：保持“不重写调度器”的边界，但给每类 outcome 定义可核对来源与允许写入方：执行绑定真实 run；artifact 绑定同 scope 的真实资产/工件；delivery 绑定真实 delivery/push 记录；user_read 只能由受信的用户读取事件写入。若相应生产事实表尚无统一来源，则类型必须显式为 pending/claimed，而不能使用 succeeded/read 的事实名称。补跨 scope、伪 asset/delivery/read ref 与非受信 actor 的拒绝测试；成功路径引用真实测试行。

## Follow-Up Checklist

- [ ] 执行 Agent 仅返工 R1–R3；不改调度器、不切 W4 开关、不迁移真实用户或部署。
- [ ] 更新 W5-delivery，撤回“过期/停用本就不在有效集”即已满足解释记录、以及“闭环完成”的过度表述。
- [ ] 返工后复验 State Packet 续页、状态排除证据、outcome 事实来源及既有 33 项回归。

## 第二次验收：14a4e61（2026-09-20）

## Acceptance Verdict

Status: **Partial — R1/R2 通过，R3 未收口；不放行 W6/W7。**

本轮的状态清点和 basis continuation 已达到执行稿要求：失效状态现在可解释、跨 scope 不可枚举，续页从冻结 run-basis 读取且不能换预算重算。结果记录的“来源存在”也比上一轮严格，但仍没核验来源与本次 `runId` 的因果关系，因而可把另一轮的 sent push 记为当前 run 的成功投递。它不能作为每个 run 的事实时间线。

## Acceptance Checklist Update

| Area | Status | Evidence | Judgment |
| --- | --- | --- | --- |
| R1 状态失效排除 | Pass | `state.ts:listScopeStateInventory`；新增 W5 R1/R2 组 | scope 内 disabled/rejected/draft 记录 inactive-status，expired 记录 expired；跨 scope 查询本身不枚举。 |
| R2 basis continuation | Pass | `assembly.ts:getRunBasisStateContinuation`；新增 W5 R1/R2 组 | 分页读取冻结 entries，预算不再作为续页参数，pageSize/hasMore 可工作。 |
| R3 outcome 事实来源 | Fail | `tasks.ts:verifyOutcomeFactSource` | 仅核对资产/push job 的存在和 scope/status，不核对它属于 input.runId；execution kind 亦不比对真实 run status。 |
| 验证 | Pass with expected-error logs | `node --import tsx --test --test-force-exit tests/agent-space-domain.test.ts` | 独立执行 exit 0，34/34 通过。W4 阻断反例会输出预期错误日志，不是测试失败。 |

### R3-2 [P1] 真实投递仍可被归到错误 run

`push_jobs` 已有 `origin_run_id` 增量列（`src/db/index.ts:1104`）。但 `verifyOutcomeFactSource` 在 `tasks.ts` 查询 push job 时只取 `user_id/project_id/instance_id/status`，未选择或比较 `origin_run_id` 与 `input.runId`。所以同 scope 的任何 `status='sent'` job 都可被写成任意 run 的 `delivery_succeeded`；dead/expired job 同样可伪造另一个 run 的 delivery_failed。前一轮要求的是“分层事实”，而本轮只证明了“同用户存在一条事实”。

`execution_succeeded` / `execution_failed` 也只验证 run 存在，没有比对 `automation_task_runs.status`，仍可对失败 run 声称执行成功。`artifact_generated` 只验证 asset/version 在 scope 内，未提供可验证的 `origin_run_id` 或工件来源；在当前 schema 没有这样的可靠关系时，不能升级为 generated 事实。

通过标准（保持不重写调度器）：

- delivery 查询并校验 `push_jobs.origin_run_id === input.runId`；缺失/不等时拒绝。补同 scope、不同 run 的 sent/dead job 反例。
- execution 成功/失败从真实 run 的终态派生或至少严格匹配终态；pending/running/相反终态拒绝。
- artifact 只有在可验证 source run / artifact relation 存在时才能使用 `artifact_generated`；否则将其命名为 `artifact_claimed`，或新增纯增量、由可信产物写入路径填充的关联记录，并在服务层核验。不可把 detail 自报的 runId 当证明。
- outcome 行和审计 detail 保留其验证来源（run status、pushJobId/originRunId、artifact relation id），以便后续检查。

给执行 Agent：只定向修 R3-2 与对应反例；保留 R1/R2、承诺闭环和 W4 默认关闭。不部署、不迁移真实用户、不中途接线调度器。修毕后复验既有 34 项与新的错 run/错状态/伪 artifact 反例。

## 第三次验收：eac6531（2026-09-20）

## Acceptance Verdict

Status: **Pass with caveats — W5 收口，放行 W6 隔离迁移演练；W7 仍须在 W6 通过及 owner 决策后执行。**

R3-2 已按可核对事实边界收口：投递记录现在同时核验 scope、状态与 `origin_run_id`；执行结果匹配真实 run 终态；当前无可信 run-to-artifact/read 关系的两类记录已明确降级为 `artifact_claimed`、`user_read_claimed`，没有再冒充事实。状态包排除、冻结续页、结果分层和承诺闭环均满足 W5 执行稿。本结论仅针对本地隔离实现，未表示 W4 开关已开启、真实用户状态已迁移或生产调度已接线。

## Acceptance Checklist Update

| Area | Status | Evidence | Judgment |
| --- | --- | --- | --- |
| R1 状态排除解释 | Pass | `state.ts:listScopeStateInventory`；W5 R1/R2 测试 | expired 与 inactive 状态进入冻结 exclusions，跨 scope 不可枚举。 |
| R2 冻结 continuation | Pass | `assembly.ts:getRunBasisStateContinuation`；W5 R1/R2 测试 | 分页只读取 basis 冻结 entries，budget 不可由续页调用者改变。 |
| R3-2 运行事实因果 | Pass | `tasks.ts:fetchRunRow/verifyOutcomeFactSource`；W5 反例 | delivery 对 `push_jobs.origin_run_id` 严格匹配本次 run；执行结果严格匹配 succeeded/failed 终态。 |
| 无可信来源的语义 | Pass | `RunOutcomeKind` 与反例测试 | `artifact_generated`、`user_read` 被拒绝；仅可明确记录 claimed，不把主张升级为事实。 |
| 承诺闭环 | Pass | W5 域测试 | 两期 recurring、投递失败、pause/resume 与关闭 lesson 的边界均保留。 |
| 独立验证 | Pass | `node --import tsx --test --test-force-exit tests/agent-space-domain.test.ts` | 本轮 exit 0；34 项域测试通过。 |

## Caveats carried forward

- `artifact_claimed` 与 `user_read_claimed` 不是用户可见的交付/阅读证据；未来只有在可信 run-to-artifact 与用户阅读事件来源落地后，才能重新开放事实名称。
- W4 的 generic runner 上游端到端与 scheduled 生产 task 注册仍未作为生产证据；W4 装配模式继续默认关闭。
- W6 必须以 W0 门禁中的候选、可恢复备份和隔离库执行演练，不能把 W5 的 fixture 结果当迁移成功。

## Follow-Up Checklist

- [ ] 放行 [W6 隔离迁移演练](./W6-isolated-migration-rehearsal.md)：只处理 W0 自动可导入项，owner-review 项不得默认采用。
- [ ] W6 验收通过后，再由 owner 决定是否进入 W7 切换窗口；不得因 W5 通过自动开启运行时开关或改写真实 Workspace。
