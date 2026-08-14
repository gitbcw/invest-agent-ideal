# Invest Agent Portal Agent Guide

## Repository Role

This repository is the cloud user Portal: Next.js UI/API, authentication, SQLite conversation mirror, WebSocket Relay and mock connector. The sibling `invest-agent-ideal` runtime owns canonical conversations, workspace ACP execution, local SQLite, user workspaces and the real connector.

Do not import runtime internals or turn Portal into a second investment runtime. Browser requests must use authenticated Portal APIs and structured connector commands.

## Current Product Contract

- Production must support fixed public IP plus HTTP at `http://118.145.115.197:22649`; no filed domain is available. Do not require HTTPS or secure-context-only APIs.
- The right workspace rail is read-only. It uses `workspace.file.list/get` and exposes only Markdown, HTML and supported images.
- Images, including SVG, open in the full-screen lightbox. Markdown and safe HTML open in deduplicated right-rail tabs.
- A conversation artifact reveals the tree only when it carries a verified `workspacePath`. Conversation-only files and images must not alter the tree state.
- The web UI cannot edit, rename, move or delete workspace files. Users request file changes through the AI conversation.
- Browser read-only access is not the AI filesystem boundary. Runtime write controls belong to `invest-agent-ideal`.
- The right rail starts closed, remains resizable, and must preserve deliberate tree/tab state. Artifact-open state is a one-shot request, not persistent selected-file state.

## Engineering Rules

- Prefer existing protocol schemas in `src/lib/protocol/` and chat helpers over parallel contracts.
- Never expose connector tokens, absolute paths, workspace roots or cross-user scope fields.
- Keep asynchronous preview/download flows terminal: success or visible error/retry, never permanent loading.
- Preserve remote `.env`, `data/`, databases and logs during ordinary deployment.
- Keep historical plans and completed acceptance records under `docs/archive/`; current operational facts belong in `README.md`, `user-portal-protocol.md` and `docs/production-runbook.md`.

## Verification

For normal changes run:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

Local development uses `npm run dev` on `http://127.0.0.1:3100` plus `npm run dev:mock` or the real local connector. Production code deployment uses `npm run deploy:volcano`, followed by `/api/health`, public HTTP login, PM2 and fresh error-log checks.

Production deployment does not authorize a Git push or data migration. Do not replace production Portal data or runtime workspaces as part of a code release.
