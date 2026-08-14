# Portal Manual Testing

> Current as of 2026-07-26. The retired curated-library/delete acceptance is archived at `docs/archive/manual-testing/MANUAL_TESTING-2026-07-25.md`.

## Local Setup

```bash
npm run seed
npm run dev
npm run dev:mock
```

Open `http://127.0.0.1:3100/chat` and sign in with a seeded test account. For real connector testing, start the local `invest-agent-ideal` runtime and connector instead of relying on mock-only behavior.

## Core Chat

1. Unauthenticated `/chat` redirects to `/login`.
2. Valid login opens conversation history; invalid credentials fail without leaking account state.
3. New conversation, send, waiting state, assistant reply and refresh persistence work.
4. Slow, failed and offline connector states reach explicit UI states; offline disables sending while cached history remains readable.
5. Left sidebar collapse preserves new-chat, search and user-menu access. Conversation rows remain clearly separated and selected state is visible.

## Workspace And Preview

1. Initial chat load does not open the right rail.
2. The workspace folder control opens the right rail and tree; folders start collapsed rather than recursively expanded.
3. The tree contains only Markdown, HTML and supported images. Verify hidden/runtime paths such as `.git`, `.state`, `.trash`, `.env*`, SQLite, logs, build output, caches and `node_modules` are absent.
4. Markdown opens in a right-rail tab. HTML opens in the sandboxed HTML viewer.
5. PNG/JPEG/WebP/SVG from either a conversation or the workspace opens directly in the full-screen lightbox and never creates a document tab.
6. Repeated clicks on the same workspace file activate one existing tab; they do not create duplicates.
7. Closing the final tab leaves it closed. Wait through at least one assistant-status refresh and confirm the file does not reopen.
8. A conversation artifact with `workspacePath` expands its ancestor folders, scrolls to and highlights the matching file.
9. A conversation-only artifact opens without expanding or changing the workspace tree.
10. Collapse and reopen the workspace tree. Its folder control moves between the tree header and document header, and the tree changes document width rather than floating above it.
11. Drag the right divider and verify the layout stays stable at desktop widths. The first-open chat-to-right-rail allocation is approximately `1:1.2`.
12. No workspace item exposes edit, rename, move or delete controls. Legacy artifact delete API routes return `405`.

## HTTP Production Compatibility

Run the same preview checks against `http://118.145.115.197:22649` after deployment:

- Markdown/HTML loads or reaches a visible retryable error.
- Every image type, including SVG, opens in the lightbox.
- Attachment and artifact checksum validation succeeds without `crypto.subtle`.
- No view remains indefinitely on “加载制品中...”.

## Automated Baseline

```bash
npm run typecheck
npm test
npm run build
git diff --check
```

After production deployment also verify:

```bash
curl -fsS http://127.0.0.1:22649/api/health
curl -sS -o /dev/null -w '%{http_code}\n' http://118.145.115.197:22649/login
pm2 describe invest-agent-portal
```
