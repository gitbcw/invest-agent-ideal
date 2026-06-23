# Service And Skill Boundary

> Created: 2026-06-01

## Core View

All intelligent messages should enter Codex through ACP.

`invest-agent` should still run as a local service, but it should not be the agent brain. Its role is to provide deterministic capabilities that Codex can call through skills and local HTTP APIs.

## Why A Service Still Exists

The service is still needed because some responsibilities are stateful, visual, or time-based:

- Dashboard GUI.
- WeChat connection page and listener lifecycle.
- Persistent SQLite database.
- Intraday scheduler.
- Alert push and fallback queue.
- Market data fetching.
- Capital flow fetching.
- Manual diagnostic endpoints.

These are not good fits for pure skill files because they require a long-running process, stable network endpoints, and background jobs.

## Why Skills Become The Main Capability Surface

Most user-facing capabilities should be represented as skills because skills are easier to inspect and evolve:

- Review workflow.
- Screening QA workflow.
- How to call service APIs.
- How to interpret deterministic results.
- What needs confirmation before mutation.
- Anti-hallucination and investment language rules.

The skill is not necessarily the whole implementation. A skill can be an operating manual that calls a program or service.

## Target Architecture

```text
User / WeChat
  -> invest-agent WeChat listener
  -> service-owned codex-acp over ACP stdio
  -> Codex
  -> project AGENTS.md + .codex/skills
  -> local invest-agent service APIs
  -> SQLite / scheduler / dashboard / push
```

## Classification

| Capability | Best Home | Reason |
| :--- | :--- | :--- |
| WeChat login GUI | Service | Needs browser UI, persisted token, listener lifecycle |
| Dashboard | Service | Needs web UI and live data |
| Intraday inspection | Service | Needs background scheduler |
| Alert push | Service | Needs active connection and queue |
| Holdings/watchlist CRUD | Service API + Skill | Deterministic mutation, but Codex should decide when/how |
| Review generation | Skill + Service data | Reasoning belongs in skill; data and persistence belong in service |
| Screening QA | Skill + optional Service API | Reasoning belongs in skill; watchlist mutation belongs in service |
| Market data | Service API | Deterministic external data fetch |
| Signal parameter tuning | Skill + Service API | Codex interprets feedback; service persists config |

## Implementation Direction

1. Keep `invest-agent` running as the local tool service.
2. Keep `/dashboard` and `/api/dashboard`.
3. Add clean HTTP endpoints for any handler currently only reachable through old Runtime functions.
4. Let `.codex/skills/invest-agent-service-tools` document how Codex calls those endpoints.
5. Keep the old self-built Agent Runtime deleted; add service APIs only for deterministic capabilities that skills need repeatedly.

## Important Distinction

"Everything becomes a skill" does not mean every program disappears.

It means every capability should have a skill-level interface for Codex:

- The skill says when to use it.
- The skill says what program/API to call.
- The service/program performs deterministic work.
- Codex explains the result and handles follow-up reasoning.

## Next Gaps

- Some deterministic handlers still need clean HTTP endpoints.
- Tool/API schemas should be made more formal so skills can call the service reliably.
- Old Runtime code has been deleted; remaining old Runtime docs should stay clearly marked as historical references.
