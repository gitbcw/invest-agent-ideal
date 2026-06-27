---
name: market-watch
description: Monitor intraday market conditions based on the latest daily review observations, user watch rules, holdings, and real-time anomalies. Push only when abnormal triggers fire. Use when the user asks for 智能盯盘, 盘中提醒, 异动提醒, or watch frequency setup.
---

# Market Watch

## Purpose

Monitor the market with low noise. The skill must use daily-review observation points and `config/watch.yaml`; it should not push routine price noise.

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
2. Fetch or verify current intraday data when running.
3. Check exception rules:
   - Core holdings near buy/sell zones.
   - Watchlist items entering configured zones.
   - Non-core holdings entering optimization or protection zones.
   - Market style contradicting daily-review assumptions.
   - Major news, financial report, policy, commodity, or FX change affecting holdings.
   - User-defined price, volume, valuation, or technical thresholds.
4. Check evidence sufficiency and suppress unverified rumors, ordinary moves, and repeated triggers without new facts.
5. Classify each exception as P0, P1, or P2 using `config/risk_taxonomy.yaml`, `config/notification.yaml`, and `config/watch.yaml`.
6. If no meaningful exception fires, do not push.
7. Push P0 immediately. Summarize P1 in the evening brief. Record P2 only in reports/logs.
8. If an exception fires, save details to `reports/alerts/YYYY-MM-DD.md`; write important views to `memory/decisions.jsonl` and data-quality events to `memory/source_events.jsonl`.

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
