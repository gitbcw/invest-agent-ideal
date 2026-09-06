# 发布记录：20260906T020157Z-2afb5e0f

按 [release-governance-evidence-template.md](./release-governance-evidence-template.md) 口径记录。这是 2026-08-24 以来第一份独立发布记录（G4 发布纪律恢复），也是语义回归门（[semantic-change-regression-gate.md](./semantic-change-regression-gate.md)）上线后的**首次真实消费者发布**（SCR-20260906-01/02，owner 2026-09-06 对话授权）。

## 变更摘要

```text
release_id: 20260906T020157Z-2afb5e0f
commit: 2afb5e0f81a9483726d5a0485ba28fbfab0257e7（main，committed-local-main；远端刷新结果记录于快照 manifest）
branch: main
date: 2026-09-06 10:01–10:04（北京时间，白天发布惯例）
owner: 用户授权（2026-09-06 对话：授权发布 + 代确认申报任务），agent 执行
change_type: code（T-472 诊断链观测口径修复 + T-473 summary 服务层质量下限）
```

- 变更目的：GAP-1 微信通道关联键统一（85 条工具调用+21 条消息反链断点归零）；GAP-2 diagnosticCoverage 排除 n.a. 任务类型消除平台指标失真；BC-20260904-001 空壳简报服务层质量下限（owner 裁决选项 A）。
- 影响范围：`src/channels/weixin-message-bridge.ts`（微信轮 turn id）、`src/services/run-diagnostic.ts`（覆盖率口径）、`src/services/generic-automation-runner.ts`（推送消息下限）、Platform 审计健康 UI（n.a. 标注）、测试 ×3、评估登记表与 BC 文档。
- 明确不影响的生产状态：`.env`、SQLite 数据、Workspace、`reviews/`、`.state/`、微信状态——零触碰（rsync 排除清单在案；发布后微信三 bot 从上次 sync 恢复）。
- 依赖与外部条件：无新增外部依赖。

## 验证证据

| 门类 | 结果 | 证据 |
| --- | --- | --- |
| 确定性测试/类型检查/构建 | pass | 快照前 `npm run verify`：646 测试 0 skip、build、boundary 7/7、agent-context 179 文档链接过（两次运行，第二次在最终 HEAD 2afb5e0） |
| scope/权限/确认/revision/幂等 | n/a | 未触及写路径与服务契约面（推送消息内容模板为新增防线，不改确认/幂等语义） |
| 错误终态、超时、取消、重试 | pass | 既有 EV-016/018/020/035/037 全绿；本发布未改调度/推送终态机 |
| Trace 覆盖和秘密边界 | pass | EV-017（含新增 GAP-2 分母分离断言）+ EV-022/034；脱敏边界未改 |
| Portal/微信/scheduler/automation 适用链路 | pass | 见下方发布后验收；语义门 SCR-20260906-01/02（tier-2）随 commit f370388，四栏：程序 pass / 语义 pass（确定性断言）/ 性能 n.a. / 业务终态待 7 天观察窗口，最终 go-with-isolation 经 owner 授权发布 |
| 隔离行为评估与 Bad Case 回归 | pass | EV-038（质量下限全链 3/3 绿）；EV-036/037 真实事件回归全绿 |
| 故障演练 | n/a | 未改故障面（F1–F4 注入点未触碰） |

## 发布执行

- 快照：`release:snapshot create` → workspace 备份完成、archive commit 2afb5e0、verified 20260906T020157Z-2afb5e0f；裁剪两个 8-24 旧快照。
- 部署：`release:deploy` 全链——代码 rsync（运行资产保护）→ Portal 停止构建（旧 `.next` 保留 `.deploy/portal-previous-*`）→ 双进程重启。部署脚本尾部一次 `curl 127.0.0.1:23655 Connection refused` 为重启瞬间端口未就绪的探测时差，后续验收确认服务正常。
- 发布窗口核对：周日 10:00（无盘中调度命中）；活动 push job 0（23 条 awaiting_user 属设计内挂起，随用户入站恢复）。

