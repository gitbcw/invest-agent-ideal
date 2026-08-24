# 隔离故障演练矩阵

状态：治理基线草案（2026-08-22）；四类演练首轮已执行（2026-08-24，T-365 / WP5）

> **实施状态（2026-08-24，T-365 / WP5）**：F1–F4 首轮演练完成，记录见 [isolated-fault-drill-record-2026-08-24.md](./isolated-fault-drill-record-2026-08-24.md)。F1（网关 503 / 首字挂起）与 F3（未知命令 / 旧协议重放信封）的注入 fixture 在 `tests/isolated-fault-drills.test.ts`（npm test 可重复）；F2、F4 由 `tests/external-mcp-resilience.test.ts`、`tests/external-mcp-observer.test.ts`、`tests/push-queue-concurrency.test.ts` 承担。同轮完成隔离发布演练（release-snapshot-smoke 全链），生产发布不在该记录授权内。

本矩阵只描述隔离环境的故障演练方法，不对生产用户、生产微信、生产数据库或真实 Workspace 注入故障。每次演练都必须使用临时 DB/Workspace、受限 MCP、模拟依赖或授权测试账号。

## 通用要求

- 演练前记录隔离状态快照、版本、配置和依赖替身。
- 演练期间验证总预算、阶段超时、错误分类、重试/不重试、降级、终态和副作用幂等。
- 演练后清理隔离状态，并核对源快照未变化。
- 失败不得以“最终有回复”判定通过；必须检查业务终态和审计证据。

## 四类故障

| 编号 | 注入点 | 场景 | 预期行为 | 必查副作用 |
| --- | --- | --- | --- | --- |
| F1 | 模型 | 首字超时、上游错误或流中断 | 在预算内分类为 timeout/provider error；只对允许的 transient 进行有限兜底；最终成功或明确失败 | 不重复写入、不重复推送，trace 记录实际尝试模型 |
| F2 | 外部 MCP | 握手失败、连接断开、工具返回 malformed/partial | 有界重试/退避；无法恢复时说明数据缺口并降级，不编造实时事实 | external MCP observer 有终态，Agent 回合不假装工具成功 |
| F3 | Portal connector | relay 断连、响应超时、重连期间重复请求 | 请求进入明确 error/timeout/cancelled；重放按幂等规则处理 | conversation/message 不复制，取消和迟到结果状态一致 |
| F4 | 推送依赖 | 发送超时、永久拒绝、窗口过期、进程重启 | 区分 retryable/permanent/expired/dead；重启排空在途工作，过期不再发送 | push/delivery 终态唯一，无重复发送，有人工处置线索 |

## 每类演练记录

```text
drill_id:
fault_id: F1 | F2 | F3 | F4
environment:
commit / snapshot:
injection method:
start/end:
expected terminal state:
actual terminal state:
traceId / runId / taskId / deliveryId:
retry count and classification:
degradation result:
side-effect check:
cleanup check:
pass: yes | no | partial
follow-up evidence:
```

## 通过门槛

- 四类故障均有可重复记录；
- 实际终态与预期终态一致，或差异有明确归因；
- 没有无限重试、静默成功、越权、重复写入或重复推送；
- 可从诊断视图找到适用的 Trace、审计、运行和投递证据；
- 演练不改变生产 `.env`、SQLite、Workspace、`reviews/`、`.state` 或微信状态。

