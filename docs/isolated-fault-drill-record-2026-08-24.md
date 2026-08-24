# 隔离故障演练与发布演练记录（2026-08-24，WP5 / T-365）

状态：已完成记录；生产发布不在本记录授权内。

环境：全部隔离——临时 DB/Workspace（`mkdtemp` 一次性目录）、本地 `127.0.0.1` 假模型网关、release-snapshot-smoke 的 fixture Git 仓库与假部署脚本。commit 基线 `349c4dd`（feat/mastra-migration）+ T-365 提交；`npm test` 全量绿。四类演练均不触碰生产 `.env`、SQLite、Workspace、`reviews/`、`.state` 或微信状态。

## F1 模型故障

```text
drill_id: FD-20260824-F1A
fault_id: F1
environment: 临时 DB/Workspace + 本地假网关（HTTP 503 注入）
commit / snapshot: 349c4dd + T-365
injection method: 本地 HTTP 网关对 /chat/completions 恒返 503（upstream unavailable / model_overloaded）
start/end: 2026-08-24（npm test 内执行，每次可重复）
expected terminal state: 回合以明确失败终态结束（异常带可分类信息），不静默成功
actual terminal state: rejects，错误文本含 503/unavailable 分类；耗时远小于 10s 预算
traceId / runId / taskId / deliveryId: 回合失败未产生业务写入（n.a.）
retry count and classification: 单次请求即失败；轮内多模型兜底决策由 tests/model-health-routing.test.ts 覆盖（exclude/迟滞）
degradation result: 明确失败（模型不可用时不得编造回复）
side-effect check: sandbox_audit_logs / conversation_messages 对该用户零增量
cleanup check: 假网关 server.close()；临时目录 rmSync
pass: yes
follow-up evidence: tests/isolated-fault-drills.test.ts（F1a）
```

```text
drill_id: FD-20260824-F1B
fault_id: F1
environment: 临时 DB/Workspace + 本地假网关（首字挂起注入）
commit / snapshot: 349c4dd + T-365
injection method: 网关接受请求后永不响应
start/end: 2026-08-24（npm test 内执行，每次可重复）
expected terminal state: timeoutMs=1200 预算内收敛为明确失败，不挂死
actual terminal state: rejects，elapsed ∈ [budget−400ms, 15s)
traceId / runId / taskId / deliveryId: n.a.（无业务写入）
retry count and classification: 超时归类为预算耗尽失败；不无限重试
degradation result: 明确失败
side-effect check: audit / message 零增量
cleanup check: 同上
pass: yes
follow-up evidence: tests/isolated-fault-drills.test.ts（F1b）
```

## F2 外部 MCP 断连

```text
drill_id: FD-20260824-F2
fault_id: F2
environment: 既有确定性回归（tests/external-mcp-resilience.test.ts、tests/external-mcp-observer.test.ts）
commit / snapshot: 349c4dd
injection method: 连接失败（握手失败）与 tools/call 失败/预算耗尽注入
start/end: 每次 npm test 重复
expected terminal state: 连接失败降级为空工具集且不阻断回合，成功后缓存；失败调用按 errorClass 落 observer 终态（HTTP_500、MCP_TOOL_CALL_REPEAT_BUDGET_EXHAUSTED 等）
actual terminal state: 与预期一致（断言通过）
side-effect check: 观测写入最小字段；无编造工具成功
cleanup check: 测试自清理
pass: yes
follow-up evidence: 上述两测试文件（已登记 EV-015）
```

## F3 Portal connector 断连/重放

