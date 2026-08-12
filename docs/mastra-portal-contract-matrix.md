# Mastra Runtime / Portal Contract Matrix

Portal source of truth inspected: `/Users/combo/MyFile/projects/invest-agent-portal` at its current local checkout. Runtime connector inspected: `src/portal/connector.ts` on `feat/mastra-migration`.

## Version and transport

| Area | Portal expectation | Migration runtime | Status |
| --- | --- | --- | --- |
| Current protocol | Portal document states `2026-07-04`; TypeScript schemas are authoritative | `2026-08-05`, with negotiated legacy `2026-07-04` | `expected`: runtime is additive and retains legacy negotiation; Portal document header is stale |
| Scope | Relay registration owns user/assistant/instance/project; browser cannot override | Connector rejects declared scope fields and injects registered scope | `equivalent` |
| Concurrency | Two independent chats per assistant; third is retryable; same conversation serialized | `ConcurrentTaskLimiter` plus per-conversation lock | `equivalent`, automated tests already cover limiter/serialization |

## User-visible capabilities

| Domain | Required by Portal | Migration runtime | Status |
| --- | --- | --- | --- |
| Conversation | chat, cancel, list, get, sync, attachments | Advertised and implemented | `equivalent` |
| Cancellation | ID-only request; `cancelled`/`no_active`; terminal failed message; late success suppressed | Implemented with Mastra cancellation and restart recovery | `equivalent` |
| Reports/artifacts | report read/mapping, artifact read/event, safe previews | Implemented; runtime also retains legacy publication/library compatibility | `equivalent` for current UI; legacy capabilities require later removal decision |
| Attachments | opaque id, expiry/deleted/not-found state, no local path | Implemented through retention service | `equivalent` |
| Workspace browser | safe relative file list/get | Implemented, but conflicts with the long-term no-Workspace direction | `pending-decision`: replace UI source with asset store before removing Workspace |
| Automation | list/get/create/update/activate/pause/run/runs/detail/asset/continue | Implemented; runtime additionally supports batch action and legacy migration | `equivalent` for current UI; additive runtime capabilities |
| User assets | Portal UI contains current asset library flows | Runtime advertises full asset/folder/version lifecycle | `equivalent` at connector surface; requires shared fixture execution |

## Errors and terminal behavior

| Contract | Status | Note |
| --- | --- | --- |
| Standard envelope with code/message/retryable | `equivalent` | Runtime preserves versioned response envelope. |
| Runtime catch-all | `changed-expected` | Migration runtime emits `AGENT_RUNTIME_FAILED`; any Portal mapping that recognizes only `ACP_FAILED` must be updated during same-repo import. |
| Scope/secret errors | `equivalent` | Absolute paths, tokens and foreign scope are not returned. |
| Long task/cancel polling | `equivalent` | Portal polls canonical conversation log; runtime publishes terminal result. |

## Known work before same-repo import

1. Generate one shared capability fixture from `packages/protocol` rather than maintaining independent unions and documentation.
2. Run Portal `tests/portal-contract.test.ts`, automation, attachment, conversation-processing and browser acceptance against the 23655 connector.
3. Decide replacements for `workspace.file.list/get`; the target is asset-store browsing, not preserving Workspace as runtime state.
4. Update Portal error mapping for `AGENT_RUNTIME_FAILED` while retaining temporary recognition of `ACP_FAILED` for the old production connector.
5. Resolve the stale Portal protocol document header against its authoritative TypeScript constant before moving code.

Unclassified domains: **0**. Pending decisions are explicitly listed above and block source movement, not current 23655 runtime testing.
