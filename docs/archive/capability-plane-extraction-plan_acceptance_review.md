# Capability Plane Extraction Acceptance Review

## Acceptance Verdict

Status: Pass with caveats

WP0 satisfies the plan's prerequisite deliverables without changing production code or durable user state. The relationship inventory and dependency matrix agree with direct source inspection; the redacted fixture set covers the planned status classes across the three capability domains. Two existing indicator smoke scripts remain red because their template inputs are absent. That is accurately documented as a pre-existing Phase 3 concern, not hidden as a WP0 pass.

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Call relationships | List production callers of market-data, research, and indicators | Pass | `docs/capability-plane-wp0-baseline.md` section 3; direct `rg` inspection of `src/mcp`, `src/routes`, `src/services`, `src/handlers`, and `src/scheduler` | Includes MCP, sandbox HTTP, platform, review, watch-rule, scheduler, and scripts. |
| Dependency matrix | Identify environment, network, SQLite, Workspace, identity, cache, telemetry, logger, and audit dependencies | Pass | Baseline section 2; `market-data.ts`, `market-data-providers.ts`, `external-evidence-search.ts`, `external-market-providers.ts`, `indicators.ts` | Correctly distinguishes `marketSnapshot` user-state reads from telemetry-only `userId` usage. |
| Fixtures | Save redacted success, partial, empty, rate-limit, and no-permission reference fixtures | Pass | `tests/capabilities/fixtures/README.md` and eight JSON fixtures; `jq empty` passed for each | Fixtures are reference baselines, deliberately not wired to tests until later work packages. |
| Redaction | Document and apply fixture redaction rules | Pass | Fixture README redaction section; manual file inspection | Provider identity is retained while credentials, user identifiers, raw payloads, and credential URLs are excluded. |
| Baseline behavior | Record provider, quality, SSRF, and indicator invariants that extraction must preserve | Pass | Baseline section 1 | Matches the plan's no-behavior-change requirement. |
| Verification record | Record existing verification commands and their scope | Pass | Baseline section 5; independent rerun below | Explicitly separates offline checks from network/state-dependent probes. |
| No behavioral scope expansion | Do not begin WP1 or alter production behavior/data | Pass | New files only for this work package; source inspection | No production source, configuration, database, Workspace, review, `.state`, or WeChat state was changed by WP0. |

## Findings

- [Medium] Indicator smoke prerequisites are missing: `smoke:script-indicator` and `smoke:composite-indicator` require template files that are absent. WP0 correctly records this as a WP6 prerequisite. Do not claim Phase 3 capability isolation is verified until the template strategy and smoke entrypoints are resolved.
- [Low] The fixture baselines are hand-maintained references rather than generated contract captures. WP1/WP2/WP6 should turn them into executable fixture tests and establish capture provenance before relying on them to prevent semantic drift.

