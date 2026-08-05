# Automation Task Interaction Design Acceptance Review

Review date: 2026-08-05 (Asia/Shanghai)
Review basis: [automation-task-interaction-design.md](./automation-task-interaction-design.md)
Execution log: [automation-task-interaction-design_execution_log.md](./automation-task-interaction-design_execution_log.md)

## Acceptance Verdict

Status: **Pass with caveats**

The service-side automation task capability is implemented and independently verified. Task definitions, immutable revisions, task-owned source/working assets, scoped Portal commands, manual-run conversations, scheduled-run history, idempotent claims, failure attention state, and attachment-retention isolation all have code and deterministic test evidence. The existing review/market-watch/rule scheduler contract remains separate and the full repository test suite passes.

The remaining caveats are bounded: this repository contains the local connector/service contract rather than the Cloud Portal UI; a live ACP provider run was not performed in this local review; CSV/XLSX extension and binary/path checks exist, but a dedicated structured spreadsheet engine/feature validator is not yet implemented; and each run keeps a verified reference to the mutable working asset plus checksum rather than a separate immutable output snapshot.

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Persistence | Create a paused daily file-maintenance task with task, revision, assets, and full `userId + instanceId + projectId` scope | Pass | `src/db/schema.ts`, `src/db/index.ts`, `src/services/automation-tasks.ts`; `tests/automation-tasks.test.ts` | Uses new `automation_*` tables and does not repurpose `scheduled_task_runs`. |
| Revisioning | Task edits append an immutable revision and pause the new version | Pass | `updateAutomationTask`; test “updates task definition by appending a revision…” | `expectedRevision` conflict protection is covered. |
| Schedule | Daily, weekdays, weekly, timezone validation, `next_run_at`, and reactivation behavior | Pass | `normalizeAutomationSchedule`, `nextAutomationRunAt`, `setAutomationTaskStatus`; automation task tests | Invalid timezone/time/frequency paths are service errors. |
| Manual execution | “Run now” creates one new Portal conversation bound to one `runId`, revision, task, and manual origin | Pass | `src/services/automation-runner.ts`, `src/services/conversation-log.ts`; runner contract test | System and assistant messages carry the run metadata. |
| Manual idempotency | Retrying a claimed/finished manual run does not repeat ACP or append duplicate conversation messages | Pass | `claimAutomationTaskRun`; runner idempotency fix; runner contract test | A lost claim is now treated as an execution-mutex miss and returns the existing run. |
| Working asset | Successful execution updates `working/`, preserves `source/`, verifies checksum, and uses service atomic replacement | Pass | `writeAutomationTaskWorkingAsset`, `refreshAutomationTaskWorkingAsset`; asset tests; staging boundary in runner | The production ACP path receives a temporary staging directory and only the service commits the working bytes. |
| Scheduled execution | Active due tasks create run history without creating ordinary conversations | Pass | `src/scheduler/automation.ts`, runner contract test, scheduler integration in `src/scheduler/index.ts` | Uses `automation_task_runs`, separate from old scheduler rows. |
| Continue in chat | `automation.continue_in_chat` creates a new ordinary conversation and does not resume or execute the background run | Pass | `continueAutomationRunInChat`; runner contract test | The new conversation contains only a scoped system entry until the user sends a new message. |
| Run details | Run state, summary/error, trace ID, input/output asset references and output checksum are persisted and exposed | Pass with caveat | `AutomationTaskRunRecord`, `automation.run.get`, `automation.asset.get`, `finishAutomationTaskRun` | Asset path/size/checksum/download data is available through the referenced asset; no separate immutable per-run snapshot is retained. |
| Failure control | Three consecutive failures set `needs_attention`, suppress the next schedule, and reactivation resets the counter | Pass | `finishAutomationTaskRun`; failure-threshold contract test | Success/skipped/cancelled reset failure count and advance the schedule when active. |
| Asset lifecycle | Task source/working files survive seven-day conversation attachment cleanup | Pass | `tests/automation-tasks.test.ts` attachment cleanup test | Task bytes live under `automations/<task-id>/source|working`, not `conversation_attachments`. |
| Scope isolation | User B cannot list, inspect, download, run, continue, or read User A’s task resources | Pass | `assertAutomationScope`, row scope checks, Portal scope binding; task and Portal contract tests | Connector payload scope fields are ignored in favor of registered connector scope. |
| Path/symlink safety | Traversal, unsafe database paths, symlink assets, type/mime mismatch, and oversized assets fail closed | Pass | Asset normalization/read/replace functions; path-escape and binary asset tests | Source overwrite is explicitly rejected. |
| Least privilege | Automation ACP uses `scheduled-automation`, conservative scheduled service MCP grant, and read-only default sandbox permissions | Pass with caveat | `src/acp/agent.ts`, `src/acp/stdio-agent.ts`, `src/acp/mcp-session-manifest.ts`, `src/lib/sandbox-context.ts`; sandbox test | The ACP process still relies on the configured backend’s workspace-write capability, but canonical task assets are isolated behind staging and service commit. |
| CSV/XLSX handling | Supported file types are validated and XLSX bytes are preserved | Partial | `normalizeAssetInput`, MIME/extension checks; XLSX binary test | A dedicated structured CSV/XLSX parser/editor and workbook-feature validator are not present yet; the execution prompt requires structured handling but does not itself prove it. |
| Existing scheduler contract | Existing daily/weekly/monthly review, market-watch, rule inspection, push, and old run-history behavior remains unchanged | Pass | New scheduler is independent; `npm test`; `npm run test:boundary`; old scheduler/attachment tests included | No production DB, Workspace, `.env`, WeChat state, or deployment was changed. |
| Portal UI | Portal task list/editor/detail/history UI is available | Unknown / external | Local `user-portal-protocol.md` and connector contract only | The Cloud Portal UI is outside this repository and was not available for direct browser verification. |

