# User Portal Protocol

> Status: current Portal-side contract as of 2026-07-26
> Protocol version: `2026-07-04`

The runtime-side canonical protocol is maintained in `invest-agent-ideal/docs/user-portal-protocol.md`. The TypeScript schemas under `src/lib/protocol/` are authoritative for this application. This document explains the commands and security boundaries a Portal developer needs most often.

## Transport And Scope

- Browser requests use the Portal's authenticated HTTP API.
- The local `invest-agent` connector initiates a WebSocket connection to Relay.
- Every command uses a versioned envelope with a stable `requestId`.
- Relay routes one assistant to one active connector and rejects connector conflicts.
- The authenticated session and registered connector inject `userId`, `assistantId`, `instanceId` and `projectId`. File APIs never accept scope or workspace roots from the browser.
- Connector tokens never reach browser code.

The production Volcano deployment intentionally uses `http://118.145.115.197:22649` and a same-host `ws://127.0.0.1:22650/` connector path. HTTP is a required compatibility baseline because no filed domain is available. Browser code must not require `crypto.subtle` or any other secure-context-only API.

## Capabilities

The current connector capability surface is:

```ts
type ConnectorCapability =
  | "conversation.chat"
  | "conversation.cancel"
  | "conversation.list"
  | "conversation.get"
  | "conversation.sync"
  | "conversation.attachments"
  | "report.asset.get"
  | "artifact.get"
  | "artifact.event"
  | "artifact.publish.legacy"
  | "dashboard.snapshot"
  | "attachment.get"
  | "artifact.library.list" // historical mock/schema compatibility only
  | "workspace.file.list"
  | "workspace.file.get"
  | "automation.list"
  | "automation.get"
  | "automation.create"
  | "automation.update"
  | "automation.activate"
  | "automation.pause"
  | "automation.run_now"
  | "automation.runs.list"
  | "automation.run.get"
  | "automation.asset.get"
  | "automation.continue_in_chat";
```

The real connector no longer advertises `artifact.library.list` or `artifact.delete.prepare/confirm`. `artifact.library.list` remains in the Portal schema and mock fixtures only for historical compatibility; current UI does not use it. Legacy delete API routes return `405` and must not be re-enabled as workspace file operations.

## Conversations

`conversation.list`, `conversation.get`, `conversation.chat` and `conversation.sync` mirror user-visible conversations between the Portal database and the runtime's canonical `conversation_sessions` / `conversation_messages` log.

- `conversation.chat` requires a stable `conversationId`, `userMessageId` and idempotency key.
- Text and attachments cannot both be empty.
- The runtime writes the user message, invokes the workspace ACP, writes the assistant reply and returns the completed messages.
- The cloud mirror upserts by stable message ID and never invents messages absent from the canonical log.
- Opening a conversation reconciles every `conversation.get` page from cursor `0` before serving the mirror. An existing partial mirror must not short-circuit runtime synchronization.
- Browser history loading consumes the Portal message `nextCursor` until completion. Message pagination uses the stable `(createdAt, messageId)` order so equal timestamps cannot skip or duplicate records.
- Connector offline state disables sending but does not prevent reading the cloud mirror.
- One assistant may run two independent `conversation.chat` tasks concurrently.
  A third request returns retryable `CONCURRENT_TASK_LIMIT`; turns in the same
  `conversationId` remain serialized.

### Cancelling A Conversation

`conversation.cancel` is an additive authenticated command for stopping the
active turn in one conversation. The Portal route is
`POST /api/conversations/:id/cancel`; it verifies the local mirror belongs to
the session's complete `(userId, assistantId, instanceId)` scope and is not
deleted before forwarding the command.

The connector payload is deliberately ID-only:

```ts
interface ConversationCancelRequest {
  conversationId: string;
}

interface ConversationCancelResult {
  conversationId: string;
  status: "cancelled" | "no_active";
}
```

`userId`, `assistantId`, `instanceId` and `projectId` are taken from the
registered connector scope, never from browser input. `no_active` is an
idempotent success response. The Portal does not mutate its processing mirror
or transcript on the cancel response; it polls `conversation.get` until the
runtime publishes the terminal assistant result. A cancelled chat is returned
as an assistant `failed` message with cancellation metadata, and a late ACP
success must not be published.

## Artifact Descriptors