```text
drill_id: FD-20260824-F3
fault_id: F3
environment: 临时 DB + connector __test__.handleCommand 直驱
commit / snapshot: 349c4dd + T-365
injection method: 未知命令、旧协议重放（asset.* 命令 + 1999 协议版本）
start/end: 2026-08-24（npm test 内执行，每次可重复）
expected terminal state: 未知命令 → INVALID_REQUEST（retryable=false）；旧协议重放 → PROTOCOL_VERSION_UNSUPPORTED；均不挂起、不留半程状态
actual terminal state: 与预期一致；conversation_sessions / conversation_messages 零新增
retry count and classification: 信封显式 retryable=false，不诱导盲目重试
degradation result: 显式错误信封
side-effect check: 零会话/消息行
cleanup check: 临时目录 rmSync
pass: yes
follow-up evidence: tests/isolated-fault-drills.test.ts（F3）；取消/孤儿回合/迟到结果抑制由 tests/portal-conversation-cancel.test.ts 覆盖；自动化重放幂等由 tests/automation-portal-contract.test.ts 覆盖
```

## F4 推送依赖失败

```text
drill_id: FD-20260824-F4
fault_id: F4
environment: 既有确定性回归（tests/push-queue-concurrency.test.ts，6 项）
commit / snapshot: 349c4dd
injection method: 过期任务、重试将超业务有效期、永久失败、会话恢复重放
start/end: 每次 npm test 重复
expected terminal state: 过期绝不外发；超业务期重试收敛 expired；永久失败停止且不再排重试定时；恢复只重排未过期 awaiting-user 任务
actual terminal state: 与预期一致（断言通过）
side-effect check: 无重复发送；终态唯一
cleanup check: 测试自清理
pass: yes
follow-up evidence: 已登记 EV-016
```

## 通过门槛核对（对照 isolated-fault-drill-matrix.md）

- 四类故障均有仓内可重复 fixture（npm test）✓
- 实际终态与预期一致 ✓
- 无无限重试、静默成功、越权、重复写入或重复推送 ✓
- 可从诊断视图定位适用证据：EV-017 run-diagnostic 端点与样例链回归 ✓
- 未改变任何生产状态 ✓

## 发布演练（隔离，非生产发布）

按 [release-governance-evidence-template.md](./release-governance-evidence-template.md) 口径记录，范围=release-snapshot-smoke fixture 全链：

| 门类 | 结果 | 证据 |
| --- | --- | --- |
| 确定性测试/类型检查/构建 | pass | `npm run verify` 退出 0（552+ 用例，0 skip；build；boundary 7/7） |
| scope/权限/确认/revision/幂等 | pass | EV-014（method-change-apply 全链） |
| 错误终态、超时、取消、重试 | pass | EV-015/EV-016 + 本记录 F1–F4 |
| Trace 覆盖和秘密边界 | pass | EV-017 + trace 截断脱敏既有实现（未改） |
| Portal/scheduler/automation 适用链路 | pass | F3 记录 + cancel/contract 回归 |
| 隔离行为评估与 Bad Case 回归 | pass | EV-010~012（本机回放）+ EV-014~018 |
| 故障演练 | pass | 本记录 F1–F4 |

发布链演练内容（fixture 环境）：`create`（含 `npm run verify` 门、工作区快照、内容清单 hash）→ `verify`（清单/checksum/bundle 校验，含旧 main 清单兼容）→ `deploy`（假部署脚本）→ `accept`（known-good 人工确认短语 + 保留策略裁剪）→ `rollback`（代码回退）→ workspace-rollback `plan/validate/apply`（隔离本地目标 + pre-apply-backup 保留）。smoke 于 2026-08-24 在当前工作树重跑通过（`release snapshot smoke passed`）。

Go/No-Go（**仅演练范围**）：G1–G5 全 go。

未解决风险与边界：

- 真实生产发布、真实灰度、生产数据迁移均不在本演练授权内；生产发布按白天惯例另行走独立发布记录与用户授权。
- 发布演练在 fixture 仓库完成，未覆盖真实远端部署路径（volcano-ops 流程），该路径以下一次真实代码发布时的发布记录为准。
- F1 轮内多模型兜底的完整回合级回归仍以 model-health-routing 单元决策 + 本记录预算/终态断言组合覆盖；真实多模型失败切换的端到端回放属后续可选增强，不阻断本门槛。
