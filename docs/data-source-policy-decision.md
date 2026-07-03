# Data Source Policy Decision

> Date: 2026-07-02
> Status: accepted

## Decision

Invest Agent will not depend on expensive paid financial data products in the current personal MVP stage.

The project will use a layered data-source policy:

1. First query the service-owned reliable-data-source layer.
2. If the service cannot provide the needed fact, allow the AI backend to perform external search as a supplementary evidence layer.
3. If neither path can produce a traceable source, state the data gap explicitly.

The service-owned layer remains the first fact layer because it is auditable: it records provider, endpoint, fetch time, freshness, confidence, degradation, and cross-source quality signals.

External AI search is allowed only as supplemental evidence. It must not silently override service data, and it must not be treated as a stable paid-data entitlement. Search results should preserve source links, publication/update time, and evidence boundaries when they are used in investment analysis.

## Rationale

The current project is a small, self-funded investment assistant. Professional financial terminals and institutional data products are too expensive for the expected benefit at this stage. Even common quant-data services can become a recurring cost that is hard to justify before the assistant proves daily usefulness.

The existing free and self-maintained sources are broadly enough for the current workflows:

- daily inspection;
- portfolio and watchlist review;
- plan trigger checks;
- index and market status observation;
- basic individual stock analysis;
- announcement/news/report evidence gathering.

The main risk is not only missing data. It is over-trusting data without source, time, freshness, or evidence-level boundaries. Therefore, the project should keep investing in the reliable-data-source service and source-quality evaluation rather than immediately buying data.

AI search may sometimes surface information that the project cannot fetch directly, possibly through model-provider search integrations or web-accessible summaries. However, the project must not assume that these integrations expose durable, licensed, structured financial databases to us. Availability, provider coverage, citation quality, and usage rights can vary by model and over time.

## Operating Rules

Service and workspace skills should follow this order:

1. Use local service APIs first for quotes, K-lines, indices, trading calendar, announcements, stock info, sector/theme tags, source health, and portfolio/watchlist/plan facts.
2. Use external search only for missing context, latest events, interpretation, or data gaps not covered by the service.
3. Label external search results as supplemental evidence, not primary service facts.
4. Keep facts, inference, and action suggestions separate.
5. Do not invent values when both service and external search are unavailable.
6. Do not expose internal API paths, sandbox tokens, curl commands, or execution details to the end user.

## Cost Policy

Current budget posture:

- default cash budget for market data: 0 RMB/year;
- no Wind, Choice, iFinD, institutional terminal, Level-2, or tick-data purchase in the MVP stage;
- no medium-tier provider purchase without a proven product gap;
- optional future low-cost experiment: Tushare Pro only if a small acceptance test identifies specific missing fields and expected quality improvement.

See `data-provider-cost-evaluation.md` for provider cost bands and build-vs-buy analysis.

## Implementation Implications

The reliable-data-source service is still valuable even when sources are free:

- it normalizes provider output;
- it records freshness and warnings;
- it supports fallback and cross-source mismatch detection;
- it gives the Platform page a way to show source quality;
- it gives review, inspection, and stock analysis a stable first fact layer;
- it provides a place to plug in future paid or free providers without changing workspace reasoning workflows.

The AI layer should become better at data acquisition order, not more confident by default. The expected future skill behavior is:

> local service first, external search second, explicit data gap last.

## Consequences

Positive:

- avoids recurring data costs that do not fit the current project size;
- keeps the architecture provider-neutral;
- improves auditability before expanding provider scope;
- lets the project use AI search opportunistically without depending on it as a hidden data vendor.

Tradeoffs:

- free endpoints may break or degrade;
- data breadth may be weaker than paid providers;
- some financial/factor datasets may remain unavailable;
- more engineering work is required for telemetry, fallback, and validation;
- external search results require careful evidence labeling.

## Revisit Conditions

Revisit this decision only if at least one condition becomes true:

- public/free sources break often enough that maintenance cost exceeds a low-cost subscription;
- review or screening quality is materially blocked by missing structured data;
- a low-cost provider can fill named gaps with clear licensing and stable APIs;
- the project becomes commercial or multi-user enough to justify recurring data spend;
- a concrete feature requires minute, factor, financial statement, or corporate-action data that cannot be reliably sourced otherwise.
