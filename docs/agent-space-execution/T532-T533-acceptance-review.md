# T-532/T-533 B2/B3 独立验收记录

日期：2026-09-21。范围：dyk（B2）与 111（B3）内部开发用户切换及最小真实 smoke。

## Acceptance Verdict

Status: **Partial — 三用户已进入新装配态；B2/B3 即时切换通过，但尚未满足兼容窗口收口条件。**

dyk 与 111 均完成生产导入、Agent 初始化、resolver 切换、真实会话、daily-review 手动运行和跨 scope 抽查；当前生产 resolver 为 `scope:mg,dyk,111`，旧 Workspace 未删除。dyk 的 daily-review 推送出现 `awaiting_user`/`ret=-2 prepare failed`，虽然执行链本身成功且该签名有历史通道先例，但不能直接把这条投递判为成功；111 的自然调度证据也尚未像 dyk 那样出现。因此当前可以继续三用户灰度观察，不能立即关闭旧入口或宣布 T-534 完成。

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| B2 dyk 导入 | 23 项 staging/import/verify，字节在正确生产根 | Pass | `W7-batch-log.md` B2；`.state/agent-space-w7-b2/` | 错误根为 0，B1 事故护栏生效。 |
| B2 dyk resolver | dyk 切换到新装配态，健康检查通过 | Pass | 批次日志；当前 resolver `scope:mg,dyk,111` | 旧 Workspace 未删除。 |
| B2 dyk 会话 | 真实会话显式空集、basis 落库、回复正常 | Pass | B2 smoke ① | 符合 D4/D5 空方法预期。 |
| B2 dyk 任务执行 | daily-review execution 成功、basis 落库 | Pass | B2 smoke ② | 执行链成功。 |
| B2 dyk 投递 | daily-review 真实微信 sent | Partial / Unknown | `awaiting_user`, `ret=-2 prepare failed` | 需等待重试或单独核验通道终态；不能引用为 sent。 |
| B2 dyk 自然调度 | 切换后自然 market-watch 成功 | Pass | 15:00 natural run | 已证明一条自然调度路径。 |
| B3 111 导入 | 24 项 staging/import/verify，字节在正确生产根 | Pass | `W7-batch-log.md` B3 | 按 D10 执行 3 个 active 任务。 |
| B3 111 会话 | 真实会话显式空集、basis 落库、回复正常 | Pass | B3 smoke ① | 符合 D6 预期。 |
| B3 111 任务与投递 | daily-review 成功且真实微信 sent | Pass | B3 smoke ② | execution/delivery 链成立。 |
| B3 111 自然调度 | 切换后自然任务运行 | Unknown / pending | 当前报告无 B3 自然调度证据 | 继续观察期补证。 |
| 跨 scope | 两批同 scope 可读、跨 scope 拒绝 | Pass | B2/B3 smoke ③ | 未见隔离泄漏。 |
| 旧入口退出 | 关闭旧 Workspace default-load、双写和历史依赖 | Not ready | B1/B2/B3 批次日志 | `reports/daily` 服务层产物路径依赖仍需 T-534 处理。 |

## Current Position

- 生产已经是**三用户新装配灰度态**：mg、dyk、111 均启用 resolver。
- 这不是“旧入口已删除”的正式收口；旧 Workspace 仍保留为 history-only/回退来源。
- mg 有即时 smoke、自然 market-watch 和隔离真模型回放；dyk 有即时 smoke 与一条自然 market-watch；111 目前只有即时 smoke。
- T-534 尚未完成，T-535 产品决策池也不应被自动标记完成。

## Next Actions

1. 继续保持 `scope:mg,dyk,111`，不删除旧 Workspace。
2. 核验 dyk `awaiting_user` job 的最终状态：若重试转 `sent`，补投递证据；若持续失败，单列微信通道故障，不判作 W7 装配失败。
3. 等待并采集 111 至少一条切换后的自然调度证据；同时观察三用户下一轮 daily-review 的 execution/delivery/微信终态。
4. 观察通过后再进入 T-534：检查三用户 default-load=0、模型旧 Workspace 写入=0、未迁移引用=0、备份恢复可用，并处理 `reports/daily` 的服务层旧根依赖。
5. T-535（产品化）可并行做设计任务，但不应把“Workspace 可视化设计完成”当成旧入口退出或生产切换通过条件。
