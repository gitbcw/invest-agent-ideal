# W4 交付：Agent 空间控制面与运行时装配（含 R1-R4 返工）

状态：本地实现与隔离接线验证完成；未切生产、未部署、未迁移真实用户、未启动真实任务或推送。装配模式默认关闭，按 scope 显式启用（`AGENT_SPACE_ASSEMBLY_MODE=scope:<userId,...>`）。
依据：[W4-agent-space-runtime.md](./W4-agent-space-runtime.md)、[W4 验收返工单](./W4-acceptance-review.md)（R1-R4 均已定向修复）。

## 0. 返工摘要（相对 b7eee44）

| 返工项 | 修复 | 证据 |
| --- | --- | --- |
| R1 三个枚举值≠三入口接线 | **真实入口接线**：`runtime/agent.ts` 模型边界（conversation 与 generic automation 共用 `createRuntimeAgent().handleMessage`）+ `runtime/scheduled-tasks.ts` 直连 `runMastraTurn` 的独立接缝（scheduled 不经过 runtime agent）。启用时 instructions/tools/workspace 来自装配与固定版本内容，**不回落旧 Workspace 挂载/默认技能发现，装配失败即本轮失败**；`generic-automation-runner.ts` 在启用 scope 显式标注入口。隔离测试以本地假模型网关捕获**真实入口最终发给模型的 messages/tools**，验证 pinned 内容/checksum/受限工具/无工作区注入；关闭时行为逐字不变（零 basis 写入） | 测试组 "W4 rework R1: real-entry wiring"（conversation/generic_automation/scheduled 三入口捕获 + mode-off 对照） |
| R2 入口身份与幂等范围 | 身份链核验：conversation→`conversation_sessions`（存在+scope）；task→`automation_tasks`；run→`automation_task_runs`（run→task 归属+scope）；依赖声明的执行 Agent 与本次 Agent 错配拒绝；**非法输入不落 basis/审计**。basis_key 存储**按 scope 命名空间**（不同 scope 同 key 互不冲突）；**冻结回放**：同 scope 同请求重试直接返回已冻结 basis（配置升级不拒绝合法重试），不同请求复用同 key 才冲突 | 测试组 R2 段（伪 conversation/task/run、跨 scope、同 key 双 scope、升级后冻结重试） |
| R3 空依赖放宽 + 资产未固定版本 | 任务装配**严格按依赖**：无依赖=显式空集（skipped 记 `task-declares-no-dependencies`，旧任务未迁移即未就绪）；依赖 **pin 的正式版本直接执行**（Agent 已升级不迫使其跳版本，origin=task-dependency-pinned）；资产解析 **versionId+checksum** 并保留 **input/output 角色**（latest 在装配起点解析成具体版本）；必需依赖无法解析（如仅草稿方法）**阻断且不落 basis**；未声明依赖的技能/资产不进入任务上下文 | 测试组 R3 段 |
| R4 状态桩实际检索全用户经验 | State Packet 改为**真正的空桩**：lesson/workflow 一律空、`agentState.note="not-integrated-until-W5: W4 loads no long-term state"`；不再调用 `listEffectiveState`；预算/分页/截断移到真实注入面（R1 内容预算 `AGENT_SPACE_CONTENT_BUDGET_CHARS`，逐段 keptChars/truncation 记录进 injection） | 测试组 R4 段 + 注入记录断言 |

run-basis 结构区分三段：`resolution`（冻结解析）/ `injection`（真实入口回写的实际注入段、工具清单、workspace=null；一次性写入，重放返回既有）/ `execution: {status:"pending-w5"}`（W5 待接，不宣称已覆盖）。

## 1. 接线与 API

**装配服务（`src/services/agent-space/assembly.ts`）**：`assembleAndRecordRunBasis` / `recordRunBasisInjection` / `getRunBasis`。Schema：`agent_space_run_basis` 增加 `request_json`（请求身份，冻结回放比对）与 `injection_json`（注入回写）列。

**运行时接线（`src/runtime/agent-space-context.ts`）**：
- `isAgentSpaceAssemblyModeEnabled(userId)`——默认 off；`on`/`scope:<ids>` 显式启用。
- `buildAgentSpaceTurnOptions({scope, conversationId, messageId, entryKind?, taskType?, taskId?, runId?, grantedTools, toolAllowlist?})`——冻结解析 → 方法/技能固定版本正文按预算注入（截断逐段记录）→ 资产注入 role+version+checksum 引用 → 授权即清单限制工具（空数组=零授权）→ 回写 injection → 返回模型边界 options（无 workspace）。
- 入口：`runtime/agent.ts`（conversation + generic automation，显式标注 `_agentSpaceAssembly` 优先）；`scheduled-tasks.ts`（`buildScheduledTurnDeps` 接缝，`runScheduledAgentTaskForTest` 供隔离测试）；`generic-automation-runner.ts`（启用 scope 显式标注）。

## 2. 测试证据

```
node --import tsx --test --test-concurrency=1 --test-force-exit tests/agent-space-domain.test.ts   # 30/30
npm test    # 720/720（~48s 自终止）
npm run build && npx tsc --noEmit   # 0 错误
```

关键断言：三真实入口经假模型网关捕获最终 system prompt 含 "Agent Space 装配（<entryKind>）" 与 pinned versionId/checksum/正文；空授权清单下注入工具为空数组；injection.workspace=null；关闭模式旧 instructions 逐字保留且零 basis 写入；伪/跨域/错配身份拒绝且不落行；同 key 双 scope 不冲突；升级后冻结重试返回原版本；空依赖任务空集；pin 旧正式版本执行；必需依赖不满足阻断。

## 3. 边界与待决

- **未切生产**：装配模式默认关闭；未部署、未切换真实用户、未启动真实任务/推送。W5 前不将 run-basis 宣称为完整执行链（execution 段明确 pending-w5）。
- scheduled 生产调用点的 taskId 多为调度器内部标识，未必是 automation_tasks 行——启用装配模式前须先落任务注册（W5 任务面对齐），否则身份链会明确拒绝。
- agent_state 依赖与状态包为明确空桩（W5）；依赖登记仍 fail-closed。
- 显式兼容读取旧 Workspace（如需）单独设计；内容存储备份/恢复验证留 W6/W7。
