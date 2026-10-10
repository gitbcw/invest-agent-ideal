# User Portal Current Contract

> Status: current as of 2026-10-06

## Ownership And Runtime

The user Portal is `apps/portal` in this repository. It owns authentication, the cloud conversation mirror, browser UI and Relay. This repository also owns the Mastra runtime, local canonical conversation log, connector and SQLite/service state.

The active production Portal is served by `mastra-portal` on the 23657/23658 deployment. The legacy `22649` Portal endpoint is no longer the production target. Fixed public IP plus HTTP remains the compatibility baseline because no filed domain is available. Preview, download, attachment reads and checksum verification must work without secure-context-only APIs such as `crypto.subtle`.

## Document Preview Rail

The right rail is a multi-tab preview area for conversation artifacts. The former workspace file tree was removed (2026-10-08 用户裁决); the connector no longer serves `workspace.file.list` / `workspace.file.get`.

- The browser reads artifact bytes only through `artifact.get` / `attachment.get`; it cannot supply `userId`, `instanceId`, workspace root, glob or arbitrary filesystem path.
- Markdown and sandboxed static HTML open in deduplicated right-rail tabs. Images, including SVG, open directly in the full-screen lightbox and never create a document tab.
- Artifact-open requests are one-shot events. Closing the last tab cannot replay a stale request and reopen the file.
- On narrow screens the preview rail opens as a full-screen surface.
- The web UI cannot edit, rename, move or delete workspace files. Users request file changes through the AI conversation.

The read-only Portal boundary is not an AI filesystem security boundary. Codex ACP currently runs with workspace write access. The remaining file-level write allowlist work is tracked in [23-multi-user-sandbox-design.md](./23-multi-user-sandbox-design.md).

## Layout And Interaction

- Chat opens without the right rail. Clicking a supported conversation file/image opens the relevant view.
- The right rail is resizable. Its initial chat-to-rail allocation is approximately `1:1.2`; the user's drag choice wins for the session.
- Tabs deduplicate by `artifactId`.

## Protocol And Lifecycle

Standalone webpage reports explicitly requested by a user are stored under `reports/html/` and published in the same Agent turn. They are permanent `durable_library` assets when they satisfy the existing MIME and 1 MiB limits. Existing semantic reports remain under their daily, weekly, monthly or company directories regardless of whether their rendering format is Markdown or HTML.

The historical `artifact.library.list` and `artifact.delete.prepare/confirm` commands no longer define the Portal file browser. The connector does not advertise deletion capabilities, and legacy Portal delete routes return `405`. Artifact retention, attachment expiry and hidden trash remain runtime lifecycle concerns; they do not grant browser-side file management.

Exact envelope types, errors and command schemas are in [user-portal-protocol.md](./user-portal-protocol.md). Production deployment and health checks are in `.codex/skills/volcano-ops/references/server-deployment.md`.

## Verification

For Portal UI changes, run in `apps/portal`:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

Deploy only through the repository Portal deployment script. It preserves production `.env`, `data/`, databases and other runtime assets. After deployment, verify `/api/health`, the public HTTP login page, the `mastra-portal` PM2 process and fresh error logs.
