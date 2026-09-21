# W6 独立验收

日期：2026-09-20；复核提交 `f31fa32`，依据 [W6 执行稿](./W6-isolated-migration-rehearsal.md)、W0 门禁产物和 W1–W5 已通过契约。

## Acceptance Verdict

Status: **Pass with caveats — W6 隔离迁移演练通过，可进入 W7 的 owner 决策前置检查。**

W6 在隔离 DB、隔离项目根和灾备副本上完成了门禁重验、真实字节 staging、导入核对、三条语义场景和独立回滚。没有触碰生产 DB、真实 Workspace、调度器或外部推送。93 项 autoImportable 均通过服务层二次门禁；92 项成功导入；1 项 `.docx` 因现有 user-assets 格式白名单被明确拦截，没有擅自扩大产品边界。205 项 owner-review 未导入，仅进入可发现队列。

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 门禁范围 | 只消费 W0 autoImportable；owner-review 不默认导入 | Pass | `migration.ts:loadW0MigrationInputs`；`.state/agent-space-w6/20260920T2/report.json` | 报告 counts 为 autoItems=93、ownerReviewQueue=205；owner-review 只进入队列。 |
| 备份与字节 | staging 实读备份，双 hash 核对，漂移/缺失拦截 | Pass | `migration.ts:stageMigrationCopies`；stage-outcomes/import-outcomes | 真实演练 93/93 staged；导入核对逐项 storedHash/sourceHash 一致。 |
| 导入语义 | data_asset 保持资产；method 只建 draft 归档，不自动采用 | Pass | `migration.ts:importStagedMigration`；`tests/agent-space-migration.test.ts` | 111 无 method 化；mg/dyk method 导入为 draft、无 current。 |
| 权限隔离 | 同 scope 可读、跨 scope 拒绝 | Pass | `verifyMigrationImport`；真实 report verifyChecked=92 | 逐项记录 scope 与跨域拒绝结果。 |
| 必测场景 | mg 四因子/KP、111 回测/策略、dyk 核心/撤回策略 | Pass | 迁移域测试 S1/S2/S3；run-basis evidence | 四因子独立可采用；KP/核心模型保留 owner-review；撤回策略 draft 不能 pin。 |
| 回滚 | 导入前快照，独立进程恢复并逐表核对 | Pass | `04-rollback/rollback-verification.json`；report-rollback | 9/9 相关表恢复为导入前状态。 |
| 幂等 | 重放不产生副作用 | Pass | migration domain test；W6-delivery | 92 项导入重放验证通过。 |
| 验证 | 隔离测试与回归 | Pass | `node --import tsx --test --test-force-exit tests/agent-space-migration.test.ts` | 独立执行 6/6 通过；W6 报告另记录域回归 34/34、全仓 730/730、build/tsc 通过。 |

## Caveats

- `.docx` 项目被 `createUserAsset` 的格式白名单拒绝，已保留为 skipped/owner 需裁决事项；W6 不应被解释为该附件已迁移。
- 真实演练使用 2026-09-20 01:05 灾备快照。W0/W6 已明确：W7 正式迁移前必须重新备份、重生成清单并重新核对漂移；本次演练不能替代正式迁移前门禁。
- run-basis 的 approve/adopt 演示发生在隔离库，仅证明授权采用路径可用，不代表任何生产 method 已采用。
- W4 generic runner 上游、scheduled 生产 task 注册、任务创建授权门面等边界仍待 W7/生产切换前处理，W6 未声称覆盖。

## W7 Preconditions

进入 W7 前必须由 owner 明确处理：

1. 是否扩展 `.docx` 资产格式白名单，或继续将该项留在 owner-review/skipped。
2. 以新的灾备快照和新的 W0 清单重跑 93 项门禁与 hash 核对。
3. 明确 W7 的真实用户范围、维护窗口、备份位置和回滚演练引用；W6 隔离 DB 不得直接升级为生产目标。

本验收未部署、未迁移真实用户、未开启 `AGENT_SPACE_ASSEMBLY_MODE`。
