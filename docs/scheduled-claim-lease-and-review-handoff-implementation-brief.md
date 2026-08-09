# 调度 Claim 租约与复盘 Prepare 交接实施简报

## 1. 背景与决策

2026-08-03 至 2026-08-07 的火山云生产审计确认两个适合立即修复的确定性问题：

1. 三个真实用户各有一条 `market-watch` 运行永久停留在 `claimed`，且 `lease_expires_at` 为空。
2. 复盘 prepare 尚在执行时，正式触发再次使用同一 ACP conversation，产生 `ACP_TURN_BUSY`。

本轮只修这两项。以下问题继续观察一周，不进入实现范围：

- ACP/API 超时及总体耗时；主因暂按外部 API 波动观察。
- Codex/ACP 打包缓存和可选依赖缺失；此前已经修复，继续观察复发率。
- Portal scope mismatch；此前已经修复，继续观察。
- YAML 用户资产格式；此前已经修复，继续观察。
- 微信 `ret=-2` 与用户会话恢复语义。

## 2. 目标

- 所有新的 `scheduled_task_runs` claim 都有明确租约，并最终进入 `success`、`skipped` 或 `error`。
- 服务重启后，过期或历史遗留的 `claimed` 记录能够安全收敛，不永久占用状态。
- 不自动重放上线前的历史任务，不补发过期盘中消息，不制造重复 push job。
- 正式复盘不得在 prepare 仍运行时启动第二个同 conversation ACP turn。
- prepare 成功后只使用其冻结结果；prepare 失败后最多执行一次现有 fallback generation。

## 3. 非目标

- 不调整 ACP 模型、API provider、请求总超时或长任务拆分策略。
- 不实现完整的生成重试状态机；`docs/scheduled-message-retry-and-expiry-plan.md` 中的多次生成重试仍是后续独立工作。
- 不修改 `push_jobs` 的投递重试和微信会话恢复逻辑。
- 不增加数据库列、表或历史数据迁移脚本。
- 不修改真实 Workspace、复盘内容、Skill 或用户配置。

## 4. 现状约束

- `scheduled_task_runs` 已有 `attempts`、`max_attempts`、`lease_expires_at`、`expires_at` 和 `error_class`，本轮无需迁移。
- `claimScheduledTaskRun()` 当前只做 `INSERT ... ON CONFLICT DO NOTHING`，不会写租约，也不会回收旧 claim。
- `finishScheduledTaskRun()` 当前只按 `task_key` 更新，会允许迟到 worker 覆盖已经收敛的状态。
- 所有 scheduled ACP 调用的默认硬超时为 10 分钟。
- review prepare 默认提前 10 分钟，与 ACP 硬超时相等，因此 prepare 很容易跨过正式触发时刻。
- prepare 和正式复盘使用相同的确定性 conversation ID；`activeConversations` 拒绝同 conversation 并发是正确的安全保护，不应移除或放宽。

## 5. 方案 A：P-001 Claim 租约与过期收敛

### 5.1 Claim 写入租约

扩展 `claimScheduledTaskRun()` 的输入：

```ts
interface ScheduledTaskRunClaimInput {
  // existing scope and task fields
  leaseMs?: number;
}
```

行为：

- 新任务写入 `attempts=1`。
- 写入 `lease_expires_at = now + leaseMs`。
- 默认租约为 15 分钟，覆盖 scheduled ACP 10 分钟硬超时、取消和状态落库缓冲。
- review 正式触发若需要等待 prepare 再 fallback，显式使用 25 分钟租约。
- 不在本轮通过过期 claim 自动重新认领或执行任务。

### 5.2 Finish 只能收敛活动 Claim

将 `finishScheduledTaskRun()` 的更新条件收紧为：

```text
task_key = ? AND status = 'claimed'
```

成功更新时同时：

- 写入终态、`finished_at`、错误和 push job。
- 清空 `lease_expires_at` 和 `next_retry_at`。

若更新行数为 0，记录一条包含 `task_key` 和目标状态的 warning，不覆盖已经被 reconciliation 收敛的状态。

### 5.3 过期 Claim Reconciliation

在 `src/services/scheduled-task-runs.ts` 增加只做终态收敛的函数：

```ts
reconcileExpiredScheduledTaskRuns(now?: Date): Promise<number>
```

原子更新以下记录为 `error`：

- `status='claimed' AND lease_expires_at <= now`。
- 兼容历史遗留：`status='claimed' AND lease_expires_at IS NULL AND claimed_at <= now - 30 minutes`。

