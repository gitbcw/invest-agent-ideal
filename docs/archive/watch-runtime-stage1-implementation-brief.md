# 阶段一实施调研与推进方案

> 归档说明（2026-07-28）：阶段一已完成真实验收；当前 watch runtime 契约以 `docs/watch-runtime-phased-implementation.md` 为准。

日期: 2026-06-28

状态: 阶段一执行 brief,已完成首轮主用户真实验收

> 2026-06-28 验收纠正:主用户手机未确认收到复盘推送,且"临时改到下一分钟等待 scheduler tick"的验收方式不可靠。当前已补 `POST /api/testing/scheduler/trigger`,并已基于主用户 `primary / invest-agent-primary` 完成首轮真实重测:
> - `daily-review` 真实推送已收到
> - `market-watch` 返回 `NO_PUSH` 时未误推送

关联文档:

- `docs/watch-runtime-phased-implementation.md`
- `docs/archive/watch-runtime-design-note.md`
- `AGENTS.md`

## 1. 阶段一目标

阶段一只解决一件事:用户已经配置的复盘任务和盘中固定时间推送任务,必须能被稳定承接。

这里的"稳定承接"包括:

- 到时间能触发。
- 能进入正确的 `userId + instanceId` scope。
- 能调用 workspace-scoped ACP backend。
- 能保存复盘 artifact。
- 能把应推送内容进入微信可靠推送队列。
- 无需推送时能稳定处理 `NO_PUSH`。
- 失败时有日志、trace 或队列状态可查,不能静默失败。

阶段一不解决明确规则盯盘,也不解决新闻/事件粗筛。

## 2. 当前代码现状

### 2.1 已具备的主链路

当前已有阶段一骨架:

- `src/index.ts` 启动顺序为:数据库初始化 → HTTP 服务 → workspace ACP backend → scheduler。
- `src/server.ts` 注册 scheduler push callback,调度器产出的消息会进入 `push_jobs` 队列。
- `src/scheduler/index.ts` 每分钟扫描可调度 scope,负责盘中 market-watch 任务触发。
- `src/scheduler/review.ts` 每分钟扫描日/周/月复盘配置。
- `src/acp/scheduled-tasks.ts` 负责后台 ACP 任务:
  - `runScheduledMarketWatchTask`
  - `runScheduledReviewTask`
- `src/acp/scheduled-tasks.ts` 会通过 `recordAcpTrace` 记录后台任务成功或失败。
- `src/services/push-queue.ts` 已有可靠推送队列、重试、dead 状态、活跃复杂任务延迟投递机制。
- `src/lib/schedules-loader.ts` 已能解析 `workspace/config/schedules.yaml` 的 daily / weekly / monthly 时间。
- `scripts/schedules-loader-smoke.mjs` 已覆盖 schedules 解析和简单 report 落盘路径。
- `scripts/review-push-summary-smoke.mjs` 已覆盖日复盘推送摘要裁剪。

### 2.2 盘中固定时间任务现状

`src/scheduler/index.ts` 当前逻辑:

1. 每分钟 tick。
2. 获取 `fallbackInterval`。
3. 调 `getSchedulableScopes()`。
4. 对每个 scope 判断 `shouldRunMarketWatchTask()`。
5. 命中后调用 `runScheduledMarketWatchTask()`。
6. 如果返回文本,调用注册的 push callback。

`shouldRunMarketWatchTask()` 当前支持:

- A 股交易时段判断。
- `config/schedules.yaml` 的 `market_watch.enabled` / `auto_run`。
- `config/watch.yaml` 的 `mode: disabled/off`。
- `schedules.market_watch.default_windows` 是盘中固定时间任务的唯一调度来源；`watch.default_check_windows` 不再参与调度判定。
- `watch.check_interval_minutes` / `watch.custom_frequency` / `schedules.market_watch.custom_frequency`。
- 进程内 `marketWatchFiredKeys` 去重。
- 同一 scope 的 `runningMarketWatchTasks` 并发防重。

