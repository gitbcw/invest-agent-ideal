## Acceptance Verdict

Status: **Partial**

草稿状态、精确确认绑定、正常路径的集中提交和完成消息均已落地，且保留的真实评测用户证明中间确认没有写入正式 Workspace。但核心的“先返回等待提示、后执行写入”在真实旅程中被违反；同一提交的重试还重复写入了正式 change log。配置了明确规则时，当前实现还可能在规则创建失败前把 `onboarding_state.yaml` 标为完成。因此不能验收为通过。

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Draft storage and MCP contract | 专用 `onboarding_drafts`，不复活 `conversation_tasks` | Pass | [schema.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/db/schema.ts:437), [service-tools-core.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/mcp/service-tools-core.ts:560) | 新草稿表、六个具名工具均存在；草稿流程没有使用 `conversation_tasks`。 |
| Intermediate confirmation | 中间确认不改正式 Workspace 文件 | Pass | Eval draft `1bb4cc3e-...`：portfolio accepted `10:30:07Z`，style accepted `10:33:34Z`，最后规则 accepted `10:43:55Z`；六个正式配置文件最终写入时间均为 `10:47:36Z` | 对话、pending confirmation、audit 和 Workspace 文件时间一致。 |
| Exact confirmation binding | accepted step 可核对 payload、confirmation ID、确认消息 | Pass | `onboarding_drafts.steps_json`、`pending_sandbox_confirmations`、`sandbox_audit_logs` | 六个步骤均有 `confirmationId`、`confirmedMessageId` 和精确 payload。 |
| Revision editing | 修改只废弃对应 revision，其他步骤保持有效 | Partial | [onboarding-drafts.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding-drafts.ts:144)；[onboarding-draft-commit-smoke.mjs](/Users/combo/MyFile/projects/invest-agent-ideal/scripts/onboarding-draft-commit-smoke.mjs:91) | 实现和烟测覆盖 portfolio revision，但保留的真实评测用户没有执行“已确认后修改”旅程，不能以单测代替真实证据。 |
| Wait-before-write | 最后确认后先回等待提示，再由后台写 Workspace | **Fail** | Eval completion state first written `10:44:07.412Z`；等待消息写入对话日志 `10:44:10.525Z` | worker 以 5 秒轮询运行，ACP 回合还未返回时已领取并写入。核心体验要求被直接反证。 |
| Frozen snapshot | 后台只提交 enqueue 时冻结的快照 | Pass with caveat | Eval `commit_snapshot_json` 与最终 `steps_json` 相等；[onboarding-drafts.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding-drafts.ts:222) | 正常顺序路径正确，且 queued/applying 时禁止修改；但领取条件存在并发问题，见 findings。 |
| Final durable correctness | 所有正式结果校验成功后才完成 onboarding | **Fail** | [onboarding.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding.ts:220), [onboarding-drafts.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding-drafts.ts:298) | `onboarding_state.yaml` 在 `commitDraftRules()` 前写为 completed。规则创建失败会留下“已完成”正式状态和 failed draft。 |
| Retry idempotency | 同一 commit 重试不重复规则、change log 或通知 | **Fail** | Eval draft attempts=`4`；[change_log.jsonl](/Users/combo/MyFile/my-data/projects/invest-agent-ideal/workspaces/eval-onboarding-draft-1784283788991/memory/change_log.jsonl) 有 4 条同一提交记录 | 实际只产生一条 completion message/push，但 duplicate change log 已违反明确要求；并发领取还可能放大为重复规则。 |
| Completion notification | 权威会话记录和 push 使用同一正确 scope，并可重试 | Partial | [onboarding-drafts.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding-drafts.ts:329)；真实 conversation message 与 push job | 对话日志 scope 正确；push 使用 draft 的 projectId，真实数据与 conversation session 的 projectId 不一致。该 push 本身因 `no_connected_account` 进入 retry。 |
| Real result projection | 冻结草稿内容准确投影到 Workspace | Partial | Eval frozen market windows `09:50/11:20/14:30`，最终 [schedules.yaml](/Users/combo/MyFile/my-data/projects/invest-agent-ideal/workspaces/eval-onboarding-draft-1784283788991/config/schedules.yaml) 为 `09:55/11:20/14:30` | 真实结果丢失了用户确认的 `09:50`，需要用当前构建重新复验并修正。 |
| Migration and rollback evidence | 提供迁移、回滚和未完成用户兼容证据 | Partial | [db/index.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/db/index.ts:439) | 表的启动建表和索引存在，但未见本次变更的迁移/回滚运行记录，也没有现有未完成用户的兼容评测证据。 |

## Findings

- **P0 - 等待提示不是写入前返回。** Eval 用户的最后确认在 `10:43:40.521Z`，Workspace 的第一次提交及 `onboarding_state` steps 时间为 `10:44:07.412Z`，而“初始配置已全部确认，正在统一完成”消息直到 `10:44:10.525Z` 才写入。5 秒 worker 已在当前 ACP 回合回复前执行。见 [scheduler/index.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/scheduler/index.ts:322) 和 [onboarding-drafts.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding-drafts.ts:222)。

