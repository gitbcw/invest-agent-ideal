# Capability Plane — WP0 Baseline Fixtures

> Scope: WP0 of `docs/capability-plane-extraction-plan.md`.
> Purpose: capture the **current** output envelopes of the market-data, research and
> indicator capabilities as redacted reference baselines, so WP1+ can prove that the
> extracted capability contract preserves provider ordering, source metadata, warnings,
> fallback semantics and indicator determinism.
> Status: **reference only.** These JSON files are NOT wired to any test runner. They
> document the pre-migration shape; WP1/WP2/WP6 will turn the relevant cases into live
> contract tests under `src/capabilities/`.

## Files

| File | Capability | Case covered |
| --- | --- | --- |
| `market-quote.success.json` | market-data | 成功 — multi-code quote with full `MarketSourceMeta` |
| `market-quote.partial.json` | market-data | 部分失败 — one code stale, `missing_market_time` warning |
| `market-kline.success.json` | market-data | 成功 — daily K-line with price-precision convention |
| `market-indices.success.json` | market-data | 成功 — normalized index quote with source provenance |
| `market-calendar.success.json` | market-data | 成功 — deterministic A-share calendar response |
| `market-health.success.json` | market-data | 成功 — capability-local health response |
| `market-capital-flow.empty.json` | market-data | 空结果 — provider returns no rows, warning preserved |
| `research-web-search.success.json` | research | 成功 — Sogou source-discovery results |
| `research-news-search.success.json` | research | 成功 — normalized, dated finance-news evidence |
| `research-web-read.success.json` | research | 成功 — sanitized public page with final URL provenance |
| `research-web-search.empty-both-fail.json` | research | 空结果 + 部分失败 — both providers fail, no key leak |
| `research-doubao.rate-limit.json` | research | 限流 — `doubao_qps_exceeded` stable warning |
| `market-fundamentals.no-permission.json` | market-data / research provider | 无权限 — `tushare:not_configured`, provider availability flags |
| `indicators.deterministic.json` | indicators | 成功 — deterministic L1 output on a fixed K-line fixture |

The numeric values in `indicators.deterministic.json` are reproduced from
`npm run smoke:indicators` (2026-07-30 build) on the in-script 30-bar synthetic K-line
(price 10.1 → 14). They are a baseline snapshot, not an eternal golden value: WP6 must
re-derive them from a checked-in K-line fixture under a fixed algorithm version.

## Redaction rules

Applied to every baseline before commit, and required of any future fixture added here:

1. **Secrets never present.** No API keys, tokens, bearer headers, cookies, or
   `Authorization` values. Provider tokens (`TUSHARE_TOKEN`, `DOUBAO_SEARCH_API_KEY`,
   `TDX_MCP_API_KEY`, service tokens) are replaced by the literal `"<redacted>"`. The
   research "both-fail" case additionally asserts warnings contain no key substring.
2. **User identifiers redacted.** Real `userId` / `instanceId` / conversation ids are
   replaced by `"user-test"` / `"instance-test"`. `userId` is a telemetry label only in
   the pure market/research paths, so redaction does not change semantics.
3. **Timestamps normalized.** `fetchedAt` / `marketTime` / `asOf` / `created_at` are
   replaced by stable `"YYYY-MM-DDTHH:mm:ssZ"`-shaped placeholders
   (`"<fetchedAt>"`, `"<marketTime>"`) so diffs are not time-sensitive. A capability
   contract test must distinguish `fetchedAt` (call time), `marketTime`/`asOf` (data
   time) and cache-served time — the placeholders keep those fields distinct.
4. **Public provider endpoints kept.** Hosts such as `qt.gtimg.cn`,
   `open.feedcoopapi.com`, `api.tushare.pro` are public provider identities, not
   secrets; they are retained because provider identity and `endpoint` are first-class
   source-provenance fields that the contract must preserve.
5. **Provider raw payloads stripped.** Fixtures store the normalized capability result
   envelope only — never raw provider HTML/JSON, internal network addresses, or
   credential-bearing URLs. `research.web_read` provenance keeps only the final
   public URL, content-type and character count.
6. **No real holdings.** `market.snapshot` is intentionally NOT captured here: it
   aggregates user portfolio/watchlist/plans and stays a Core-Service orchestration,
   not a capability fixture (see plan §1A.3).

## Out of scope for WP0

- Wiring these into a runner or `npm test` (that is WP1/WP2/WP6).
- Capturing `market.snapshot` or any user-state-dependent output.
- Live provider golden values (live probes must not be frozen as永远正确).
