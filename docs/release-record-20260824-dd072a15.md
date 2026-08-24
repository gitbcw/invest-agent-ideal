# 发布记录：20260824T065229Z-dd072a15

按 [release-governance-evidence-template.md](./release-governance-evidence-template.md) 口径记录。

## 变更摘要

```text
release_id: 20260824T065229Z-dd072a15
commit: dd072a158c7c3d2253d9b06302a4d5d75b4c8964
branch: feat/mastra-migration（committed-local-baseline；远端刷新仅审计证据，未推送远端——用户指示）
date: 2026-08-24 14:52–15:00（本地）
owner: 用户授权，agent 执行（白天发布惯例）
change_type: code（治理落地执行线 WP0–WP5 + Portal 基线红线 + 数据缺口指令行）
```

- 变更目的：T-357 治理落地执行线（WP0 文档基线、WP1 确定性/发布阻断修复、WP3 运行诊断链、WP4 评估变更门、WP5 故障/发布演练）+ Portal 正式基线红线（apps/portal）+ owner 在途指令行（数据缺口宣告前穷尽其他途径）+ 发布快照/备份脚本深度口径修复。
- 影响范围：runtime 服务工具（投影读回、audit trace_id）、调度穿线（runId）、Platform 诊断端点、Portal 构建感知部署链、治理文档与测试。
- 明确不影响的生产状态：`.env`、SQLite 数据、Workspace、`reviews/`、`.state`、微信状态——零触碰；`sandbox_audit_logs.trace_id` 为叠加列，启动时自动补列，旧行保持 NULL 并按缺失计数呈现。
- 依赖与外部条件：无新增外部依赖。

## 验证证据

| 门类 | 结果 | 证据 |
| --- | --- | --- |
| 确定性测试/类型检查/构建 | pass | 快照内 `npm run verify`：555 用例 0 skip、build、boundary 7/7 |
| scope/权限/确认/revision/幂等 | pass | EV-014（method-change-apply 全链） |
| 错误终态、超时、取消、重试 | pass | EV-015/EV-016/EV-018（F1–F4 演练记录） |
| Trace 覆盖和秘密边界 | pass | EV-017 + trace 写入端截断脱敏未改；诊断端点 admin_audit.read 门禁 |
| Portal/微信/scheduler/automation 适用链路 | pass | 见下方发布后验收 |
| 隔离行为评估与 Bad Case 回归 | pass | EV-010~012（本机回放）+ EV-014~018 |
| 故障演练 | pass | [isolated-fault-drill-record-2026-08-24.md](./isolated-fault-drill-record-2026-08-24.md) |

## 发布执行

- 快照创建：两次失败两次修复后成功——①备份源含嵌套 `.codex/.tmp`（自动化运行沙箱残留）被安全校验拦截 → rsync 排除改任意深度；②哈希校验表达式仍锚定顶层导致暂存与远端清单永不相等 → 三处哈希/清理表达式对齐为全深度（b43edd2、dd072a1）。修复本身作为本次发布内容提交并随快照验证。
- 部署：`release:deploy` 全链——代码 rsync（保护运行资产、排除 apps/portal/.next）→ mastra-portal 停止 → 服务器 next build → 旧 .next 保留于 `.deploy/portal-previous-*` → 新构建齐全后重启 → invest-agent-mastra 重启。

## 发布后最小验收（手册第 8 节）

1. `/health` 200 ok ✓
2. PM2 `invest-agent-mastra`、`mastra-portal` online；旧 `invest-agent`/`invest-agent-portal` 保持 stopped ✓
3. Portal `/api/health` 200、`/login` 200、登录页引用的 `/_next/static` 哈希资源 200 ✓
4. `smoke:mcp-service-tools`（同一 dist）49 工具 ok ✓
5. Workspace 预检 n.a.（本发布未改 templates/workspace）✓
6. 微信两个 bot monitor 启动并从上次 sync 恢复 ✓（pushReady 依真实入站会话，按手册不为验收强发测试消息）
7. 活动 push job：0（发布前 1 个 retry 任务为 111 的自动化简报、来源明确，重启后队列收敛为 0）✓
8. 新进程日志：无新 ERROR/ACP ENOENT/scope 回退；Portal 构建窗口（14:53:24–29）的 connector socket 报错为预期断连，14:54:04 全部 connector 重新注册并提供服务（conversation.get ok=true）✓
9. 只读单点：真实 connector `conversation.get`（invest-agent-mgreplay）经新进程返回 ok ✓ + 同一 dist 的 stdio MCP 全链冒烟 ✓；未给真实用户发送任何测试消息 ✓

## 灰度与观测

- 灰度对象/allowlist：全体（代码发布通道；无行为开关类变更）
- 观测窗口：发布后 7 天（重点：调度链 trace runId 落库、audit trace_id 覆盖率经 diagnosticCoverage 上升、无重复推送）
- 必看指标：调度/推送终态、Portal/微信成功率、trace 覆盖、数据来源缺口
- 已知-good 标记：`accept --confirm=mark-known-good-v1` 完成，保留策略自动裁剪旧版本（20260809T115000Z-cf1e3e1c）

## 回滚

- 回滚目标：上一 known-good 快照（快照根按保留策略保留）；或 `npm run release:rollback -- 20260824T065229Z-dd072a15 --confirm=rollback-code-v1` 前先取更早快照
- 回滚只替换代码；不触碰 `.env`、SQLite、Workspace、reviews、`.state`、微信
- 回滚触发条件：安全/scope/事务/重复副作用回归，或核心链路不可用
- 回滚演练证据：release-snapshot-smoke 全链（含代码回退与 workspace 受控回退）当日通过

## Go / No-Go

```text
G1 反馈证据：go（EV-014~018 + 回放族）
G2 服务边界：go（scope/确认/幂等确定性断言；boundary 7/7）
G3 失败终态：go（F1–F4 演练记录）
G4 灰度与回滚：go（快照/known-good/回滚演练齐备）
G5 关联与脱敏：go（trace_id 显式关联 + 缺失计数；脱敏边界未改）

最终结论：go（生产已按此记录部署）
未解决风险：①生产首条真实回合落 trace_id 后建议复查 diagnosticCoverage；②F1 多模型轮内兜底端到端回放为可选增强；③远端 origin 未推送（用户指示），发布审计以 committed-local-baseline 为准
批准人：用户（2026-08-24 对话授权部署；不推远端）
复核日期：2026-08-24
```