## 发布后最小验收（手册第 8 节）

1. `/health` 200 ok ✓（10:03:42Z）
2. PM2 `invest-agent-mastra` online（↺100 计数为历史累计）、`mastra-portal` online ✓
3. Portal `/api/health` 200、`/login` 200、登录页引用静态哈希资源 200 ✓
4. `smoke:mcp-service-tools`（同一 dist）48 工具 ok ✓（8-24 时为 49，差异为期间工具面合法变更，非本发布引入）
5. Workspace 预检 n.a.（本发布未改 templates/workspace）✓
6. 微信三 bot monitor started 并从上次 sync buf 恢复 ✓（pushReady 依真实入站会话，按手册不强测）
7. 活动 push job：0 ✓
8. 新进程日志：runtime 零 ERROR/ACP ENOENT/scope 回退；portal error 日志命中 4 行均为 2026-08-24 历史尾部，非本次 ✓
9. 变更点单点核验：部署 dist 三文件含修复符号（`SCHEDULER_TRACE_NA_TASK_TYPES`、`AUTOMATION_SUMMARY_MIN_CHARS`、信封键统一路径）✓；MCP stdio 全链冒烟 ✓；真实 connector `conversation.get` 单点未执行（本发布未改 connector/会话面，以同 dist MCP 冒烟+dist 符号核验替代，特此注明）

known-good 标记：`accept --confirm=mark-known-good-v1` 完成（2026-09-06 10:04 前后），自动裁剪旧 known-good 20260824T065229Z-dd072a15。

## 灰度与观测

- 灰度对象/allowlist：全体（代码发布通道；无行为开关类变更）
- 观察窗口：发布后 7 天（至 2026-09-13）——
  - GAP-1：新的微信轮 trace_id/消息/工具调用三方同键（覆盖率复测脚本按 [diagnostic-coverage-report-2026-09-06.md](./diagnostic-coverage-report-2026-09-06.md) 口径重跑，微信反链未解析数应归零且不再回升）；
  - GAP-2：`/api/platform/audit/trace-coverage` 的 scheduler 比率不再恒 0%，`scheduledRunsNa` 单列呈现；
  - 质量下限：巡查关注 `summary quality floor applied` warn 频次（触发=防线工作，空壳照推=复发）；
  - S7 巡查项三率（audit/automation/push 关联）按阈值执行。
- 必看指标：推送终态、微信/Portal 成功率、trace 覆盖、语义 FP
- 回滚触发：安全/scope/事务/重复副作用回归，核心链路不可用，或 SCRs 任一观察窗口硬失败

## 回滚

- 回滚目标：本快照自身已是 known-good；异常时回退至被裁剪前的上一个基线需从快照池取次新，或 `git revert f370388 + 2afb5e0` 后重新发布
- 回滚只替换代码；不触碰 `.env`、SQLite、Workspace、reviews、`.state`、微信
- 回滚演练证据：release-snapshot-smoke 全链（含代码回退与 workspace 受控回退）既有机制在案；本次未重跑（无 schema/数据面变更，回滚面=纯代码）

## Go / No-Go

```text
G1 反馈证据：go（EV-034~038 + 语义门首两份 SCR 实战）
G2 服务边界：go（未触及；boundary 7/7）
G3 失败终态：go（未改故障面；EV-016/018/020 全绿）
G4 灰度与回退：go（快照/known-good/回滚口径齐备；发布记录纪律自本次恢复）
G5 关联与脱敏：go（GAP-1/GAP-2 修复上线，7 天复测为观察项）

最终结论：go（生产已按本记录部署并验收）
未解决风险：①GAP-1 修复只对新微信轮生效，历史 85+21 条断链保持登记不回填；②质量下限首次生产运行，降级模板触发率待观察；③远端 origin 未推送（沿用户既有指示，审计以 committed-local-main 为准）
批准人：用户（2026-09-06 对话授权）
复核日期：2026-09-06；下次复核：2026-09-13 观察窗口收口时
```
