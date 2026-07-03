# Market Data Service Design

> Created: 2026-07-01
> Status: Stage 1 implementation target

## Background

Invest Agent already fetches A-share quotes, daily K-lines, minute K-lines, index quotes, stock search results, and Eastmoney capital flow data. The current implementation is useful but too function-oriented: callers import `src/services/stock.ts` and `src/services/eastmoney.ts` directly, while Codex workspace skills do not have a stable market-data API contract.

The desired direction is service-owned deterministic market data. Codex and skills should call local service APIs for facts, then apply investment reasoning on top. They should not improvise live market scraping when a supported service endpoint exists.

## Goals

- Provide a unified service-layer market data facade for quotes, K-lines, indices, capital flow, stock resolving, health, and portfolio/watchlist snapshots.
- Preserve Tencent quote/K-line APIs as the primary free A-share source for Stage 1.
- Preserve Eastmoney capital flow as an auxiliary, lower-confidence source.
- Expose read-only sandbox APIs that Codex can call with the existing sandbox token.
- Attach source, fetch time, confidence, stale/data warnings, and provider health metadata to responses.
- Keep existing review, scheduler, dashboard, and watch-rule behavior working during migration.

## Non-Goals

- Do not introduce AKShare, Tushare, Wind, JoinQuant, broker Level-2, or Python runtime dependencies in Stage 1.
- Do not promise tick-level, Level-2, one-minute K-line, true chip distribution, or precise main-force behavior.
- Do not replace all existing internal `getQuote` / `getKline` call sites in the first pass.
- Do not add trading or order execution behavior.

## Source Policy

| Source | Stage 1 Role | Confidence | Boundary |
| --- | --- | --- | --- |
| Tencent `qt.gtimg.cn` | Primary real-time/delayed quote and index source | high | Level-1 quote only. Use for price, open/high/low, volume, amount, turnover, 5-level aggregate imbalance. |
| Tencent `web.ifzq.gtimg.cn` | Primary daily K-line source | high | Daily OHLCV, adjusted by current implementation. |
| Tencent `ifzq.gtimg.cn` | Primary 5-minute K-line source | medium | Only 5-minute bars, limited recent window. |
| Tencent `smartbox.gtimg.cn` | Stock search/resolve fallback | medium | Name/code resolving only. |
| Eastmoney capital flow | Auxiliary capital-flow observation | low/medium | Can support “资金异动” observation. Must not be described as proven main-force accumulation/control. |

## API Shape

Stage 1 exposes sandbox read APIs:

```text
GET  /api/sandbox/market/quote?codes=002460,601058
GET  /api/sandbox/market/kline?code=002460&period=day&count=120
GET  /api/sandbox/market/indices
GET  /api/sandbox/market/capital-flow?codes=002460,601058
GET  /api/sandbox/market/resolve?keyword=赛轮轮胎
POST /api/sandbox/market/snapshot
GET  /api/sandbox/market/health
```

`snapshot` body:

```json
{
  "scope": "portfolio_watchlist_plans",
  "includeCapitalFlow": false
}
```

All APIs return `ok`, `updatedAt`, and source metadata. Partial failures should return usable partial data with warnings instead of throwing when possible.

## Data Contract

Every market fact returned through the facade should include:

```ts
type MarketSourceMeta = {
  provider: "tencent" | "eastmoney" | "service";
  endpoint: string;
  fetchedAt: string;
  marketTime?: string;
  confidence: "high" | "medium" | "low";
  stale: boolean;
  warnings: string[];
};
```

Quote response item:

```ts
type MarketQuote = StockQuote & {
  source: MarketSourceMeta;
};
```

K-line response:

```ts
type MarketKlineResult = {
  code: string;
  period: "day" | "m5";
  count: number;
  items: StockKline[] | MinuteKline[];
  source: MarketSourceMeta;
};
```

Snapshot response should group current user data and market facts:

```ts
{
  holdings: [{ stockCode, stockName, quote? }],
  watchlist: [{ stockCode, stockName, quote? }],
  plans: [{ stockCode, stockName, support?, resistance?, targetPrice?, stopLoss?, quote? }],
  indices: [...],
  capitalFlows?: [...]
}
```