## Findings

1. **[P2] Structured spreadsheet execution remains a follow-up.** The service validates CSV/XLSX extension, MIME, size, path, and checksum, and the ACP prompt forbids treating XLSX as text. It does not yet provide or verify a structured table editing implementation. A future implementation should define the supported CSV/XLSX feature subset and validate the produced workbook before commit.

2. **[P2] Run recovery is reference-based rather than snapshot-based.** A run stores `outputAssetId` and `outputChecksum`, while the asset row points to the current working path. This is verifiable and downloadable, but it is not an immutable historical output copy. Decide the retention count/TTL for finite run snapshots before promising historical rollback from a run detail page.

3. **[P2] Live ACP/Portal UI evidence is unavailable in this local review.** Deterministic runner tests use an injected executor; they prove the run/conversation/storage contract but do not prove a real configured Codex ACP provider can edit a representative CSV/XLSX. The local connector contract is directly exercised; the separate Cloud Portal UI is not.

## Verification Performed

- `npm run build` — passed.
- `node --import tsx --test tests/automation-tasks.test.ts` — passed, 9/9.
- `node --import tsx --test tests/sandbox-context.test.ts tests/automation-tasks.test.ts` — passed, 10/10.
- `node --import tsx --test tests/automation-portal-contract.test.ts` — passed, 1/1 during the prior verification pass.
- `npm test` — passed, 351 tests / 17 suites in the final full run.
- `npm run test:boundary` — passed, 7 boundary suites.
- `git diff --check` — passed.
- No production deployment, production migration, real Workspace template adoption, attachment cleanup in a real user Workspace, or WeChat state change was performed.

## Follow-Up Checklist

- [ ] Add a real ACP fixture or isolated provider probe that edits one CSV and one representative XLSX through the staging directory.
- [ ] Define and implement the supported structured spreadsheet feature subset and output validation.
- [ ] Decide whether run details require immutable output snapshots; if yes, add bounded retention and restore verification.
- [ ] Integrate and browser-verify the Cloud Portal automation list/editor/detail/history UI against the connector contract.
- [ ] Before production rollout, perform the project’s approved additive DB migration/backup/verification procedure; do not modify production state as part of this local task.

---

## Re-review · 2026-08-05 (Asia/Shanghai)

### Acceptance Verdict

Status: **Pass**

The original blockers are resolved without changing the existing review/push
contract. ACP failures now finish the automation run as `failed` and cannot
commit staged working bytes; the task lease is persisted, fenced and recovered
after expiry; manual and scheduled execution share one task-level mutex; and
automation follow-up chat is restricted to a fresh `source/` + `working/`
staging scope. The Cloud Portal implementation is now present, built and
connected through the authenticated connector contract. Runtime and Portal
release candidates passed their complete required local validation suites.

### Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Persistence and revisioning | A paused daily task, its immutable revision and source/working assets persist under all three scope fields | Pass | `src/services/automation-tasks.ts`; `tests/automation-tasks.test.ts` | SQLite tables are additive; assets live in `automations/<task-id>/source|working/`. |
| Manual execution truthfulness | “Run now” creates one bound conversation/run and reports ACP failure as `failed` without committing working bytes | Pass | `src/acp/agent.ts`; `src/services/automation-runner.ts`; targeted suite 21/21 | Failure-state and unmodified-working-file regression are explicit tests. |
| File safety and spreadsheet handling | Source is immutable; working replacement is atomic, path/symlink-safe and structurally validates CSV/XLSX | Pass | `src/services/automation-spreadsheet.ts`; asset tests | XLSX is loaded with ExcelJS and the staging scope contains a structured `automation-sheet.mjs` helper. |
| Follow-up conversation boundary | Manual/continue chats use only task staging files; no attachments or general Workspace scope reappear | Pass | `src/services/conversation-log.ts`; follow-up staging test | Concurrent follow-up claims return `AUTOMATION_TASK_BUSY`; a fenced run audits the new action. |
| Scheduled reliability | One task cannot overlap manual/scheduled execution; expired running rows recover into a failed attempt and retry safely | Pass | `src/services/automation-tasks.ts`; `tests/automation-scheduler-reliability.test.ts` | Persistent lease plus task mutex replaces process-only de-duplication. |
| History and continuation | Scheduled runs stay out of normal chat; details and explicit “continue in chat” create a new bounded conversation | Pass | runner contract tests; connector commands | Continuation does not revive or rerun the background execution. |
| Scope and browser boundary | A second connector scope cannot list/read/run/get/continue another user’s task; browser responses omit scope and lease credentials | Pass | `tests/automation-portal-contract.test.ts`; Portal sanitizer test | Cross-user cases now explicitly cover `run_now`, `run.get` and `continue_in_chat`. |
| Portal UI | Authenticated Portal exposes task list/editor, CSV/XLSX upload, pause/enable, run-now jump, history, download and continue actions | Pass | `/Users/combo/MyFile/test-projects/invest-agent-portal/src/app/automations/page.tsx`; `AutomationShell.tsx`; Portal build | `npm run typecheck`, `npm test` (19/19), `npm run build` all pass; isolated production-mode route probe redirects `/automations` to login and protects `/api/automations` with 401. |
| Existing review/push behavior | Existing day/week/month review, push, persistence and boundary contracts remain intact | Pass | `npm run verify`: 360 tests / 17 suites, 7 boundary suites | Automation uses its own service tables/scheduler and no production data was touched during verification. |

### Verification Performed

- Runtime targeted regression: `node --import tsx --test tests/automation-tasks.test.ts tests/automation-scheduler-reliability.test.ts tests/automation-portal-contract.test.ts tests/sandbox-context.test.ts` — 21/21 passed.
- Runtime full verification: `npm run verify` — 360 tests / 17 suites, agent-context check, TypeScript build and 7 boundary suites passed.
- Runtime connector/service smoke: `npm run smoke:portal-conversation-log` and `npm run smoke:mcp-service-tools` — passed.
- Portal verification: `npm run typecheck`, `npm test` (19/19), `npm run build` — passed.
- Portal UI release-route probe: an isolated production-mode Portal process returned `307 /login` for `/automations`, `401` for unauthenticated `/api/automations`, and `200` for `/login`.
- Scoped `git diff --check` for the automation Portal paths — passed. The unrelated pre-existing trailing blank line in `src/lib/models.ts` was not adopted into this release.

### Remaining Non-blocking Follow-ups

- The first production observation should use an authorized test account and a **read-only** ACP/MCP probe; do not create a real task or write a real user file merely as a deployment smoke test.
- The product currently stores the latest validated working file plus each run checksum, not immutable per-run output snapshots. Snapshot retention is a future product decision, not a correctness or safety blocker for this first release.
