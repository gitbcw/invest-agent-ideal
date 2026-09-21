# T-531 手册修订独立验收

日期：2026-09-21。范围：仅审阅手册、决策记录与生产前边界；未执行生产操作。

## Acceptance Verdict

Status: **Pass with caveat — 手册修订可接收，T-531 仍停在窗口授权闸门。**

执行 Agent 已把 T-530 的四项 owner 裁决写入 D8–D11，并在 W7 执行计划中补充步骤 0、111 的 3 个 active 任务、默认 Skill 空集口径、发布/回滚分层与目标身份核对。生产 `--confirm`、resolver 切换、真实消息和真实用户写入仍被 D11 明确禁止，边界正确。

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 决策回写 | 四项 owner 裁决进入唯一冻结记录 | Pass | `W7-decisions.md` D8–D11 | D11 作为全局闸门，未被误写成窗口授权。 |
| 步骤 0 | 发布当前 main、schema 核对、发布后行为核对、留痕 | Pass | `W7-execution-plan.md` §2 步骤 0 | 已明确先发布再导入；D11 仍阻止实际执行。 |
| schema 期望清单 | 22 张 `agent_space_*` 表与当前 initDb 一致 | Pass | 执行计划 §2 0b；`src/db/index.ts` 当前 `CREATE TABLE IF NOT EXISTS` 共 22 张 | 名单与代码表名一致。 |
| 生产路径 | 目标 DB、scope、instance、manifest、批次记录边界 | Pass | 执行计划 §0.5 | `/home/claude/invest-agent-mastra/data/runtime.db` 已写入，但窗口日仍需现场复核。 |
| 回滚边界 | 代码、resolver、数据补偿、整库快照分层 | Pass | 执行计划“发布/回滚边界” | 明确代码回退不删增量表，批次默认不整库恢复。 |
| 111 任务基线 | 计划数字修正为实际 3 个 active 任务 | Pass | 执行计划 §1 B3、D10 | 原 4 个已标为作废。 |
| 真实窗口授权 | 未授权前不得触碰生产 | Pass | D11、执行计划 §6 | 当前 Agent 报告未执行生产动作。 |
| schema 验证深度 | 表名之外验证列、索引、迁移版本 | Partial | 当前 0b 命令仅查询 `sqlite_master` 表名 | 由于生产当前没有这些表，首轮建立后应再运行 typecheck/初始化 smoke；若要把步骤 0 作为长期 runbook，建议补代表性列和 migration marker 核验。 |

## Findings

- **[P2] schema 命令只证明表名存在。** 22 张表名单与 `initDb` 当前代码一致，但该命令不验证列、索引、关键约束或 migration marker。对于首次从无表建库，发布后还应以 `w7-smoke`/只读查询确认关键表可写入并可读回，避免“表名齐全、结构不完整”。这不阻塞当前手册接收，但应作为窗口日步骤 0 的核对增强项。
- **[P2] “一次正常调度”要明确不等于真实用户切换。** 步骤 0c 可作为发布后回归证据，但应使用明确的低风险、可追溯任务，并记录是否产生投递；不能把它当成 mg resolver 已切换或 T-531 smoke 已通过。

## Verification Performed

- 对照检查 `W7-execution-plan.md` 与 `W7-decisions.md` 的 D8–D11、步骤 0、B3 数量和回滚边界。
- 从 `src/db/index.ts` 提取 `CREATE TABLE IF NOT EXISTS agent_space_*`，结果为 22 张，和手册名单一致。
- 确认当前工作树没有因本轮审核执行生产命令；未连接生产 DB、未发布、未运行 `--confirm`、未切 resolver。

## Follow-Up Checklist

- [ ] 执行 Agent 可继续保持 T-531 doing，但不得进入生产步骤。
- [ ] 可选增强步骤 0b：加入关键列/索引/迁移 marker 核对，或在发布后用只读 smoke 补齐该证据。
- [ ] 若你要正式授权窗口，需另行明确 mg B1 的日期/时间、执行人和失败时关闭 resolver 的权限；当前 D11 仍是未授权状态。

## 2026-09-21 结构核验补强复审

### Verdict

Status: **Pass with caveat — 原 schema caveat 已关闭，仍未获得生产窗口授权。**

`w7-verify-schema.mjs` 使用当前部署代码的 `initDb` 创建临时参照库，并以 readonly 模式逐表比较目标库的 22 张表、列名、非自动索引名和唯一索引列元组；隔离绿测通过，构造缺列/缺索引的红测能以 exit 1 精确拦截。手册已把结构比对设为步骤 0b 的权威门，并要求把纯 JSON 输出留痕。

### Remaining caveat

脚本还没有比较非自动索引的列组成，也没有把目标库多出的非自动索引列为问题；这不阻塞当前手册接收，因为目标生产库当前没有 `agent_space_*` 表且首次建立由同一 `initDb` 负责，但可在窗口前作为 P2 小修补齐。

### Current decision gate

D11 仍有效：执行 Agent 只能继续做文档/隔离验证。生产发布、schema 核验、导入、注册、resolver 切换和真实消息都需要 owner 另行明确窗口授权。
