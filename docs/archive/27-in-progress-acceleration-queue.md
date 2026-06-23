# 27 — 进行中任务集中推进队列

> 创建于 2026-06-05。本文档把当前散落在路线图里的进行中任务收束成一个可连续执行的队列，优先推进能形成产品闭环的事项。

## 推进目标

把 Hermes 旁路从实验能力推进成可靠的多 AI Project 运行平台样板，同时让投资助手复盘闭环具备连续审计能力。

## 执行队列

| 顺序 | 任务 | 对应路线图 | 状态 | 验收标准 |
| --- | --- | --- | --- | --- |
| 1 | 周复盘接入结构化观点统计 | D4-5 / D4-10 | 阶段完成 | 周复盘和 `/api/reviews/weekly-context` 已能展示 `review_viewpoints` 的 validated / invalidated / pending / open 汇总和明细 |
| 2 | 平台后台补 AI Project 配置可视化 | D6 后续 | 阶段完成 | `/platform` 已能查看项目 manifest、skill bundle、prompt profile、tools、permissions、resource types 的配置摘要 |
| 3 | Hermes 旁路自恢复运维闭环 | D4-13 | 阶段完成 | 已新增 `npm run smoke:hermes-service`，覆盖 launchd 配置、日志路径、健康检查和 Hermes profile |
| 4 | 真实使用验收清单 | D4-5 / D4-6 / D4-13 | 阶段完成 | 已新增 [28-hermes-bypass-acceptance-checklist.md](./28-hermes-bypass-acceptance-checklist.md)，覆盖日复盘、周复盘、选股问答、沙箱权限、推送队列、客户输出边界 |
| 5 | 周/月复盘上下文接口设计 | D4-10 | 阶段完成 | 已新增 `/api/reviews/weekly-context`、`/api/reviews/monthly-context` 及 sandbox 版本，提供提醒统计、日复盘覆盖和结构化观点统计 |
| 6 | 盘前推送优化 | D4-3 | 阶段完成 | 盘前推送已引用最近日复盘要点和今日观察重点，手动接口已验证 |

## 当前优先级判断

第 1 项已经阶段完成。日复盘已经能结构化保存观点并回写状态，周复盘和 weekly context 已能消费这些状态，复盘体系开始从“生成报告”进入“审计判断质量”的阶段。

平台配置、自恢复和验收清单随后推进。它们会让 Hermes 旁路更接近可长期运行的服务，而不是一次性实验。
