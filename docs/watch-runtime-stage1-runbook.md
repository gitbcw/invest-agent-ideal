# 阶段一人工验收 Runbook

日期: 2026-06-28

适用范围:阶段一复盘与定时推送可靠承接验收

状态: 进行中。2026-06-28 已基于 `POST /api/testing/scheduler/trigger` 完成一轮主用户真实验收:

- `daily-review` 立即触发成功,主用户手机已收到复盘摘要。
- `market-watch` 立即触发成功返回 `NO_PUSH`,数据库正确记为 `skipped`,未误推送。

阶段一核心链路已跑通,后续继续观察自然调度场景与次日稳定性。

主用户 scope:

- `userId`: `primary`
- `projectId`: `invest-agent`
- `instanceId`: `invest-agent-primary`

注意:

- 不创建新的测试用户或实例。
- 该 scope 连接的是主用户本人的测试手机微信。
- 标记为"会推送"的步骤会真实发送微信消息。

## 1. 验收前检查

启动服务:

```bash
npm run dev
```

或构建后启动:

```bash
npm run build
npm start
```

检查健康状态:

```bash
curl -s http://localhost:22655/health
```

重点看:

- `status` 是否为 `ok`
- `hermesAcp` 是否存在
- `pushQueue` 是否能返回状态统计

## 2. 自动化 smoke

执行:

```bash
npm run smoke:stage1-scheduler
```

该 smoke:

- 使用主用户 scope。
- 不创建新用户。
- 会创建临时 `push_jobs` 记录并在结束前删除。
- 不会调用真实微信发送。

不要把 `smoke:schedules-loader` 当作本轮必跑项;它会创建临时测试 workspace,不符合本阶段"只用主用户投资助手"的验收约束。

通过标准:

- scheduled reply / schedules / push queue 契约均通过。

## 3. 主用户配置检查

检查主用户 workspace:

```bash
ls -la ../../my-data/projects/invest-agent-ideal/workspaces/primary
sed -n '1,220p' ../../my-data/projects/invest-agent-ideal/workspaces/primary/config/schedules.yaml
sed -n '1,220p' ../../my-data/projects/invest-agent-ideal/workspaces/primary/config/watch.yaml
```

重点看:

- `daily_review.enabled`
- `daily_review.auto_run`
- `daily_review.default_time`
- `weekly_review.default_time`
- `monthly_review.default_time`
- `market_watch.enabled`
- `market_watch.default_windows`
- `watch.yaml` 的 `mode`

## 4. 手动验证主用户助手推送

这个步骤会真实推送到主用户微信。

```bash
curl -s -X POST http://localhost:22655/api/platform/instances/invest-agent-primary/weixin/push/test \
  -H 'Content-Type: application/json' \
  -d '{"message":"阶段一验收：主用户投资助手推送测试"}'
```

通过标准:

- 手机微信收到测试消息。
- 如果没有收到,查看返回体里的 `state` 和服务日志。

不要使用 `/api/weixin/push/test` 验主用户助手;该接口走旧全局微信管理器,可能显示未连接,不能代表 `invest-agent-primary` 用户助手推送状态。

## 5. 手动触发巡检并进入队列

这个步骤可能真实推送,仅当当前有提醒触发时才会推送。

```bash
curl -s -X POST http://localhost:22655/api/alerts/check-and-push \
  -H 'Content-Type: application/json' \
  -d '{"userId":"primary","instanceId":"invest-agent-primary"}'
```

通过标准:

- 返回 `userId=primary`
- 返回 `instanceId=invest-agent-primary`
- 如 `count > 0`,返回 `pushJobId`
- 可在服务日志看到推送队列处理结果

## 6. 定时日复盘验收

这个步骤会真实推送日复盘摘要。正式验收统一使用可控触发入口,不要再依赖"改到下一分钟等待 tick"。

先看当前可调度 scope:

```bash
curl -s http://localhost:22655/api/testing/scheduler/scopes | jq
```

应包含:

- `userId=primary`
- `instanceId=invest-agent-primary`

立即触发 daily review:

```bash
curl -s -X POST http://localhost:22655/api/testing/scheduler/trigger \
  -H 'Content-Type: application/json' \
  -d '{
    "task":"daily-review",
    "userId":"primary",
    "instanceId":"invest-agent-primary",
    "manualReason":"stage1-acceptance-daily"
  }' | jq
```

通过标准:

- 返回 `ok=true`
- 返回 `taskKey`
- `taskRun.status` 为 `success` 或 `error`
- 成功时 `trace.mode=scheduled-daily-review`
- 若生成微信摘要,返回 `pushJobId`
- 手机微信收到复盘摘要,或 `pushJob.status` 明确落到 `retry/dead` 并带错误

2026-06-28 当前验收记录:

- `taskKey`: `2026-06-28:daily-review:primary:invest-agent-primary:stage1-acceptance-daily-2`
- `pushJobId`: `01c7c965-944d-4d45-b4bf-fb6f4d13afb4`
- `taskRun.status`: `success`
- `trace.mode`: `scheduled-daily-review`
- 主用户手机: 已确认收到

补充查询:

