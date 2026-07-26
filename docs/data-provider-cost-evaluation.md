# Data Provider Cost Evaluation

> Created: 2026-07-02
> Status: current decision support

This document supports the accepted data-source policy in `data-source-policy-decision.md`.

## Purpose

This document evaluates whether Invest Agent should continue building its own reliable market-data service or buy an aggregated data provider.

The key question is not "which provider is best in absolute terms". The key question is:

> Given the current product is a personal WeChat-first investment assistant, what level of paid data can we afford, and which data gaps are worth paying for?

## Current Product Need

Invest Agent currently needs data for:

- daily inspection of holdings, watchlist, plans, alerts, and market status;
- daily/weekly/monthly review evidence;
- individual stock analysis and screening;
- plan trigger checks around support, resistance, target, and stop-loss levels;
- source-quality telemetry and degraded-source alerts.

The current stage does not need:

- tick-level data;
- Level-2 order book data;
- institutional terminal workflows;
- automatic trading;
- high-frequency backtesting.

Therefore, the first paid-data target should be broad, stable, and auditable daily/quote/fundamental/announcement data, not expensive real-time professional terminal data.

## Price Bands

Prices and rules below are public information checked on 2026-07-02. Vendor prices can change, and several professional products do not publish complete list prices.

| Band | Approx Annual Cash Cost | Typical Options | Fit For Us | Notes |
| --- | ---: | --- | --- | --- |
| Free | 0 | Tencent/Sina/Eastmoney public endpoints, AKShare, BaoStock | Strong MVP fit | Lowest cash cost, but highest maintenance and validation burden. |
| Low | 200-1,500 RMB/year | Tushare Pro point tiers | Best first paid experiment | Affordable enough to test. Better data breadth than pure scraping. |
| Medium | 2,000-10,000 RMB/year | Tushare minute permissions, possible RQData/JQData paid tiers or negotiated access | Selective only | Worth considering only if a specific missing dataset blocks product value. |
| High | 10,000-50,000 RMB/year | Choice, iFinD, Wind basic terminals, some professional data APIs | Not suitable now | Usually designed for professional workstations or institutions. |
| Institutional | 50,000+ RMB/year | Full terminal/API packages, databases, Level-2/Tick packages | Out of scope | Too expensive for current MVP and likely overkill. |

## Provider Notes

### Tushare Pro

Tushare is the most realistic first paid candidate.

Public Tushare pricing shows:

- 120 points: free, limited mainly to unadjusted daily data;
- 2,000 points: about 200 RMB/year;
- 5,000 points: about 500 RMB/year;
- 10,000 points: about 1,000 RMB/year;
- 15,000 points: about 1,500 RMB/year;
- historical minute data: separate permission, about 2,000 RMB/year;
- real-time minute/daily/index/ETF permissions: often monthly add-ons.

Decision implication:

- For our current product, the 500-1,500 RMB/year tier is the only paid option that looks obviously worth testing.
- We should not buy minute or real-time add-ons unless a concrete feature needs them.
- Tushare should be integrated as a provider behind the existing market-data facade, not as a replacement for our source-quality layer.

### AKShare

AKShare is free and open source, and covers a wide range of financial data. Its own documentation says it is mainly for academic research and that data may be removed under force majeure or other constraints.

Decision implication:

- AKShare is useful as a low-cost adapter for breadth and cross-source comparison.
- It should not be treated as a commercial-grade reliability guarantee.
- Because it is Python-first, adding it directly would introduce runtime/deployment complexity. A small sidecar or offline ingestion task is safer than putting it into the TypeScript hot path immediately.

### BaoStock

BaoStock is free/open and focuses on A-share historical data. It is attractive for historical K-line and some financial-data backfill.

Decision implication:

- Good candidate for offline backfill and cross-checking daily bars.
- Not enough as the only source for current quote freshness, announcements, news, and source reliability.

### JQData / JoinQuant

JQData publicly describes broad local data access across A-shares, indices, funds, futures, options, macro, factors, and other datasets. Public pages emphasize trial/purchase flows, but a simple current public price table was not found.

Decision implication:

- Likely stronger than our free endpoints in breadth and cleanliness.
- Pricing and commercial terms need direct inquiry before serious planning.
- Treat as a medium-tier candidate, not a default MVP dependency.

### RQData / RiceQuant

