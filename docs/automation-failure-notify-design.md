# 自动化失败通知与恢复通知（T-479）设计与通知契约

- 依据：T-477 研究结论（`data/error-analysis/2026-09-06-t477-automation-failure-stages-and-degradation.md` §4-C1）。E2 稳定期 45 起 failed run 关联推送 0 条，scheduled 失败对用户完全静默，发现延迟 p50 24h+。
- 状态：已实现（2026-09-06）。本文既是实现方案也是通知契约（消费/诊断/验收时以本文为准）。

## 1. 目标与非目标

**目标**：scheduled 自动化 run 到达失败终态时通知用户；同任务连续失败只推首条；失败消除后（下次 scheduled 成功）推恢复通知。

**非目标（边界，来自任务契约）**：
- 不通知 manual origin 的 run（观察性运行，不影响熔断与游标）。
- 不通知轮内已被兜底救回的中间失败（那不是 run 终态，天然不进本机制）。
- 不调用模型生成通知正文（纯服务层模板）。
- 不改变现有重试、awaiting_user、dead/expired、summary 推送语义；不新增自动重试。
- 不新增"连败升级/暂停"通知类型（连续失败聚合后只有首条+恢复两类；暂停语义在首条文案中预告）。

## 2. 通知契约

### 2.1 触发条件（统一决策器，事务后查询式）

决策器 `notifyAutomationRunTerminal({ scope, taskId, runId })`（`src/services/automation-notify.ts`）在 run 终态落库后执行，纯 DB 查询决策，可安全重复调用：

| 通知 | 条件（全部满足） |
|---|---|
| 失败首条 | run 终态 `failed` ∧ run.origin=`scheduled` ∧ `automation_tasks.consecutive_failures = 1`（本次终态更新后） |
| 恢复 | run 终态 `succeeded` ∧ run.origin=`scheduled` ∧ 该 task 最新一条通知 job（failure/recovery 按 created_at 取最新）为 `automation_failure` |

推论（聚合语义的自然结果）：
- 连续第 2/3 次失败（cf≥2）→ 无新通知；needs_attention 暂停不单独通知。
- `skipped`/`cancelled` 终态 → 不推恢复（任务未恢复成功）。
- 从未失败过的任务成功 → 最新通知 job 不存在 → 不推。
- needs_attention 经人工恢复（cf 清零）后再次失败 → cf 又等于 1 → 推新一轮首条。
- 失败通知 job 即使 expired/dead（用户没收到），后续成功仍推恢复——用户至少知道已恢复。

### 2.2 push job 字段

| 字段 | 值 |
|---|---|
| messageKind | `automation_failure` / `automation_recovery`（新增自由字符串，无 DB 枚举；portal 不消费 message_kind，platform 诊断视图按 source 展示，无需改动） |
| idempotencyKey | `automation:{taskId}:failure:{runId}` / `automation:{taskId}:recovery:{runId}`（runId 全局唯一，天然跨任务隔离与重入幂等） |
| source | `automation`（进入 DEFERABLE_SOURCES：ret=-2 → awaiting_user 挂起语义继承） |
| originTaskKey | taskId |
| originRunId | **不设置**——避免 push 消费侧 `syncAutomationDelivery` 把通知投递结果回写 run.delivery_status（该字段语义属于 summary 推送） |
| expiresAt | 入队时刻 + 2h（时效性通知；与盯盘 validity 同量级。错过不补） |
| maxAttempts | 默认 5（继承管道） |
| channel/backend | weixin-mobile / mastra（继承缺省） |
| userId/projectId/instanceId | 取自 run 行（任务归属 scope） |

### 2.3 文案模板（服务层渲染，过 sanitizeWeixinCustomerText）

失败：
```
【定时任务失败】任务 {label}（计划 {HH:mm}）本次执行失败：{阶段人话}。
系统将按原计划在下个周期自动重试；若连续 3 次失败，任务会自动暂停并需要人工处理。
```
恢复：
```
【任务已恢复】任务 {label} 已于 {HH:mm} 成功完成，此前的连续失败已消除。
```
- `{label}`：taskId 主体段 + 尾部短码（如 `market-watch·88b950f3`）；不读取 revision instruction（不把用户配置正文带入推送）。
- `{HH:mm}`：run 的 scheduled_for（失败）/ finished_at（恢复）按 Asia/Shanghai 格式化。
- 阶段人话映射（error_category）：timeout→执行超时；expired→运行超时被系统回收；invalid_input/validation_failed→结果校验未通过；dependency_unavailable→依赖服务暂不可用；scope_or_permission→权限不足；transient→瞬时错误；其余→未分类错误。

### 2.4 审计

通知入队后写 `automation_task_audit_logs`：action=`run.failure_notified` / `run.recovery_notified`，status=`sent`（入队即审计；投递成败由 push_jobs 自身跟踪），details 含 runId、errorCategory、pushJobId、idempotencyKey。

## 3. 挂点（终态写入后、事务外）

| 路径 | 挂点 |
|---|---|
| runner 正常/失败收口 | `finishAutomationTaskRun`（automation-tasks.ts）事务提交后调用决策器（dynamic import 防循环依赖） |
| 租约过期 reaper | `recoverExpiredAutomationTaskRuns` 事务后对发生终态迁移的 rows 调用 |
| 队列延迟预检 | `src/scheduler/automation.ts` 中 `expireStaleScheduledAutomationTaskRun` 返回 expired 后调用 |

三条路径都只写终态不改通知状态本身（决策器查询式），重复触发幂等。

## 4. 已知取舍

- 失败通知 2h 内未送出即过期放弃（不补发）：若任务随后自愈，用户会收到恢复通知；若持续失败，用户在 portal 任务页仍可见 run 历史。选择短时效是为了避免"数小时后收到一条过时失败"的打扰。
- cf=1 判定依赖 active_run 互斥保证终态串行化（同 task 并发终态不存在）；reaper 与 runner 收口对同一 run 幂等（先到者写终态，后到者被 status!=running 挡住）。
- 恢复判定依赖"最新通知 job 是 failure"这一持久事实（push_jobs 无清理机制，标志稳定）；若未来引入 push_jobs 滚动清理，需保留每 task 最新一条 failure/recovery job 或改用显式标志。

## 5. 验收对照

隔离测试 `tests/automation-notify.test.ts` 覆盖：首次失败推 1 条、连续失败不重推、恢复通知、无失败历史成功不推、manual 不推、跨任务隔离、同 runId 重入幂等、needs_attention 恢复后再败推新一轮、reaper 过期路径通知、job 字段契约（messageKind/idempotency/expiresAt/无 originRunId/source）。
