---
name: capability-extension
description: Use when a user asks the investment assistant to add, install, create, extend, customize, or automate a persistent capability, investment method, indicator, workflow, report, data source, scheduled task, integration, or tool. Classify what can be implemented inside the current Workspace and what requires service, MCP, scheduler, credential, or deployment changes; draft persistent Workspace changes for confirmation and turn system-owned gaps into explicit capability requests without claiming they are installed.
---

# Capability Extension

Treat the Workspace as an isolated customization layer, not as a service administration surface. Read `knowledge/capability_extension_protocol.md` before making a persistent extension.

## Classify The Request

Use exactly one of these outcomes:

1. `one_off_analysis`: Complete the request without creating a persistent capability.
2. `workspace_extension`: Implement only with files inside the current Workspace.
3. `supported_service_configuration`: Use an already exposed named MCP tool and its confirmation contract.
4. `system_capability_request`: Explain the missing system capability and produce an implementation request; do not implement or claim activation.

Workspace extensions may include:

- Investment methods, analysis instructions, report structures, and evidence rules.
- Codex skills under `.codex/skills/<name>/SKILL.md`.
- User-scoped configuration, schemas, templates, and pure local computation scripts.

System-owned capabilities include:

- MCP tools and MCP server configuration.
- New scheduler task types, background workers, push channels, or service timers.
- Service APIs, databases, durable service writes, permissions, confirmations, and audit enforcement.
- Credentials, secrets, paid providers, external integrations, and trusted data-source adapters.
- Runtime installation, package deployment, process restart, and cross-Workspace changes.

## Follow The Workflow

1. Inspect the current Workspace and named MCP tools before declaring a gap.
2. Prefer a one-off analysis when persistence is unnecessary.
3. Classify every proposed component. Split mixed requests into Workspace and system-owned parts.
4. For persistent Workspace changes, present a concise draft with affected files, data needs, risks, rollback, and acceptance checks.
5. Wait for explicit user confirmation before writing persistent Workspace files.
6. Implement only the confirmed Workspace portion. Never edit files outside the current Workspace.
7. Verify the artifact at the level actually implemented.
8. Record confirmed Workspace changes in `memory/change_log.jsonl`.

## Enforce Runtime Boundaries

- Do not edit `.codex/config.toml`, `mcp.json`, global Codex configuration, service repositories, databases, tokens, or process configuration.
- Do not use `config/skills.yaml` or a manifest as evidence that a Skill or tool is registered.
- Do not claim a script is an MCP tool. A script is only a Workspace implementation that the Agent may run in its sandbox.
- Do not claim a new automatic task exists after editing schedule text. Only task types already supported by the service scheduler can run.
- Do not bypass a missing named MCP tool with shell, localhost HTTP, hidden routes, direct database access, or guessed credentials.
- Do not claim an external data source is connected until a service-owned adapter exposes it with source and freshness metadata.

## Verify Truthfully

Use these acceptance standards:

- A Workspace Skill is active only when it is stored under `.codex/skills/<name>/SKILL.md` and discoverable by a new Codex session.
- A local script is usable only after a representative execution succeeds in the Workspace sandbox.
- An MCP tool is active only when the runtime exposes it in the session tool list and a scoped call succeeds.
- A scheduled capability is active only when the service recognizes its task type and an audited run succeeds.
- A durable write capability is active only when its named tool, confirmation policy, scope enforcement, and audit record all succeed.

When the last three standards cannot be met from the Workspace, return a `system_capability_request`. State that the Workspace portion is ready, if applicable, but the system portion is not yet active.
