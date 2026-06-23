---
name: invest-agent-service-tools
description: Use the running Invest Agent service as Codex's deterministic tool layer. Use when Codex needs to query or mutate holdings, watchlist, plans, alerts, signal settings, dashboard state, WeChat status, manual alert checks, or other local Invest Agent HTTP APIs.
---

# Invest Agent Service Tools

## Purpose

Codex is the agent. Invest Agent is the local deterministic service.

Use this skill when a user asks Codex to perform an operational action that should be executed by the running `invest-agent` service rather than by free-form reasoning.

## Boundary

The service must keep running for:

- Dashboard GUI.
- WeChat connection and listener.
- Scheduler.
- Intraday inspection.
- Alert push.
- SQLite persistence.
- Market data and capital flow fetching.

Codex should use this skill to call the service APIs, then explain the result to the user.

When this skill is used from the WeChat/ACP message path, the `invest-agent`
service is normally the parent process that invoked Codex. Do not start,
restart, stop, or otherwise manage the service process from inside a customer
turn. A local port being occupied usually means the main service is already
running; it is not evidence that the customer action failed.

## Base URL

Default local base URL:

```text
http://localhost:22648
```

If the service runs on another port, read `PORT` from `.env` or ask the user only if it cannot be discovered.

## Sandbox Mode For WeChat / ACP

When this skill is used from the WeChat/ACP message path, prefer the sandbox API surface.
The parent service prompt should provide `INVEST_AGENT_SANDBOX_TOKEN` or an explicit Bearer token.

Use:

```bash
curl http://localhost:22649/api/sandbox/dashboard \
  -H "Authorization: Bearer $INVEST_AGENT_SANDBOX_TOKEN"
```

Rules:

- Do not pass `userId` in query, headers, or body when calling `/api/sandbox/*`.
- The service determines the current user from the sandbox token.
- Never call admin APIs from a WeChat/ACP customer turn: `/api/users*`, `/api/signals/update`, `/api/interval/set`, `/api/weixin/*`, `/api/bypass-weixin/*`, or debug test endpoints.
- If the sandbox API rejects the token, report that the requested action could not be confirmed; do not try to bypass it with legacy APIs.
- Delete-style sandbox operations require a server-side pending confirmation. First call the delete endpoint without `confirmationId`; it will return `confirmation required`. Ask the customer to confirm the exact deletion. After the customer confirms in a later message, query `/api/sandbox/confirmations/pending` and retry the exact delete with the matching `confirmationId`.
- Do not invent or reuse confirmation IDs across users, conversations, operations, or resources.

Do not run `npm start`, `npm run dev`, PM2 commands, or any service startup
command while handling a customer request. If a health check or API call fails,
retry the API once, then report that the requested action could not be confirmed.

## Common Read APIs

```bash
curl http://localhost:22648/health
curl http://localhost:22648/api/dashboard
curl http://localhost:22648/api/weixin/status
```

Use `/api/dashboard` as the main state snapshot. It includes holdings, watchlist, plans, alert rules, signal config, capital flows, recent alert events, and recent reviews/plans.

In sandbox mode, use `/api/sandbox/dashboard` instead.

### Dashboard 字段语义(避免误读)

`/api/sandbox/dashboard` 返回里有几个字段容易被混淆,务必按下面语义理解:

- `alertRules` / `upgradedAlertRules`:用户**已生效**的提醒规则。这是"当前在跑的规则",不是"待确认的规则"。
- `proposedMethodChanges`:**策略实例展开候选**(`method_change_candidates` 表里 status=proposed 的记录)。这是"复盘/对话里捞出来的、可考虑沉淀到方法论档案的候选",**不是待确认的提醒规则,也不是待确认的沙盒写操作**。仅展示最近 7 天,更老的候选请通过 `/api/sandbox/reviews/monthly-context` 的 `methodChangeProposals` 字段完整查看。向用户汇报时应说"近期方法论候选 N 条,是否要采纳沉淀到方法论档案",不要把它说成"待确认规则"。
- 待确认的沙盒写操作(删除类操作)走另一个完全独立的机制,通过 `/api/sandbox/confirmations/pending` 查询,字段名是 `confirmations`。**两个机制不要混用。**

判断"用户当前有什么提醒规则"永远只看 `alertRules` / `upgradedAlertRules`,不要从 `proposedMethodChanges` 反推。

## Review APIs

Use these when skills need deterministic review context or need to persist a generated review artifact.

