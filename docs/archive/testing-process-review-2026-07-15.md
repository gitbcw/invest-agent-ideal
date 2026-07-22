## Acceptance Verdict

Status: Partial

`npm run verify` 和 GitHub Actions 已提供稳定的编译、单测、上下文、安全、MCP 与旧数据库迁移门禁，但当前测试流程没有把 scheduler、微信投递和近期的“过期会话待补送”行为纳入统一门禁。它适合作为基础质量线，尚不足以单独作为生产发布验收。

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Unified CI gate | Push/PR run one reproducible command | Pass | `.github/workflows/verify.yml`, `package.json` | GitHub Actions runs `npm ci` then `npm run verify`. |
| Compile and unit tests | Type check, build, deterministic tests | Pass | `npm run verify` on 2026-07-15 | 55 tests passed. |
| Service security contracts | Migration, MCP and security boundary checks | Pass | `package.json`, `npm run verify` | Included in CI gate. |
| Scheduler and push queue | Scheduler state transitions are gated in CI | Partial | `scripts/stage1-scheduled-tasks-smoke.mjs` | Smoke covers success/retry/dead/context-expired, but is not invoked by `verify` or CI. |
| WeChat delivery protocol | Send response parsing and context-token contract are gated | Partial | `scripts/weixin-sendmessage-contract-smoke.mjs` | Useful mock contract exists but is not an npm script or CI step. |
| Expired-session recovery | Awaiting-user, prompt, and `补发` recovery behavior is executable-tested | Fail | `src/services/weixin-delivery.ts`, `src/channels/weixin-message-bridge.ts` | Only the queue transition is covered. No isolated test drives pending lookup, normal inbound notice, recovery response, or recovery state update. |
| Test isolation | CI-safe tests avoid shared default DB/workspaces and real ACP | Partial | `docs/quality/test-system-health-review.md` | Existing health review explicitly records remaining shared-state smoke. `stage1` smoke still uses the default scope. |
| Production release acceptance | Release has a required health/API/trace verification checklist | Partial | `scripts/deploy-volcano.sh`, `volcano-ops` | Deployment script checks health, but targeted/manual releases have no enforced post-release contract or rollback verification. |

## Findings

- [P1] Critical scheduler/WeChat smoke is outside CI: `npm run verify` does not run `smoke:stage1-scheduler`, `smoke:weixin-complex-ack`, or `weixin-sendmessage-contract-smoke`. A change can pass PR checks while breaking scheduled delivery or its error classification.
- [P1] Recovery workflow lacks executable coverage: there is no test for `context_expired -> awaiting_user`, compatible historical pending lookup, normal user-message notice, `补发` content response, and `recovered_after_user_message` persistence as one flow.
- [P2] Some tests are structural source inspections rather than behavior tests: `weixin-complex-ack-smoke` searches source text, so valid refactors can fail and behavioral regressions can pass.
- [P2] Production verification is not standardized: the production runtime is checked manually after deployment, but no release command verifies instance status, delivery state, and a non-destructive scheduler/push contract after restart.

## Verification Performed

- `npm run verify`: passed on 2026-07-15 (typecheck, 55 tests, context check, build, migration/MCP/security contracts).
- Inspected `.github/workflows/verify.yml`: CI runs only `npm run verify`.
- Inspected the scheduler, WeChat protocol, and recovery smoke coverage and package script registration.

## Follow-Up Checklist

- [ ] Add isolated `node:test` coverage for the full expired-session recovery flow, including an idempotent second `补发` request.
- [ ] Promote WeChat send-message contract and the isolated scheduler/push contract into `npm run verify`.
- [ ] Refactor `stage1` scheduler smoke to use a temporary DB/workspace, then make it CI-safe.
- [ ] Add a post-deploy read-only production verification command: health, instance WeChat status, queue summary, and no unexpected pending/retry jobs.