收敛字段：

- `status='error'`
- `error_class='lease_expired'`
- `error_message='scheduler claim lease expired before terminal state'`
- `finished_at=now`
- `lease_expires_at=NULL`
- `updated_at=now`

调用位置：

- `startScheduler()` 启动时执行一次。
- scheduler 周期扫描开始时执行；同一进程通过轻量时间门限限制为每分钟最多一次。

安全边界：

- 不调用 ACP。
- 不创建 push job。
- 不改变原 `task_key`。
- 不自动重放历史三条 `claimed` 任务；上线后只把它们收敛为可审计的 `error/lease_expired`。

### 5.4 租约时长约束

租约必须大于执行链硬上限，避免仍在正常执行的 worker 被提前收敛：

- `market-watch`、rule check、prepare：15 分钟。
- 正式 review handoff：25 分钟。
- 非 ACP 短任务可沿用 15 分钟，首轮不为每类任务建立复杂策略表。

本轮不实现 heartbeat。只有当后续出现合法任务超过上述硬上限时，才增加续租，而不是无限放大租约。

## 6. 方案 B：P-003 Prepare 与正式复盘交接

### 6.1 不改变 Conversation 锁

保留 `StdioAcpAgent.activeConversations` 和 `ACP_TURN_BUSY`。该锁阻止同一 conversation 并发，问题在 scheduler 缺少阶段协调，不在 ACP 锁本身。

### 6.2 查询 Prepare 状态

在 scheduled task service 增加按 `task_key` 读取最小状态的函数，返回：

```ts
type ScheduledTaskRunState = {
  status: string;
  leaseExpiresAt: string | null;
  finishedAt: string | null;
  errorClass: string | null;
};
```

`triggerReviewNow()` 在找不到 prepared payload 时，查询对应 prepare key：

```text
{date}:{kind}-review-prepare:{user}:{instance}
```

### 6.3 Handoff 决策

正式复盘已经获得自己的 task claim 后，按以下顺序处理：

1. prepared JSON 或已发布 daily review 存在：直接使用，不调用 ACP。
2. prepare 为 `claimed` 且租约仍有效：等待 prepare 收敛，期间轮询 task 状态和 prepared payload；禁止调用 fallback ACP。
3. prepare 变为 `success`：读取并推送冻结结果。
4. prepare 变为 `error`/`skipped`，或租约过期且 reconciliation 已收敛：确认没有可复用产物后，执行一次现有 fallback generation。
5. 等待期间服务停止：由 P-001 将正式 review claim 最终收敛为 `lease_expired`；本轮不自动补发。

等待实现要求：

- 使用可注入的 `sleep`/clock，便于确定性测试。
- 默认每 1 秒检查一次本地 SQLite/文件，最长等待到 prepare 租约结束并加 5 秒收敛缓冲。
- 每 30 秒最多记录一次进度日志，避免刷屏。
- 日志包含 kind、user、instance、date 和 prepare task key，不记录报告内容。

### 6.4 防止重复生成与重复推送

- 只要 prepare 仍为 live claim，正式触发不得调用 `runScheduledReviewTask()`。
- fallback 前再次检查 prepared file 和 durable daily review，处理“ACP 超时但产物已保存”的竞态。
- push job 继续使用现有稳定 `scheduledMessageIdempotencyKey()`，不创建新的幂等规则。
- manual trigger 带 `manualReason` 时保持现有行为，不等待自然调度 prepare，避免测试/人工触发被历史 prepare 阻塞。

### 6.5 Prepare 提前量

将默认 `REVIEW_PREPARE_LEAD_MINUTES` 从 10 调整为 12 分钟，给 10 分钟硬超时留出 2 分钟状态落库缓冲。环境变量仍可覆盖。

提前量只是降低重叠概率；正确性仍由 6.3 的状态交接保证，不能把“调大提前量”当作唯一修复。

## 7. 文件级实施范围

### 必改

- `src/services/scheduled-task-runs.ts`
  - claim 写租约。
  - finish 限制活动 claim 并清租约。
  - 增加状态读取和 expired reconciliation。
- `src/scheduler/index.ts`
  - scheduler 启动和周期调用 reconciliation。
  - market-watch/rule claim 使用明确租约。
- `src/scheduler/review.ts`
  - prepare/final claim 使用不同租约。
  - 增加 prepare handoff 等待和 fallback 前二次产物检查。
  - 默认提前量改为 12 分钟。
- `tests/scheduled-task-runs.test.ts`（新增）
  - claim、finish、lease expiry 和 legacy claim 收敛测试。