```bash
curl -X POST http://localhost:22648/api/reviews/context \
  -H 'Content-Type: application/json' \
  -d '{}'

curl -X POST http://localhost:22648/api/reviews/weekly-context \
  -H 'Content-Type: application/json' \
  -d '{}'

curl -X POST http://localhost:22648/api/reviews/monthly-context \
  -H 'Content-Type: application/json' \
  -d '{}'

curl -X POST http://localhost:22648/api/reviews/save \
  -H 'Content-Type: application/json' \
  -d '{"date":"YYYY-MM-DD","content":"FULL_REVIEW_MARKDOWN","summary":"WECHAT_SUMMARY"}'
```

In sandbox mode, use `/api/sandbox/reviews/context`, `/api/sandbox/reviews/weekly-context`, `/api/sandbox/reviews/monthly-context`, and `/api/sandbox/reviews/save` with the Bearer token.

`/api/reviews/context` returns facts only: market index lines, holdings/watchlist quotes, technical status, capital flow, information filter text, alert events, existing stock plans, review template, and data limits. Skills should make the investment judgment and final wording.

### `/api/reviews/weekly-context` 返回字段

`context.viewpointSummary` 包含本周所有结构化观点,字段:

| 字段 | 含义 |
| :--- | :--- |
| `counts` | `{ validated, invalidated, pending, open }` 状态计数 |
| `rows[].sourceDate` | 观点写入日期(YYYY-MM-DD) |
| `rows[].id` | 观点编号(如 v1) |
| `rows[].status` | `open` / `pending` / `validated` / `invalidated` |
| `rows[].view` | 观点正文(如"看多茅台") |
| `rows[].reason` | 当时理由 |
| `rows[].action` | 建议行动 |
| `rows[].validation` | **验证条件**:满足时判 `validated`(如"突破前高") |
| `rows[].invalidationSignals` | **失效信号数组**:任一触发判 `invalidated`(如 `["跌破 1700", "MACD 死叉"]`) |
| `rows[].confidence` | 置信度:`unknown` / `low` / `medium` / `high` |
| `rows[].expectedReviewDate` | 期望复核日期(YYYY-MM-DD) |
| `rows[].resolution` | 当前回测说明(已回测的有,未回测为 null) |

回测时,对 `status` 为 `open`/`pending` 的观点:
- 自行调 `get_quote` / `get_kline` / 资金流接口拉当周行情
- 用 `validation`(满足→`validated`)和 `invalidationSignals`(任一触发→`invalidated`)做判定
- 在复盘报告"日复盘观点回测"表格里输出 `validated`/`invalidated`/`pending`,服务端会解析回填

`context.viewpointSummaryText` 是同样的数据经过 markdown 表格化后的字符串(可读但字段不全,优先用 `viewpointSummary` 的结构化字段)。

## Common Write APIs

### Holdings

```bash
curl -X POST http://localhost:22648/api/portfolio/add \
  -H 'Content-Type: application/json' \
  -d '{"name":"招商银行"}'

curl -X POST http://localhost:22648/api/portfolio/remove \
  -H 'Content-Type: application/json' \
  -d '{"code":"600036"}'
```

Portfolio sandbox endpoints are not exposed yet. Do not mutate holdings from a WeChat/ACP customer turn until a sandbox endpoint exists.

### Watchlist

```bash
curl -X POST http://localhost:22648/api/watchlist/add \
  -H 'Content-Type: application/json' \
  -d '{"name":"宁德时代","reason":"来自选股报告，观察回调后的技术确认"}'

curl -X POST http://localhost:22648/api/watchlist/remove \
  -H 'Content-Type: application/json' \
  -d '{"code":"300750"}'
```

In sandbox mode, use `/api/sandbox/watchlist/add` and `/api/sandbox/watchlist/remove`.

Terminology:

- The watchlist is customer-facing `自选池` / `自选股`.
- Do not call it `观察池` in replies or saved reasons.
- If the user says “观察池”, treat it as a request for 自选池 and reply with 自选池 terminology.
- After adding stocks, report only the actual service result. Do not say the service restarted, failed, or recovered unless an API response or log proves it.

### Plans

```bash
curl -X POST http://localhost:22648/api/plans/set \
  -H 'Content-Type: application/json' \
  -d '{"stockCode":"600036","support":36,"resistance":40,"targetPrice":43,"stopLoss":33,"notes":"银行防守核心，关注净息差和资产质量"}'

curl -X POST http://localhost:22648/api/plans/remove \
  -H 'Content-Type: application/json' \
  -d '{"stockCode":"600036"}'
```

In sandbox mode, use `/api/sandbox/plans/set`, `/api/sandbox/plans/remove`, and `/api/sandbox/plans/watch-conditions`.

### Trading Strategies

