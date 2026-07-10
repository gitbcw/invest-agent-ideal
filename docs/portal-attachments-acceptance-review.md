## Acceptance Verdict

Status: Pass with caveats

As of 2026-07-06, the local runtime and adjacent cloud portal portions of `docs/portal-attachments-implementation-brief.md` are now substantially implemented. The local runtime accepts portal attachments, validates and stores them under the workspace, records public metadata without absolute paths, passes stored attachments to ACP, and coalesces in-flight idempotent retries. The cloud portal now accepts attachment payloads, forwards them through `conversation.chat`, exposes attachment protocol types/capability, supports file selection/drag-drop/chips in the composer, and renders historical attachment metadata in message bubbles. Build/typecheck and the attachment smoke checks pass. Remaining caveats are narrower test coverage for full in-flight retry and negative route-level attachment cases.

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Attachment store | Support portal image/document input with base64/download URL, limits, allowed MIME/extensions, and magic-byte checks. | Pass | `src/lib/attachment-store.ts:5`, `src/lib/attachment-store.ts:45`, `src/lib/attachment-store.ts:146`, `src/lib/attachment-store.ts:230`; `node scripts/attachment-store-smoke.mjs` passed. | Covers PNG/JPEG/WEBP, PDF, Office, HTML/MD/TXT validation and rejects unsupported/binary text in smoke. |
| WeChat regression | Preserve `storeWeixinAttachment()` image behavior. | Pass | `src/lib/attachment-store.ts:87`; `node scripts/attachment-store-smoke.mjs` passed. | Smoke includes WeChat image and non-image rejection. |
| Portal HTTP API | `POST /api/portal/conversations/:conversationId/messages` accepts `text` or `attachments`; health advertises attachment capability. | Pass | `src/routes/portal.ts:45`, `src/routes/portal.ts:98`, `src/routes/portal.ts:111`. | Attachment errors are converted to 400 responses with specific codes. |
| Connector protocol | `conversation.chat` forwards attachments; connector registers `conversation.attachments`. | Pass | `src/portal/connector.ts:136`, `src/portal/connector.ts:140`, `src/portal/connector.ts:229`; `docs/user-portal-protocol.md`. | Connector catches `AttachmentStoreError` and returns an error instead of a fake assistant reply. |
| Conversation log | Store public attachment metadata and pass stored attachments to ACP. | Pass | `src/services/conversation-log.ts:477`, `src/services/conversation-log.ts:482`, `src/services/conversation-log.ts:500`; `node scripts/portal-attachment-smoke.mjs` passed. | Public metadata is produced via `toPublicAttachmentMetadata()`, which omits absolute `path`. |
| Attachment-only messages | Generate a reasonable internal user text when only attachments are sent. | Pass | `src/services/conversation-log.ts:481`, `src/services/conversation-log.ts:548`. | Covers image-only, document-only, and mixed attachment-only cases. |
| ACP prompt | Include internal `localPath` for ACP and instruct not to expose it to the user. | Pass | `src/acp/agent.ts:169`, `src/acp/agent.ts:180`, `src/acp/agent.ts:188`. | This satisfies the local ACP injection requirement; final response sanitization is instruction-based rather than deterministic. |
| No absolute path in public metadata | API/log metadata should not expose `path`. | Pass | `src/lib/attachment-store.ts:181`; `node scripts/portal-attachment-smoke.mjs` passed. | Smoke asserts `metadata.attachments[0]` has no `path`. |
| Unsupported/invalid inputs | Reject unsupported MIME/type and disguised binary text. | Pass | `src/lib/attachment-store.ts:260`; `node scripts/attachment-store-smoke.mjs` passed. | Smoke does not yet include every oversized/count/base64 case, but code paths exist. |
| Full idempotent retry | Same `idempotencyKey` retry must not duplicate user message, attachments, or assistant response. | Pass with caveat | `src/services/conversation-log.ts` now uses an in-flight `pendingPortalChats` map; `npm run build` passed. | Code now coalesces concurrent/fast retries before attachment storage and ACP invocation. A dedicated concurrency smoke is still recommended. |
| Tests/smoke | Build and attachment smoke checks should pass. | Pass with caveat | `npm run build`, `node scripts/attachment-store-smoke.mjs`, `node scripts/portal-attachment-smoke.mjs`, portal `npm run typecheck`, and portal `npm run build` all passed. | Missing direct smoke for full chat idempotency, oversize request, too many files, invalid base64, and route-level 400 behavior. |
| Cloud portal API | Browser API should accept `text` or `attachments`, forward attachments to connector, and preserve safe metadata. | Pass | `/Users/combo/MyFile/projects/invest-agent-portal/src/app/api/conversations/[id]/messages/route.ts`. | Schema now accepts optional text plus attachments, validates cloud-side limits, forwards attachments, and stores pending public metadata. |
| Cloud portal protocol types | Portal protocol should include `conversation.attachments` capability and `attachments` in `ConversationChatRequest`. | Pass | `/Users/combo/MyFile/projects/invest-agent-portal/src/lib/protocol/types.ts`; `/Users/combo/MyFile/projects/invest-agent-portal/user-portal-protocol.md`. | Types and protocol doc now include attachment schema and capability. |
| Cloud portal UI | File picker/drag-drop/chips/thumbnails/error states/history cards. | Pass with caveat | `/Users/combo/MyFile/projects/invest-agent-portal/src/components/chat/MessageComposer.tsx`; `/Users/combo/MyFile/projects/invest-agent-portal/src/components/chat/MessageBubble.tsx`. | Supports file selection, drag/drop, pre-send chips, removal, local image previews, validation errors, and historical attachment cards. No browser screenshot was captured in this pass. |
| Cloud mirror | Save/display safe attachment metadata in cloud mirror. | Pass | `/Users/combo/MyFile/projects/invest-agent-portal/src/lib/db/conversations.ts`; `/Users/combo/MyFile/projects/invest-agent-portal/src/components/chat/types.ts`; `/Users/combo/MyFile/projects/invest-agent-portal/src/components/chat/MessageBubble.tsx`. | Mirror already stores `metadata_json`; chat view now preserves and renders `metadata.attachments` without local absolute paths. |

