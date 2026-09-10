# BC-20260904-001 空壳简报照推：程序全绿、语义失败的范式案例

## 记录卡片

```yaml
case_id: BC-20260904-001
status: triaged
severity: S2-medium
first_seen_at: 2026-09-04T03:00:58Z（11:00 北京，盘中窗口）
last_seen_at: 2026-09-04
reported_by: owner 会话发现（2026-09-04 诊断）；2026-09-06（T-469）经生产只读链路核实并立案
scope: 生产用户 dyk，盯盘自动化任务
channel: automation
taxonomy_ref: M3 邻接（模型行为漂移——产出内容空转）；正式入表建议走 ED-P1 例行初稿
```

## 1. 场景与结果

- 场景名称：盘中盯盘简报（wechat_summary 到点必推）11:00 窗口
- 用户/隔离实例：dyk（生产）；任务 `migrated_scheduled-market-watch_88b950f3`
- 预期事实/状态：推送内容为可用盘中简报（个股行情 + 持仓相关简评）；即使无重大异动也应为轻量但实质的说明
- 实际用户可见结果：收到 **13 字符**的元话语式 summary 照推（具体文本见生产 push_job `7188852f-b8c5-4f97-b8db-0785acfb62db`，本文按纪律不摘录正文）
- 实际系统终态：**全链成功**——automation run `atrun_d19bf8ff-69c1-40f3-b579-6fd982e058a5` `succeeded`（trace 同 ID，result_summary 非空）、push `sent`、投递 `sent`
- 禁止行为是否发生：无越权/编造/重复推送；发生的是「程序成功但用户结果不可用」——程序性信号（S1/S2/S4/S5）对此零感知，这正是本案的治理价值

## 2. 关联证据（诊断链显式 ID，2026-09-06 只读核实）

```text
runId: atrun_d19bf8ff-69c1-40f3-b579-6fd982e058a5
taskId: migrated_scheduled-market-watch_88b950f3
traceId: atrun_d19bf8ff-69c1-40f3-b579-6fd982e058a5
pushJobId: 7188852f-b8c5-4f97-b8db-0785acfb62db
message_kind: automation_summary；message 长度 13
```

同窗口对照：同日 09:56 用户 111 同型任务推送 61 字符（`atrun_02ac8804…`，亦 succeeded/sent）——说明非任务级系统性故障，是单轮模型产出质量漂移。

## 3. 归因（按数据→服务契约→工具→Prompt→模型顺序）

- 数据/工具层：无缺陷——run 成功、工具调用正常（trace 在案）。
- **模型层（主因）**：模型把 summary 写成元话语而非简报内容，单轮行为漂移；同任务前后窗口正常。
- **服务契约层（次因/防线缺失）**：交付语义为「到点必推」（2026-08-28 裁决），但服务层对 summary 内容**无质量下限**——空壳 summary 不会被拦截或降级，照常入队照推。即使模型偶发漂移，服务层防线本可把用户影响降为「收到轻量说明」而非「收到元话语」。
- 交互层：用户报「没推送」实为「收到但无内容」——受损不可见的另一面。

## 4. 影响与风险

- 用户在盘中决策窗口拿不到简报实质内容，且程序层无任何信号——**语义失败的盲区范式案例**（T-469 立项的直接论据）。
- 复发即累积信任损耗；当前仅此一次确证（2026-09-06 复核 9-4/9-5 窗口未见同型）。

## 5. 处置结论

```text
是否允许灰度：n.a.（行为+防线缺陷，无发布面）
修复路径（owner 2026-09-06 裁决：选项 A 服务层质量下限）：
  已实现（2026-09-06，T-473，随 SCR-20260906-02 待发布）：wechat_summary 推送入队前确定性校验——
  summary 去空白后低于 40 字符（AUTOMATION_SUMMARY_MIN_CHARS）时，推送消息降级为服务层模板
  （任务名+引用原文开头≤80 字+Portal 指引）；到点必推语义不变；落库 result_summary 保持模型原文。
  语义变更门判级 tier-2（自动化推送内容契约），SCR-20260906-02 随代码 commit。
回归样例：EV-038（tests/automation-summary-quality-floor.test.ts，全链+边界 3/3 绿）
观察：发布后由巡查 S7/S3 与 rubric 周评观察；降级模板触发即 logger.warn（频次可巡查聚合）
复核人：owner
关闭条件：发布 + 复核窗口内无「空壳照推」同型（降级模板触发属于防线工作正常，不算复发）
```

## 记录纪律符合性

- 未摘录推送正文、未保存 Prompt 原文；证据只含 ID 与长度等元数据（生产只读查询，2026-09-06）。

## 观察追加

- 2026-09-06（T-469）：作为语义受阻信号移交格式（Diagnosis Record）的走通案例，六问全答记录见 [customer-friction-signal-collection-design.md](../customer-friction-signal-collection-design.md) §八。
- 2026-09-06（owner 裁决 + T-473 实现）：选项 A 服务层质量下限落地（40 字符下限+降级模板+EV-038 三测全绿），随 SCR-20260906-02 待白天发布窗口；发布前案例保持 triaged，发布后按关闭条件复核。状态从「修复待裁决」进「已实现待发布」。
- 2026-09-10（T-475 观察窗口中期复核，窗口 9-06T02:04Z~09-10T03:11Z）：**无同型复发，符合关闭条件走势**。证据：①`automation summary quality floor applied` 日志 0 次触发（app.log 覆盖自 8-15，全窗口在案）——降级模板零实际送达，交付核对项 n.a.；②窗口内已投递 automation_summary（sent）0 条低于 40 字符下限、0 条含降级模板标记（最短一条 80 字符，dyk 9-07，为正常短摘要）；③run 落库 result_summary 0 条低于下限——9-04 的 13 字元话语签名未再现；④S3 催补四日仅 9-08 一条已知 111 会话命中（归因 W4 超时，与本防线无关），S6 点踩四日全 0——用户未因此受阻。SCR-20260906-02「业务终态正确」栏据此**中期回填 pass**（证据详见 [diagnostic-coverage-retest-2026-09-10.md](../diagnostic-coverage-retest-2026-09-10.md) §五）。终局：9-13 窗口收口时如仍无同型，建议 status → fixed 并关闭（owner 裁决）。
