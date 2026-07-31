# External MCP Registry Generalization

## Status

Implemented as the current external-MCP contract. This document replaces the pre-implementation plan and describes the behavior that the registry now enforces.

## Registered external servers

The registry supports independently activated, default-disabled external read-only MCP servers:

| Server | Transport | Activation | Session kinds |
| --- | --- | --- | --- |
| `market-data-tool` | Streamable HTTP | `INVEST_AGENT_MCP_MARKET_DATA_ENABLED=true` | `interactive`, `scheduled-read` |
| `qsse-qlib` | Streamable HTTP | `INVEST_AGENT_MCP_QSSE_ENABLED=true` | `interactive` |

`INVEST_AGENT_MCP_EXTERNAL_ENABLED=true` remains a compatibility alias for `market-data-tool` only. It does not activate QSSE or any future registration.

Both servers require their own URL and Bearer-token environment references. No credentials are committed to the repository. QSSE is intentionally excluded from scheduled and evaluation sessions so screening calls do not consume scheduler capacity or evaluation isolation.

## Registration and safety contract

External registrations are declarative. Stdio servers may use literal arguments or `<env:NAME>` templates; template substitution is a direct string operation and never invokes a shell. HTTP servers declare a URL, required references, and explicitly mapped headers.

An external registration is rejected when it references service scope in any of these places:

- stdio `envRefs` or `requiredEnvRefs`;
- HTTP legacy `headerRefs`, mapped `headers[].envRef`, URL template references, or `requiredEnvRefs`.

The HTTP resolver repeats this check before composing a request, so direct resolver use also fails closed. Service scope includes database paths, Workspace paths, user and instance identity, sandbox secrets, and service credentials.

Resolved credential values may enter only the spawned external child environment or the outbound HTTP request headers. They never enter the session manifest, log messages, registration fingerprints, or the tool-conflict cache key. Diagnostics may name missing environment references but never their values.

Set `INVEST_AGENT_MCP_OBSERVER_ENABLED=true` to send external HTTP MCP traffic through the local observer. It records only `server_id`, `tool_name`, request id, completion status, elapsed time, and input/output sizes in `external_mcp_tool_calls`; it never persists raw tool arguments, results, or credentials.

## Assembly behavior

HTTP MCP is assembled only after the ACP initialize response advertises `agentCapabilities.mcpCapabilities.http=true`; an unavailable capability or missing required configuration skips that external server without blocking the service-owned MCP. Service-owned MCP initialization remains blocking.

Before a session begins, the conflict probe discovers tools from every assembled stdio and HTTP server. Any duplicate tool name blocks the session; a failed external probe removes only that external server, while a failed service-tools probe blocks the session.

## Verification

The deterministic suite covers per-server activation, session-kind filtering, template resolution, HTTP capability gating, missing configuration, service-scope rejection, manifest/cache redaction, and tool-name conflicts. Live probes remain opt-in and require the relevant endpoint and token:

```bash
npm run probe:market-data-tool
npm run probe:mcp-tool-call
npm run probe:mcp-qsse-tool-call
```

No deployment, production environment modification, database migration, Workspace template update, or QSSE infrastructure change is part of this registry contract.
