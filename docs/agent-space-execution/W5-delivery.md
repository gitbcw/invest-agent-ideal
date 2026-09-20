# W5 交付：任务依赖、工作状态与承诺闭环

状态：本地实现与隔离 DB 验证完成；未重写调度器、未切生产、未部署、未迁移真实用户。W4 装配模式保持默认关闭。
依据：[W5-tasks-state-commitments.md](./W5-tasks-state-commitments.md)、W1-W4 已通过验收的域契约。W4 验收保留的两项边界不变：generic runner 上游端到端、scheduled 生产 task 注册对齐（见 §3）。

## 0. 范围与实现

### 作用域 State Packet（真实检索，替换 W4 空桩）

`state.ts buildScopedStatePacket({scope, ownerKind, ownerId, agentId?, budgetChars, offset?})`：

- **作用域过滤**：只检索属于本次执行上下文的状态——任务入口取 task 归属 + 执行 Agent 归属，会话入口取 conversation + Agent 归属；他域 conversation/task 状态 out-of-scope 排除。
- **可审计排除（返工 R1）**：检索改为 scope 内**全量清点**——expired（含到期时间已过）、inactive-status（draft/rejected/disabled/superseded，携带当前状态）均产出排除记录并进入冻结 run-basis 与注入说明，不再静默过滤；跨 scope 对象从查询层不可枚举（连排除记录都不出现）。
- **冲突排除**：`evidence_state='counterexample'` 的经验按 conflict-evidence 排除（批准不代表正确）。
- **去重**：同类型同内容（规范化 JSON）只保留首个，重复记录 duplicate-content。
- **硬预算与续页契约（返工 R2）**：`buildScopedStatePacket` 支持 `pageSize`（预算内集合按页切片，`retrieval.hasMore` 在仍有下一页时为 true）；**basis 绑定 continuation**——`getRunBasisStateContinuation({scope, basisKey, page, pageSize})` 在冻结 basis 的预算内集合上分页：总预算在首次检索时冻结（续页无预算参数，无法换更大预算拿回被排除项），去重/冲突/预算排除共享同一冻结集合，条目正文按冻结 versionId 重读；伪 cursor（越界页）返回空页且 hasMore=false。
- **解释记录**：scanned/included/usedChars/scopeOwners + 每条排除原因全量返回。
- **状态只读**：状态包不创建任务、不写资产、不发通知（结构保证：state.ts 无任何此类面；note 随包注入）。

**W4 装配集成**：`assembleAndRecordRunBasis` 的 `resolution.statePacket` 由空桩换为真实包（条目引用 versionId+chars、排除原因、检索统计——**可被 run-basis 查证**；新增可选 `stateBudgetChars`，缺省 20000）。注入侧（`agent-space-context.ts`）按冻结 versionId 经 `readStateVersionContent` 读内容注入状态段（共享内容预算、逐段记录截断），状态包说明与排除清单进入最终 instructions。状态包不扩权：装配的技能/方法/资产集不因状态存在而变化。

### 运行结果分层记录

`tasks.ts recordRunOutcome/listRunOutcomes` + 新表 `agent_space_run_outcomes`（第 22 张 agent_space 表）：分层记录**绑定可核对事实来源（返工 R3）**——
- `execution_succeeded/failed`：来源=run 本身（存在+同 scope 已核）；
- `artifact_generated`：`detail.assetId` 必须是同 scope 真实用户资产（可选 versionId 须属于该资产）；
- `delivery_succeeded`：`detail.pushJobId` 必须是同 scope 真实 `push_jobs` 行且 status='sent'；`delivery_failed` 须 status∈{dead, expired}；
- `user_read`：无受信阅读事件源，**不提供**——只能记显式非事实名 `user_read_claimed`（声称，不冒充已读事实）。

append-only 带审计；run 真实存在且同 scope；幂等键同键同内容回放返回既有条、异内容冲突；时间线按插入序。

### 任务边界（沿用 + 明确）

任务不扫描全量资产（W4 依赖收窄语义保持）；修改形成新 revision、运行不可变 snapshot（W1 契约保持）；commitment 两期履约/暂停恢复走 W1 activate/transition 语义（本轮补齐隔离场景验证）。

## 1. 测试证据

`tests/agent-space-domain.test.ts` 新增组 "W5: scoped state packet, run-basis evidence, layered run outcomes, commitment closure"：

- 检索矩阵：conversation 包含本会话+Agent 归属、排除他域/冲突证据/重复/草稿（每类排除有原因）；task 包不混入会话经验；硬预算下 offset 补查不可达；rejected 不生效。
- run-basis 查证：resolution 携带 versionId 钉住的状态条目，冻结回放同一证据；注入内容按冻结 versionId 可重读一致；状态包不扩权。
- 结果分层：五阶段按序成条、幂等回放/冲突/未知类型/错域 run 拒绝。
- 承诺闭环：recurring 两期履约（跨期保持 active）、投递失败落 outcome、暂停→授权恢复、**关闭学习不取消既有授权任务**。

```
node --import tsx --test --test-concurrency=1 --test-force-exit tests/agent-space-domain.test.ts   # 34/34（含 R1/R2/R3 返工组）
npm test    # 724/724（~48s 自终止）
npm run build && npx tsc --noEmit   # 0 错误
```

返工补充断言：expired/rejected/disabled/draft 各有带状态的排除记录且入冻结 basis、跨 scope 不可枚举；pageSize+hasMore 真实续页、basis 绑定 continuation 逐页走完冻结集合、越界空页、tiny 预算被排除项任何续页不可达；伪资产/跨 scope 资产/错版本/伪 push job/状态不符/缺 ref/冒充 user_read 全部拒绝。

表计数 21→22（`agent_space_run_outcomes`）；table-ownership 已含 W1-W4 说明，本表同域归属。

## 2. Schema 变更

| 表 | 用途 |
| --- | --- |
| `agent_space_run_outcomes` | 运行结果分层记录（六类 kind、detail、scope 三列、幂等键唯一索引） |

## 3. 待决项（沿用 W4 边界，不在本单元）

- generic runner 上游完整端到端驱动；scheduled 生产 task 注册与身份链对齐（启用装配模式前置条件）。
- 任务创建的用户授权门面（新持续工作的创建入口）在 Portal/调度接入时一并设计——本单元不新增调度器行为。
- 状态包检索的 owner 策略（会话轮次内新增 owner 类型）随 W6/W7 迁移演练校准。
