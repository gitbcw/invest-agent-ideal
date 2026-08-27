# 一次运行诊断视图契约

状态：治理基线草案（2026-08-22）；核心链路已实现（2026-08-24，T-363 / WP3）；诊断视图 UI 已落地（2026-08-27，Platform「运行诊断」视图，`src/admin/platform-ui/owner/view-diagnostic.ts`）

> **实现状态（2026-08-24，T-363 / WP3）**：本契约的核心关联已落地——
> - `sandbox_audit_logs` 新增 `trace_id`（叠加列），服务工具 audit 从回合上下文显式携带；
> - scheduler 回合（market-watch / 复盘）把 `taskKey` 作为 `runId` 写入 trace，trace↔run 不再依赖时间邻近；
> - 查询入口：`GET /api/platform/audit/run-diagnostic?by=<traceId|messageId|conversationId|runId|taskId|deliveryId>&id=...`（`admin_audit.read`），实现于 `src/services/run-diagnostic.ts`；
> - 缺失关联计数：`missingLinks`（per 查询）与 `GET /api/platform/audit/trace-coverage` 的 `diagnosticCoverage`（窗口聚合）；
> - Platform 推送运行聚合（`aggregatePushRuns`）显式关联优先，时间邻近仅作旧行展示兜底并以 `traceLink=time_proximity` 标记，不作为治理证据；
> - 样例链回归：`tests/run-diagnostic-chain.test.ts`（Portal 对话链 + scheduler/push 链 + 反向入口 + n.a. 语义 + 缺失计数）。
> 契约第「验收样例」3、4 号（外部 MCP 降级链、推送过期链）属 WP4/WP5 评估与故障演练范围，尚未纳入回归。
> UI（2026-08-27）：入口表单（六种 ID 类型）+ 九段阶段流（n.a. 段折叠灰显）+ missingLinks 红色缺口徽章 + notes 脚注；日志审计时间线的 trace/run/pushJob 徽章可一键跳入。健康总览条另消费 `trace-coverage` 的 `health` 字段。

本契约定义“从一次运行复盘整个链路”的最小视图。它补充 [mastra-observability-contract.md](./mastra-observability-contract.md)，不替代 `agent_traces`、conversation、automation、artifact 或 delivery 表的 ownership。

## 目标

给定一个 `traceId`，诊断者应能看到请求入口、Agent 回合、模型尝试、工具调用、服务审计、自动化/调度运行、产物写入和投递终态；任何缺失关联都必须显示为缺口，不得用时间邻近猜测关联。

## 关联链

```text
channel request
  -> conversation turn
  -> agent trace
  -> model attempt(s)
  -> tool call(s)
  -> service audit / deterministic write
  -> artifact or asset
  -> automation / scheduler run
  -> push / delivery terminal state
```

## 最小字段

| 节点 | 必需字段 | 缺失语义 |
| --- | --- | --- |
| request | `requestId`, channel, receivedAt, scope | `request_unlinked` |
| conversation | `conversationId`, `messageId`, user/instance scope | `conversation_unlinked` |
| trace | `traceId`, backend, model, status, elapsedMs | `trace_missing` |
| model attempt | model, source, startedAt, firstTokenMs, terminal status | `model_attempt_missing` |
| tool call | tool name, duration, result status, bounded summary | `tool_observation_missing` |
| service audit | operation, scope, confirmation/revision result, audit id | `audit_missing` |
| artifact/write | artifact/asset id, operation, checksum or version, result | `artifact_unlinked` |
| automation/run | task id, run id, task type, terminal status | `run_unlinked` |
| delivery | push/delivery id, channel, status, error class, timestamps | `delivery_unlinked` |

## 诊断视图要求

- 以 `traceId` 为入口，同时支持按 `conversationId`、`runId`、`taskId` 和 `deliveryId` 反查。
- 展示状态转换和时间顺序，但不把时间邻近当作长期主关联。
- 对 `success` 必须显示业务终态；对 `error`/`timeout`/`cancelled`/`expired`/`dead` 必须显示错误分类、是否重试和最终处置。
- 显示缺失关联计数，并进入 Trace 覆盖率统计。
- 工具、Prompt、模型回复和错误内容只保留必要的脱敏摘要、大小和类型，不显示秘密或完整原文。
- 观测写入失败不得阻断用户请求，但必须产生覆盖率缺口和运维告警。

## 验收样例

至少准备四个隔离样例：

1. Portal 成功对话并产生文件交付；
2. scheduler/automation 成功运行并完成推送；
3. 外部 MCP 失败后降级并收敛为明确终态；
4. 推送过期或永久失败，且没有重复副作用。

每个样例都必须能从入口 ID 找到所有适用节点，并明确记录不适用字段。