## Findings

- [Low] Dedicated smoke coverage is still narrower than the brief's suggested acceptance set: there are passing smokes for storage, public metadata, basic portal metadata, unsupported MIME, disguised binary text, and append-level idempotency, but not for full in-flight `chatViaConversationLog()` retry, route-level oversize, too-many-files, or invalid base64.
- [Low] Cloud portal UI passed production build, but this review did not include a Playwright/browser screenshot pass for drag/drop and thumbnail rendering.

## Verification Performed

- `npm run build`: passed.
- `node scripts/attachment-store-smoke.mjs`: passed.
- `node scripts/portal-attachment-smoke.mjs`: passed.
- `/Users/combo/MyFile/projects/invest-agent-portal`: `npm run typecheck` passed.
- `/Users/combo/MyFile/projects/invest-agent-portal`: `npm run build` passed.
- Inspected `src/lib/attachment-store.ts`, `src/services/conversation-log.ts`, `src/routes/portal.ts`, `src/portal/connector.ts`, `src/acp/agent.ts`, `docs/user-portal-protocol.md`, and `docs/user-portal-goal-and-acceptance.md`.
- Inspected adjacent portal repository `/Users/combo/MyFile/projects/invest-agent-portal`, including `src/app/api/conversations/[id]/messages/route.ts`, `src/components/chat/MessageComposer.tsx`, `src/components/chat/api.ts`, `src/components/chat/MessageBubble.tsx`, `src/components/chat/types.ts`, `src/lib/protocol/types.ts`, and `src/lib/db/conversations.ts`.

## Follow-Up Checklist

- [x] Make `chatViaConversationLog()` idempotency cover in-flight retries before saving attachments or calling ACP again.
- [ ] Add a full `chatViaConversationLog()` or route-level smoke for idempotent retry with attachments.
- [ ] Add negative smokes for invalid base64, too many files, total size too large, and single file too large.
- [x] Implement cloud portal API/types forwarding for `attachments`.
- [x] Implement cloud portal composer file selection, drag/drop, preview chips/cards, size/type validation, and send-state behavior.
- [x] Render historical `metadata.attachments` in cloud portal message bubbles without exposing local absolute paths.