这说明阶段一的"定时窗口承接"已经有代码基础。

### 2.3 复盘任务现状

`src/scheduler/review.ts` 当前逻辑:

1. 每分钟 tick。
2. 获取可调度 scopes。
3. 对 daily / weekly / monthly 分别判断是否命中。
4. daily 在北京时间 15:00 前不扫描。
5. workspace 存在时读 `config/schedules.yaml`。
6. daily 可按 `skip_automatic_if_manual_report_exists` 避免重复。
7. 命中后调用 `runScheduledReviewTask()`。

`runScheduledReviewTask()` 当前:

- daily:构建 deterministic review context → 调 workspace ACP backend → 清洗正文 → 生成 push summary → `saveSkillDailyReview()` 保存。
- weekly/monthly:构建上下文 → 调 workspace ACP backend → 写 `workspace/reports/<kind>/` → 返回推送摘要。

这说明阶段一的"复盘任务承接"也已经有代码基础。

### 2.4 推送可靠性现状

`src/server.ts` 注册给 scheduler 的 push callback 会:

1. 调 `enqueuePushJob()` 创建 `push_jobs`。
2. 记录日志。
3. 立即调用 `processDuePushJobs()` 尝试投递。

`startPushQueueWorker()` 还会每 30 秒处理 due jobs。

因此,阶段一不需要重做可靠队列。需要做的是把它纳入验收,确保 scheduler 任务产出的消息确实进入队列并有状态可查。

## 3. 当前主要缺口

### 3.1 之前缺少可控验收入口

现有 smoke 覆盖了 schedules-loader、复盘摘要、push routing 的部分契约。2026-06-28 之前,人工验收真正缺的是一个可控触发 scheduler 等价路径的入口,导致只能靠"改到下一分钟"这种不稳定方式。

> 2026-06-28 更新:`smoke:stage1-scheduler` 已补充第一版,使用主用户 `primary / invest-agent-primary`,不创建新用户,并清理自己创建的临时 `push_jobs`。同时新增 `POST /api/testing/scheduler/trigger`,可立即触发 daily/weekly/monthly review 或 market-watch。

自动化 smoke 仍需要验证:

- schedules 命中判断。
- scheduler 命中后会调用任务 runner。
- runner 产出文本后会进入 push callback。
- push callback 能入队。
- `NO_PUSH` 不入队。
- runner 抛错不会卡住下一轮。

如果当前函数不可注入,第一步可以先补静态/模块级 contract smoke,第二步再做小重构提升可测性。

### 3.2 多进程重复触发风险

真实验收时发现本机存在多个 invest-agent 服务进程监听不同端口,但共享同一份主用户 workspace 和数据库。临时修改主用户 `schedules.yaml` 后,多个进程可能同时命中同一个 daily review slot,造成重复 ACP 调用和重复微信推送。

2026-06-28 已补充 `scheduled_task_runs` 持久化抢锁:

- 复盘任务 key:`date:kind-review:userId:instanceId`。
- 盘中巡检 key:`date:market-watch:userId:instanceId:slot`。
- 多进程同时命中时,只有第一个成功 `INSERT` 的进程执行;其他进程跳过。
- task run 记录 status、claimedAt、finishedAt、errorMessage、pushJobId。

进程内 `Set` 仍保留用于单进程内快速防重,但跨进程防重以 `scheduled_task_runs` 为准。

### 3.3 配置解析失败只有 warn,缺少用户可见状态

`readSchedules()` 和 `readWatchConfig()` 出错时会 warn 并降级为空配置或 null。

这能防止系统崩溃,但用户或运营侧不容易知道某个 workspace 的定时任务为什么没有跑。

阶段一建议增加最小可观测性:

- health 或 dashboard 能看到最近 scheduler 错误摘要。
- 或至少补 `scripts/stage1-scheduler-health-check.mjs`,检查 workspace 配置是否可读、字段是否有效。

### 3.4 daily 保存路径比 weekly/monthly 更完整

