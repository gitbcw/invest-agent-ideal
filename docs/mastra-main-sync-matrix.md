# main -> Mastra Migration Sync Matrix

Baseline: `4b20aef`. Upstream: local `main`. Target: `feat/mastra-migration`.

| main commit | Classification | Mastra disposition | Evidence |
| --- | --- | --- | --- |
| `8702952` cancel/recover interrupted conversations | `mastra-rewrite` | Implemented as service-owned `AbortController`, Mastra `AbortSignal`, `TASK_CANCELLED`, and startup reconciliation. No ACP session cancellation retained. | `9cccf8b`; `tests/portal-conversation-cancel.test.ts` |
| `d2b493f` automation timeouts and XLSX output | `direct-port` with neutral types | Ported staging-relative file validation, file bytes, and timeout behavior using `AgentMessage`/`AgentResponse`. | `e5734c8`; automation tests |
| `21d43a9` ignore local migration draft | `not-applicable` | Canonical worktree housekeeping only; no runtime behavior to port. | `.gitignore` remains branch-local policy |
| `74184c9` automation run audit | `direct-port` | Ported Platform route, permission, and owner audit UI. | `c9bf06c`; `/api/platform/automation-runs` |

Unclassified upstream commits: **0** as of 2026-08-12.

Future sync procedure is defined in `docs/mastra-main-sync.md`. Old ACP implementation changes must never be merged as runtime code; only their business behavior may be rewritten behind the neutral runtime boundary.
