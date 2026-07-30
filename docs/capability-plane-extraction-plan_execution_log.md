# Capability Plane Extraction Execution Log

## 2026-07-30 - Scope decision

- Source plan: `docs/capability-plane-extraction-plan.md`.
- Requested action: execute the plan.
- This run starts with WP0 only. The plan requires each work package to be independently reversible and accepted; no work package was explicitly designated, and WP0 is the documented prerequisite for implementation work.
- Safety boundary: do not modify real Workspaces, SQLite state, `reviews/`, `.state/`, or WeChat state. Preserve all pre-existing worktree changes.

## 2026-07-30 - Executor prompt

Requested a WP0-only implementation: inspect the plan and stated runtime documents, preserve the dirty worktree, add only the Phase 0 relationship inventory, dependency matrix, redacted fixtures, and migration-precondition verification record; make no production-behavior change.

## 2026-07-30 - WP0 executed

WP0 delivered. No production source, tests, config, or user state modified — only new docs + redacted fixtures.

Deliverables:
- 主基线文档：`docs/capability-plane-wp0-baseline.md`（调用关系清单、能力依赖矩阵、fixture 清单与脱敏规则、迁移前验证记录、完成条件自检、风险与阻塞）。
- 脱敏基线 fixture：`tests/capabilities/fixtures/`（README + 8 个 fixture，覆盖成功/部分失败/空结果/限流/无权限；参考用、未接 runner）。
- 本日志更新。

Verification run (read-only/offline, 2026-07-30):
- `npm run typecheck` ✅；`npm run build` ✅；`npm run smoke:indicators` ✅。
- `npm run smoke:script-indicator` / `smoke:composite-indicator` ❌（前置条件缺失，pre-existing：模板资产在 `771bbe9` 被移除，非本次引入；WP6 阻塞项）。
- `smoke:mcp-service-tools` / `probe:market-data-live` 按红线未实跑（需公网/真实 provider），仅记录其验证范围。

Key findings feeding WP1:
- 唯一读用户状态的 market 导出是 `marketSnapshot`（留 Core Service）；其余 market 导出 `userId` 仅遥测标签。
- research 模块用户状态零依赖，但共享持久遥测 sink（`withSourceEvent`→`data/source-telemetry/*.jsonl`）——计划 §1A 注入式 sink 的对象；`searchPublicWeb`/`readPublicWebPage` 已支持 `fetchImpl/env/now` DI，利于 WP2 fixture 模式。
- `indicators.ts` 纯函数；L3a/L3b/script/composite/acknowledgement 生产无调用方（仅 smoke），Phase 3 无活跃入口可迁移，需重评。

Stopping per scope: WP0 only. Not beginning WP1 or later.

## 2026-07-30 - Independent verification

- `npm run typecheck` passed.
- `npm run build` passed.
- `npm run smoke:indicators` passed, including all logged L1 operators.
- `jq empty` accepted each fixture JSON file.
- `npm run smoke:script-indicator` failed because `templates/workspace/scripts/indicators/double_ma_cross.ts` is absent.
- `npm run smoke:composite-indicator` failed because `templates/workspace/config/composite_indicators.yaml` is absent.
- Source inspection confirmed the documented `marketSnapshot` data-backend reads, shared `withSourceEvent` telemetry boundary, MCP/HTTP adapters, and active indicator callers.

## 2026-07-30 - WP1 scope

- User authorized continuation with WP1.
- Scope: shared result/error contract and a `market-data` capability shell using branch-by-abstraction.
- Non-goals: no standalone runner, no MCP/HTTP/scheduler/review/watch-rule migration, no provider-order or data-quality-policy change, and no production deployment/state operation.

## 2026-07-30 - WP1 executed

- Added `src/capabilities/shared/result.ts` and `errors.ts` as the shared, versionable result and error vocabulary for later capability work.
- Added `src/capabilities/market-data/contract.ts` and `capability.ts`. The contract covers market-only reads; the factory accepts only explicit query operations and has no runtime dependency on Core Service state.
- Converted `src/services/market-data.ts` to a compatibility facade: existing public market read exports now delegate to a composed `marketDataCapability`; their former bodies are internal `*Impl` operations. `marketSnapshot` remains in the service facade and still reads portfolio, watchlist, and plan state before invoking those public market reads.
- Did not change MCP/HTTP tools, provider order, telemetry behavior, source metadata, warning strings, algorithms, or durable state.

Verification:
- `npm run typecheck` passed.
- `npm run build` passed.
- `node --import tsx --test tests/capabilities/market-data-capability.test.ts` passed.
- `node --import tsx --test --test-concurrency=1 tests/market-kline-contract.test.ts` passed (3/3).
- `npm run smoke:indicators` passed.

## 2026-07-30 - WP2 scope

