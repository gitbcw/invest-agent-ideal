# T-530 独立验收记录

日期：2026-09-21。依据：T-530 任务卡、`T530-ab-replay-report.md`、`.state/agent-space-w7-replay/20260921T3/report.json`、`scripts/agent-space/w7-ab-replay.mjs`。

## Acceptance Verdict

Status: **Pass with caveats — T-530 隔离回放交付可接收；T-531 暂不放行。**

T-530 已使用灾备快照中的 mg/111/dyk 真实历史数据，在隔离 DB、隔离项目根、假模型网关和假投递 sender 中完成旧 Workspace 装配与新 Agent Space 装配的 A/B 对照。报告记录 73/73 机器检查通过，覆盖装配差异、run-basis、execution/delivery outcome、跨 scope 拒绝和未迁移引用。该证据足以完成 T-530 的回放目标，但不构成生产切换、真实 Portal/微信/调度或真实模型输出证据。

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 真实数据来源 | 使用灾备快照和 W0 清单的受控副本，记录输入指纹 | Pass | `T530-ab-replay-report.md` §0；`.state/agent-space-w7-replay/20260921T3/00-inputs/input-facts.json` | 快照 DB 只读、快照目录未写入的纪律有脚本护栏和报告声明。 |
| A/B 装配比较 | 同任务比较旧 Workspace 与新 Agent Space | Pass | 报告 §1；`report.json` 73 checks | A 侧 workspace/skill 面与 B 侧显式 Agent Space 装配差异有计数和 basis 证据。 |
| 运行与投递事实 | 覆盖成功、失败、execution outcome、delivery outcome 和 origin run 关联 | Pass | 报告 §2；`report.json` checks | 仍是隔离假网关/假 sender，不能替代真实 smoke。 |
| scope 与引用 | 检查跨 scope 拒绝、资产字节可解析、旧路径/标题引用 | Pass | 报告 §3–4；`04-references/` | 已知 `logs_2.sqlite` WAL 缺失被区分为 W0 已知阻塞，不被误报为复制失败。 |
| 回放边界 | Unknown 与真实 smoke 缺口明确列出 | Pass | 报告 §6；`stillNeedsRealSmoke` | Portal、真实模型、微信、自然调度、生产资产绑定仍待真实验证。 |
| 生产切换准备 | 可直接进入 T-531 | Partial | 报告 §5.1 | 快照生产 DB 没有 `agent_space_*` 表，T-531 必须新增代码发布/schema 建表/发布后核对步骤。 |
| 默认 Skill 口径 | 切换后 Skill 面是否符合 owner 预期 | Unknown / owner decision | 报告 §5.3 | 当前 B 侧默认 Skill 为 0；报告认为是设计内状态，但是否接受要由 owner 明确。 |
| 任务基线 | W7 批次任务数量与当前事实一致 | Partial | 报告 §5.2 | 111 实际 active 任务为 3，W7 计划中的 4 已过时；需修订执行清单。 |

## Findings

- **[P1] T-531 缺生产代码/schema 前置。** 生产快照中不存在任何 `agent_space_*` 表，因此不能直接执行导入、依赖注册或 resolver 切换。必须先形成可审阅的发布步骤，并在生产确认 `initDb` 建表、当前代码版本和回滚边界后，才能考虑批次窗口。
- **[P1] 当前结果不授权生产操作。** T-530 的 73/73 只证明隔离回放；真实 Portal 会话、真实模型输出质量、自然调度、微信投递和生产资产绑定仍是 Unknown。T-531 需要独立的窗口授权和真实 smoke 验收。
- **[P2] 默认 Skill 为空需要 owner 选择。** 若接受，切换按“方法/任务模板驱动，Skill 暂不注入”执行；若不接受，必须先发布并安装明确的默认 Skill 版本，不能在窗口中临时隐式补入。
- **[P2] W7 计划数字需修订。** 111 active 任务应按 3 个执行，不能继续使用旧的 4 个任务数字。

## Verification Performed

- 阅读 T-530 交付报告、回放脚本和最终 `report.json`。
- 复核最终报告为 73 checks、0 failures、0 blockers。
- 检查脚本的隔离环境变量护栏、外部 `AGENT_SPACE_ASSEMBLY_MODE` 拒绝、快照 DB `readonly + query_only`、假网关/假 sender 和真实 smoke 列表。
- 未连接生产 DB、未运行生产 `--confirm`、未切 resolver、未发送真实消息。

## Follow-Up Checklist

- [ ] owner 决定是否接受 B 侧默认 Skill 为空。
- [ ] 将“发布当前 main → 确认生产 `agent_space_*` schema → 再导入”的步骤补入 T-531，并明确发布回滚边界。
- [ ] 修订 W7 计划中的 111 active 任务数为 3。
- [ ] owner 指定 T-531 维护窗口、执行人和失败时的关闭 resolver 权限。
- [ ] 在 T-531 中完成真实 Portal/模型/调度/微信 smoke 后，再决定是否继续 T-532。
