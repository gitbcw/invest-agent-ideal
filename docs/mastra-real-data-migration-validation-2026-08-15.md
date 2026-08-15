# 真实数据迁移验证报告（2026-08-15）

状态：**通过**（含 2 个发现，1 个已修复、1 个已文档化）
执行依据：用户授权（2026-08-15）；流程 [mastra-real-data-migration-plan.md](./mastra-real-data-migration-plan.md) Phase 0-3
工作区：`data/migration-validation-20260815/`（reports/ + target/，本地证据保留）

## 快照与范围

- DB 快照：`disaster-recovery/full/2026-08-15T010001+0800`（COMPLETE、quick_check ok、manifest 前后两次全量校验 0 异常）
- Workspace 快照：同批次内含 `mg`（4 用户中唯一有可迁移 Workspace 业务态的用户；primary 为默认测试号，dyk/111 仅有会话数据，属表保留域、无需迁移）
- 真实数据画像：mg 持仓 19 项（吉林化纤/钒钛股份等）、日计划 14 份（2026-07-20 起）、复盘记忆 316 条、资产 29 个版本、节奏偏好（日 19:00/周六 09:00/月末周六/盯盘 09:55+14:30）

## 执行结果

| 阶段 | 内容 | 结果 |
| --- | --- | --- |
| P0 | 快照完整性 + 源摘要 | ✅ COMPLETE/quick_check/manifest 全过 |
| P1 | workspace manifest + 5 域 dry-run | ✅ 514 项 unclassified=0（1 个已文档化冲突：strategy.yaml 的 profile/methods 拆分）；portfolio/strategy/preferences/review-memory/assets 映射全部成功 |
| P2 | 6 个导入双跑 + P4a | ✅ 全域 inserted→replayed（幂等）；P4a 从真实偏好创建 4 类 typed 任务（active、next_run 正确），复跑 skipped=4 |
| P3 | 双读 + 冷启动 + 写入 smoke + 源不变 | ✅ 双读 portfolio/dailyPlans 全 match；冷启动投影全可读（316 记忆/183 资产，调度保持禁用语义）；写入 smoke 通过（伪造 scope 被拒、资产提交、自动化创建+字节校验）；**源快照 0 改动** |

## 发现（本轮验证的核心价值）

**F1（发现并已修复）——strategy 导入与 E1 画像退役冲突**：迁移脚本把 strategy.yaml 的 investment-profile 字段（style/riskPreference/userMode 等）写入 `mastra_project_profiles.profile_json`，而 E1 之后 runtime 启动的剔除迁移会**静默删除这些键**——导入数据在首次冷启动即丢失。修复：`mastra-strategy-target-import.mjs` 按 E1 退役键清单过滤（droppedRetiredKeys 入报告）；导入后 mg 投影仅剩 `markets/allocation`（与运行时语义一致）。教训：迁移机与架构裁决（D5/E1）之间存在时间差，验证轮的价值正在于暴露这类交叉。

**F2（发现并已文档化）——目标根布局双轨**：导入脚本默认写扁平根 `projects/<projectId>`，而 runtime 注册表规范根是 **scope-digest** `projects/<digest>`；自动化/资产写入经注册表解析，会在 digest 根落字节——两根不一致时同一 target 的字节被拆到两处。本轮已按 digest 根重做全部导入并使 write-smoke 断言对齐（要求传入注册表根）。**切换 runbook 必须绑定 digest 根**；后续可考虑让导入脚本自动解析/登记 digest 根（挂 E2 系列顺带）。

**F3（工具修缮）**：write-smoke 的资产断言停留在旧的按任务目录布局，已对齐现行"注册表根 + relativePath + 尺寸校验"语义；strategy 导入报告补充退役键清单。

## 门解锁判定

- **E4（废除偏好散读点与 schedulerActivation）**：P4a 已在真实偏好上验证幂等 → **解锁**，可作为独立工程项执行
- **E8（workspace 回滚后端拆除）**：验证侧门（真实数据迁移验证）已满足 + H1 已过 → **门已开**；执行仍建议独立系列（convergence scan 护栏）
- R1（发布）：技术侧前置全部齐备，**等你决策**（端口/内测用户/微信重连/切换时机）

## 后续建议

1. E4 执行（小）：移除 scheduler/index.ts、scheduled-tasks.ts 等处偏好散读与 schedulerActivation 门
2. E8 执行（大）：独立提交系列拆除 workspace 回滚后端
3. 切换 runbook：固化"DB + digest 根 + 导入顺序 + P4a + smoke"为本报告流程