```bash
sqlite3 data/invest-agent.db "select task_key, task_type, status, push_job_id, finished_at from scheduled_task_runs where user_id='primary' and instance_id='invest-agent-primary' order by updated_at desc limit 5;"
sqlite3 data/invest-agent.db "select id, mode, status, elapsed_ms, created_at from codex_acp_traces where user_id='primary' and instance_id='invest-agent-primary' order by created_at desc limit 5;"
sqlite3 data/invest-agent.db "select id, source, status, attempts, last_error, created_at from push_jobs where user_id='primary' and instance_id='invest-agent-primary' order by created_at desc limit 5;"
sqlite3 data/invest-agent.db "select plan_date, generated_at, substr(summary,1,80) from daily_plans where user_id='primary' and instance_id='invest-agent-primary' order by generated_at desc limit 3;"
```

### 临时观察方式(仅保留作故障排查)

操作前先备份:

```bash
cp ../../my-data/projects/invest-agent-ideal/workspaces/primary/config/schedules.yaml /tmp/invest-agent-primary-schedules.yaml.bak
```

把 `../../my-data/projects/invest-agent-ideal/workspaces/primary/config/schedules.yaml` 中:

```yaml
daily_review:
  enabled: true
  auto_run: true
  default_time: "19:00"
```

临时改成一个足够靠后的时间,例如当前北京时间 3-5 分钟后,避免修改过程错过 scheduler tick:

```yaml
daily_review:
  enabled: true
  auto_run: true
  default_time: "19:31"
```

等待 scheduler tick。

通过标准:

- 服务日志出现 `触发 daily 复盘 user=primary instance=invest-agent-primary`
- `codex_acp_traces` 中有 `mode=scheduled-daily-review`
- `daily_plans` 或 workspace report 中有当天复盘记录
- `push_jobs` 中出现 `source=scheduler` 的记录
- 手机微信收到复盘摘要,或 push job 进入 retry/dead 并有错误原因

查询示例:

```bash
sqlite3 data/invest-agent.db "select id, mode, status, elapsed_ms, created_at from codex_acp_traces where user_id='primary' order by created_at desc limit 5;"
sqlite3 data/invest-agent.db "select id, source, status, attempts, last_error, created_at from push_jobs where user_id='primary' order by created_at desc limit 5;"
```

验收后恢复:

```bash
cp /tmp/invest-agent-primary-schedules.yaml.bak ../../my-data/projects/invest-agent-ideal/workspaces/primary/config/schedules.yaml
```

## 7. 盘中固定窗口验收

这个步骤只能在 A 股交易时段自然验证。当前阶段不建议为此改系统时间。

操作前备份:

```bash
cp ../../my-data/projects/invest-agent-ideal/workspaces/primary/config/schedules.yaml /tmp/invest-agent-primary-schedules.yaml.bak
cp ../../my-data/projects/invest-agent-ideal/workspaces/primary/config/watch.yaml /tmp/invest-agent-primary-watch.yaml.bak
```

优先使用可控触发入口:

```bash
curl -s -X POST http://localhost:22655/api/testing/scheduler/trigger \
  -H 'Content-Type: application/json' \
  -d '{
    "task":"market-watch",
    "userId":"primary",
    "instanceId":"invest-agent-primary",
    "manualReason":"stage1-acceptance-market-watch"
  }' | jq
```

通过标准:

- 返回 `ok=true`
- 返回 `taskKey`
- `trace.mode=scheduled-market-watch`
- ACP backend 返回 `NO_PUSH` 时,`taskRun.status=skipped` 且不产生新的 `pushJobId`
- ACP backend 返回正文时,返回 `pushJobId` 并真实推送

2026-06-28 当前验收记录:

- `taskKey`: `2026-06-28:market-watch:primary:invest-agent-primary:manual-2042:stage1-acceptance-market-watch-1`
- `replyTextRaw`: `NO_PUSH`
- `taskRun.status`: `skipped`
- `pushJobId`: 空
- 手机微信: 未收到额外消息,符合预期

如果需要排查交易时段自然命中问题,把 `config/schedules.yaml` 的 `market_watch.default_windows` 改到一个足够靠后的时间,例如当前北京时间 3-5 分钟后。`watch.yaml` 不再作为盘中固定时间任务的调度来源。

通过标准:

- 服务日志显示行情巡检命中对应 scope。
- `codex_acp_traces` 中有 `mode=scheduled-market-watch`。
- ACP backend 返回 `NO_PUSH` 时不产生新的 push job。
- ACP backend 返回正文时产生 `push_jobs` 记录并真实推送。

验收后恢复:

```bash
cp /tmp/invest-agent-primary-schedules.yaml.bak ../../my-data/projects/invest-agent-ideal/workspaces/primary/config/schedules.yaml
cp /tmp/invest-agent-primary-watch.yaml.bak ../../my-data/projects/invest-agent-ideal/workspaces/primary/config/watch.yaml
```

## 8. 已知限制

- 阶段一已使用 `scheduled_task_runs` 做持久化 task key 抢锁,用于防止多个服务进程同时扫同一主用户 workspace 时重复触发。
- 验收前建议用 `lsof -iTCP -sTCP:LISTEN -n -P | rg '2264|2265'` 查看是否存在多个 invest-agent 服务进程;多进程不再应导致重复触发,但会让日志分散在不同进程中。
- 当前阶段一已完成一轮立即触发人工验收,但仍建议继续观察自然调度场景和次日稳定性。
- 周/月复盘当前主要验收 workspace artifact 生成,不要求完整 Dashboard 查询闭环。
- 阶段一不验收价格阈值、均线突破、新闻粗筛等阶段二/三能力。