## Staleness And Warnings

Stage 1 uses lightweight staleness rules:

- If provider fetch fails, return a warning and empty data for that component.
- If quote `time` is missing, mark `stale: true` with `missing_market_time`.
- If the service time is outside A-share trading hours, data may be delayed; responses should preserve `marketTime` and avoid inventing freshness.
- Eastmoney capital flow should always carry a usage warning that it is an observation signal, not proof of main-force control.

## Codex / Skill Usage

Workspace skills should prefer these local APIs for market facts:

```bash
curl -s "http://127.0.0.1:$PORT/api/sandbox/market/quote?codes=002460" \
  -H "Authorization: Bearer $sandboxToken"
```

Skills must:

- cite data gaps explicitly;
- avoid exact price claims when quote data is missing;
- not use capital flow as sole evidence for buy/sell advice;
- combine market facts with existing holdings, plans, alerts, and user methodology before making action suggestions.

## Execution Plan

1. Add `src/services/market-data.ts` as the unified facade.
2. Add sandbox tool id `invest.market.read` using existing `read:self` permission.
3. Add sandbox routes under `/api/sandbox/market/*`.
4. Add ACP tool manifest entries for market quote/K-line/indices/capital-flow/snapshot.
5. Build and manually smoke test quote, kline, indices, capital-flow, resolve, snapshot, and health.
6. Later migration: update review, watch-rules, dashboard, and alert-check to call the facade directly.

## Acceptance Criteria

- `npm run build` passes.
- Sandbox market APIs require a valid sandbox token and are read-only.
- Quote API returns source metadata for each quote.
- K-line API supports `period=day` and `period=m5`.
- Capital-flow API returns data when available and warnings when unavailable.
- Snapshot API returns de-duplicated quote facts for holdings, watchlist, and plans.
- Tool registry and ACP manifest expose market read capabilities to Codex.
- Existing dashboard, review, scheduler, and watch-rule flows still compile.

## Risks

- Public free endpoints can change without notice. Mitigation: source metadata, health endpoint, partial failure warnings.
- Overconfidence from capital-flow data. Mitigation: low/medium confidence and explicit warning.
- Skill misuse or hidden hallucination. Mitigation: local API contract plus skill instruction updates in a later pass.
- Cache semantics can become subtle. Mitigation: Stage 1 avoids persistent caching; add TTL cache only after API shape settles.

## Reviewer Prompt

Review the implementation against this design. Focus on whether market APIs are read-only, source-aware, partial-failure tolerant, and usable by Codex through sandbox tokens. Do not require migration of all internal call sites in Stage 1.

## Follow-Up TODO

> Added: 2026-07-01
> Purpose: next-session handoff after Stage 1 market data API and Codex sandbox access were verified.

### Boundary Correction: Evaluation Assets Stay Service-Level

> Updated: 2026-07-02

Provider telemetry, provider health summaries, golden/eval reports, and cross-instance data-quality scoring are platform/service observability assets. They should live under service-owned `data/` or `tests/`, not under a user's workspace.

Workspace files are only for user-instance business memory and decision artifacts. It is still valid to write a workspace `memory/source_events.jsonl` entry when a specific review, alert, or investment conclusion used, missed, or downgraded a source. It is not valid to put raw provider telemetry or global quality evaluation there.

Current service-level paths:

- `data/source-telemetry/YYYY-MM-DD.jsonl`: raw provider call telemetry.
- `data/source-quality/YYYY-MM-DD.{md,json,jsonl}`: provider quality summaries and service-level quality alerts.

### Current Verified State

- Service-layer market data facade exists for quote, K-line, indices, capital flow, resolve, snapshot, and health.
- Sandbox routes are available under `/api/sandbox/market/*` and require the sandbox token.
- ACP tool manifest and workspace prompts expose the market read capability to Codex.
- Codex ACP is started with sandbox network access, so workspace skills can call the local service APIs.
- Golden case `portfolio-003` verified that Codex can call `market.snapshot` and use returned prices.
- Scheduled market-watch and daily-review flows can use the market service and push WeChat output.

