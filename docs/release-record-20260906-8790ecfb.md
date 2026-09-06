# 发布记录：20260906T034815Z-8790ecfb

按 [release-governance-evidence-template.md](./release-governance-evidence-template.md) 口径记录。含语义回归门 [SCR-20260906-03](./semantic-change-regression-gate.md)（tier-2：自动化推送内容契约，commit message 落档）。

## 变更摘要

```text
release_id: 20260906T034815Z-8790ecfb
commit: 8790ecfb182be5db2ff06671fa0817ad6690ed0f（main，committed-local-main）
branch: main
date: 2026-09-06 11:48–11:50（北京时间，白天发布惯例）
owner: 用户授权（2026-09-06 对话：「领取479任务并执行」——任务契约明定发布条件为出 SCR）
agent 执行
change_type: code（T-479 自动化失败/恢复通知）
```

- 变更目的：T-477 研究确认的 scheduled 失败静默空白（E2 稳定期 45 起 failed run 关联推送 0 条）。新增 `src/services/automation-notify.ts`：失败首条通知（consecutive_failures=1）+ 恢复通知（最新通知 job 为 failure）聚合语义，契约见 [automation-failure-notify-design.md](./automation-failure-notify-design.md)。
- 影响范围：`src/services/automation-notify.ts`（新增）、`src/services/automation-tasks.ts`（finishAutomationTaskRun / reaper 挂点）、`src/scheduler/automation.ts`（队列延迟过期挂点）、`tests/automation-notify.test.ts`（8 用例）、设计文档与 README 索引。
- 明确不影响的生产状态：`.env`、SQLite 数据、Workspace、`reviews/`、`.state/`、微信状态——零触碰（rsync 运行资产保护清单在案）。
- 依赖与外部条件：无新增外部依赖；不改变重试/awaiting_user/dead/expired/summary 推送语义（通知 job 独立 message_kind，不设 originRunId，不回写 run.delivery_status）。

## 验证证据

| 门类 | 结果 | 证据 |
| --- | --- | --- |
| 确定性测试/类型检查/构建 | pass | 快照前 `npm run verify`：654 测试 0 fail、agent-context 183 文档、build、boundary 7/7 |
| scope/权限/确认/revision/幂等 | pass | 幂等键含 runId（重入/跨任务隔离断言）；manual 不通知断言；不触碰确认/revision 语义 |
| 错误终态、超时、取消、重试 | pass | 既有 EV-016/018/020 全绿；通知在终态后、吞错不反噬收口（挂点 try/catch） |
| 语义门 SCR-20260906-03 | pass | tier-2（automation_output）；四栏：程序 pass / 语义 pass（8 用例确定性断言）/ 性能 n.a.（模板无模型调用）/ 业务终态待 7 天观察窗口；go-with-isolation |
| 隔离行为评估 | pass | tests/automation-notify：首次失败/连续失败去重/恢复通知/无历史不推/manual 不推/跨任务隔离/重入幂等/needs_attention 再败/租约过期路径 |
| 故障演练 | n/a | 未改故障面；回滚=纯代码 revert |

## 发布执行

- 快照：`release:snapshot create` → verified 20260906T034815Z-8790ecfb（workspace 备份完成、archive commit 8790ecf）。发布前工作树有其他任务（T-478 等）两份待验收未跟踪文档，以 `git stash -u` 临时收起（不卷入、不改内容），部署后已恢复。
- 部署：`release-deploy deploy 20260906T034815Z-8790ecfb`——代码 rsync → Portal 重建 → 双进程重启。尾部一次 `curl 127.0.0.1:23655 Connection refused` 为重启瞬间时差（与 20260906T020157Z 发布同现象）。
- 发布窗口核对：周六 11:48（无盘中调度命中）。

## 发布后最小验收（手册第 8 节）

1. `/health` 200 ✓；PM2 `invest-agent-mastra` online（↺101）、`mastra-portal` online（↺28）✓
2. Portal `/api/health` 200、`/login` 200 ✓
3. `smoke:mcp-service-tools`（同一 dist 源）48 工具 ok ✓
4. Workspace 预检 n.a.（未改 templates/workspace）✓
5. 微信 connector：重启瞬间 socket error 5 条后 3 秒内五 connector 全部重新注册（app.log 03:49:50）✓；pushReady 依真实入站，不强测
6. 活动 push job：pending/retry/processing 0 ✓（awaiting_user 23 属设计内挂起）
7. 新进程日志：app.log 近 200 行 ERROR 0 ✓；runtime-error 命中均为重启窗口 connector 瞬时错误
8. 变更点单点核验：生产 dist/services/automation-notify.js 含 `automation_failure` 符号 ✓

known-good 标记：`accept --confirm=mark-known-good-v1` 完成，自动裁剪旧 known-good 20260828T012927Z-af95b01b。

## 灰度与观测

- 灰度对象：全体（代码发布通道，无行为开关）。
- 观察窗口：发布后 7 天（至 2026-09-13）——
  - 通知频率：`automation_failure` 新增 ≤1 条/任务/失败轮、同任务连败仅首条（重复副作用=硬失败信号）；
  - 成对性：失败后恢复的 task 应出现 `automation_recovery`；失败通知 job 永不早于对应 run 终态；
  - 无预期外 summary 干扰：run.delivery_status 语义不变（通知 job 无 originRunId）；
  - 巡查 S7 三率照常；`run.failure_notified` 审计可对账。
- 回滚触发：重复副作用、通知反噬终态收口（run 卡 running）、或观察窗口硬失败；回滚=`git revert 8790ecf` 后重新发布（纯代码，无迁移无数据面）。

## Go / No-Go

```text
G1 反馈证据：go（T-477 证据型研究 → 契约 → 实现 → 8 用例隔离验证全链）
G2 服务边界：go（boundary 7/7；通知走既有 push_jobs 管道无新边界）
G3 失败终态：go（通知挂点吞错，不改变终态机；EV-016/018/020 全绿）
G4 灰度与回退：go（快照/known-good/纯代码回滚口径齐备）
G5 关联与脱敏：go（审计 run.failure_notified/recovery_notified；不读 revision 正文，文案仅 task 短码+阶段人话）

最终结论：go（生产已按本记录部署并验收）
未解决风险：①失败通知首次生产运行，真实触发样本待观察窗口（下次 scheduled 失败即首验）；② awaiting_user 挂起的失败通知若用户 2h 内未回会 expired——设计内（时效性通知不补发），观察是否需要放宽
批准人：用户（2026-09-06 对话授权任务含发布，SCR 条件已满足）
复核日期：2026-09-06；下次复核：2026-09-13 观察窗口收口或首次真实触发时
```