交易策略实体存 `workspace/config/trading_strategies.yaml`,与预案(stock_plans)是 1:N 关系。

```bash
curl http://localhost:22648/api/strategies
curl -X POST http://localhost:22648/api/strategies/set \
  -H 'Content-Type: application/json' \
  -d '{"key":"breakout-pullback","name":"突破回踩","applicability":"主板趋势股","body":"突破20日线且量比>1.5时关注..."}'

curl -X POST http://localhost:22648/api/strategies/remove \
  -H 'Content-Type: application/json' \
  -d '{"key":"breakout-pullback"}'
```

In sandbox mode, use `/api/sandbox/strategies`, `/api/sandbox/strategies/set`, and `/api/sandbox/strategies/remove`. Remove 走二次确认流程。

策略推荐 + 预案起草走 `invest-agent-strategy-plan-drafting` SKILL,不在服务端做 AI 推理。

`stock_plans.strategy_key` 字段是策略 → 预案的溯源软引用;策略被删除时该字段不级联清理,Dashboard 标灰提示。

### Alerts And Signals

```bash
curl -X POST http://localhost:22648/api/alerts/set \
  -H 'Content-Type: application/json' \
  -d '{"stockCode":"600036","indicator":"support_price","threshold":36}'

curl -X POST http://localhost:22648/api/signals/update \
  -H 'Content-Type: application/json' \
  -d '{"signalKey":"price_change","enabled":true,"params":{"threshold":3}}'

curl -X POST http://localhost:22648/api/interval/set \
  -H 'Content-Type: application/json' \
  -d '{"minutes":5}'
```

In sandbox mode, use `/api/sandbox/alerts/set`, `/api/sandbox/alerts/toggle`, and `/api/sandbox/alerts/remove`.
Turning an alert off or removing it requires the pending confirmation flow. Manual checks can use `/api/sandbox/alerts/check` and `/api/sandbox/alerts/check-and-push`.

### Manual Checks

```bash
curl -X POST http://localhost:22648/api/alerts/check
curl -X POST http://localhost:22648/api/alerts/check-and-push
curl -X POST http://localhost:22648/api/alerts/pre-market
```

### Reviews

```bash
curl --max-time 180 -s -X POST http://localhost:22648/api/reviews/daily \
  -H 'Content-Type: application/json' \
  -d '{"force":true}'

curl -s "http://localhost:22648/api/reviews/query?date=2026-06-01"
```

### Method Changes(方法候选,Wp5.3)

月复盘归因输出方法候选;用户在微信/Dashboard 确认采用后才落 `knowledge/methods/*.md`。

**Propose(创建候选,任何复盘/对话都可调用)**:

```bash
curl -X POST http://localhost:22649/api/sandbox/method-changes/propose \
  -H "Authorization: Bearer $INVEST_AGENT_SANDBOX_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "sourceType": "monthly_review",
    "sourceReviewId": "2026-06_monthly",
    "proposedChange": "在 fundamental 方法里加入\"存货周转率同比恶化>15%\"作为减仓触发条件",
    "reason": "本月 3 条 invalidated 观点都因库存高位失败,数据证据见 2026-06 月复盘第四节",
    "affectedResource": "knowledge/methods/fundamental.md"
  }'
```

字段:
- `sourceType`(可选,默认 `review`):候选来源类型(如 `monthly_review` / `weekly_review` / `conversation`)
- `sourceReviewId`(可选):来源复盘 id(如 `2026-06_monthly`),用于审计追溯
- `proposedChange`(**必填**):具体改动描述,要可执行(不要写"加强基本面"这种空话)
- `reason`(**必填**):为什么要改,必须引用本月具体证据(reason 字段聚类、失效信号统计等)
- `affectedResource`(可选,默认 `methodology_profile`):受影响资源路径,推荐填具体 `knowledge/methods/*.md`

**Decide(用户确认采用,需二次 confirmation)**:

```bash
# 第一步:发起决定,服务端会返回 confirmation required
curl -X POST http://localhost:22649/api/sandbox/method-changes/decide \
  -H "Authorization: Bearer $INVEST_AGENT_SANDBOX_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"<candidate_id>","status":"confirmed","decisionNote":"用户已确认采用"}'

# 第二步:用户在后续消息中确认后,通过 /api/sandbox/confirmations/pending 取 confirmationId
# 第三步:带上 confirmationId 重发 decide
curl -X POST http://localhost:22649/api/sandbox/method-changes/decide \
  -H "Authorization: Bearer $INVEST_AGENT_SANDBOX_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"<candidate_id>","status":"confirmed","decisionNote":"用户已确认采用","confirmationId":"<confirm_id>"}'
```