- `tests/review-scheduler.test.ts`
  - prepare/final 交接和无并发 fallback 测试。

### 可能需要调整

- 其他调用 `claimScheduledTaskRun()` 的 scheduler 模块，只需显式传租约或接受 15 分钟默认值。
- Platform 任务列表无需新增字段即可继续工作；若现有 UI 不展示 `error_class`，本轮不扩 API。

### 不改

- `src/acp/stdio-agent.ts`
- `src/services/push-queue.ts`
- 数据库 schema 和迁移代码
- Workspace 模板与真实 Workspace
- Portal 仓库

## 8. 测试计划

### 8.1 Scheduled task lease

- 新 claim 写入非空未来租约和 `attempts=1`。
- 同 task key 在活动 claim 期间不能二次领取。
- 正常 finish 清租约并进入目标终态。
- finish 不能覆盖已经被 reconciliation 标成 `lease_expired` 的记录。
- 已过期新 claim 被收敛为 `error/lease_expired`。
- 历史 `lease_expires_at=NULL` 且超过 30 分钟的 claim 被收敛。
- 未超过 30 分钟的 legacy claim 不被误收敛。
- reconciliation 不创建 push job、不改变终态任务。

### 8.2 Review handoff

- prepare 在正式触发时仍运行：final 等待，ACP generation 总调用次数为 1。
- prepare 完成并写文件：final 读取文件并只创建一个 push job。
- prepare 保存 durable daily review 后超时报错：final 探测到产物，不重复生成。
- prepare 确认失败且无产物：final 只 fallback 一次。
- prepare lease 过期：先收敛，再 fallback；不出现 `ACP_TURN_BUSY`。
- manual trigger 不等待自然 prepare。
- final 等待期间异常：task 最终可由 reconciliation 收敛，不永久 claimed。

### 8.3 回归

- `npm test`
- `npm run build`
- `npm run smoke:stage1-scheduler`
- `npm run smoke:stage2-watch-rules`

所有本地测试使用隔离 DB/Workspace，不连接真实 ACP，不发送真实微信。

## 9. 验收标准

1. 人工插入的过期和 legacy `claimed` 记录在 reconciliation 后进入 `error/lease_expired`，不会被重放。
2. 任意 scheduled task 正常结束后 `lease_expires_at` 为空。
3. 迟到 worker 不能覆盖 reconciliation 已写入的终态。
4. prepare 跨过正式触发时刻时，只有一个同 conversation ACP turn。
5. prepare 成功或已经持久化产物时，正式触发不重复生成。
6. 每个逻辑复盘最多产生一个稳定幂等 push job。
7. 现有 market-watch、rule check、daily/weekly/monthly review 测试通过。
8. 生产发布后，历史三条 `claimed` 仅被标记为 `lease_expired`，不产生补发。

## 10. 发布与观察

- 只走普通代码发布，不使用 runtime-data migration，不替换生产数据库或 Workspace。
- 发布前执行完整 `npm run verify` 和定向 scheduler smoke。
- 发布后只读确认：健康状态、PM2 uptime、历史三条 claim 已收敛、没有新增无租约 claim。
- 未经明确授权，不用真实用户触发复盘或微信推送；优先等待下一次自然调度并审计三位用户状态。
- 连续观察一周：`claimed` 存量、`lease_expired` 数量、daily/weekly review 的 `ACP_TURN_BUSY`、生成/推送幂等冲突。
- API timeout 单独记录趋势，不把它作为本轮修复成败标准。

## 11. 回滚

- 代码回滚到上一 known-good release。
- reconciliation 已收敛为 `error/lease_expired` 的历史行保留为审计事实，不回改为 `claimed`。
- 因为不改 schema、不自动重放、不修改 Workspace，回滚不需要数据恢复。

## 12. 执行与验收交接

Executor prompt:

> 按 `docs/scheduled-claim-lease-and-review-handoff-implementation-brief.md` 实现 P-001 和 P-003。严格遵守非目标：不调整 ACP/API 超时，不实现生成重试，不修改 push delivery、数据库 schema、Portal 或 Workspace。先完成确定性测试，再运行回归命令；不要部署生产。

Reviewer prompt:

> 独立审查实现是否满足 `docs/scheduled-claim-lease-and-review-handoff-implementation-brief.md` 第 9 节验收标准。重点检查过期 claim 是否可能被自动重放、迟到 worker 是否会覆盖终态、prepare live 时是否仍可能启动第二个 ACP turn，以及是否存在重复 push 风险。
