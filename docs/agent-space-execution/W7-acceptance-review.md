# W7 准备独立验收

日期：2026-09-21；复核提交 `b46e81b`，依据 [W7 执行稿](./W7-owner-cutover.md)、W7 执行计划及 W0-W6 验收记录。

## Acceptance Verdict

Status: **Partial — 准备资产通过，暂不进入真实切换窗口。**

批次方案、generic runner 上游接线测试和任务依赖注册脚本已具备；隔离测试可证明采用方法能沿真实 generic runner 到模型边界，未注册依赖会得到显式空集。尚不能把当前材料当作可直接执行的生产切换手册，因为真实运行结果没有接入自动化链路，注册脚本和回滚步骤仍有高影响误操作风险，且 D5/D6 仍是未决决策。

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| 批次范围 | mg/dyk/111 分三批、逐批观察、失败不影响其他用户 | Partial | `W7-execution-plan.md:11` | 计划写明批次，但回滚实现仍可能整库恢复，见 R2。 |
| 方法依赖注册 | dry-run、scope/active/adopt 校验、重放幂等 | Pass | `scripts/agent-space/w7-register-task-deps.mjs`；迁移测试新增注册组 | 隔离测试 7/7 包含未采用、非 active、重复注册反例。 |
| generic runner 上游 | 装配开关下从 claim/lease 到模型边界 | Pass | `tests/agent-space-generic-e2e.test.ts` | 独立执行通过，固定版本正文和显式空集均被捕获。 |
| 会话/任务 smoke | 真实 basis、投递、跨 scope 证据 | Partial | 计划第 7 步 | 只有 generic fixture 测试；没有窗口日可执行的三项真实 smoke 工具/查询清单。 |
| W5 outcome | 运行/产物/投递结果自动可查证 | Fail | `rg recordRunOutcome src` 仅命中服务实现 | runtime/scheduler/runner 没有调用 `recordRunOutcome`；计划要求的 outcome+交付链不能靠切换自动产生。 |
| 生产写入护栏 | `--confirm` 只对明确目标库执行 | Partial | `w7-register-task-deps.mjs:35-42` | 要求 DB_PATH，但没有生产/隔离目标标识、manifest hash 或二次目标确认；任意显式 DB_PATH + `--confirm` 都可写。 |
| 批次回滚 | 只回滚当前用户，不影响其他用户 | Fail | `W7-execution-plan.md:39` | “恢复步骤 2 快照”是整库恢复，可能覆盖其他用户及窗口期间新写入；W6 的 9 表清零只适用于隔离演练。 |
| 决策完整性 | 窗口前冻结所有采用决策 | Partial | 计划 §3 D1-D7 | D1 建议已明确，但 D5 dyk 核心模型、D6 111 策略仍未决，不满足 owner-cutover 前置。 |

## Findings

### R1 [P1] W5 outcome 尚未接入真实运行链

`recordRunOutcome` 目前只存在于 Agent Space 服务层；generic runner、scheduled runner、delivery/push 路径没有调用它。W7 第 7、9 步要求 daily-review 的 run basis + outcome + delivery chain 可查证，但当前切换只会产生 basis/既有运行记录，不能自动产生 `execution_*` 或 delivery outcome。不能把隔离测试手工写入 outcome 当成真实运行证据。

通过标准：在不重写调度器的前提下，为本窗口实际会经过的 generic/scheduled/delivery 入口明确结果写入接缝；至少 execution outcome 与真实 run status、delivery outcome 与 `push_jobs.origin_run_id` 可查。若本窗口不接入，应把 smoke 标准改为“仅 basis + 既有生产 delivery 事实核对”，不能写成 outcome 已正常。

### R2 [P1] 整库快照恢复不满足逐用户隔离回滚

执行计划第 10 步允许恢复步骤 2 的生产 DB 快照。窗口期间其他用户的对话、任务、投递或资产写入都可能落在该快照之后，整库恢复会覆盖这些无关写入，直接违反“三批次失败不影响其他用户”。

通过标准：默认关闭开关并停用本批对象；若仍需数据恢复，使用按 scope/对象的补偿式前向修复或经过 owner 明确批准的维护窗口整库恢复，并在恢复前阻断所有相关写入、核对快照之后的变更清单。W6 的隔离整库 rollback 不能作为生产逐用户回滚证据。

### R3 [P1] 依赖注册脚本可被 `--confirm` 指向任意 DB

脚本只检查 `DB_PATH` 非空，然后 `initDb()`；没有要求目标库的 scope/manifest 指纹、生产环境显式确认或禁止默认 `NODE_ENV=test` 下写入生产。对生产执行时，plan 文件本身也未携带期望 project/instance 和目标 manifest hash。

通过标准：confirm 必须携带目标 DB 身份证明（scope/instance、当前 W7 manifest hash、批次 token 或等价人工确认），并拒绝 test/unknown 环境的生产写入；dry-run 可以在任意隔离 DB 运行。注册前后输出可核对的 affected task/dependency 列表，重跑仍幂等。