daily 通过 `saveSkillDailyReview()` 保存到 daily backend,并可能 mirror 到 workspace。

weekly/monthly 当前直接写 `workspace/reports/weekly|monthly`。这符合阶段一最小目标,但后续如果要在 Dashboard 统一查询周/月复盘,还需要补统一 artifact 查询。

阶段一只要求生成和保存,不要求完整工作台阅读能力。

### 3.5 后台 ACP 输出质量没有强约束测试

market-watch 要求 ACP backend 返回 `NO_PUSH` 或 500 字以内正文;daily/weekly/monthly 也要求短推送摘要。

现有 smoke 主要测日复盘摘要裁剪,没有覆盖:

- scheduled market-watch 的 `NO_PUSH` 清洗。
- "当前无提醒/暂无提醒" 等中文无推送语义。
- 后台任务输出中工程词汇过滤。

阶段一应补低成本纯函数 smoke,避免不该推的内容被推送。

### 3.6 人工验收需统一收敛到立即触发路径

阶段一是服务可靠性,仅靠单元测试不够。需要一份人工验收步骤:

- 如何使用 `POST /api/testing/scheduler/trigger` 触发 scheduler 等价路径。
- 如何观察日志。
- 如何查 `push_jobs`。
- 如何查 `codex_acp_traces`。
- 如何确认 workspace report 已保存。
- 如何恢复配置。

## 4. 阶段一推进方案

### P1. 先补阶段一验收文档和人工 runbook

目标:让任何执行 agent 或人都能验证当前链路。

交付:

- 在本文或单独 runbook 中写清命令和检查点。
- 覆盖日复盘、周复盘、月复盘、盘中固定窗口、NO_PUSH、推送队列。

验收:

- 不读源码也能按步骤完成一次阶段一验收。

### P2. 补后台任务 smoke

目标:把阶段一关键契约自动化。

已新增:

```text
scripts/stage1-scheduled-tasks-smoke.mjs
```

第一版 smoke 可覆盖:

- `sanitizeScheduledReply()` 行为。若函数未导出,建议导出为 test-only 友好的纯函数。
- schedules-loader 对 market_watch windows / custom_frequency 的解析。
- push queue 入队、发送成功、发送失败重试、dead 的基本行为。

第二版 smoke 可覆盖:

- 注入 fake runner / fake push callback,验证 scheduler 命中后调用路径。
- fake `NO_PUSH` 不产生 push job。

验收:

- `npm run build && node scripts/stage1-scheduled-tasks-smoke.mjs` 通过。
- 可加入 package script: `smoke:stage1-scheduler`。

### P3. 强化后台任务日志与 trace 字段

目标:失败可定位。

建议检查并补齐:

- market-watch hit 时记录 userId / instanceId / slot。
- market-watch skipped 的关键原因可在 debug 或 trace 中看到,至少配置错误要 warn。
- `runAcpTask()` 已记录 success/error trace,确认 trace 中包含 mode、elapsedMs、sandbox token id、permissions。
- push enqueue 后记录 job id。

验收:

- 人工触发一次后台任务,能在日志中串起:命中调度 → ACP task → trace → push job。

### P4. 持久化 task run 去重

目标:避免多服务进程同时扫同一 workspace 时重复触发。

已落地:

- 新增 `scheduled_task_runs` 表。
- 新增 `src/services/scheduled-task-runs.ts`。
- review scheduler 和 market-watch scheduler 在调用 ACP backend 前先 claim。
- `smoke:stage1-scheduler` 覆盖同一 taskKey 只能领取一次。

验收:

- 多进程或重复调用同一 task key 时,只有一个进程执行。
- `scheduled_task_runs` 能记录 task 领取和完成状态。

### P5. 验证用户 scope 扫描是否符合当前产品

当前 `getSchedulableScopes()` 会纳入:

- 默认用户。
- active users 的 active aiInstances。
- 微信绑定 identity instances。
- enabled stage2 watch_rules(`alert_rules`) 对应 scope;legacy `alerts` 不再纳入 scheduler scope。

