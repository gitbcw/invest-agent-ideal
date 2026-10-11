# 周复盘策略进化建议 + htmlReport：预发布语义验证记录（SCR tier-2 预检）

日期：2026-10-11。评估对象：commit `c3f8d70`（feat(reviews): 周复盘策略进化建议 + 周/月复盘 HTML 可视化报告）。本文是发布前语义门预检记录，供未来发布记录引用；**未发布，go/no-go 待 owner 裁决**。

## 验证方法

本地镜像（10-10 生产快照重建，Portal 3120 / runtime 23670）重启至 HEAD 后，以 mirror-mg 触发周复盘 run-now（真实 GLM、真实行情工具）。run：`atrun_f9f8bf24-3b4a-4a0f-a472-144efc83384f`，2026-10-11T01:49:39Z–01:55:22Z，终态 succeeded。

## 四栏初步结论

| 栏 | 结论 | 证据 |
| --- | --- | --- |
| 程序 | pass | 直接触及测试 28 用例全过；reviews.save 相关 10 文件 166 用例仅 4 个预存红（aaa6fc3 计数漂移，已随 `4c1ade0` 修复） |
| 语义 | **partial——发现真实缺口，见下** | htmlReport 链路全通；「策略进化建议」未到达存量任务 |
| 性能 | 观察项 | 单次周复盘 5m43s（历史同任务 ~1m，约 5 倍），仍在 840s 预算内；需观察 T-581 三车道并发下任务簇时段的相互影响 |
| 业务终态 | 未发布，待决 | — |

## 语义结果详情

**htmlReport：pass（单样本）。** mg 的迁移任务 revision 指令为旧文本（不含 htmlReport 要求），模型仍首次调用即传入合规 htmlReport——服务门未触发任何 `REVIEW_HTML_REPORT_REQUIRED` 拒绝重试，合规来源是工具 schema 参数描述自解释。产物：`reports/weekly/2026-10-11_weekly.md`（5080B）+ `.html`（7510B，preview_mode=html，1 个内联 SVG、28 个内联样式属性、5 个章节，无任何违禁模式）。双 artifact 幂等语义由单测覆盖。样本导出：`artifacts/weekly-review-html-sample-mg-20261011.html`。局限：单次、单模型（glm-5.3-flash 高深度）；服务门保证最坏情形是 run 失败进重试与失败通知，不是静默缺报告。

**策略进化建议：未到达存量任务（缺口）。** 证据链：md 与 html 均无该区块；任务 `migrated_scheduled-weekly-review_c023418f` 的 revision.instruction 冻结为旧 `PERIODIC_REVIEW_INSTRUCTION` 文本；generic automation runner 只使用 `task.revision.instruction`，不合并 `SCHEDULED_TASK_TYPES` 默认指令；`buildWeeklyReviewContext`（含本次新增的 methodChangeProposals 注入）仅被旧编排路径（`isLegacyReviewOrch`）与 sandbox 路由调用。结论：**生产全部存量用户（mg/dyk/111 均为迁移任务）发布后不会获得进化建议区块，也不会获得防重复提议上下文**；仅发布后新建的预置任务生效。

## 处置选项（owner 决策）

- **A 按现状发布**：存量用户获得 HTML 可视化（已验证可达），进化建议仅新任务生效；发布记录如实标注范围。
- **B 存量任务指令升级**：为迁移复盘任务追加新 revision（走 db-migration/服务流程），进化建议到达全部用户。
- **C runner 层类型化注入**：generic runner 对 typed review 任务注入类型级指令附录（改代码不动数据，`scheduled-task-types.ts` 与 `scheduled-tasks.ts` 双份事实需三处同步）。

若进化建议是本次发布的核心价值，建议 B 或 C 完成后再发布；若 HTML 可视化优先，可择 A 先行。

## 其它观察

- 本 run `delivery_status=failed`：镜像微信 bot 会话过期（errcode -14，镜像按红线不携带真实微信登录态），环境属性，非代码回归；历史 `sent` 行来自生产快照。
- 镜像在演示前重启过一次（运行代码=HEAD），demo 用户数据与会话不受影响。
