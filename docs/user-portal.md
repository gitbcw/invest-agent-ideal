# User Portal Current Contract

> Status: current as of 2026-07-26

## Ownership And Runtime

The user Portal is the separate `invest-agent-portal` Next.js application. It owns authentication, the cloud conversation mirror, browser UI and Relay. This repository owns the local canonical conversation log, workspace-scoped ACP execution, connector, SQLite and the user workspace.

The production Portal is `http://118.145.115.197:22649`. Fixed public IP plus HTTP is a required compatibility baseline because no filed domain is available. Preview, download, attachment reads and checksum verification must work without secure-context-only APIs such as `crypto.subtle`.

## Workspace Browser

The right rail is a read-only view of the authenticated user's workspace, not the former curated artifact library.

- The connector advertises `workspace.file.list` and `workspace.file.get`.
- The browser cannot supply `userId`, `instanceId`, workspace root, glob or arbitrary filesystem path.
- The runtime lists only Markdown, HTML and supported images. It excludes credentials, hidden/runtime directories, SQLite, logs, build output, caches, temporary files and symlinks.
- Markdown and sandboxed static HTML open in deduplicated right-rail tabs. Images, including SVG, open directly in the full-screen lightbox and never create a document tab.
- Opening a conversation artifact with a verified `workspacePath` expands ancestor folders, selects and reveals the matching file. A conversation-only artifact leaves the workspace tree state unchanged.
- Opening the workspace, opening a path-bearing artifact, completing an assistant turn, or using the refresh control reloads the tree without discarding open tabs or preview scroll state.
- Artifact-open requests are one-shot events. Closing the last tab cannot replay a stale request and reopen the file.
- On narrow screens the workspace opens as a full-screen surface and the file tree behaves as a collapsible drawer.
- The web UI cannot edit, rename, move or delete workspace files. Users request file changes through the AI conversation.

The read-only Portal boundary is not an AI filesystem security boundary. Codex ACP currently runs with workspace write access. The remaining file-level write allowlist work is tracked in [23-multi-user-sandbox-design.md](./23-multi-user-sandbox-design.md).

## Layout And Interaction

- Chat opens without the right rail. Clicking a supported conversation file/image or the workspace folder control opens the relevant view.
- The right rail is resizable. Its initial chat-to-rail allocation is approximately `1:1.2`; the user's drag choice wins for the session.
- The workspace tree is an in-flow column, so expanding or collapsing it changes document-view width. It is not a floating overlay.
- The workspace folder control sits in the tree header while expanded and in the document header while collapsed.
- Tabs deduplicate by `workspacePath`, falling back to `artifactId` for conversation-only files.

## Protocol And Lifecycle

Conversation artifact descriptors may include an optional workspace-relative `workspacePath`. It is emitted only for Markdown, HTML and image artifacts that are eligible for Portal workspace browsing; conversation-only YAML/config artifacts are read through the scoped artifact channel. Existing descriptors without the field remain valid.

Standalone webpage reports explicitly requested by a user are stored under `reports/html/` and published in the same Agent turn. They are permanent `durable_library` assets when they satisfy the existing MIME and 1 MiB limits. Existing semantic reports remain under their daily, weekly, monthly or company directories regardless of whether their rendering format is Markdown or HTML.

The historical `artifact.library.list` and `artifact.delete.prepare/confirm` commands no longer define the Portal file browser. The connector does not advertise deletion capabilities, and legacy Portal delete routes return `405`. Artifact retention, attachment expiry and hidden trash remain runtime lifecycle concerns; they do not grant browser-side file management.

Exact envelope types, errors and command schemas are in [user-portal-protocol.md](./user-portal-protocol.md). Production deployment and health checks are in `.codex/skills/volcano-ops/references/server-deployment.md`.

## Verification

For Portal UI changes, run in `invest-agent-portal`:

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

Deploy only through the Portal code deployment script. It preserves production `.env`, `data/`, databases and other runtime assets. After deployment, verify `/api/health`, the public HTTP login page, the `invest-agent-portal` PM2 process and fresh error logs.