RQData provides a Python financial data toolkit and documents broad historical data coverage, including daily, minute, and tick data for multiple Chinese-market instruments. Current official pages emphasize trial and documentation; old community references mention prices such as 3,000 RMB/year and 10,000 RMB/year, but those should be treated only as historical signals.

Decision implication:

- Strong candidate if we later need clean multi-asset historical/minute data.
- Too expensive to buy speculatively at the current stage.
- Need direct inquiry for current price, personal-use eligibility, and redistribution/API terms.

### Wind / Choice / iFinD

These are professional financial terminal/data products. Public official pages emphasize institutional-grade coverage. News and industry reporting in 2026 cites approximate annual terminal prices around:

- Wind basic terminal: about 39,800 RMB/year;
- Choice standard account: about 18,000 RMB/year;
- iFinD standard account: about 14,000 RMB/year.

These figures are not procurement quotes, but they are enough for budget triage.

Decision implication:

- Not a fit for our current self-funded MVP.
- The product value they provide is not only data API; it includes terminal workflows, research tooling, news, reports, and institutional support.
- We should not design Invest Agent assuming access to these products.

### MCP Candidate Observation (2026-07-25, No Adoption Decision)

The following is a research record only. An MCP server is a transport and
tool-schema wrapper; it does not itself grant reliable data, commercial
redistribution rights, or a production support commitment. None of the listed
servers is approved for direct Workspace use or production deployment.

| Candidate | Verified shape | Practical value | Decision status |
| --- | --- | --- | --- |
| TDX MCP | Official remote MCP, API-key authenticated, one natural-language financial query tool | Returned A-share quote and structured PE/PB/ROE/financial fields in a local read-only probe; announcement/report query did not return the requested items | Keep as paid-candidate observation; its natural-language response needs service-side templates, field validation, and commercial redistribution approval |
| `buuzzy/tushare_MCP` | MIT Python server, 30+ documented A-share/fund tools, runs locally or as self-hosted MCP | Broad claimed Tushare coverage | Do not use customer credentials: static review found persistent home-directory token storage, an unpinned `tinyshare` dependency and a default all-interface HTTP bind |
| `guangxiangdebizi/FinanceMCP` | MIT Node MCP wrapper around Tushare/Binance and other public sources; local stdio mode supports a caller-owned Tushare token | Local stdio probe returned Tushare daily bars and surfaced upstream limit/permission errors clearly | Do not use its shared public server for customer data; at most treat its local stdio implementation as a reference until it is independently audited and pinned |
| AKShare MCP variants | No single canonical `mcp-akshare` project exists. The metadata-driven variant exposes dictionary lookup plus a reflective arbitrary-AKShare execution tool | Very broad free-data exploration and offline/backfill potential | Not suitable for direct Agent exposure: dynamic function execution makes source scope, parameter safety, output size and reliability hard to govern. Select individual AKShare functions behind our own typed adapter instead |
| yfinance MCP variants | Several independent open-source servers consume Yahoo Finance; no official Yahoo MCP was identified | Good candidate for US/global prices, statements, corporate actions, options and news supplementation | Use only as supplemental evidence. Yahoo/yfinance is unofficial, availability and fields can change, and it is not a licensed real-time feed or an A-share authority |
| Alpha Vantage MCP | Official `alphavantage/alpha_vantage_mcp`, remote OAuth endpoint and local mode | Strong typed global-market, FX, crypto, macro and technical-indicator coverage | Best global-market MCP candidate. Free tier is currently 25 requests/day, not 500/day; real-time/delayed US data and meaningful production volume require paid entitlement |

Integration rule for every future candidate:

1. The provider runs behind a service-owned adapter, never directly in a
   Workspace or Portal browser.
2. The adapter emits provider, upstream source, fetched time, market/reporting
   period, freshness, warnings and a redacted audit record.
3. Only allowlisted typed capabilities become `invest-agent-service-tools` MCP
   tools. Do not expose generic natural-language query or arbitrary upstream
   function-call tools to the Agent.
4. A provider cannot become a production source until a fixed acceptance set
   proves field correctness, fallback behavior, rate/cost behavior and the
   required display/cache/redistribution rights.

Sources checked:

- Tushare MCP: https://github.com/buuzzy/tushare_MCP
- FinanceMCP: https://github.com/guangxiangdebizi/FinanceMCP
- AKShare metadata-driven MCP: https://github.com/cwjcw/AKShareMCP
- yfinance MCP reference: https://github.com/narumiruna/yfinance-mcp
- official Alpha Vantage MCP: https://github.com/alphavantage/alpha_vantage_mcp
- Alpha Vantage usage limits: https://www.alphavantage.co/support/

