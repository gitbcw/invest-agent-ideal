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

## Owner 裁决修订（2026-10-12）：htmlReport 从无条件强制改为报告格式偏好

owner 复核本文后裁决：**HTML 可视化是默认配置，不是服务端强制契约**。复盘报告可以是各种格式（新用户默认带 HTML 获得首次可视化体验；老用户可能只要一小段文字或一张表格），必须有开关，且开关由 **Agent 经对话调整**（用户说"我的复盘报告要什么格式"，Agent 走 preferences.apply 带确认切换），不是用户去设置页自己翻。

实现（2026-10-12，随本次发布一并提交）：

- 偏好层：`reviewSchedule.<section>.report_format`，枚举 `html|markdown|brief|table`（接受中文别名归一化），按日/周/月分段，**缺省 html**（存量三用户与未配置用户行为不变，无需数据迁移）。
- 服务门：`REVIEW_HTML_REPORT_REQUIRED` 仅在偏好为 html 时强制；偏好不可读时按 html 处理（fail-closed，最坏情形仍是 run 失败进重试，不静默缺报告）。偏好非 html 时传入 htmlReport 仍走安全校验（宽容接受）。
- 运行注入：generic automation runner 与旧编排 prompt（runStructuredReviewPrompt）都注入当前格式偏好行（describeReviewReportFormat 单一事实）——**存量迁移任务（revision 指令冻结旧文本）因此也能感知偏好变化**，偏好 brief/table 时按注入形态生成。
- 指令层：类型默认指令（新任务/onboarding 预置任务）改为偏好感知文案；Agent 工具描述（preferences.apply / reviews.save 中英文）同步。

对本文结论的影响：

- 原「语义 partial」的**进化建议缺口不变**（revision 指令冻结是独立问题，处置选项 A/B/C 仍待 owner 裁决）。
- HTML 部分语义从"无条件强制"变为"偏好驱动（默认 html）"：发布后存量用户默认获得 HTML；不想可视化的用户对 Agent 说一声即可关闭，不再有"任务失败 vs 忍着"的两难。
- 本节修订后需在发布前重跑一次镜像语义验证（偏好缺省 html 的周复盘 run-now + 一次偏好切换后的行为验证）。

## Owner 二次裁决（2026-10-12 同日）：移除服务门，宽松模式

owner 进一步裁决：**服务端不做 htmlReport 契约强制，既不硬拒绝也不软警告**。理由：为单一偏好逐项加代码校验会使系统臃肿（若 HTML 要校验，其他偏好要求是否也要校验）；偶发缺失（预期 ~90% 成功率可接受）由用户自己发现、反馈，后续再通过上下文调整稳定性。

落地（替换上一节的"服务门"条目）：

- `REVIEW_HTML_REPORT_REQUIRED` 强制逻辑整体移除：scheduled 周/月复盘缺 htmlReport 时正常保存（仅发布 markdown artifact），不拒绝、不挂警告、不判失败。
- 保留的只有**内容安全校验**（`REVIEW_HTML_REPORT_INVALID`：传入 htmlReport 时校验自包含、禁脚本/外链/iframe/1MB 上限）——这是 Portal 渲染安全边界，与偏好无关，不随宽松模式放宽。
- 偏好注入不变（运行上下文注入格式偏好行引导模型生成）；偶发漂移缺 HTML 属可接受损耗，靠用户反馈暴露。

## 宽松模式镜像语义验证（2026-10-12，二次裁决后）

本地镜像重启至工作树（含偏好开关 + 服务门移除）后，以 mirror-mg 走全链路验证。

**验证 1：偏好缺省 html 的周复盘 run-now。** run `atrun_44f463b0`（02:18–02:22，4m11s，glm-5.3-flash，¥0.13）终态 succeeded。trace 实证偏好行进入运行消息（user_text 含「本用户复盘报告格式偏好为 html」）；无服务门拒识发生。双产物发布：`reports/weekly/2026-10-12_weekly.md` + `.html`（8010B，preview_mode=html，六项安全检查全过：无 script/javascript:/http(s)外链/@import/iframe）。md 无「策略进化建议」区块（0 次）——符合已登记的存量指令冻结缺口预期，非本次回归。**结论：宽松模式下 HTML 靠注入行 + 工具 schema 自解释到达存量迁移任务，首次实证成色良好。**

**验证 2：Agent 对话调整偏好 + 形态变化。** 对话请求「周复盘不要可视化 HTML，改成简短文字」→ Agent 正确登记草案（主动区分 brief 与 markdown 语义）→ 对话内一句确认 → 写入并回读：`weekly_review.report_format=brief` 落库，daily/monthly 未动（分段粒度正确）。再次 run-now：`atrun_1de9a70d`（02:33–02:34，1m36s，¥0.53）终态 succeeded，注入行已切换为 brief；**html artifact 保持旧版本未动（updated_at 停留在 02:22）**，md 更新为 5036B 文字版（对比 html 版 6208B）。**结论：开关全链路生效——Agent 可调、偏好分段落库、下次运行形态跟随、HTML 生成与否由偏好决定。** 顺带实证对话内确认链在此场景可走通（T-594 缺陷未在本次场景复现）。

**观察项（非阻塞）**：brief 版仍保留 7 段完整结构（简短尺度是模型执行质量问题，属 owner 已裁决的「后续调上下文确定稳定性」范畴）；brief 版 run 费用反而更高（¥0.53 vs ¥0.13）——成本主要由研究深度（本轮多读三份历史复盘）决定，非 HTML 生成，格式开关不是成本开关。

## 其它观察

- 本 run `delivery_status=failed`：镜像微信 bot 会话过期（errcode -14，镜像按红线不携带真实微信登录态），环境属性，非代码回归；历史 `sent` 行来自生产快照。
- 镜像在演示前重启过一次（运行代码=HEAD），demo 用户数据与会话不受影响。
