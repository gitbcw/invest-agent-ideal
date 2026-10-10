# 豆包搜索 Custom 接入计划

> Status: proposed implementation plan  
> Scope: extend the existing `research.web_search` service capability with a primary-to-fallback provider chain.  
> Decision: use Doubao Search **Custom** as the primary web-search provider and the self-hosted SearXNG endpoint as fallback.

## Goal

Improve Chinese web-source discovery for the investment assistant without changing the existing workspace/MCP evidence boundary:

```text
research.web_search
  -> Doubao Search Custom
  -> usable result: return normalized source-discovery results
  -> unavailable or no usable result: SearXNG
  -> unavailable again: return an empty, audited result with warnings

research.web_read
  -> independently validate and fetch a selected public URL
```

`research.web_search` remains a read-only, service-owned MCP tool. It remains supplemental evidence, never a replacement for service-owned market facts, announcements, or financial statements. Search titles, snippets, summaries, relevance scores, and provider-returned content are not sufficient to establish a high-risk investment fact.

## Why Custom

Doubao Search Custom provides the fields needed by the existing source-discovery contract: title, URL, site name, publication time, summary, full content, relevance score, authority level, provider request ID, and latency. It also supports URL-only results, content-required results, allowed/blocked sites, time ranges, Markdown content, a finance industry filter, and very-authoritative-site filtering.

Use the API Key integration, not the TOP AK/SK gateway:

- endpoint: `POST https://open.feedcoopapi.com/search_api/web_search`
- authentication: `Authorization: Bearer <API_KEY>`
- content type: `application/json`
- default account limit: 5 QPS

The official MCP server and Skill are intentionally out of scope. The application must call the HTTP API through its own service adapter so existing MCP authorization, source telemetry, audit, URL validation, and evidence discipline remain enforced.

Official references:

