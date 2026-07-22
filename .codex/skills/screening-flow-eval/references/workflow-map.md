# Screening Workflow Map

## Current Product Path

```text
User asks industry/theme/company screening question
  -> WeChat or portal bridge resolves user, instance, workspace
  -> workspace ACP reads observation-pool Skill and selection protocol
  -> candidate research / risk scan / waiting conditions
  -> observation-pool draft after user confirmation
  -> optional service-owned watchlist.add after separate confirmation
```

## Current Workspace Assets

- `skills/observation-pool/`: observation-pool construction, candidate risk scan, and waiting-zone workflow.
- `config/selection.yaml`: product boundary, modules, candidate fields, and forbidden outputs.
- `config/observation_pool.yaml`: confirmed observation-pool artifact.
- `knowledge/selection_protocol.md`: candidate evidence, risk, waiting-condition, and no-recommendation rules.
- `config/portfolio.yaml` and `config/strategy.yaml`: current holdings, watchlist, style, and risk context.

## Service-Owned Evidence

- `market.snapshot`, `market.quote`, and `market.health`: scoped market facts, metadata, warnings, and freshness.
- `watchlist.add`: confirmed, auditable conversion of one selected candidate to watchlist.
- `conversation_messages`, `codex_acp_traces`, and `sandbox_audit_logs`: interaction and durable-write evidence.

## Known Boundary

There is no deterministic full-market constituent/factor screener or dedicated observation-pool service write tool today. Evaluate actual behavior against that limit; do not infer that template configuration alone proves a deterministic service capability.
