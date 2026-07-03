---
name: market-watch
description: Monitor intraday market conditions based on the latest daily review observations, user watch rules, holdings, and real-time anomalies. Push only when abnormal triggers fire. Use when the user asks for 智能盯盘, 盘中提醒, 异动提醒, or watch frequency setup.
---

# Market Watch

## Purpose

Monitor the market with low noise. The skill must use daily-review observation points, `config/watch.yaml`, and the service-owned watch-rule APIs; it should not push routine price noise.

## Inputs

- `config/portfolio.yaml`
- `config/strategy.yaml`
- `config/watch.yaml`
- `config/notification.yaml`
- `config/sources.yaml`
- `config/evidence_policy.yaml`
- `config/risk_taxonomy.yaml`
- `config/interaction_policy.yaml`
- `knowledge/watch_protocol.md`
- Latest report in `reports/daily/`
- Latest decisions in `memory/decisions.jsonl`

## Workflow

1. Load the latest daily review observations and user watch rules.
2. When the user wants to create, inspect, update, or remove a deterministic intraday rule, use the service APIs instead of inventing or expanding local schema:
   - `GET /api/sandbox/watch-rules/catalog`
   - `GET /api/sandbox/watch-rules`
   - `POST /api/sandbox/watch-rules/validate`
   - `POST /api/sandbox/watch-rules`
   - `PATCH /api/sandbox/watch-rules/:id`
   - `DELETE /api/sandbox/watch-rules/:id`
   - `POST /api/sandbox/watch-rules/:id/dry-run`
3. First read the catalog, then map the user's request into a supported rule type. Current deterministic stage-2 rule types are:
   - `price_cross`
   - `ma_cross`
   - `near_plan_level`
4. Ask follow-up questions for missing params such as threshold, MA period, direction, target stock, tolerance, cooldown, and priority.
5. For deterministic explicit rules, default to `P0` immediate push unless the user explicitly asks for `P1` or `P2`.
6. Require user confirmation before creating or materially changing a persistent watch rule.
7. After the user confirms, you must actually call `/api/sandbox/watch-rules` to create or update the rule before replying `已加上` or `已修改`.
8. After writing, verify success by re-reading the rule list or calling dry-run; if the API call failed, report the failure plainly and do not pretend it succeeded.
9. Fetch or verify current intraday data when running. Prefer the service-layer market API with the current sandbox token:
   - Use `POST /api/sandbox/market/snapshot` for holdings, watchlist, plans, and indices.
   - Use `GET /api/sandbox/market/quote` for symbols outside the snapshot.
   - Use `GET /api/sandbox/market/kline?period=m5` only for supported 5-minute checks.
10. Check exception rules:
   - Core holdings near buy/sell zones.
   - Watchlist items entering configured zones.
   - Non-core holdings entering optimization or protection zones.
   - Market style contradicting daily-review assumptions.
   - Major news, financial report, policy, commodity, or FX change affecting holdings.
   - User-defined price, volume, valuation, or technical thresholds.
11. Check evidence sufficiency and suppress unverified rumors, ordinary moves, and repeated triggers without new facts.
12. Classify each exception as P0, P1, or P2 using `config/risk_taxonomy.yaml`, `config/notification.yaml`, and `config/watch.yaml`.
13. If no meaningful exception fires, do not push.
14. Push P0 immediately. Summarize P1 in the evening brief. Record P2 only in reports/logs.
15. If an exception fires, save details to `reports/alerts/YYYY-MM-DD.md`; write important views to `memory/decisions.jsonl` and data-quality events to `memory/source_events.jsonl`.

## Deterministic Rule Notes

- Do not treat `config/watch.yaml` as the primary machine-readable store for stage-2 deterministic rules.
- `config/watch.yaml` remains the low-frequency policy surface for windows, noise suppression, and notification posture.
- Deterministic stage-2 watch rules should live in the service layer and be managed through `/api/sandbox/watch-rules*`.
- Do not claim a rule was created just because a draft, text note, or `config/watch.yaml` change exists; success means the service API returned success.
- Do not write stage-2 deterministic rule instances into `config/watch.yaml`, `memory/change_log.jsonl`, or similar workspace files as a substitute for the service-layer write.
- If the catalog does not support the user's requested rule type, explain the gap instead of making up a hidden schema.

## Alert Format

```markdown
【盯盘提醒】
优先级：P0/P1/P2
触发事项：
初步判断：
证据与数据时间：
建议动作：
是否需要用户确认：
验证/失效信号：
详情记录：
```

## Style Rules

- Push only on meaningful exceptions.
- The purpose is to reduce watching effort, not provide continuous price companionship.
- Do not recommend trades without connecting to the user's confirmed strategy.
- Keep alerts short and operational.
- For working professionals, avoid interrupting work unless the alert is P0.
- If the service-layer market API is unavailable, do not fabricate intraday facts; report the data gap or return no push when evidence is insufficient.
