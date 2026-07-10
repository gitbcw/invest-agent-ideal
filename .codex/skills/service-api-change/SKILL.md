---
name: service-api-change
description: Use when adding or changing Invest Agent service APIs, sandbox endpoints, portal endpoints, MCP service tools, Dashboard/Platform routes, or deterministic capabilities that workspace skills or Codex ACP will call.
---

# Service API Change

Use this skill when the task changes deterministic service capabilities rather than investment reasoning style.

## Boundary

- Service owns deterministic execution: SQLite, market data, scheduler, push, sandbox audit, confirmations, portal connector, Dashboard/Platform APIs, and MCP tools.
- Workspace skills own investment judgment: when to call APIs, how to interpret results, cautious language, and confirmation discipline.
- Do not reintroduce service-level triage, fast-lane classification, onboarding short-circuiting, review intent detection, or context-packet wrapping for normal WeChat messages.

## Read First

- `AGENTS.md` for service/skill boundary and runtime red lines.
- `CLAUDE.md` for current API inventory and key files.
- `docs/system-overview.md` for ownership boundaries.
- `docs/service-tools-mcp.md` when adding or changing MCP service tools.
- `docs/23-multi-user-sandbox-design.md` when permissions, sandbox token, audit, or workspace isolation are involved.
- `docs/user-portal-protocol.md` when changing portal connector protocol.

## Implementation Workflow

1. State the deterministic capability and caller: workspace ACP, MCP tool, sandbox HTTP, portal connector, Dashboard/Platform, or scheduler.
2. Check whether an existing endpoint/tool can be extended safely instead of adding a parallel path.
3. Define request/response schema, permission boundary, audit behavior, and error shape.
4. Implement in the narrowest layer:
   - routes under `src/routes/*` for HTTP surfaces;
   - services under `src/services/*` or `src/lib/*` for shared deterministic logic;
   - MCP tools under `src/mcp/*` when Codex ACP needs stable tool access;
   - scripts under `scripts/*` for smoke/contract validation.
5. Update workspace prompts or skills only if the caller needs new usage instructions.
6. Add or update a smoke/contract test for the API path.
7. Run `npm run build` and the smallest relevant smoke.
8. Update current docs only when the API becomes a durable contract.

## API Checklist

- Scope: `userId`, `instanceId`, `projectId`, and workspace path resolution are explicit and consistent.
- Permissions: sandbox or MCP writes require the right permission and audit.
- Confirmation: user-facing writes that change durable investment state use confirmation workflows.
- Data source: market facts include source, fetched time, confidence, and warnings when applicable.
- Customer output: API paths, curl, localhost, tokens, and internal implementation details do not leak to user replies.
- Multi-user safety: no primary-user shortcuts in new code unless explicitly documented as test-only.

## Verification Map

Choose by changed surface:

```bash
npm run build
npm run smoke:mcp-service-tools
npm run smoke:onboarding-confirm-step
npm run smoke:portal-conversation-log
npm run smoke:portal-attachment
npm run smoke:stage2-watch-rules
npm run smoke:customer-output
```

If the API changes user-visible behavior, inspect the smallest real interaction and its audit evidence with `invest-eval`; only add deterministic contracts for stable service behavior.

## Review Questions

- Is this capability deterministic enough to belong in service code?
- Did we avoid duplicating product semantics already owned by skills?
- Can a future Agent discover how to call it without reading implementation details?
- Does the verification prove both success path and boundary behavior?