- **P1 - 规则创建失败后仍可能对外显示 onboarding 完成。** `applyOnboardingDraftCommit()` 先验证五个 YAML、写 `onboarding_state.yaml` 和 change log，再由 `commitDraft()` 创建规则。规则校验或创建失败时，draft 会变 `failed_retryable`，但正式状态已经 completed。见 [onboarding.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding.ts:220) 和 [onboarding-drafts.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding-drafts.ts:298)。

- **P1 - 实际重试重复写入正式审计。** 同一 `commit_key` 的评测草稿尝试 4 次，`memory/change_log.jsonl` 写入了 4 条 `onboarding_draft_committed`。设计明确要求同一 commit key 不重复 change log。当前 `appendChangeLog()` 没有提交键去重，见 [onboarding.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding.ts:227)。

- **P1 - worker 领取不是原子租约。** 查询到 queued 后，条件更新允许 `queued`、`applying`、`failed_retryable` 都被领取；第二个 worker 可以在第一个置为 `applying` 后再次成功领取，进而并发提交同一快照。见 [onboarding-drafts.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding-drafts.ts:257)。这会破坏规则和通知去重的前提。

- **P1 - 完成通知的 push scope 未复用权威会话 scope。** 对话消息从 session 取 projectId，而 enqueue push 仍取 draft projectId。真实 eval 的 conversation message projectId 为 `invest-agent-eval-onboarding-draft-1784283788991`，push job 却为 `invest-agent`。见 [onboarding-drafts.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding-drafts.ts:335) 和 [onboarding-drafts.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding-drafts.ts:349)。

- **P2 - 真实提交没有保留用户确认的首个盘中简报时间。** 冻结草稿是 `09:50/11:20/14:30`，最终 schedules 变成 `09:55/11:20/14:30`。这与 [onboarding.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding.ts:547) 的当前输入兼容代码不一致，说明本地构建/真实评测结果需要重新对齐验证。

- **P2 - 每个正式文件并非最多读取一次。** 提交先读取六个文件，随后 `verifyDraftCommit()` 再读 portfolio、strategy、schedules、notification、watch，违反设计中的一次读取目标。见 [onboarding.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding.ts:115) 和 [onboarding.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding.ts:225)。

## Verification Performed

- 对照 [onboarding-draft-commit-design.md](/Users/combo/MyFile/projects/invest-agent-ideal/docs/onboarding-draft-commit-design.md) 的状态、提交顺序、通知和验收条款。
- 读取保留真实用户 `eval-onboarding-draft-1784283788991` 的对话、`onboarding_drafts`、pending confirmations、sandbox audit、push jobs、alert rules 和 Workspace 正式文件。
- 对照当前草稿服务、统一提交器、worker、MCP schema、模板提示词和已有烟测脚本。
- 未运行会新建或清理用户数据的 smoke，未修改代码、数据库、Workspace 或部署环境。

## Follow-Up Checklist

- [ ] 将 enqueue 与“等待提示已持久化/已发送”建立明确顺序，避免 worker 在首条等待回复前领取。
- [ ] 将 watch rules 的创建/核对纳入 onboarding state 完成之前；失败时恢复或保持 state 未完成。
- [ ] 以 commit key 幂等化 change log、push enqueue，并修正 worker 的 compare-and-swap 领取条件。
- [ ] push enqueue 复用已解析的 conversation session scope。
- [ ] 修复/重跑真实评测，证明 market-watch windows 按冻结快照写入，且覆盖已确认步骤的修改旅程、明确规则旅程和通知不可达恢复。
- [ ] 补充数据库迁移、回滚及已有未完成 onboarding 用户兼容的可复核证据。

## Re-review 2026-07-17

Status: **Partial**

上一轮的三个实现级 blocker 已有实质修复，且当前构建下的草稿烟测通过；不过尚未提供修复版本的第二次真实 Onboarding 旅程，不能用烟测覆盖此前真实用户的时序反证。完成通知的 push 幂等性仍存在进程中断窗口，因此总体仍不能升级为 Pass。