## Verification Performed

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm run smoke:indicators`: passed.
- `jq empty` for every `tests/capabilities/fixtures/*.json`: passed.
- `npm run smoke:script-indicator`: failed only because `templates/workspace/scripts/indicators/double_ma_cross.ts` is absent.
- `npm run smoke:composite-indicator`: failed only because `templates/workspace/config/composite_indicators.yaml` is absent.
- Direct source inspection confirmed `marketSnapshot` uses `portfolioBackend`, `watchlistBackend`, and `planBackend`; `withSourceEvent` is shared by market and research; MCP/HTTP and active indicator callers are represented in the inventory.

## Follow-Up Checklist

- [ ] Start WP1 with the documented market-data boundary and injected telemetry-sink decision.
- [ ] Before WP6, decide whether to restore controlled fixture assets or rewrite the two stale indicator smoke entrypoints.
- [ ] Convert reference fixtures into offline executable contract tests in their respective extraction work packages.

## 2026-07-30 - WP1 Acceptance Verdict

Status: Pass with caveats

WP1 establishes a real branch-by-abstraction boundary for market-only reads while preserving the existing public service facade. The capability module has no runtime imports from the service state, MCP, HTTP, route, scheduler, or audit layers; the only service-to-capability dependency is the explicit composition root. `marketSnapshot` remains service-owned and retains its data-backend reads. This is a shell rather than a provider-module relocation, as intended for WP1; runner and adapter migration remain future work packages.

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Shared contract | Establish shared result/error vocabulary | Pass | `src/capabilities/shared/result.ts`, `errors.ts` | New vocabulary is additive; no outward response shape changed. |
| Market contract | Define a market-only capability interface | Pass | `src/capabilities/market-data/contract.ts` | Types retain current source/warning-compatible service contracts. |
| Facade delegation | Existing market read exports delegate to one capability instance | Pass | `src/services/market-data.ts` `*Impl` operations and `marketDataCapability` composition | No duplicate implementations were introduced. |
| Core ownership | Keep user-state aggregation outside capability | Pass | `marketSnapshot` remains in `src/services/market-data.ts` with `portfolioBackend`, `watchlistBackend`, `planBackend` reads | Capability files have no prohibited runtime imports. |
| Compatibility | Preserve K-line and indicator behavior | Pass | `tests/market-kline-contract.test.ts` 3/3; `npm run smoke:indicators` passed | MCP/HTTP migration is explicitly deferred to WP3. |

### WP1 Verification Performed

- `npm run typecheck`: passed.
- `npm run build`: passed.
- `node --import tsx --test tests/capabilities/market-data-capability.test.ts`: passed.
- `node --import tsx --test --test-concurrency=1 tests/market-kline-contract.test.ts`: passed, 3/3.
- `npm run smoke:indicators`: passed.
- Static import scan of `src/capabilities`: no Core Service state, MCP, route, scheduler, or audit import found.

### WP1 Caveats

- The public domain types remain declared in the service facade and are type-imported by the new contract. A later compatibility-safe refactor may make the contract their canonical home after consumer inventory confirms no declaration-path breakage.
- Provider implementations and telemetry are still physically in the service module/provider module. WP2 should add the standalone runner and executable fixture contracts before any broader module relocation.

## 2026-07-30 - WP2 Acceptance Verdict

Status: Pass with caveats

WP2 supplies a standalone market runner for all five planned operations. Its default path is entirely local and deterministic, while live calls require an explicit flag and retain the existing facade rather than adding a second implementation. The runner has no user-state command or Workspace path input. MCP/HTTP and internal call migrations remain correctly deferred.

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Standalone runner | Support quote, K-line, indices, calendar, and health without full runtime | Pass | `scripts/capabilities/market-data.mjs`; `docs/capability-plane-wp2-runner.md` | Fixture mode imports only `node:` modules and local fixture files. |
| Machine interface | JSON input/output, stdout-only result, stderr diagnostics | Pass | Runner tests; `--input` parsing and subprocess assertions | One JSON object on stdout; invalid input exits nonzero and writes stderr. |
| Offline default | Default fixtures do not depend on network or user state | Pass | `fixtureByOperation`, fixtures, subprocess tests | No live probe was exercised. |
| Explicit live mode | Live mode must be opt-in and preserve service semantics | Pass | Runner `--live` branch; package command | Uses the WP1 compatibility facade rather than a duplicate provider chain. |
| Fixture coverage | Cover all planned runner operations | Pass | Ten market fixture files and fixture README | Existing failure/partial/empty fixtures remain alongside new success fixtures. |
| Regression | Focused runner and existing market behavior remain valid | Pass | `capability:market-data:test` 4/4; typecheck/build; WP1 K-line test | No MCP/HTTP migration is in this package. |

### WP2 Caveats

- Fixture-mode output is a contract reference and does not validate live provider parsing. The explicit live command is available for that purpose but was not run because it requires real provider/network access.
- `market.health` fixture represents capability-local provider health. The planned Core Service aggregate-health distinction remains a later design decision.

## 2026-07-30 - WP3 Acceptance Verdict

Status: Pass

MCP and sandbox HTTP market reads now call the single WP1 capability instance without changing their tool/route names, input validation, scoped identity passing, audit calls, or outward response envelopes. `market.snapshot` is intentionally left as a Core Service orchestration because it reads user-scoped durable state.

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| MCP migration | Named `market.*` read tools use capability | Pass | `src/mcp/service-tools-core.ts`; MCP smoke | The service retains scope and audit around each call. |
| HTTP migration | Sandbox market reads use capability | Pass | `src/routes/sandbox.ts`; adapter boundary test | Existing sandbox permission wrapper and audit remain unchanged. |
| Core ownership | `market.snapshot` stays service-owned | Pass | Both adapters retain `marketSnapshot`; boundary test | No Workspace path reaches capability input. |
| Compatibility | MCP protocol and existing market semantics remain stable | Pass | `npm run smoke:mcp-service-tools`; K-line contract 3/3 | Provider behavior remains the same composed implementation. |
| Regression guard | Prevent adapter drift back to legacy direct reads | Pass | `tests/capabilities/market-adapter-boundary.test.ts` | Checked by `capability:market-data:test`. |

## 2026-07-30 - WP4 Acceptance Verdict

Status: Pass with caveats

WP4 migrates scheduler-adjacent internal market readers to the capability while intentionally retaining the service-owned market snapshot path. Capability boundary tests and the isolated watch-rule stage2 smoke pass. Full scheduled review and market-watch end-to-end runs are not repeated because they are outside this narrow adapter migration and can depend on configured runtime/user state.

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Watch-rule migration | Rule quote/K-line reads use capability | Pass | `src/services/watch-rules.ts`; isolated stage2 smoke | Alert, persistence, lock, and push ownership remain unchanged. |
| Review migration | Review quote/K-line/index reads use capability | Pass | `src/handlers/review.ts`; internal boundary test | Review content and storage behavior were not changed. |
| Plan conditions | Price lookup uses capability | Pass | `src/handlers/plan-conditions.ts`; internal boundary test | Existing error fallback remains intact. |
| Platform health | Provider health read uses capability | Pass | `src/routes/platform.ts`; internal boundary test | Platform auth and response handling remain in route layer. |
| Snapshot ownership | User-state snapshot remains Core Service | Pass | `src/services/market-watch-snapshot.ts`, `src/services/market-data.ts` | No snapshot input is added to the capability contract. |
| Regression | Internal reader boundary and watch-rule behavior pass | Pass | `capability:market-data:test` 6/6; stage2 smoke | Stage2 used a fresh initialized temporary database. |

### WP4 Caveat

- Scheduled review and market-watch full-chain smoke were not rerun because they exercise unrelated configured runtime/user-state paths. WP4 did not modify their orchestration or persistence code; later production-readiness work should run those checks in an explicitly authorized test scope.

## 2026-07-30 - WP5 Acceptance Verdict

Status: Pass with caveats

Research retrieval now has a capability contract, explicit fixture-first runner, and MCP adapter path. The existing safety implementation remains on the capability execution path and its dependency injection remains available for offline tests. No generic HTTP or provider-specific MCP interface was added.

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Research contract | Named news/search/read operations use one capability | Pass | `src/capabilities/research/`; `researchReadCapability` | Existing facade preserves callers and test injection. |
| MCP adapter | Named research tools call capability | Pass | `src/mcp/service-tools-core.ts` | Scope and audit remain in Core Service. |
| Safety | SSRF, redirect, size/type, timeout and credential defenses remain effective | Pass | `tests/external-evidence-search.test.ts` 16/16 | All checks are offline via injected dependencies. |
| Runner | Fixture-first JSON runner has explicit live mode | Pass | `scripts/capabilities/research.mjs`; runner test | Default path does not import service runtime or network. |
| Provider provenance | Fallback and actual provider identity remain test-covered | Pass | External evidence tests and research fixtures | No provider ordering changed. |

### WP5 Caveat

- The runner's live mode was not exercised because real provider availability is intentionally outside default tests. Use it only as an explicit read-only probe.

## 2026-07-30 - WP6 Acceptance Verdict

Status: Pass with caveats

The active, pure L1 indicator path is independently runnable and shared by review/watch-rule callers. After explicit authorization, script/composite smoke inputs moved to repository-owned test fixtures and all three indicator smoke suites pass without restoring or touching Workspace templates.

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| L1 contract | Pure deterministic indicator capability | Pass | `src/capabilities/indicators/`; `indicatorCapability` | No database, network, Workspace, or ACP dependency. |
| Active callers | Review and watch-rule computations use capability | Pass | `src/handlers/review.ts`, `src/services/watch-rules.ts` | User definitions and acknowledgement are not moved. |
| Golden fixture runner | Fixture-mode indicator runner | Partial | `scripts/capabilities/indicators.mjs` | Existing fixture is deterministic but still records itself as reference-only; a checked-in full K-line fixture/version pin remains needed. |
| L1 verification | Deterministic calculations/warm-up behavior | Pass | capability test; `smoke:indicators` | Existing smoke passes. |
| Script sandbox safety | Timeout and execution boundary | Pass with caveats | `smoke:script-indicator` | Isolated-vm timeout, bounded isolate construction, runtime bridge, and missing-export handling pass. Dedicated memory/module-denial assertions remain a gap. |
| Composite safety | Definition/parser/expression safety | Pass | `smoke:composite-indicator` | Whitelist, function-call, string-literal, malformed-input, and expression-timeout paths pass. |

### WP6 Caveats

- The fixtures are repository-owned under `tests/fixtures/indicators/`; Workspace templates remain untouched.
- Add dedicated script-engine memory-exhaustion and prohibited-import tests before treating the isolated-vm boundary as exhaustively covered.
- Promote the L1 reference snapshot to a version-pinned full K-line golden fixture in a follow-up if exact algorithm-drift detection is required.
