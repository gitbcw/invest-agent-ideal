# Service Market Data Retirement Archive

Retired on 2026-07-31 after ACP market facts moved to the external `market-data-tool` MCP.

This archive preserves the old service-owned market data implementation for audit and rollback reference only. It is intentionally outside `src/`, `scripts/`, and active test paths.

Archived scope:

- Service provider adapters and facade: Tencent/Sina/Eastmoney/Tushare/TDX wrappers, stock resolver, stock news, provider telemetry, and `market-data.ts`.
- Market-data capability runner/contracts and retired fixtures/tests.
- Live probe and service-market provider smoke/eval scripts.
- Historical service-market design and resource inventory docs.

Active runtime posture:

- Service MCP no longer registers `market.*` tools.
- Sandbox HTTP no longer exposes `/api/sandbox/market/*` routes or `invest.market.read`.
- `market_watch.snapshot` remains only as a read-only historical scheduler snapshot/audit record.
- Research web/news telemetry remains active through `src/services/source-telemetry.ts`; it does not include retired market quote/K-line/fundamental providers.
- Price-cross rule facts currently return `market_data_provider_retired` until a deterministic external-MCP-backed rule price path is introduced.

Do not import files from this archive into active code. If a legacy behavior is needed, re-design it against external MCP discovery instead of restoring the service-owned provider facade.