## Build vs Buy

### Buying Data Helps With

- fewer broken public endpoints;
- cleaner adjusted historical data;
- broader financial statements and factor datasets;
- more consistent calendars and corporate actions;
- lower manual data-cleaning work;
- better confidence in review and screening evidence.

### Buying Data Does Not Replace

- our provider abstraction;
- source freshness checks;
- cross-source mismatch detection;
- evidence-level classification;
- warnings in investment output;
- workspace skill discipline;
- source-quality platform observability.

Even if we buy a provider, Invest Agent still needs the current reliable-data-source service. The provider is one input; the service is our quality gate.

## Recommended Cost Strategy

### Phase 0: Continue Free Multi-Source Service

Keep Tencent/Sina/Eastmoney/CNINFO/service calendar and source-quality telemetry.

Add only low-risk free/offline providers where they improve cross-checking:

- BaoStock for historical daily backfill;
- AKShare only through a small isolated adapter if a specific endpoint is valuable.

Cash cost: 0 RMB.

Engineering cost: moderate.

Best for: current inspection/review/stock-analysis MVP.

### Phase 1: Test Tushare Pro

Buy only if we can name the target data gaps first. Suggested first test:

- 500 RMB/year or 1,000 RMB/year tier;
- no minute add-on initially;
- use for stock basic info, financial statements, daily basic indicators, adjusted daily bars, and trading calendar cross-checks;
- compare against existing free sources through telemetry.

Cash cost: 500-1,000 RMB/year.

Engineering cost: low/moderate.

Best for: improving product trust without jumping to institutional spend.

### Phase 2: Consider Medium-Tier Provider Only After Gap Proof

Do not buy JQData/RQData/minute packages just because they are cleaner. Buy only if one of these becomes a real blocker:

- review quality is limited by missing historical fundamentals;
- screening needs stable broad-market financial/factor data;
- plan/alert logic needs clean minute data;
- public endpoints break often enough that maintenance cost exceeds subscription cost.

Cash cost: likely several thousand RMB/year or quote-based.

Engineering cost: moderate.

Best for: after the assistant proves daily usefulness.

### Phase 3: Avoid Terminal Products

Wind/Choice/iFinD are not current MVP purchases.

Cash cost: likely 10,000-40,000+ RMB/year per account.

Best for: future commercial or institutional deployment, not the current personal assistant.

## Decision

Current decision:

1. Keep building the internal reliable-data-source service.
2. Treat free providers as replaceable inputs, not trusted facts by themselves.
3. Do not buy institutional terminals.
4. Make Tushare Pro the only near-term paid-data candidate.
5. Before paying even for Tushare, define a small acceptance test:
   - which fields are missing for the current trading day;
   - which service endpoints it will improve;
   - how many provider mismatches it reduces;
   - whether review/inspection output becomes more useful.

Practical recommendation:

> For the next stage, budget 0 RMB cash and continue engineering the source-quality service. Keep a 500-1,000 RMB/year optional Tushare experiment as the first paid upgrade. Do not commit to several-thousand or terminal-level products until the assistant has proven enough daily value to justify that recurring cost.

## Sources Checked

- Tushare point and frequency table: https://tushare.pro/document/1?doc_id=290
- Tushare permission notes: https://tushare.pro/document/1?doc_id=108
- Tushare service agreement: https://tushare.pro/document/1?doc_id=405
- AKShare introduction: https://akshare.akfamily.xyz/introduction.html
- AKShare special notice: https://akshare.akfamily.xyz/special.html
- BaoStock official site: https://www.baostock.com/
- BaoStock docs: https://www.baostock.com/helpDocsHome
- JoinQuant data page: https://www.joinquant.com/data
- JQData docs: https://www.joinquant.com/help/api/doc?id=9997&name=JQDatadoc
- RQData docs: https://www.ricequant.com/doc/rqdata/python/index-rqdatac
- RQData generic API docs: https://www.ricequant.com/doc/rqdata/python/generic-api
- Wind terminal official page: https://www.wind.com.cn/mobile/WFT/zh.html
- Choice terminal official page: https://choice.eastmoney.com/terminal
- iFinD official page: https://www.51ifind.com/
- 2026 terminal price reporting reference: https://www.stcn.com/article/detail/3620915.html