| Previous finding | Updated status | Evidence | Judgment |
| --- | --- | --- | --- |
| 等待提示被 worker 抢跑 | Pass in deterministic smoke / Partial in product acceptance | [onboarding-drafts.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding-drafts.ts:255), [onboarding-draft-commit-smoke.mjs](/Users/combo/MyFile/projects/invest-agent-ideal/scripts/onboarding-draft-commit-smoke.mjs:132) | worker 没有 enqueue 后的 assistant message 时保持 queued，烟测同时验证 Workspace 零变化。仍需真实 ACP 对话证明该提示先抵达用户。 |
| worker 非原子重复领取 | Pass | [onboarding-drafts.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding-drafts.ts:258) | 条件更新现在与候选时的 queued / 过期 applying / retryable 条件匹配；第二个 worker 看见新的 startedAt 后无法领取。 |
| 规则失败后 state 提前完成 | Pass in code path | [onboarding-drafts.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding-drafts.ts:304), [onboarding.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding.ts:236) | YAML 投影、规则创建和规则校验都成功后，才 finalize state 和 change log。 |
| 重试重复 change log | Pass in code path | [onboarding.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding.ts:242) | `draft_commit_key` 让成功后的重试跳过重复 state/change log；当前烟测的再次 worker 调用通过。 |
| push scope 不一致 | Pass | [onboarding-drafts.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding-drafts.ts:347) | push 已改为复用由 conversation session 解析出的 delivery scope。 |
| 09:50 被投影为 09:55 | Pass in deterministic smoke / Partial in product acceptance | [onboarding-draft-commit-smoke.mjs](/Users/combo/MyFile/projects/invest-agent-ideal/scripts/onboarding-draft-commit-smoke.mjs:148) | 当前 build 下 smoke 断言 `09:50/11:20/14:30` 并通过；仍应重跑真实 ACP 旅程取代旧数据。 |

### Remaining Findings

- **P1 - 等待提示门槛只检查“任意 assistant 消息”，没有绑定期望的等待提示或 enqueue 回合。** [onboarding-drafts.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding-drafts.ts:374) 仅要求同一会话、同一用户实例且 `created_at > queued_at` 的 assistant message；任何无关回复也会放行提交。应使用专用 idempotency key/metadata 标记排队后的 handoff，或至少校验固定 handoff 类型。

- **P1 - 完成通知的 push enqueue 仍不具备崩溃幂等性。** [onboarding-drafts.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding-drafts.ts:353) 先以幂等 key 写对话消息，随后无幂等键地插入 push job，最后才写 `notifiedAt`。若进程在 enqueue 后、写 `notifiedAt` 前中断，重试会复用同一对话消息但新增一个 push job。需要 push-job 的 commit-key 唯一约束或在 draft 中原子持久化通知领取状态。

- **P2 - 真实评测证据仍停留在修复前版本。** 已通过 `npm run smoke:onboarding-draft-commit`，但这一脚本不能替代一个真实 ACP 旅程的对话、草稿、确认、Workspace 和推送记录。修复后应保留新的 eval 用户作为最终验收依据。

### Re-review Verification

- `npm run smoke:onboarding-draft-commit`: passed, including build。
- 静态复查等待提示门槛、严格 CAS、规则后 finalize、change log 去重和会话 scope 复用。

## Final Re-review 2026-07-17

Status: **Partial**

此前剩余的两个 P1 已修复：worker 只会接受排队后带有“信息/初始配置已全部确认…统一完成”语义的等待提示；`push_jobs.idempotency_key` 具有实际数据库唯一索引，成功与失败通知均以 `commit_key + result` 去重。当前草稿烟测重新通过。最终状态仍为 Partial 的唯一实质原因是：没有保留一轮**修复后**真实 ACP Onboarding 旅程，无法证明在实际 ACP 回复落入权威会话日志后才由 worker 写入 Workspace，也无法以真实 push 记录取代单元/烟测证明。

| Requirement | Status | Evidence |
| --- | --- | --- |
| 无等待提示或无关 assistant 消息时不得提交 | Pass | [onboarding-drafts.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding-drafts.ts:375)；[onboarding-draft-commit-smoke.mjs](/Users/combo/MyFile/projects/invest-agent-ideal/scripts/onboarding-draft-commit-smoke.mjs:132) 先验证无消息，再验证“好的，我会继续处理”仍不放行。 |
| 正确等待提示后允许提交 | Pass | 同一 smoke 在匹配“信息已全部确认。我现在会统一完成初始配置”后完成并断言最终配置。 |
| completion / failure notification 不重复 push | Pass in code and schema | [onboarding-drafts.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/onboarding-drafts.ts:362)、[push-queue.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/services/push-queue.ts:48)、[db/index.ts](/Users/combo/MyFile/projects/invest-agent-ideal/src/db/index.ts:676)；本地 SQLite 已有 `idx_push_jobs_idempotency_key` unique partial index。 |
| 修复后的真实 ACP journey | **Partial** | 保留用户 `eval-onboarding-draft-1784283788991` 运行于修复前；本轮没有新增真实 ACP 对话、Workspace 和推送证据。 |

### Final Verification

- `npm run smoke:onboarding-draft-commit`: passed, including `tsc` build.
- 静态检查：等待提示正则、push idempotency key 写入、`push_jobs` 的实际唯一索引和插入冲突回读逻辑。
- 未创建、删除或修改真实评测用户、正式 Workspace、生产环境或云端服务。
