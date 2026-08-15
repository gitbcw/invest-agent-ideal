# 复盘/盯盘任务化与偏好映射设计

状态：v1 已采纳；P1 已实施（2026-08-14）——schedule 支持 monthly/monthlyDay/windows；任务类型注册表（`src/services/scheduled-task-types.ts`，id 对齐授权表）；任务表新增 `task_type` 列；`nextAutomationRunAt` 支持 monthly 落点与 windows 多触发点。
P2 已实施（2026-08-14）——runner 按任务自身 taskType 解析授权（复盘任务获得 reviews.save 授权）；`shouldFire` 防双发（活跃 typed 任务存在时偏好路径让位）；`applyPreset` 激活复盘任务（盯盘待 P3）。
P3 已实施（2026-08-14）——盯盘任务 `wechat_on_condition` 条件投递（NO_PUSH 语义）+ 激活；`shouldRunMarketWatchTask` 防双发（活跃 typed 盯盘任务让位）。
P4a 已实施（2026-08-14）；**P4b 已执行（2026-08-15，真实数据迁移验证通过后）**：5 处偏好散读点与 schedulerActivation 门全量废除，复盘/盯盘唯一由 typed 任务驱动（D27）；偏好中调度字段只读留档
关联：[preset-system-design.md](./preset-system-design.md)（前置消费方）、[mastra-architecture-baseline.md](./mastra-architecture-baseline.md) §6/§7.5
裁决来源：D3（复盘、盯盘并入自动化任务；规则巡检另行重设计）、D9（通知偏好语义归预设）

## 1. 目标与原则

1. **Scheduler 退化为纯触发器**：扫描任务实例→到期触发→投递。不再内置"复盘是什么、盯盘是什么"的知识
2. **一切有节奏的工作 = 自动化任务实例**：复盘、盯盘、清理、未来的任何周期工作统一为一个模型
3. **调度可见性 = 任务列表**（G21 的解）：用户在 Portal 看到"我有哪些任务、下次何时跑、可暂停/恢复"——`schedulerActivation` 开关随之废除（任务存在即启用，暂停即停用）
4. 偏好不再是平行配置文件，而是**任务实例的参数来源**；应用预设 = 批量实例化任务

## 2. 任务模型扩展（现状差距）

现有 automation schedule：`frequency: daily | trading_days | weekdays | weekly` + 单 `time`。需要补：

| 扩展 | 用途 | 说明 |
| --- | --- | --- |
| `frequency: "monthly"` | 月复盘（day_1 09:00） | 枚举 + `monthlyDay?: number` |
| `windows?: string[]` | 盯盘多时段（09:55/11:20/14:30） | 一个任务多触发点；等价于多个 time，不拆成多任务（保持"一个盯盘任务"的用户心智） |
| `taskType` 注册表 | `review-daily` / `review-weekly` / `review-monthly` / `market-watch` 成为系统注册的任务类型 | 每类型绑定：执行器（agent 回合 prompt 模板）、完成契约（如 reviews.save）、产物/投递语义 |

**执行语义映射**（现在 scheduler/review.ts + scheduled-tasks.ts 的内置逻辑 → 任务执行器）：

| 现状内置行为 | 任务化后 |
| --- | --- |
| 复盘预生成暂存（preparedReviewPath → 注册项目根 staging） | 任务 run staging（复用现有 automation staging 机制） |
| 复盘完成契约（"reviews.save 是唯一完成路径"prompt，§10.3） | `review-*` 任务类型的完成契约（随任务类型注册，不再是 scheduler 内字符串） |
| 盯盘 push 模式（resolveMarketWatchPushMode 读偏好） | 任务 delivery policy 参数（预设写入默认值） |
| 复盘/盯盘 prompt 构建（scheduled-tasks.ts 内置） | 任务类型的默认 prompt 模板 + 预设 copyPack 追加段 |

## 3. 偏好字段映射（终局表）

| 偏好字段（mastra_runtime_preferences） | 去向 |
| --- | --- |
| `schedules.daily_review / weekly_review / monthly_review` | review-* 任务实例的 schedule 参数 |
| `schedules.market_watch.default_windows / enabled / auto_run` | market-watch 任务实例（enabled=false → 任务 pause） |
| `notification.preference.mode`（低打扰三态） | **预设语义**：低打扰复盘型预设的 deliveryPolicy；系统级只留通用频控（防轰炸/免打扰窗口） |
| `watch.only_push_on_exception / priority_policy` | 任务级 push policy；priority 归规则巡检重设计（D3 独立线） |
| `watch.mode = disabled/off` | market-watch 任务 pause |
| `schedulerActivation` | **废除**；存在=启用，pause=停用 |
| `onboardingState` | 留在 preferences（onboarding 进度语义，非调度语义） |

## 4. 迁移设计

1. **一次性幂等迁移脚本**：扫 `mastra_runtime_preferences` → 为有复盘/盯盘偏好的 scope 创建对应任务实例（source 标记 `migration:preferences:<date>`）→ 双轨期调度器先查任务、无任务再回落偏好
2. **双轨验证期**：任务触发与偏好触发结果对照（同一 scope 不双发：任务存在即以任务为准）
3. **收敛**：删除 scheduler 内 5 处偏好散读点（review.ts:114、scheduler/index.ts:440/547、scheduled-tasks.ts:439/451），preferences 中调度相关字段只读保留供审计
4. 生产形态注意：真实数据迁移属 WP2/发布阶段；本设计在隔离候选验证

## 5. 规则巡检边界（不在本设计内，仅划界）

规则巡检（alert_rules 确定性检查）**不并入**自动化任务——它是"事件驱动条件评估"而非"节奏性工作"，且已有独立重设计决议（D3）。但它同样从 preferences 解耦（优先级/推送策略自成一体），且其可见性（G21）与任务列表同页呈现。

## 6. 分阶段落地

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P1 | 任务模型扩展（monthly/windows/taskType 注册表） | 契约测试 |
| P2 | review-* 任务执行器 + 完成契约迁移 | 隔离候选：日/周/月复盘经任务触发跑通，产物/trace 等价 |
| P3 | market-watch 任务执行器 + delivery policy | 隔离候选：盯盘经任务触发，NO_PUSH/简报行为等价 |
| P4 | 偏好迁移脚本 + 双轨收敛 + 废除散读点与 schedulerActivation | 迁移幂等；全量回归 |

## 7. 开放问题（已收口，2026-08-14 议程收尾）

1. **盯盘多时段** ✅ 已裁决并实施：windows 方案（一任务多触发点，用户心智"一个盯盘"）——D10/D12 落地
2. **预生成保留与否** ✅ 已裁决：保留复盘预生成暂存（现实现即保留，G20 已验证预生成阶段行为；推送提速价值大于复杂度）
3. **暂停语义** ✅ 已裁决：不补跑——`nextRunAt` 从当前时间正向计算（实现即如此，无 backfill）；暂停期间的空档由运行历史呈现（随 G21 Portal 管理面）
4. **G21 Portal 呈现范围** ⏸ 维持挂起：任务列表+运行历史+手动触发+暂停恢复+"下次运行时间"预测（建议要）随基线 §12 工程项 E9（Portal 管理面设计）一并定