- [豆包搜索产品简介](https://docs.volcengine.com/docs/87772/2272949?lang=zh)
- [豆包搜索 Custom API](https://docs.volcengine.com/docs/87772/2272953?lang=zh)
- [豆包搜索产品计费](https://docs.volcengine.com/docs/87772/2272951?lang=zh)
- [AI 工具接入指南](https://docs.volcengine.com/docs/87772/2297384?lang=zh)

## Existing Integration Points

| Concern | Existing owner | Required change |
| --- | --- | --- |
| Web-search capability | `src/services/external-evidence-search.ts` | Add a Doubao request/normalization adapter and provider-chain selection. |
| Provider registry and telemetry | `src/services/market-data-providers.ts` | Add `doubao_web_search` metadata. Reuse `withSourceEvent`. |
| MCP surface and audit | `src/mcp/service-tools-core.ts` | Keep the same `research.web_search` tool and audit operation; extend the audit summary only. |
| Workspace behavior | `templates/workspace/AGENTS.md` and QA prompt | No initial contract change: results still require `research.web_read` before factual use. |
| Tests | `tests/external-evidence-search.test.ts` | Add Doubao normalization and fallback-chain cases. |

Do not add a new MCP tool, HTTP route, database table, or Workspace setting in this change. Existing callers continue to invoke `research.web_search({ query, limit })`.

## Configuration And Secret Handling

Add the following process environment variables:

| Variable | Required | Meaning |
| --- | --- | --- |
| `DOUBAO_SEARCH_API_KEY` | Required to enable primary search | Custom API Key from the corresponding subscription or post-paid key tab. |
| `DOUBAO_SEARCH_ENABLED` | No, default `true` when a key is present | Explicit kill switch for the Doubao provider. |
| `DOUBAO_SEARCH_ENDPOINT` | No | Override only for test or approved endpoint migration; production default is the official API URL. |
| `EXTERNAL_WEB_SEARCH_SEARXNG_URL` | Required for fallback availability | Existing local SearXNG JSON endpoint. |

Rules:

- Never write the API key to source, tests, telemetry, audit records, logs, exception messages, or customer output.
- Do not forward `userId`, `instanceId`, Workspace content, portfolio data, or audit data to Doubao. Only the normalized search query and request options are sent.
- Subscription and post-paid API Keys are isolated by the provider. Operations must configure the key matching the enabled billing mode.
- A missing or disabled Doubao key is not an error: use SearXNG directly and report its actual provider name.

## Provider Contract

### Request

For the first implementation, send:

```json
{
  "Query": "<normalized query>",
  "SearchType": "web",
  "Count": 8,
  "Filter": {
    "NeedUrl": true,
    "NeedContent": false
  }
}
```

Rules:

- Reuse the existing query normalization, but additionally enforce the provider maximum of 100 characters before the request.
- Map the caller's current `limit` range of 1-10 to `Count`; do not expose Custom's larger 50-result limit in this change.
- Do not enable `Industry: finance`, `AuthInfoLevel: 1`, `TimeRange`, or query rewriting by default. They reduce recall and require an explicit future tool-contract decision.
- Do not request content in the primary path. It is available for a later, separately designed `web_read` fallback, but returning it now would blur the existing search-versus-original-page boundary.

### Normalized Response

Add provider name `doubao_web_search`. Keep the public item shape unchanged:

```ts
type PublicWebSearchItem = {
  title: string;
  snippet: string;
  url: string;
  rank: number;
};
```

Map valid `Result.WebResults` items as follows:

| Doubao field | Normalized field | Rule |
| --- | --- | --- |
| `Title` | `title` | Strip markup and ignore blank titles. |
| `Summary` | `snippet` | Prefer `Summary`; use `Snippet` only if Summary is empty. Cap at the existing 500 characters. |
| `Url` | `url` | Keep only credential-free `http:`/`https:` URLs using the existing safe URL helper. |
| `SortId` | `rank` | Preserve a positive provider rank when present; otherwise assign normalized order. |

Do not add `Content`, `RankScore`, authority fields, or raw provider response fields to the current MCP response in this change. Record request metadata only in the service's telemetry/audit summary where supported; never include raw query or API credentials beyond current audit behavior.

`ResponseMetadata.Error` is a provider failure even when the HTTP status is 200. Treat missing or malformed `ResponseMetadata` / `Result` structures as `INVALID_RESPONSE`.

## Fallback And Failure Semantics

Provider order is deterministic:

1. If `DOUBAO_SEARCH_ENABLED` and `DOUBAO_SEARCH_API_KEY` are present, call Doubao Custom.
2. Return Doubao results only when at least one normalized item has a valid HTTP(S) URL.
3. Otherwise, call configured SearXNG.
4. Return SearXNG results when available; otherwise return zero items and warnings for each attempted provider.

Fall back from Doubao on all of the following:

- transport timeout, network failure, TLS failure, HTTP 429, or HTTP 5xx;
- a parse/response-schema failure;
- `ResponseMetadata.Error`, including `10400`, `10402`, `10403`, `10406`, `10409`, `10410`, `10412`, `10500`, and `700429`;
- an empty `WebResults` array, or no valid normalized URL after filtering.

Reuse the current retry and circuit-breaker behavior for transient transport failures. Provider business errors, invalid credentials, missing entitlement, quota exhaustion, and malformed payloads must not be retried. A provider-specific 5-QPS process-local limiter is required before sending requests; it must not delay or block SearXNG fallback after a Doubao failure.

Warning requirements:

- Preserve provider identity in `source.provider`; it must identify the provider that supplied returned items.
- When SearXNG succeeds after Doubao fails, add a warning such as `primary_provider_failed:doubao_web_search:<classified_reason>`.
- When Doubao returns no usable URLs, add `primary_provider_no_usable_results:doubao_web_search` before the SearXNG attempt.
- When both fail, preserve both classified failures in a stable, bounded warning list.
- Never claim that SearXNG "verified" or "corrected" a Doubao result; it is only a discovery fallback.

## Registry, Telemetry, And Audit

Add `doubao_web_search` to `ProviderName` and the provider registry with:

- `runtimeProvider: "web"`
- `confidence: "medium"`
- `evidenceLevel: "secondary_evidence"`
- `category: "web_search"`
- a usage boundary stating that the provider is for source discovery and summaries/content cannot substitute for original-source verification.

Wrap each attempted provider in `withSourceEvent` so source telemetry records success/failure and timing per provider. This makes primary failures and successful fallback visible in `data/source-telemetry/` without putting telemetry in user Workspaces.

Keep MCP operation name `research.web_search`, resource type `external_evidence`, and the request shape unchanged. Extend its audit summary to include the primary provider and fallback occurrence without adding raw provider payloads, API Key material, or full URLs beyond existing URL-redaction policy.

## Evidence And Safety Boundaries

- Continue to use `research.web_read` for page-body verification. Its public-address validation, redirect validation, size limits, and content-type handling must stay unchanged.
- Search result text is supplemental evidence only. It cannot fill missing quotes, financial-statement fields, or announcements.
- The agent must retain the current rule that source URL, title, and fetch time in customer responses originate from actual tool results.
- Do not treat provider-supplied `Content` as an original-page fetch in this change. A future use of that field requires its own response schema, provenance labeling, rights review, and evaluation plan.

## Implementation Steps

1. Add environment parsing for the Doubao API Key, enabled flag, and endpoint. Do not expose these through MCP schemas or customer output.
2. Add `doubao_web_search` to the provider registry and define its source boundary.
3. Refactor `searchPublicWeb` from the current binary provider selection into an ordered provider-chain helper while keeping its public function signature unchanged.
4. Implement the Doubao Custom request, 100-character query limit, response-error handling, and item normalization.
5. Add a small provider-local 5-QPS limiter and integrate it with the existing retry/circuit breaker. Do not share this limiter with SearXNG.
6. Implement warnings and telemetry for primary failure, no-usable-result fallback, direct-SearXNG mode, and total failure.
7. Update `docs/service-tools-mcp.md` to document the provider order and evidence boundary. Update the provider inventory only where it is current and authoritative.
8. Add focused unit tests and run the verification commands below.

## Required Tests

Add deterministic tests to `tests/external-evidence-search.test.ts` for:

1. Doubao request construction: endpoint, Bearer authorization, `SearchType`, `Count`, `NeedUrl`, and query truncation.
2. Successful normalization: `Summary` preferred over `Snippet`, titles cleaned, only valid HTTP(S) URLs returned, provider rank preserved.
3. Fallback on provider business error returned in an HTTP 200 response.
4. Fallback on timeout/429/5xx and preservation of a primary-failure warning.
5. Fallback when Doubao has zero results or only invalid URLs.
6. Direct SearXNG behavior when Doubao is disabled or unconfigured.
7. Both providers unavailable: no items and stable, non-secret warnings.
8. Provider registry accepts and emits `doubao_web_search` telemetry.

Run:

```bash
npm test
npm run build
npm run smoke:mcp-service-tools
```

The implementation should also run the existing SearXNG evaluation path to ensure the fallback path remains usable:

```bash
npm run eval:acp-data-quality:searxng
```

## Acceptance Criteria

- `research.web_search` keeps its current MCP name, input schema, read-only permission model, and response shape.
- With a valid Custom API Key, a normal request uses Doubao and identifies it as `doubao_web_search` in returned source metadata and service telemetry.
- A Doubao error, quota/permission failure, empty result, or unusable URLs makes one SearXNG attempt when configured.
- A successful SearXNG fallback identifies SearXNG as the result provider and retains a bounded primary-failure warning.
- No API Key, account credential, internal endpoint, raw provider body, or user Workspace data is exposed through MCP output, audit records, telemetry, logs, tests, or customer replies.
- `research.web_read` remains the path for original-page verification; no search response is upgraded to primary evidence.
- Existing SearXNG-only and no-provider behavior remains covered by tests and does not regress.

## Non-Goals

- No direct installation of the vendor MCP server or Skill into production runtime.
- No new user-visible search control, API endpoint, MCP tool, persistence table, or migration.
- No use of Custom `Content` as a replacement for `research.web_read`.
- No automatic finance-only, authority-only, site-only, time-filtered, or query-rewritten search policy in the first release.
- No claim that this service is a licensed substitute for structured financial data providers.