### R4 [P1] D5/D6 未决，不满足 W7 cutover 前置

dyk 核心模型是否恢复采用、111 策略是否拆分/接受空方法/延后批次，都会改变装配内容和 smoke 结果。当前计划仍允许直接走 B2/B3，但 owner-cutover 规定窗口和逐项授权决策必须先指定。

通过标准：窗口执行前冻结 D1-D7 的签名决策记录；未决用户批次不得开启 resolver。建议 B3 在 D6 决策前保持关闭，D5 未决不影响 B2 但必须明确 dyk 的空方法预期。

## Verification Performed

- 独立运行 `node --import tsx --test --test-force-exit tests/agent-space-generic-e2e.test.ts tests/agent-space-migration.test.ts`：8/8 通过（1 generic e2e + 6 W6 migration + 1 W7 registration group）。
- 阅读 `w7-register-task-deps.mjs`、W7 计划、owner cutover 约束及 runtime outcome 调用面；未执行 `--confirm`，未连接生产 DB。
- 未部署、未切换 resolver、未迁移真实用户、未发送消息、未修改生产数据。

## Follow-Up Checklist

- [ ] 明确 D5/D6 并冻结逐批授权记录。
- [ ] 定义或接入窗口日 outcome/delivery 事实采集。
- [ ] 把生产回滚改成 scope 隔离的补偿方案，或明确维护窗口内整库恢复的强前置与影响范围。
- [ ] 给注册脚本增加目标库/manifest/confirm 护栏，并用隔离 DB 反例验证。
- [ ] 补齐窗口日 smoke 和采证命令，之后再申请 W7 执行放行。

---

## 2026-09-21 返工复验（`f8de7ec` + `9b9dc2b`）

### Acceptance Verdict

Status: **Partial — R1/R3/R4 主要证据通过，R2 仍阻塞；不进入真实切换窗口。**

本轮确认了运行终态与投递事实已接入真实服务咽喉点，注册护栏和只读 smoke 资产可运行，D1–D7 的独立冻结记录也已存在。但 scope 补偿回滚的实现会误伤该用户已有的非 W7 依赖和 Agent，违反“只停用本批对象、保留既有历史”的通过标准；执行计划中的 D5/D6 概览也尚未同步冻结结论。因此仅放行隔离准备复核，不放行生产 resolver 切换。

### Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| R1 运行结果接入 | 所有 run 终态自动记录 execution outcome；投递终态自动记录 delivery outcome 并绑定真实 job/run | **Pass** | `src/services/automation-tasks.ts:2331-2364`；`src/services/push-queue.ts:349-382`；`tests/agent-space-generic-e2e.test.ts` | `finishAutomationTaskRun` 与 `syncAutomationDelivery` 为实际咽喉点；generic e2e 覆盖成功、失败、sent 投递，未执行人工 outcome 写入。 |
| R2 scope 回滚 | `switch-only` 零写；`deactivate` 只补偿本批 `w6:*` 对象，不触碰用户既有对象/窗口写入 | **Fail** | `scripts/agent-space/w7-rollback-scope.mjs:76-79,107-115` | 依赖查询按 `user_id` 全量，删除时无 `w6:*` 限定；Agent 查询也按 `user_id` 全量，停用时无 W7/W6 标识过滤。现有测试只验证隔离 fixture，未覆盖同 scope 既有 Agent/依赖。 |
| R3 注册护栏 | confirm 必须带 target、W0 root、manifest hash、batch；生产 test 环境拒绝；批次用户不匹配拒绝；dry-run/重跑幂等 | **Pass** | `scripts/agent-space/w7-register-task-deps.mjs:56-80`；`tests/agent-space-migration.test.ts` W7 注册组 | 反例与 affected 前后清单均有隔离测试证据。脚本仍依赖操作者显式提供正确 `DB_PATH`；未在脚本内证明 DB 文件与 manifest 的物理绑定，作为窗口操作注意项保留。 |
| R4 决策冻结 | D1–D7 均有状态、依据和批次解锁规则 | **Partial** | `docs/agent-space-execution/W7-decisions.md:1-15`；`docs/agent-space-execution/W7-execution-plan.md:48-52` | 唯一冻结记录已将 D5/D6 标为 `decided`；但执行计划概览仍写“窗口日前 owner 裁决/三选一”，与冻结结论不一致，需同步后才可作为窗口手册。 |
| 隔离验证 | 返工测试、generic e2e、类型检查通过；未触碰生产 | **Pass** | `node --import tsx --test --test-force-exit tests/agent-space-generic-e2e.test.ts tests/agent-space-migration.test.ts`（10/10）；`npm run typecheck` | 本轮仅使用隔离数据库/假模型网关；未执行 `--confirm`、未切 `AGENT_SPACE_ASSEMBLY_MODE`、未发送真实消息。 |

### Findings

