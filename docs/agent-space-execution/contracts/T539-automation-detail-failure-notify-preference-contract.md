# T-539 实施契约：自动化详情升级、失败告知与通知偏好（P2）

任务：os-mcp T-539（executor: agent）。前置：T-537（可与 T-538 并行，两者改动面不同：本契约主要在 automation/attention/notify 面，T-538 在 agent_space 对象面；仅侧栏入口有少量汇合，以后合并者为准）。
设计依据：[正式设计 §6/§7/§8](../../agent-space-user-product-design.md)；差距：[T537-gap-analysis D3/D4/D5/A3/A4/A5/U1/U4/U5/U6](../T537-gap-analysis.md)。

## 目标

111 隔离环境完成：自动化任务详情四块信息升级；全局「待处理」失败告知（服务拥有的 attention 事实）；通知偏好设置页；T-479 恢复通知策略调整为「成功与自动恢复默认不提醒」。网页保存完整失败告知，微信只是同语义投影，且假投递环境下可全链路验证。

## 输入

- 隔离环境与 111 数据：98 条自动化运行历史（含真实失败 run 可选作展示样本）、T-479 实现 `src/services/automation-notify.ts`（幂等键、audit、quiet 包装）、needs_attention 状态机（`automation-tasks.ts` 连败 ≥3）。
- 分层结果数据源：`agent_space_run_outcomes`（111 有 6 条）+ `automation_task_runs` + `push_jobs`/`weixin_delivery_attempts`（执行/产物/投递三层事实）。

## 工作内容

1. **attention 事项事实（服务层新对象）**：
   - 新表（走 db-migration 流程，仅隔离库先行）：attention_items —— 幂等键（如 `automation:<taskId>:failure:<runId>`，与 T-479 通知幂等键同源）、用户可读字段（失败任务/交付、发生时间、直接影响摘要、系统当前状态）、生命周期（open → resolved，自动恢复即 resolved，去重与保留服务端维护）、审计；
   - 挂点：`notifyAutomationRunTerminal` 决策器处同事务写事项（通知与事项同一事实源）；
   - **不向用户暴露状态机**：Portal 只读列表 + resolved 归档展示，无手动收口操作。
2. **T-479 策略调整**：恢复微信通知默认不发（代码路径保留，由偏好/类别开关决定）；失败首条通知保留。回归五场景：失败、连败、恢复、微信投递失败（Portal 告知不受影响）、Portal 可见性；断言任务终态/失败事实/重试语义零变化。
3. **connector API**：`attention.list / attention.get`（scope 派生 + redact）；`automation.detail` 聚合读模型（目标/依赖产物跳转句柄/执行·产物·投递分层结果/关联 attention 摘要）；`preference.get / preference.set`（微信提醒开关/静默时段/类别）。
4. **Portal**：全局「待处理」页（失败卡片固定字段：任务/交付、时间、直接影响、系统状态、「让 Agent 解释并处理」入口——入口按钮本任务只做占位路由，语义落地在 T-540）；侧栏入口带未处理数；`/automations` 详情四块改造（复用 AutomationWorkspace 的 task view）；最小设置页（通知偏好）。
5. **失败反例构造**（`scripts/agent-space/p0/seed-failure-fixtures.mjs`）：在隔离库经服务层构造 1 个 needs_attention 任务 + 2 条 open attention 事项 + 1 条已恢复事项（微信投递失败反例一例），供页面与回归验证。
6. **偏好语义**：偏好只影响提醒投递，不改变事项事实、任务状态、运行与授权；关闭微信提醒不删除网页告知。

## 边界（红线）

- 首版待处理只展示失败事项，不做细分类/改进队列/手动收口；不展示错误码、trace、重试次数、工具调用、版本 ID。
- attention 事项是服务拥有事实：写入只发生在既有终态钩子，禁止任何 Agent/前端直写。
- 恢复通知调整必须用回归测试证明未改变失败事实；不可为省事整体禁用 notify。
- 不改生产、不部署。

## 验收

- 隔离环境 verify 全过 + 新增：构造的失败反例经 `attention.list` 可读、跨 scope 0 行、resolved 事项保留可查；
- 浏览器走查：待处理页卡片字段齐全、未处理计数正确、从卡片可跳任务详情；任务详情四块齐全且分层结果时间线可辨（执行成功但投递失败的 run 能区分显示）；设置页偏好改动后隔离环境行为符合 §8（不改变事实）；
- 回归：T-479 五场景测试全绿；`npm test` 全绿；
- 微信投影在 OFFLINE 假投递下验证：投递失败被记录、Portal 告知仍完整（这正是 §7.2「微信投递失败不得让网页告知消失」的直接证据）。

## 失败与上报

- run_outcomes 对 111 历史运行覆盖不全（仅 6 条 W7 后记录）导致分层结果大量缺失：属真实形态，按「无数据层显示未知」处理并在报告标注；不得用 push_jobs 推测补写 run_outcomes。
- attention 表结构涉及生产迁移时：本文档只授权隔离库建表 + 代码路径；生产迁移与发布归 owner 后续授权任务。