阶段一需要确认这符合当前"精品投资助手/少数客户"模式。风险是测试用户或历史实例被扫入。

建议:

- 增加 smoke 或 health check 输出 schedulable scope 摘要。
- 至少人工验收时打印/查询当前 scopes。

验收:

- 阶段一验收前能确认不会对无关测试用户触发复盘或盘中推送。

## 5. 建议实施顺序

1. 先补 `smoke:stage1-scheduler` 的最小版本,覆盖纯函数和 push queue。
2. 补可控的立即触发入口,避免再靠"下一分钟"验收。
3. 再补 scheduler / scheduled task 的日志与可观测性。
4. 写人工 runbook,统一用主用户助手验证 daily review 和 market-watch `NO_PUSH`。
5. 再用真实微信 push 通道验证 `push_jobs` 状态流转。
6. 保留真实验收发现:多进程重复触发已通过持久化 task run 去重修复。

## 6. 阶段一验收清单

### 自动化验收

- `npm run build` 通过。
- `npm run smoke:stage1-scheduler` 通过。
- `npm run smoke:review-push-summary` 通过。
- 如有改动,`npm test` 通过。

说明:`smoke:schedules-loader` 会创建临时测试 workspace,不作为本阶段主用户验收必跑项。

### 人工验收

- 使用主用户投资助手 workspace,不要创建新的测试用户或实例。
- 使用 `POST /api/testing/scheduler/trigger` 立即触发 daily review scheduler 等价路径。
- 启动服务,观察 scheduler 命中。
- 确认 `codex_acp_traces` 记录 `scheduled-daily-review`。
- 确认 daily report 已保存。
- 确认 push job 进入 `push_jobs`,并最终 sent / retry / dead 状态可查。
- 使用 `POST /api/testing/scheduler/trigger` 验证 market-watch 固定窗口。
- 确认 market-watch 命中后,`NO_PUSH` 不入队,有正文时入队。
- 恢复 workspace 配置。

2026-06-28 实际结果:

- `daily-review`:
  - `taskRun.status=success`
  - `pushJobId=01c7c965-944d-4d45-b4bf-fb6f4d13afb4`
  - 主用户手机已确认收到
- `market-watch`:
  - `replyTextRaw=NO_PUSH`
  - `taskRun.status=skipped`
  - 未产生 `pushJobId`
  - 未误推送

## 7. 不进入阶段一的事项

以下事项不要在阶段一实现:

- `watch_rules.yaml`。
- 价格阈值、均线突破/跌破等 Primitive evaluator。
- 新闻源、公告源、正则粗筛。
- Agent 主观事件判断。
- SQLite alert 规则迁移。
- Dashboard 大改版。

## 8. 开放问题

1. `scheduled_task_runs` 是否需要定期清理历史记录?第一版可以保留,后续按 90 天或 180 天清理。
2. 阶段一是否要暴露 `/api/scheduler/status` 给 Dashboard 或健康检查使用?
3. 阶段一 market-watch 的人工验收是否允许使用非交易日 force/mock time?如果允许,需要给测试入口留 mock now。
4. 周/月复盘是否需要在阶段一进入统一查询 API,还是只要求 workspace artifact 存在?

## 9. 执行代理提示

Executor prompt:

```markdown
请基于 `docs/watch-runtime-stage1-implementation-brief.md` 推进阶段一。只处理复盘与定时推送可靠承接,不要实现阶段二 Primitive 或阶段三新闻粗筛。优先补 smoke、日志/trace 可观测性、人工验收 runbook。每个改动都要能对应阶段一验收清单。
```

Reviewer prompt:

```markdown
请按 `docs/watch-runtime-stage1-implementation-brief.md` 审查阶段一执行结果。重点检查:是否越阶段实现、是否有端到端或契约 smoke、复盘 artifact 是否保存、push_jobs 是否可追踪、NO_PUSH 是否不推送、ACP backend 失败是否不会卡住 scheduler、scheduled_task_runs 是否能防止多进程重复触发。
```
