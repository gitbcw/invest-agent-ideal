# Market Data Resource Inventory

> Status: active evaluation, no provider adoption decision
>
> Last evidence update: 2026-07-25

## Purpose

This is the service-layer inventory for data resources that may eventually
support Invest Agent. It deliberately inventories upstream data sources,
not just MCP projects: MCP is one transport protocol alongside direct HTTP
APIs and internally maintained public-source adapters.

No source listed here is exposed directly to a Workspace or Portal browser.
The service owns provider authentication, rate limits, caching, source
metadata, audit, fallback, and the narrow capabilities eventually published
through `invest-agent-service-tools`.

## Architecture Rule

```text
upstream API or external MCP
  -> service-owned provider adapter
  -> normalized facts + provenance + warnings + audit
  -> named invest-agent-service-tools MCP capability
  -> workspace ACP
```

External provider tool names, arbitrary function calls, secrets, HTTP URLs,
and vendor-specific query languages must not reach the Workspace Agent. A
provider only becomes a named ACP capability after it passes the acceptance
set below.

## Current Resource Ledger

| Resource | Transport / actual upstream | Coverage relevant to us | Evidence | Current disposition |
| --- | --- | --- | --- | --- |
| Existing market facade | Direct service adapters to Tencent, Sina, Eastmoney, CNInfo and internal calendar | A-share quote, daily/5m K-line, indices, sector/theme, capital flow, announcements/news/report summaries | Production audit: 264 successful `market.*` calls during 2026-07-11 to 2026-07-25; local fallback smoke passes | Current primary; retain and improve its gaps |
| TDX MCP | Official remote MCP, API-key authenticated, natural-language query tool | A/HK/fund/index quote, selected fundamentals, board/industry, fund flow and screening claims | Read-only probe passed for A-share quote and PE/PB/ROE/revenue/net-income fields; announcement/report query returned only quote fields | Service adapter is available behind `TDX_MCP_API_KEY`, restricted to one fixed structured fundamentals prompt. ACP can only use the normalized `market.fundamentals` service tool; it cannot discover or call TDX MCP directly. Production use remains subject to terms and acceptance. |
| Tushare Pro | Direct API; also wrapped by several MCP projects | A-share statements, daily basic, calendar, funds, macro, selected minute/flow datasets | Direct caller-token probe passed `trade_cal`, `daily`, and `daily_basic`; the same token was denied `fina_indicator`, `income`, and `disclosure_date` on 2026-07-25 | Service adapter is available behind `TUSHARE_TOKEN` for `daily`, `daily_basic`, and `trade_cal`. ACP can receive normalized fields only through `market.fundamentals`; the tested tier cannot fill the financial-statement or disclosure gap. |
| `buuzzy/tushare_MCP` | Python local/self-hosted MCP on `tinyshare` over Tushare | 30+ documented stock, financial and fund tools | Static review found no CI workflow, an unpinned `tinyshare` dependency, persistent Token storage under the user home directory, and default HTTP binding to all interfaces | Do not test with customer credentials or use as a provider of record; it is only an implementation/reference candidate |
| FinanceMCP | Node MCP wrapper mainly over caller-supplied Tushare token, plus Binance/public sources | 18 typed tools across stocks, statements, funds, macro, news, money flow and CSI constituents | Public endpoint initialized and listed tools; without a caller token its A-share probe failed explicitly. Local stdio mode with the caller token returned daily bars matching direct Tushare and surfaced upstream rate-limit/permission errors on 2026-07-25 | Useful implementation reference; never use the maintainer's shared endpoint for customer traffic |
| AKShare | Python aggregation library, indirectly calling many public sites including sources already in use | Broad market, historical, financial, macro and niche datasets | Project documentation and wrapper review; local package probe did not finish in the evaluation window | Select individual functions only for offline/backfill or proven gaps; no generic reflective MCP tool |
| yfinance / Yahoo Finance | Unofficial Yahoo Finance client and multiple third-party MCP wrappers | US/global prices, statements, actions, options, holders and news | Direct Yahoo chart endpoint returned HTTP 403 from this environment on 2026-07-25 | Unverified and currently blocked here; supplemental only, never a real-time or A-share authority |
| Alpha Vantage | Official direct API and official remote/local MCP | Global equities, FX, crypto, macro and technical indicators | Official demo `GLOBAL_QUOTE` returned IBM data dated 2026-07-24; a demo-key FX request correctly reported that a self-owned key is required | Global-market candidate; free allowance is 25 requests/day, not production capacity |

## Do Not Double Count Wrappers As Sources

- Tushare MCP and FinanceMCP overlap heavily with the same Tushare upstream.
- AKShare is an aggregation layer, not a new independent source for every
  endpoint it wraps; several paths overlap Tencent, Sina, Eastmoney and CNInfo.
- yfinance MCP variants all depend on Yahoo Finance behavior and terms.
- An external MCP improves protocol integration, not source reliability,
  licensing, freshness or redistribution rights.