- **[P1] R2 回滚过滤范围不足。** `w7-rollback-scope.mjs` 的 `deps` 查询（第 77 行）只按 `user_id`，第 107–109 行会删除该用户全部任务依赖；`agents` 查询（第 76 行）只按 `user_id`，第 111–115 行会停用该用户全部 Agent。必须把目标集合限定为本批 W6 导入标识（或在导入时记录明确的 batch/object manifest），并增加同 scope 既有依赖与 Agent 的保留反例。
- **[P2] 执行计划与冻结记录不一致。** `W7-decisions.md` 已冻结 D5“继续留队列”和 D6“接受 B3 空方法”，但 `W7-execution-plan.md` §3 仍保留旧的待决描述。窗口操作员若只读执行计划，可能错误地暂停或改变批次决策。
- **[P2] 注册目标库证明仍是操作员输入。** 护栏已拒绝缺参数、错 hash、错批次和 test 环境 production 写入；但脚本无法独立证明 `DB_PATH` 就是声明的目标实例。窗口日应把 DB 路径、scope/instance 与 manifest 指纹作为外部采证一并记录。

### Verification Performed

- `node --import tsx --test --test-force-exit tests/agent-space-generic-e2e.test.ts tests/agent-space-migration.test.ts`：10/10 通过（generic upstream、W6 fixtures、注册护栏、scope rollback fixture、smoke、W6 rollback）。
- `npm run typecheck`：通过。
- 直接阅读 `finishAutomationTaskRun`、`syncAutomationDelivery`、`w7-rollback-scope.mjs`、`w7-register-task-deps.mjs`、W7 执行计划与决策冻结记录；未执行生产脚本或生产数据库写入。

### Follow-Up Checklist

- [ ] 将 `w7-rollback-scope.mjs` 的 Agent/依赖选择收窄到本批 W6 导入对象，并补同 scope 既有对象保留测试。
- [ ] 同步 `W7-execution-plan.md` §3 的 D5/D6 为冻结结论，保留唯一权威记录引用。
- [ ] 窗口日前记录实际目标 DB 的 scope/instance、路径和 manifest 指纹，作为 R3 的外部操作证据。
- [ ] 修复并复验后，重新申请 W7 真实 resolver 切换；在此之前仅允许隔离演练和 dry-run。

---

## 2026-09-21 二次返工复验（`b66294b`）

### Acceptance Verdict

Status: **Pass with caveats — W7 准备条件通过，可申请窗口；尚未执行生产切换。**

R2 的误伤面已收窄到批次对象，R2 诱饵测试覆盖手工 Agent、非 W6 方法依赖和 asset 依赖；执行计划的 D1–D7 概览已与冻结记录一致。隔离测试与类型检查通过，仍只证明准备资产和隔离行为，不构成生产切换证据。

### Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| R2 scope 回滚 | 仅停用批次 Agent、W6 方法依赖、W6 方法/资产；非批次对象不动 | **Pass** | `scripts/agent-space/w7-rollback-scope.mjs:76-137`; `tests/agent-space-migration.test.ts` R2 诱饵组 | Agent 按 `w6:*`/`w7:*` 幂等键；依赖限定 `kind=method` 且 ref 指向本 scope W6 方法；NULL 幂等键显式归入非批次。 |
| R2 非批次保留 | 手工 Agent、非 W6 方法依赖、asset 依赖回滚后原封不动 | **Pass** | 隔离测试断言 `nonBatchAgents=1`、`nonBatchDependencies=2`，并核对状态/行数 | 覆盖此前发现的 NULL 三值逻辑风险。 |
| R3 注册批次标记 | 注册依赖写入 `registeredBy/batch/manifestSha256` 元数据 | **Pass** | `scripts/agent-space/w7-register-task-deps.mjs`；注册隔离测试 | 后续补偿回滚可识别注册来源；dry-run 不写入。 |
| R4 文档一致性 | 执行计划与唯一冻结记录一致 | **Pass** | `W7-execution-plan.md:42-52`；`W7-decisions.md` | D5/D6 已改为冻结结论，无旧待决表述残留。 |
| 隔离验证 | W7 相关测试与类型检查通过 | **Pass** | `node --import tsx --test --test-force-exit tests/agent-space-generic-e2e.test.ts tests/agent-space-migration.test.ts`：10/10；`npm run typecheck` | 未执行生产 `--confirm`、未切 resolver、未发送真实消息。 |

### Remaining Caveat

- **[P2] 生产目标身份仍需窗口日外部核对。** 注册脚本的 target、manifest hash、batch 护栏已通过，但 `DB_PATH` 与目标 scope/project/instance 的物理对应仍需窗口日由操作员按计划记录并复核；本轮不以隔离测试替代该生产证据。

### Follow-Up Checklist

- [ ] 窗口日前刷新备份与 W0 清单，并记录本批 manifest 指纹。
- [ ] 窗口日先核对 `DB_PATH`、scope/project/instance、manifest hash，再允许 `--confirm`。
- [ ] 仅在 owner 指定维护窗口后执行 B1，按批次观察与 R2 补偿回滚方案操作。
