# Market Data Capability Runner (WP2)

`market-data` can now be exercised without starting Fastify, ACP, scheduler, or the WeChat bridge. The default fixture mode has no network access and does not load the service runtime.

```bash
npm run capability:market-data -- quote --input '{"codes":["600519","000001"]}'
npm run capability:market-data -- kline
npm run capability:market-data -- indices
npm run capability:market-data -- calendar
npm run capability:market-data -- health
npm run capability:market-data:test
```

The runner accepts a named operation plus optional JSON object through `--input`; stdout contains exactly one JSON object. Fixture mode returns the corresponding redacted file in `tests/capabilities/fixtures/`. Diagnostics and invalid-input failures go to stderr with a nonzero exit code.

Live calls are opt-in and read-only:

```bash
npm run capability:market-data:live -- quote --input '{"codes":["600519"]}'
```

Live mode uses the existing market facade and therefore preserves its provider order, fallback behavior, telemetry, source metadata, and warning semantics. It must not be used in the default test suite or as a golden-data source.
