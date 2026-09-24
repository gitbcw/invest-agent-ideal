# T-524 当前状态与后续工作

日期：2026-09-21。本文是 T-524/W7 在三用户切换后的当前交接入口；执行细节仍以 `W7-execution-plan.md`、批次日志和独立验收记录为准。

## 当前结论

生产已将 `mg`、`dyk`、`111` 三个 scope 切到新 Agent Space resolver：

```text
AGENT_SPACE_ASSEMBLY_MODE=scope:mg,dyk,111
```

这表示三用户的默认模型装配已来自新 Agent Space。旧 Workspace 尚未删除，仍保留为 history-only/回退来源，因此当前是**三用户生产灰度态**，不是兼容窗口已经关闭的最终收口态。

## 已完成

- W0-W6：权威源清单、对象契约、方法/Skill/Agent/任务依赖、运行依据、状态/结果事实、隔离迁移演练。
- T-530：真实历史数据隔离 A/B 回放，73/73 检查通过。
- W7 B1：mg 导入、四因子方法采用、任务依赖绑定、真实会话、真实模型、自然 market-watch、真实微信投递和跨 scope smoke。
- W7 B2：dyk 导入、空方法上下文、真实会话、手动 daily-review、自然 market-watch 和跨 scope smoke。
- W7 B3：111 导入、空方法上下文、真实会话、手动 daily-review/微信投递和跨 scope smoke。
- 生产 schema、备份、批次导入护栏和 scope 补偿回滚路径已建立。

## 当前未收口项

- dyk 的一条 daily-review 投递曾处于 `awaiting_user`/`ret=-2 prepare failed`，需确认最终重试终态；这条记录单独按微信通道问题追踪。
- 111 仍需要切换后的自然调度证据。
- 三用户需要继续观察自然 daily-review、execution、delivery 和微信终态。
- `reports/daily` 是 `reviews.save` 服务层产物链的旧根路径依赖，暂不判为模型双写，但必须在 T-534 兼容窗口收口时明确处置。
- 旧 Workspace 的 default-load、模型驱动写入和旧路径引用需要持续证明为零，之后才由 owner 批准关闭旧运行入口。

## 两条并行工作线

### 线上观察与兼容窗口

保持三用户 resolver，不删除旧 Workspace。采集真实自然调度、basis、execution/delivery、微信终态和旧入口计数。满足 T-534 验收后，再决定是否结束兼容窗口；物理删除历史另立任务。

### 本地产品化与可视化

在隔离数据库/回放数据上开发 Agent 空间只读控制面，先由 owner 校对，再考虑发布。首版只展示 Agent、方法及版本、Skill 安装状态、任务依赖、最近运行和本轮运行依据，不新增生产写入、自动批准、Skill 市场或旧 Workspace 删除。

已冻结的 T-536 口径（owner 2026-09-21）：首版坚持纯只读；数据使用脱敏快照加回放数据；先做本地原型与隔离验收，owner 校对页面/交互后再决定是否拆 Portal 发布任务。

## 路线顺序

```text
三用户观察
  ├─→ T-534 兼容窗口收口 → owner 批准关闭旧运行入口
  └─→ T-536 本地只读 Agent 空间可视化 → owner 校对 → 独立发布评估

T-535：方法采用、策略拆分、Skill 与产品范围决策
```

T-536 不阻塞线上观察；T-535 的业务方法决策也不自动改变当前三用户已冻结的运行口径。

## 仍需 owner 决策

1. T-534 通过后是否立即关闭旧运行入口；历史物理删除仍需另行授权。
