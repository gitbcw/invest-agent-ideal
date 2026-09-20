# W5 交付：任务依赖、工作状态与承诺闭环

状态：本地实现与隔离 DB 验证完成；未重写调度器、未切生产、未部署、未迁移真实用户。W4 装配模式保持默认关闭。
依据：[W5-tasks-state-commitments.md](./W5-tasks-state-commitments.md)、W1-W4 已通过验收的域契约。W4 验收保留的两项边界不变：generic runner 上游端到端、scheduled 生产 task 注册对齐（见 §3）。

## 0. 范围与实现

### 作用域 State Packet（真实检索，替换 W4 空桩）

`state.ts buildScopedStatePacket({scope, ownerKind, ownerId, agentId?, budgetChars, offset?})`：

- **作用域过滤**：只检索属于本次执行上下文的状态——任务入口取 task 归属 + 执行 Agent 归属，会话入口取 conversation + Agent 归属；他域 conversation/task 状态 out-of-scope 排除。draft/拒绝/停用/过期本就不在有效集（`listEffectiveState`）。
- **冲突排除**：`evidence_state='counterexample'` 的经验按 conflict-evidence 排除（批准不代表正确）。
- **去重**：同类型同内容（规范化 JSON）只保留首个，重复记录 duplicate-content。
- **硬预算**：起始检索与补查共用总字符预算——超预算条目记 budget-exhausted 且**分页不可达**（offset 无法绕过）。
- **解释记录**：scanned/included/usedChars/scopeOwners + 每条排除原因全量返回。
- **状态只读**：状态包不创建任务、不写资产、不发通知（结构保证：state.ts 无任何此类面；note 随包注入）。

**W4 装配集成**：`assembleAndRecordRunBasis` 的 `resolution.statePacket` 由空桩换为真实包（条目引用 versionId+chars、排除原因、检索统计——**可被 run-basis 查证**；新增可选 `stateBudgetChars`，缺省 20000）。注入侧（`agent-space-context.ts`）按冻结 versionId 经 `readStateVersionContent` 读内容注入状态段（共享内容预算、逐段记录截断），状态包说明与排除清单进入最终 instructions。状态包不扩权：装配的技能/方法/资产集不因状态存在而变化。

### 运行结果分层记录

`tasks.ts recordRunOutcome/listRunOutcomes` + 新表 `agent_space_run_outcomes`（第 22 张 agent_space 表）：六类分层——`execution_succeeded / execution_failed / artifact_generated / delivery_succeeded / delivery_failed / user_read`，append-only 带审计；run 必须真实存在且同 scope；幂等键同键同内容回放返回既有条、异内容冲突；时间线按插入序。执行成功、产物生成、投递成功/失败、用户阅读分别成条。

### 任务边界（沿用 + 明确）

任务不扫描全量资产（W4 依赖收窄语义保持）；修改形成新 revision、运行不可变 snapshot（W1 契约保持）；commitment 两期履约/暂停恢复走 W1 activate/transition 语义（本轮补齐隔离场景验证）。

## 1. 测试证据

`tests/agent-space-domain.test.ts` 新增组 "W5: scoped state packet, run-basis evidence, layered run outcomes, commitment closure"：

- 检索矩阵：conversation 包含本会话+Agent 归属、排除他域/冲突证据/重复/草稿（每类排除有原因）；task 包不混入会话经验；硬预算下 offset 补查不可达；rejected 不生效。
- run-basis 查证：resolution 携带 versionId 钉住的状态条目，冻结回放同一证据；注入内容按冻结 versionId 可重读一致；状态包不扩权。
- 结果分层：五阶段按序成条、幂等回放/冲突/未知类型/错域 run 拒绝。
- 承诺闭环：recurring 两期履约（跨期保持 active）、投递失败落 outcome、暂停→授权恢复、**关闭学习不取消既有授权任务**。

```
node --import tsx --test --test-concurrency=1 --test-force-exit tests/agent-space-domain.test.ts   # 33/33
npm test    # 723/723（~48s 自终止）
npm run build && npx tsc --noEmit   # 0 错误
```

表计数 21→22（`agent_space_run_outcomes`）；table-ownership 已含 W1-W4 说明，本表同域归属。

## 2. Schema 变更

| 表 | 用途 |
| --- | --- |
| `agent_space_run_outcomes` | 运行结果分层记录（六类 kind、detail、scope 三列、幂等键唯一索引） |

## 3. 待决项（沿用 W4 边界，不在本单元）

- generic runner 上游完整端到端驱动；scheduled 生产 task 注册与身份链对齐（启用装配模式前置条件）。
- 任务创建的用户授权门面（新持续工作的创建入口）在 Portal/调度接入时一并设计——本单元不新增调度器行为。
- 状态包检索的 owner 策略（会话轮次内新增 owner 类型）随 W6/W7 迁移演练校准。