- User authorized continuation with WP2.
- Scope: standalone market-data JSON runner, fixture-mode contract tests, explicit live-probe entry point, and developer command documentation.
- Non-goals: no MCP/HTTP/scheduler/review/watch-rule migration, no provider-order or telemetry semantic change, and no user-state aggregation in the runner.

## 2026-07-30 - WP2 executed

- Added `scripts/capabilities/market-data.mjs`, which supports `quote`, `kline`, `indices`, `calendar`, and `health` with JSON `--input` and one JSON object on stdout.
- Default fixture mode loads only redacted local JSON files and never imports the service runtime. `--live` is explicit and delegates to the existing market facade, preserving its current provider/fallback and telemetry behavior.
- Added fixture coverage for K-line, indices, calendar, and health, and documented the command contract in `docs/capability-plane-wp2-runner.md`.
- Added `capability:market-data`, `capability:market-data:test`, and `capability:market-data:live` package commands plus runner subprocess tests.

Verification:
- `npm run capability:market-data:test` passed (4/4).
- `npm run typecheck` passed.
- `npm run build` passed.
- Fixture-mode `quote` and `calendar` runner invocations emitted valid JSON without diagnostics.
- No live probe was run.

## 2026-07-30 - WP3 executed

- Exported the composed `marketDataReadCapability` from the service composition root.
- Migrated MCP `market.quote`, `market.kline`, `market.indices`, `market.capital_flow`, `market.sector_theme`, `market.calendar`, `market.health`, `market.stock_info`, and `market.resolve` to call that capability directly after their existing validation and before their existing audits.
- Migrated sandbox HTTP market reads and its two internal quote consumers to the same capability. `market.snapshot` remains a service call because it aggregates scoped portfolio/watchlist/plan state.
- Added a boundary regression test asserting that MCP and sandbox retain the snapshot service boundary while all pure reads call the shared capability.

Verification:
- `npm run typecheck` and `npm run build` passed.
- `npm run smoke:mcp-service-tools` passed using its isolated temporary database, Workspace, and review root.
- `npm run capability:market-data:test` passed before the new boundary test was added; it is rerun below as the final check.
- `tests/market-kline-contract.test.ts` passed (3/3).

## 2026-07-30 - WP4 scope and execution

- User authorized continuation with WP4.
- Migrated watch-rule evaluation, review market reads, plan-condition quote checks, and platform provider health to `marketDataReadCapability`.
- Kept `market-watch-snapshot` and `marketSnapshot` on the Core Service path because both aggregate scoped durable state.
- Added a static regression test over all internal production readers. No scheduler, push, persistence, or user-state responsibility was moved to the capability.

Verification:
- `npm run typecheck` and `npm run build` passed.
- `npm run capability:market-data:test` passed (6/6, including MCP/HTTP/internal boundary checks).
- `scripts/watch-rules-stage2-smoke.mjs` passed after the project test-DB bootstrap initialized an isolated temporary database. The first isolated invocation correctly failed before that bootstrap because `alert_rules` did not exist; no real database was accessed.

## 2026-07-30 - WP5 executed

- Added `researchReadCapability` and a typed contract for finance-news search, web search, and public-page read. Existing exported functions remain compatibility facades, including their dependency-injection signatures used by offline security tests.
- Migrated MCP `research.news_search`, `research.web_search`, and `research.web_read` to the capability while retaining existing named tools, user scope, input validation, audit, and URL redaction.
- Added fixture-first `scripts/capabilities/research.mjs`, redacted news/page fixtures, and `capability:research` commands. Live mode is explicit and uses the same capability facade.

Verification:
- `npm run capability:research:test` passed (17/17), including SSRF/private-address, redirect, content-limit, TLS, provider fallback, rate-limit, and no-secret-warning coverage.
- `npm run typecheck`, `npm run build`, and a fixture-mode runner invocation passed.
- No network live probe was run.

## 2026-07-30 - WP6 partial execution

- Added the pure L1 `indicatorCapability`, a typed contract, deterministic fixture runner, and migrated active review/watch-rule callers to that capability.
- `capability:indicators:test`, typecheck, build, and the existing L1 indicator smoke pass.
- Composite/script engine migration and its safety-smoke acceptance remain blocked by the pre-existing missing template assets documented in WP0. No template was restored or substituted because existing Workspace/template assets require explicit authorization.

## 2026-07-30 - WP6 fixture authorization applied

- User explicitly authorized repository-owned test fixtures in `tests/fixtures/indicators/`.
- The script/composite smoke scripts now consume those fixtures, not `templates/workspace/`; no Workspace template or user asset was restored or modified.
- `smoke:script-indicator`, `smoke:composite-indicator`, and `smoke:indicator-acknowledgement` now pass; typecheck and `git diff --check` pass.