Assistant message metadata can include artifact descriptors:

```ts
interface ArtifactDescriptor {
  artifactId: string;
  title: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: "report" | "chart" | "table" | "document";
  previewMode: "markdown" | "html" | "image" | "pdf" | "text" | "table" | "unsupported";
  createdAt: string;
  checksum?: string;
  workspacePath?: string;
}
```

`workspacePath` is optional and workspace-relative. The runtime emits it only when the artifact is backed by a Portal-browsable Markdown, HTML or image file. It never contains an absolute server path.

- Images, including SVG, open in the full-screen lightbox.
- Markdown and safe HTML open in right-rail tabs.
- A descriptor with `workspacePath` reveals and selects the matching workspace tree item.
- A conversation-only descriptor leaves the workspace tree state unchanged.
- Tabs deduplicate by `workspacePath`, falling back to `artifactId`.

Artifact open commands are one-shot UI requests. Once the workspace consumes a request, the parent clears it; closing the last tab therefore cannot replay and reopen a stale artifact.

## Workspace File List And Get

`workspace.file.list` takes no browser-supplied path, glob, filter or scope. It returns a flat list that the Portal groups into a directory tree:

```ts
interface WorkspaceFileItem {
  fileId: string;
  relativePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  updatedAt: string;
  previewMode: "markdown" | "html" | "image" | "pdf" | "text" | "table" | "unsupported";
  downloadable: boolean;
}

interface WorkspaceFileListResult {
  items: WorkspaceFileItem[];
}
```

`workspace.file.get` accepts only a listed safe relative path and returns the same descriptor plus `base64` and `checksum`.

## Automation tasks

The Portal exposes automation task management under authenticated `/api/automations/*` routes. Browser requests contain only task/run/asset ids and task fields; `userId`, `instanceId` and `projectId` are never accepted from the browser and are injected by the registered connector scope. The Portal forwards the following connector commands: `automation.list`, `automation.get`, `automation.create`, `automation.update`, `automation.activate`, `automation.pause`, `automation.run_now`, `automation.runs.list`, `automation.run.get`, `automation.asset.get` and `automation.continue_in_chat`.

The `/automations` page is reachable from the Chat sidebar. It supports CSV/XLSX upload, immutable revision edits, pause/activate, real run-now navigation to the returned conversation, run history/details, task asset downloads and explicit continue-in-chat navigation. Responses redact connector scope columns before reaching browser code.

Runtime enforcement:

- Allow only Markdown, HTML and supported image extensions for the current Portal tree.
- Reject absolute paths, empty/dot segments, traversal, symlinks and realpath escapes.
- Exclude credentials, `.env*`, SQLite, logs, `.git`, `.state`, `.trash`, `node_modules`, build/cache/temp directories and other runtime internals.
- Never return an absolute path or a workspace root.
- Enforce file count and file size limits before returning bytes.

Portal enforcement:

- Viewing and downloading are allowed.
- Editing, renaming, moving and deleting are not exposed.
- Markdown/HTML opens in a tab; images open in the lightbox and do not create tabs.
- All checksum paths must work over non-secure HTTP.
- Every asynchronous read reaches success or a visible retryable error; it must not remain at “加载制品中...” indefinitely.

## Attachment Get

User uploads are addressed only by opaque `attachmentId`. `attachment.get` returns either active bytes and authoritative `expiresAt`, or an expired/deleted/not-found state. The browser never submits or receives the local stored path. Image attachments use the lightbox; other attachments use the supported download path.

## Errors

Protocol errors are returned in the standard envelope with `code`, user-safe `message`, `retryable` and optional safe details. Workspace-specific codes include:

- `WORKSPACE_FILE_INVALID_PATH` -> HTTP 400
- `WORKSPACE_FILE_NOT_FOUND` -> HTTP 404
- `WORKSPACE_FILE_FORBIDDEN` -> HTTP 403
- `WORKSPACE_FILE_TOO_LARGE` -> HTTP 413
- `WORKSPACE_FILE_LIMIT_EXCEEDED` -> HTTP 413

Error details must never reveal absolute paths, tokens, secrets or another user's identifiers.

## Versioning

Breaking envelope or command-shape changes require a new protocol version. Additive optional fields such as `workspacePath` remain backward compatible: older clients ignore them, and current clients accept their absence.