`status` 必须是 `confirmed` 或 `rejected`。

**List(本月已有候选)**:无独立 list 端点,通过 `/api/sandbox/reviews/monthly-context` 返回的 `methodChangeProposals` 字段查看本月全部候选(proposed/confirmed/rejected 全量)。

### 候选确认对话模式(WP5.4)

用户在微信里通过自然语言确认方法候选。Codex 收到采用/拒绝消息时,按以下模式处理:

**模式 1:用户主动询问候选**

用户:"有哪些方法候选?"
- 调 `/api/sandbox/reviews/monthly-context`(取本月 methodChangeProposals)
- 或调 `/api/sandbox/dashboard`(取 methodCandidates 摘要)
- 回复列出 proposed 状态候选 + 用法

**模式 2:用户采用/拒绝单个候选**

用户:"采用 27"
1. 解析 candidate_id(27)和动作(confirmed)
2. 调 decide API,**不带 confirmationId**:
   ```bash
   curl -X POST http://localhost:22649/api/sandbox/method-changes/decide \
     -H "Authorization: Bearer $INVEST_AGENT_SANDBOX_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"id":"27","status":"confirmed","decisionNote":"用户口头采用"}'
   ```
3. 服务端返回 `confirmation required`(因为 decide 是改用户知识库的危险操作,必须二次确认)
4. **不要直接告诉用户"已完成"**。明确告诉用户需要再次确认:
   > 已收到采用 candidate 27 的请求,涉及修改知识库,请回复"确认" 或 "取消"。
5. 等用户下一条消息回复"确认" / "yes" / "同意"
6. 调 `/api/sandbox/confirmations/pending` 查最近的 method_changes.decide 待确认项,取 confirmationId
7. 带 confirmationId 重发 decide:
   ```bash
   curl -X POST http://localhost:22649/api/sandbox/method-changes/decide \
     -H "Authorization: Bearer $INVEST_AGENT_SANDBOX_TOKEN" \
     -H 'Content-Type: application/json' \
     -d '{"id":"27","status":"confirmed","decisionNote":"用户口头采用","confirmationId":"<confirm_id>"}'
   ```
8. 服务端真正落盘 → 告诉用户"candidate 27 已采用,将在下次 knowledge/methods/*.md 同步时生效"

**模式 3:批量采用/拒绝**

用户:"采用 27, 28" / "拒绝 27, 28, 29"
- 逐个调 decide(每个都需要单独的二次确认)
- 简化回复:把多个 confirmationId 收齐后,**单次回复里**告诉用户"共 N 个待确认,请回复'确认'统一处理"
- 用户"确认"后,**逐个**带 confirmationId 重发(不要并行,避免审计日志混乱)

**模式 4:用户取消/反悔**

用户在二次确认前发"取消" / "算了"
- 不调 decide 带 confirmationId
- 可选:调 `/api/sandbox/confirmations/pending` 找到对应 pending 项,告诉用户"已取消该次操作"
- confirmation 过期会自动清理,不需要主动撤销

**注意**:
- candidate_id 必须从 monthly-context 或 dashboard 返回的真实 id,**不要凭印象编造**
- 用户表达模糊(如"采用那个关于 MACD 的")时,先反问"请问是 candidate 27 吗?"
- rejected 候选不删除,留作审计(用户可能后续改主意)
- confirmed 候选不会自动写 `knowledge/methods/*.md`,只是状态变更;知识库同步是后续工作(可由 admin 或独立流程触发)

## Operating Rules

- For read-only queries, call the API directly.
- For destructive or noisy actions, confirm with the user first unless they explicitly requested the action.
- Do not bypass the service by editing SQLite directly.
- Do not invent stock codes; use service-side stock resolution where available.
- After a write action, query `/api/dashboard` if the user needs confirmation of final state.
- Keep user-facing replies concise and mention only the meaningful result or failure.
- Do not invent operational status. If an API call fails, report the failed action plainly and ask whether to retry.
- Never expose `localhost`, port numbers, curl commands, API paths, source file paths, skill names, Codex/ACP, logs, stack traces, or internal service/component names in customer-facing replies.
- Do not say the service restarted, recovered, is unavailable, or has no response unless the actual API result proves that specific fact.
- Never tell the customer about port conflicts, health checks, startup attempts, retries, or diagnostic steps. These are internal execution details.

## Future Tool API Gap

Some existing handler capabilities are not yet exposed as clean HTTP APIs. Prefer adding small deterministic endpoints instead of reviving the old self-built Agent Runtime.