## Standard Acceptance Set

Every candidate is tested through the same read-only cases before an adapter
is written. Record response time, returned field names, upstream data date,
source attribution, empty-result behavior, error shape, rate-limit behavior,
and any credit consumption.

| Case | Required fact | Acceptance condition |
| --- | --- | --- |
| Identity | Resolve a known listed A-share and, where relevant, a US ticker | Correct code/name/market with no ambiguous silent substitution |
| Quote | Last trading-day quote for a fixed symbol | Price, market timestamp, market status and source available; stale data is explicit |
| Daily history | Five daily bars with adjustment information | Ordered OHLCV, date range and adjustment convention are explicit |
| Fundamentals | PE, PB, ROE, revenue and net income for a fixed reporting period | Each field carries reporting period and units; missing fields are explicit |
| Statements | Income, balance sheet and cash flow | Statement period, currency, units and restatement behavior identifiable |
| Disclosures | Recent announcements and research/news separately | Returned items include title, date, source link and type; a quote-only fallback is a failure |
| Sector / universe | Sector membership, constituents or a fixed screen | Result universe, filters, pagination and sorting are explicit and reproducible |
| Global | US equity and FX only for global candidates | Symbol mapping, exchange/currency and market-time semantics are correct |
| Failure | Invalid symbol and deliberate rate/credit boundary | Typed, non-secret error; adapter can produce a safe warning and fallback |

## Promotion Gates

Before a provider becomes part of the service facade, all are required:

1. A fixed acceptance run succeeds for the exact capability being promoted.
2. The service can normalize its result into provider, upstream source,
   fetched time, market/reporting period, confidence, stale status and warnings.
3. Credentials remain service-only and audit records redact secrets.
4. Timeouts, bounded retries, rate limits and response-size limits are defined.
5. Contract terms permit the intended customer display, report generation,
   caching and multi-user usage.
6. The resulting capability is narrow and typed; no generic vendor query tool
   is exposed to ACP.

## Current Adapter Boundary (2026-07-25)

- `src/services/external-market-providers.ts` contains optional service-only
  adapters. `TUSHARE_TOKEN` enables typed `daily`, `daily_basic` and
  `trade_cal` reads. `TDX_MCP_API_KEY` enables a single fixed-prompt
  fundamentals query whose structured headers are validated before use. The
  default TDX endpoint is the official `mcp.tdx.com.cn:3001/mcp` endpoint.
- `integratedFundamentals` is the current internal aggregation contract. It
  merges TDX PE/PB/ROE/revenue/net-income fields with Tushare daily valuation
  fields when a caller supplies a trading date, preserving source metadata
  and warnings for each provider.
- Successful reads use short-lived in-process caches and per-capability minimum
  intervals (including the longer Tushare `daily_basic` interval). Concurrent
  identical reads share one upstream request; cache misses never hide a typed
  `rate_limited`, permission, or upstream error.
- Credentials only enter through the service process environment. Neither
  adapter is a Workspace MCP server or a Portal feature. ACP accesses only the
  fixed `market.fundamentals` service contract, which accepts no upstream tool
  name, endpoint, query language, or credentials and returns normalized fields
  with provenance and warnings.
- `market.health` reports configuration state and supported operation names,
  but never keys, remote URLs containing credentials, raw MCP output, or
  arbitrary vendor query capability.
- Existing Tencent/Sina/Eastmoney/CNInfo behavior remains the market facade's
  primary path. These adapters are intentionally not quote or K-line fallbacks
  until their production terms and acceptance cases are complete.

## Evaluation Order

1. Complete a caller-owned Tushare acceptance run with a low-tier test token.
2. Test FinanceMCP only as a locally self-hosted wrapper using that same token;
   compare schema, errors and source attribution against direct Tushare.
3. Test selected AKShare functions for named gaps only, beginning with
   structured statements or a backfill endpoint; do not test a broad reflective
   gateway as an ACP dependency.
4. Obtain a free Alpha Vantage key and run the global cases through its
   official MCP/API path, including quota exhaustion behavior.
5. Re-test yfinance from the target deployment network only if a lawful Yahoo
   access path is confirmed; the current 403 is a deployment blocker.
6. Return to TDX with fixed typed prompts and obtain commercial terms before
   comparing it against Tushare for production scope.

## Sources

- Existing facade: `src/services/market-data.ts`
- Tushare: https://tushare.pro/document/1?doc_id=290
- Tushare MCP: https://github.com/buuzzy/tushare_MCP
- FinanceMCP: https://github.com/guangxiangdebizi/FinanceMCP
- AKShare: https://akshare.akfamily.xyz/
- AKShare metadata MCP: https://github.com/cwjcw/AKShareMCP
- yfinance MCP reference: https://github.com/narumiruna/yfinance-mcp
- Alpha Vantage MCP: https://github.com/alphavantage/alpha_vantage_mcp
- Alpha Vantage limits: https://www.alphavantage.co/support/
