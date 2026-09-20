# W4 交付：Agent 空间控制面与运行时装配（含 R1-R9 返工）

状态：本地实现与隔离接线验证完成；未切生产、未部署、未迁移真实用户、未启动真实任务或推送。装配模式默认关闭，按 scope 显式启用（`AGENT_SPACE_ASSEMBLY_MODE=scope:<userId,...>`）。
依据：[W4-agent-space-runtime.md](./W4-agent-space-runtime.md)、[W4 验收返工单](./W4-acceptance-review.md)（R1-R4、R5-R9 均已定向修复）。

## 0. 返工摘要（第二轮 R5-R9，相对 956f9bd）

| 返工项 | 修复 | 证据 |
| --- | --- | --- |
| R5 平台常驻指令被删 | `agent-instructions.ts` 拆出 `buildPlatformBaseInstructions({channel, agentSpaceAssembly})`：平台 L1 段（身份/能力边界/事实纪律/工具原则/通道规则）保留，【用户方法论】按模式切换——装配模式下替换为新对象契约（装配注入固定版本、无旧目录发现、修订走草案-确认-版本化），旧模式输出与拆分前逐字一致。三入口最终模型输入 = 平台段 + 装配段 | R5 段测试：captured system 同时含【能力边界】【事实与推断纪律】【工具使用原则】与"Agent Space 装配"，且不含 "methods/ 与 skills/ 目录" |
| R6 必需正文损坏仍生成输入 | 方法/技能正文读取/校验失败 → **抛错阻断本轮模型调用**（不再降级为 reference-only 成功注入；冻结 resolution 保留为失败证据）；恢复字节后同请求重试成功 | R6 段：篡改 → builder 抛错 + 装配模型调用零增长；恢复 → 同 basisKey 重试成功 |
| R7 最新创建 Agent 不稳定 | 身份解析改为：已有 basis → **沿用冻结身份**（保留 active 校验）；任务入口 → 依赖声明的显式 Agent 绑定（多绑定拒绝）；无绑定且多 active → **明确拒绝歧义**，绝不按创建时间猜 | R7 段：A 装配后新增激活 B，同请求重试仍 A 且不冲突；两 active 无绑定的新会话请求被拒 |
| R8 run→revision 链漏核验 | `verifyEntryIdentity` 补齐：修订必须真实存在、同 scope、`revision.task_id === run.task_id`（对齐 W1 快照校验）；不存在/错配/跨 scope 拒绝且不落 basis。**修正了本仓测试自身的错配夹具**（run_w4w_sched 曾错借 task_exec_1 的修订——R8 核验上线后当场拦截） | R8 段：不存在修订 NOT_FOUND、错配修订 ARGUMENT_INVALID、行数不变 |
| R9 注入记录与实际输入不符 | `recordRunBasisInjection` 改**逐尝试记录**：每次真实注入按本次实际 sections/tools 记为 attempt（与最近一次完全一致则不重复）；预算/工具授权变化的重试产生新尝试，关联同一冻结 resolution；`injection` 暴露最近一次 + `attempts` 历史 | R9 段：预算 24000→1 重试，attempt 2 记录真实截断输入（keptChars≤1），attempt 1 保留在历史 |

## 1. 返工摘要（第一轮 R1-R4，相对 b7eee44）

| 返工项 | 修复 | 证据 |
| --- | --- | --- |
| R1 三个枚举值≠三入口接线 | **真实入口接线**：`runtime/agent.ts` 模型边界（conversation 与 generic automation 共用 `createRuntimeAgent().handleMessage`）+ `runtime/scheduled-tasks.ts` 直连 `runMastraTurn` 的独立接缝（scheduled 不经过 runtime agent）。启用时 instructions/tools/workspace 来自装配与固定版本内容，**不回落旧 Workspace 挂载/默认技能发现，装配失败即本轮失败**；`generic-automation-runner.ts` 在启用 scope 显式标注入口。隔离测试以本地假模型网关捕获**真实入口最终发给模型的 messages/tools**，验证 pinned 内容/checksum/受限工具/无工作区注入；关闭时行为逐字不变（零 basis 写入） | 测试组 "W4 rework R1: real-entry wiring"（conversation/generic_automation/scheduled 三入口捕获 + mode-off 对照） |
| R2 入口身份与幂等范围 | 身份链核验：conversation→`conversation_sessions`（存在+scope）；task→`automation_tasks`；run→`automation_task_runs`（run→task 归属+scope）；依赖声明的执行 Agent 与本次 Agent 错配拒绝；**非法输入不落 basis/审计**。basis_key 存储**按 scope 命名空间**（不同 scope 同 key 互不冲突）；**冻结回放**：同 scope 同请求重试直接返回已冻结 basis（配置升级不拒绝合法重试），不同请求复用同 key 才冲突 | 测试组 R2 段（伪 conversation/task/run、跨 scope、同 key 双 scope、升级后冻结重试） |
| R3 空依赖放宽 + 资产未固定版本 | 任务装配**严格按依赖**：无依赖=显式空集（skipped 记 `task-declares-no-dependencies`，旧任务未迁移即未就绪）；依赖 **pin 的正式版本直接执行**（Agent 已升级不迫使其跳版本，origin=task-dependency-pinned）；资产解析 **versionId+checksum** 并保留 **input/output 角色**（latest 在装配起点解析成具体版本）；必需依赖无法解析（如仅草稿方法）**阻断且不落 basis**；未声明依赖的技能/资产不进入任务上下文 | 测试组 R3 段 |
| R4 状态桩实际检索全用户经验 | State Packet 改为**真正的空桩**：lesson/workflow 一律空、`agentState.note="not-integrated-until-W5: W4 loads no long-term state"`；不再调用 `listEffectiveState`；预算/分页/截断移到真实注入面（R1 内容预算 `AGENT_SPACE_CONTENT_BUDGET_CHARS`，逐段 keptChars/truncation 记录进 injection） | 测试组 R4 段 + 注入记录断言 |