### P0: Make Runtime Use The Facade Consistently

- Migrate review collection code from direct `src/services/stock.ts` calls to `src/services/market-data.ts` where the output needs source metadata or warnings.
- Migrate scheduled market-watch deterministic checks to prefer the market facade for quote facts.
- Keep legacy `getQuote` / `getKline` helpers only as provider internals or compatibility wrappers.
- Acceptance: review and market-watch outputs include data gaps or stale warnings when the facade reports them, and existing smoke tests still pass.

### P0: Harden Skill Usage Discipline

- Update review, market-watch, weekly-review, monthly-review, and QA skills to consistently say: use local market APIs first for prices, indices, K-lines, watchlist snapshots, and plan trigger facts.
- Keep prompts encouraging Markdown when useful, but do not force Markdown for every user answer.
- Add explicit instruction that API paths, curl commands, sandbox tokens, and tool execution notes must not be exposed to the user.
- Acceptance: golden cases for holdings price questions, daily review, and market-watch do not invent prices and do not leak internal execution process.

### P1: Add Provider Health And Freshness Observability

- Expand `/api/sandbox/market/health` so it reports per-provider status, latest successful fetch time, latest failure, and sample latency.
- Add lightweight logs or audit entries when provider fetch fails, returns empty data, or produces stale market time.
- Surface health status in the platform cost/audit or instance diagnostics page only if it helps operations.
- Acceptance: a provider failure can be diagnosed from logs/API without reading model output.

### P1: Add Cache And Rate-Limit Protection

- Add short TTL in-memory cache for quote, indices, K-line, and capital-flow calls.
- Cache key should include provider, endpoint type, codes, period, count, and relevant options.
- Preserve source metadata: distinguish `fetchedAt` from `servedAt` if cached data is returned.
- Avoid persistent cache until API contracts settle.
- Acceptance: repeated snapshot calls for the same portfolio do not repeatedly hit public endpoints within the TTL, while stale warnings remain visible.

### P1: Multi-Source Fallback Design

- Keep Tencent as Stage 1 primary source.
- Evaluate one secondary quote/K-line fallback before adding it to production. Candidate sources should be judged by stability, terms, latency, field coverage, and anti-scraping risk.
- Do not add AKShare/Python runtime or paid/provider-key dependencies without a separate decision.
- Acceptance: fallback behavior is documented as `primary_failed -> secondary_used` with provider and confidence metadata, not silently mixed.

### P2: Better Snapshot Semantics

- Extend snapshot to include:
  - de-duplicated symbols across holdings/watchlist/plans;
  - plan-distance fields such as distance to support/resistance/target/stop-loss;
  - quote missing reasons per item;
  - optional `includeKline` and `includeCapitalFlow` flags with clear defaults.
- Keep the default snapshot fast enough for WeChat review and market-watch.
- Acceptance: Codex can answer "哪些持仓接近预案触发位" without doing its own distance math from incomplete data.

### P2: Tests And Golden Coverage

- Add route-level tests or smoke scripts for quote, kline, indices, resolve, capital-flow, snapshot, and health.
- Add golden cases that specifically check:
  - current holding price question uses market API;
  - missing quote produces a data-gap answer;
  - daily review uses final response only and does not leak internal thought/process;
  - market-watch `NO_PUSH` stays silent and triggered alerts push concise text.
- Acceptance: these tests are listed in `docs/quality/golden-test-set.md` with when-to-run guidance.

### P2: Documentation Cleanup

- Update `docs/README.md` when the market data design graduates from implementation target to source-of-truth.
- Move superseded market-data research notes to archive if they start steering implementation incorrectly.
- Add a short operator runbook for manually verifying market API access from the primary workspace.

### Defer For Later

- Level-2, tick data, real chip distribution, and broker-grade paid feeds.
- Automatic trading or order placement.
- Large provider abstraction framework before a second source is actually needed.
- Persistent market-data database unless review/backtest workflows require historical replay.
