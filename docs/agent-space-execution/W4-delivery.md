# W4 交付：Agent 空间控制面与运行时装配

状态：本地实现与隔离 DB 验证完成；未真实切换或删除旧 Workspace、未接线生产入口、未部署、未迁移真实用户。
依据：[W4-agent-space-runtime.md](./W4-agent-space-runtime.md)、W1-W3 已通过验收的域契约。W5 状态注册面未开工，agent_state 在依赖与状态包中以**明确标注的空接口桩**呈现（fail-closed）。

## 0. 装配顺序与不变量

装配严格按执行稿顺序：**认证 scope → 固定已安装 Skill/绑定 Method/asset grant 版本 → 按任务 dependencies 收窄 → 预算 State Packet → 记录可解释 run-basis**。

- **版本装配即固定**：basis 内一切引用都是具体 versionId + checksum（技能=安装行钉住版本；方法=`resolveMethodVersion` 解析结果；W2/W3 校验读取路径按 versionId 取回字节）。并发升级/换绑不改变已记录的 basis；下一轮重新解析才拿新版本。
- **未绑定/禁用/跨 scope 不进入上下文**：Agent 必须 active（draft/disabled 明确拒绝）；方法绑定解析失败记 skipped（含原因，不静默）；过期 grant 记 pruned；跨 scope 读取拒绝。
- **任务收窄**：automation/scheduled 入口按 `agent_space_task_dependencies` 严格交集——未声明依赖的装配项 pruned（not-in-task-dependencies）、依赖 pin 与装配版本不一致 skipped、声明了但装配缺失（未安装/未绑定/未授权）skipped 并说明；无依赖记录的任务不收窄。agent_state 依赖 → 明确标注的 W5 桩 skipped。
- **预算状态包**：有效 lesson/workflow（`listEffectiveState`）按 `stateBudgetChars`（缺省 20000）预算截断，超出条目记 truncation（原因 state-budget-exceeded）；`stateOffset` 分页取余；`agentState` 槽位 status="stub" 明确标注待 W5。
- **run-basis 可解释且幂等**：`agent_space_run_basis` 表（basis_key UNIQUE）；同 key 同内容返回既有记录，同 key 不同内容 `IDEMPOTENCY_CONFLICT`（一个入口键只装配一次）；记录含 Agent、各对象固定版本、资产、状态包摘要、pruned/skipped/truncations 全量原因、入口上下文（conversation/task/run）。
- **旧 Workspace 隔离**：装配模块零 fs 依赖（不 list/grep/discover 旧 Workspace）；测试断言工作区目录为空时装配完整可用——关闭旧 default-load 不影响新对象提供依赖。未来兼容读取必须显式、按需、可观察并写入 run-basis（本模块不提供隐式兼容读取）。

## 1. 新增 API（`src/services/agent-space/assembly.ts`）

| API | 语义 | 失败契约 |
| --- | --- | --- |
| `assembleAndRecordRunBasis({scope, agentId, entryKind, basisKey, conversationId?, taskId?, runId?, stateBudgetChars?, stateOffset?, actor})` | 解析并原子记录一次运行依据；entryKind ∈ conversation / generic_automation / scheduled（conversation 须 conversationId，任务类须 taskId） | Agent 不存在/跨 scope `NOT_FOUND`/`SCOPE_MISMATCH`；非 active `INVALID_TRANSITION`；缺入口上下文 `ARGUMENT_INVALID`；同 key 异内容 `IDEMPOTENCY_CONFLICT` |
| `getRunBasis(scope, basisKey)` | scoped 最小查询面（幂等回放/审计） | 缺失 `NOT_FOUND`；跨 scope `SCOPE_MISMATCH` |

Schema：新增 `agent_space_run_basis`（第 21 张 agent_space 表；basis_id PK / basis_key UNIQUE / scope 三列 / agent_id / entry_kind / conversation_id / task_id / run_id / basis_json / created_at）+ drizzle 镜像；表计数测试 20→21。

## 2. 测试证据

`tests/agent-space-domain.test.ts` 新增组 "W4: runtime assembly — pinned run-basis, task narrowing, budget truncation, isolation"：

- conversation 入口：固定版本装配（技能=安装行版本、方法=解析版本+checksum、资产、有效 lesson 入状态包、agentState 桩标注）；同 key 幂等回放。
- **并发隔离**：技能升级 + 重装后，已记录 basis 仍持旧 versionId；下一 key 解析拿新版本；同 key 内容变化冲突。
- generic_automation/scheduled 入口：依赖交集（covered 保留、未声明资产 pruned、pin 不一致 skipped、未绑定方法 skipped missing、agent_state 桩 skipped）。
- 预算截断：极小预算产生 truncation 记录；offset 越界返回空页不报错。
- 拒绝矩阵：draft/disabled Agent、跨 scope Agent、跨 scope 读 basis、任务入口缺 taskId。
- Workspace 隔离：工作区根目录为空时装配完整可用（结构性：assembly.ts 无 fs import）。

```
node --import tsx --test --test-concurrency=1 --test-force-exit tests/agent-space-domain.test.ts   # 29/29
npm test    # 719/719（~47s 自终止）
npm run build && npx tsc --noEmit   # 0 错误
```

## 3. 待决项与交接

- **未接线生产**：三类入口的装配调用点（conversation turn / generic runner / scheduler）待接口稳定后接入；当前为纯服务层能力，模型与调度不可达。运行中输入输出/写入/交付的回填记录（run-basis 的后续段）随 W5 任务面落地。
- agent_state 注册面（W5）：依赖登记仍 fail-closed；状态包槽位 stub 待 W5 换真实注册表。
- 兼容读取旧 Workspace 的显式入口（如需）单独设计：按需、可观察、写入 run-basis；默认不挂载。
- 新技能内容存储的备份/恢复验证按裁决留在 W6/W7。