run-basis 结构区分三段：`resolution`（冻结解析）/ `injection`（真实入口回写的实际注入段、工具清单、workspace=null；**逐尝试记录**——预算/工具授权变化的重试追加新尝试并关联同一冻结 resolution，与最近一次完全一致不重复；956f9bd 旧结构读取时无损归一化为第一条历史尝试，保留原时间戳/内容，不清库）/ `execution: {status:"pending-w5"}`（W5 待接，不宣称已覆盖）。

## 第三轮返工（R5 续/R9 续 + 真实入口证据补齐，相对 c64b662）

- **R5 续**：通道段（`buildChannelContextInstruction`）并入 `buildPlatformBaseInstructions` 统一拼接——新模式与旧模式同源、不重复拼接；web 与 weixin-mobile **真实入口**捕获的最终 system prompt 分别含各自【通道上下文】规则；旧模式同通道输出保持一次拼接（agent-instructions 3/3 测试通过）。
- **R9 续**：旧 injection JSON（956f9bd 合法结构，无 attempts）读取时**无损归一化**为第一条历史尝试——同请求重试不崩溃、原时间戳/sections/tools 保留、不重复历史；预算/授权变化正确追加。升级重放测试使用上一版**真实注入内容**的旧形态。
- **R6 真实入口证据**：Method 校验失败（conversation 真实入口）与 Skill 固定字节缺失（scheduled 真实接缝）都断言**装配模型调用零增长**（此前仅 builder 级证据）；恢复字节后同请求在真实入口重试成功。阻断轮的 resolution basis 可保留为失败证据，但注入记录必为空。
- **R9 真实证据**：非空服务工具授权变化逐尝试比对——attempt 1 记录授权工具、attempt 2 记录空授权，与各次实际发送一致。

## 1. 接线与 API

**装配服务（`src/services/agent-space/assembly.ts`）**：`assembleAndRecordRunBasis` / `recordRunBasisInjection` / `getRunBasis`。Schema：`agent_space_run_basis` 增加 `request_json`（请求身份，冻结回放比对）与 `injection_json`（注入回写）列。

**运行时接线（`src/runtime/agent-space-context.ts`）**：
- `isAgentSpaceAssemblyModeEnabled(userId)`——默认 off；`on`/`scope:<ids>` 显式启用。
- `buildAgentSpaceTurnOptions({scope, conversationId, messageId, entryKind?, taskType?, taskId?, runId?, grantedTools, toolAllowlist?})`——冻结解析 → 方法/技能固定版本正文按预算注入（截断逐段记录）→ 资产注入 role+version+checksum 引用 → 授权即清单限制工具（空数组=零授权）→ 回写 injection → 返回模型边界 options（无 workspace）。
- 入口：`runtime/agent.ts`（conversation + generic automation，显式标注 `_agentSpaceAssembly` 优先）；`scheduled-tasks.ts`（`buildScheduledTurnDeps` 接缝，`runScheduledAgentTaskForTest` 供隔离测试）；`generic-automation-runner.ts`（启用 scope 显式标注）。

## 2. 测试证据

```
node --import tsx --test --test-concurrency=1 --test-force-exit tests/agent-space-domain.test.ts tests/agent-instructions.test.ts   # 32/32 + 3/3
npm test    # 722/722（~48s 自终止）
npm run build && npx tsc --noEmit   # 0 错误
```

关键断言：三真实入口经假模型网关捕获最终 system prompt 同时含平台 L1 段与 "Agent Space 装配（<entryKind>）"（pinned versionId/checksum/正文）；空授权清单下注入服务工具为空数组；injection.workspace=null；关闭模式旧 instructions 逐字保留且零 basis 写入；伪/跨域/错配身份（含 run→revision 链）拒绝且不落行；同 key 双 scope 不冲突；升级后冻结重试返回原版本、身份不因新增 Agent 漂移；空依赖任务空集；pin 旧正式版本执行；必需依赖不满足与必需正文校验失败阻断（模型零装配调用）；预算变化重试的注入记录逐尝试反映实际输入。

**工具断言口径**：`injection.tools` 记录的是经装配下发的**服务工具**；外部 MCP 数据工具是另一条传入模型的路径（`toolsets`），不在此清单内也不因装配模式被无差别禁用。隔离环境无外部 MCP，测试断言"记录的服务工具 ⊆ 模型请求工具"。**generic automation 覆盖口径**：验证到 runtime agent 的 handleMessage 接缝（启用 scope 由 runner 自身的 `assemblyEntryAnnotation` 标注入口），未驱动 generic runner 完整上游执行流程——不将手动标注等同全入口覆盖。

## 3. 边界与待决

- **未切生产**：装配模式默认关闭；未部署、未切换真实用户、未启动真实任务/推送。W5 前不将 run-basis 宣称为完整执行链（execution 段明确 pending-w5）。
- scheduled 生产调用点的 taskId 多为调度器内部标识，未必是 automation_tasks 行——启用装配模式前须先落任务注册（W5 任务面对齐），否则身份链会明确拒绝。
- agent_state 依赖与状态包为明确空桩（W5）；依赖登记仍 fail-closed。
- 显式兼容读取旧 Workspace（如需）单独设计；内容存储备份/恢复验证留 W6/W7。
