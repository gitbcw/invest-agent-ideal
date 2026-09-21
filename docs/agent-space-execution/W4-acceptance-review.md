# W4 独立验收与返工单

日期：2026-09-20。提交b7eee44；依据W4执行稿及v3。结论：**Partial，不放行W5完整实施；允许按已约定保留显式空State Packet接口桩。** 当前交付是装配记录原型，不是三条实际运行入口接管。

## 证据

重跑域测试29/29通过；阅读assembly.ts全部实现、schema与交付文档。独立临时DB直接调用装配器：不存在conversationId成功；不存在taskId/runId成功；两用户使用相同basisKey，第二用户发生IDEMPOTENCY_CONFLICT。未发现跨用户内容泄露，不将键冲突夸大为泄露。临时数据已清理。全仓719项/build为执行方报告。

## R1 [P1] 三个枚举值不是三入口接线

提交未改runtime/agent.ts、generic-automation-runner.ts或scheduled-tasks.ts；搜索这些实际入口无新装配调用。没有fs import及空目录fixture不能证明实际运行已排除旧挂载/Skills发现。现网不切换是正确边界，但不意味着本地不实现接线。

实现默认关闭、只在隔离scope显式启用的新路径，分别从真实三入口调用resolver，传入固定内容与受限工具到模型边界。用注入模型/工具的隔离测试检查真实入口最终messages/tools/workspace；不要求真实模型或生产执行。新模式不得回落旧根；普通旧模式未切换时保持兼容。run-basis要区分解析、实际注入/裁剪与后续执行产物，后续W5结果段可明确待接，不能宣称已覆盖。

## R2 [P1] 入口身份和幂等范围不成立

仅检查ID字符串非空，未核对conversation/task/run的真实存在、scope及归属关系。独立实测伪ID可登记。basis_key全局UNIQUE，第二用户同key冲突。

验证真实身份链（run→revision/task→scope、conversation→scope、Agent/任务关系），非法输入不落basis/审计。唯一键与查询按scope命名空间，增量迁移保留已有记录。同scope相同请求后续重试读取已冻结basis；不能在最新配置上重算后因配置升级而拒绝合法重试。真实不同请求/上下文用同键仍冲突；动作时当前撤权校验另行保留。

## R3 [P1] 任务空依赖放宽范围且资产未固定版本

代码在deps.length===0时保留Agent全部skills/methods/assets，违背任务显式绑定输入范围。资产条目仅含assetId，未解析版本/checksum；asset_input/output合并Map也丢失角色及不同版本策略。依赖旧pin与Agent新版本不一致只skip，不能支持已授权任务固定旧正式版本继续运行。

任务无依赖时显式空集或阻塞（按是否需要输入），不得扩大为Agent全部资产；需要迁移的旧任务标记未就绪。逐任务revision解析技能/方法/输入输出版本，校验采用许可与授权，保留角色；latest也在运行起点解析成具体版本/hash。必需依赖不满足应阻断对应执行，不把空装配记录当可运行成功。

## R4 [P1] 状态桩实际检索全用户经验，截断记录不对应内容

assembly.ts调用listEffectiveState获取同用户全部lesson/workflow，忽略ownerKind/ownerId与场景，丢弃所属信息后加入packet。同用户不同Agent/任务经验可混入。记录所谓preview截断，但packet只有title/id/contentChars，没有实际截断正文；不能据此证明模型内容预算受控。

本阶段采用此前已允许的方案：真正空State Packet桩，lesson/workflow也空，并明确not-integrated，完整检索留W5；或实现真实作用域过滤与有预算正文，但不得混称空桩。W4仍须对技能/方法/资产最终模型输入验证预算、分页、版本固定，记录实际内容覆盖；W5未来补查共用预算，不通过重复offset绕过。

## 验收清单

- 三条实际入口的隔离调用捕获到新模式上下文，旧Workspace/默认Skills不可达；未启用scope行为保持原样。
- 伪/跨域/错配conversation-task-run拒绝；不同scope同key互不冲突；同请求配置变化后仍用原basis。
- 任务空依赖不扩大可见范围；旧pin按已授权版本工作或明确阻塞；资产固定version/checksum/role。
- W5空桩确实不加载任何长期状态；或者实现并证明所属范围过滤和真实预算，不能只检查计数。
- 更新W4-delivery撤回“全部引用已有版本”“三入口覆盖”“无fs即退出”的过度结论。

给执行Agent：定向修R1–R4，优先确认真实入口与模型边界的测试注入点，范围仍是本地/隔离接线。不得部署、切换真实用户、启动真实任务或推送；不重写调度器。按每项列出实现与运行证据后复验，W5完整闭环待本阶段通过。

## 第二次验收：956f9bd（2026-09-20）

结论：**Partial，W4 尚不收口，W5 完整实施仍待放行。** 本轮已完成实质接线，不再是仅有枚举值的原型；剩余问题集中在真实输入失败处理、执行身份、身份链与注入记录一致性。仅修改本验收文档，未修实现、未触碰生产。

### 本轮证据与已通过部分

独立重跑 `node --import tsx --test --test-force-exit tests/agent-space-domain.test.ts`：30/30 通过，包含本地假模型网关。另建独立临时 DB 探针，复用测试文件的 fixture 初始化而不运行其测试主体，直接调用真实装配函数；以下四个反例全部复现。临时脚本与 DB 已清理。全仓 720/720、build/tsc 为执行方报告，本轮未重复执行，不表述为独立验证。

| 原项 | 本轮判定 | 证据与边界 |
| --- | --- | --- |
| R1 实际入口接线 | Partial | runtime agent 与 scheduled 的真实模型调用已接入；默认关闭分支保留。generic 测试是直接调用 handleMessage 并手动标注入口，未驱动 generic runner 的上游执行流程。新模式平台指令丢失见 R5。 |
| R2 身份与冻结 | Partial | scope 命名空间、伪 conversation/task/run 拒绝、显式 agentId 下冻结版本测试通过；运行时自动选 Agent 与 revision 链仍有缺口，见 R7/R8。 |
| R3 依赖范围与版本 | Partial | 空依赖返回空集、旧 pin、资产 version/checksum/role 已实现并通过域测试；必需正文读取失败被吞，见 R6。 |
| R4 空状态桩与预算 | Partial | 长期状态确实不加载，空桩部分通过；正文预算存在，但重试时注入记录与实际输入不符，见 R9。 |

### R5 [P1] 新模式把平台常驻指令一起删除

位置：`src/runtime/agent.ts:473`、`src/runtime/scheduled-tasks.ts:402`、`src/runtime/agent-space-context.ts:113`。启用新模式后 instructions 完全替换成装配标头、用户方法/技能正文与空桩说明，未组合平台基础指令，也未传入 channel。直接检查 builder 返回值，事实与推断纪律、工具使用原则均缺席。此处是指令回归，不声称服务层权限因此被绕过。

依据：`docs/context-and-prompt-architecture.md` 的 L1 仍规定身份、能力边界、投资纪律、事实标准与通道政策属于服务代码；退出旧 Workspace 不等于删除 L1。不能简单原样拼回旧提示词，因为它还要求读取 methods/skills 旧目录。

通过标准：拆分或参数化平台基础段，保留仍有效的平台身份/事实纪律/能力边界/服务工具原则/通道呈现规则，将旧文件发现和写入引导替换为新对象契约。三入口最终模型输入须同时具备平台段和新装配段，且不重新出现旧目录默认发现要求；旧模式兼容测试保持。

### R6 [P1] 必需正文损坏仍被当成可执行输入

位置：`src/runtime/agent-space-context.ts:137`、`:150`。方法/技能读取异常被 catch 后，仅追加 section 原因，随后按 reference-only 继续，最终返回可供模型执行的 instructions 并写 injection。

独立复现：建立已批准真实字节方法，将 task_exec_1 的必需依赖 pin 到它；篡改对应 strategy.md，调用 `buildAgentSpaceTurnOptions`（generic_automation）。调用成功返回，注入记录同时含 `content read failed: ASSET_CHECKSUM_MISMATCH:ver_w2_1` 与同一方法的 reference-only。必要方法实际没有正文，却未阻止后续模型调用。

通过标准：已解析且需注入的方法/技能无法读取、校验失败或固定内容缺失时，阻断模型调用；可保留解析记录/失败证据，但不得标成成功注入。恢复正确字节后，同请求可重试成功。至少覆盖必需 Method 校验失败及 Skill 固定字节缺失，两者都在真实模型边界断言零调用；禁止退回旧 Workspace。

### R7 [P1] 最新创建 Agent 不是稳定执行身份

位置：`src/runtime/agent-space-context.ts:46`、`:96`。每次先按 created_at/rowid 选择最新 active Agent，再查 basis；创建新 Agent 会改变已有会话/任务的执行身份。任务依赖绑定原 Agent 时，还可能选中新 Agent 后才报错。

独立复现：Agent A 成功装配 `conversation:conv_w1:message:review-1`；同 scope 创建并激活 B；同一请求再次调用 builder，报 `AGENT_SPACE_IDEMPOTENCY_CONFLICT`。底层显式传 agentId 的冻结测试不能证明真实入口重试成立。

通过标准：入口使用可信的显式 Agent/任务绑定；已有 basis 重试沿用冻结身份，并保留当前停用/撤权校验。无绑定且多 Agent 时明确拒绝歧义，不得按创建时间猜测。测试 A 的任务在新增 B 后仍由 A 装配，以及同请求重试不换身份；不要求在本阶段新增完整 Agent 选择 UI。

### R8 [P1] run→revision→task 身份链漏核验

位置：`src/services/agent-space/assembly.ts:293`。查询取得 revision_id，却未读取修订行，也未验证修订存在、同 scope、属于当前 task。

独立复现：将隔离 run_w1_1 的 revision_id 改为 nonexistent-revision，其他 run/task/scope 保持有效；scheduled 装配成功并生成 basis。现有 scheduled 接线测试本身也将 task_w4w_sched 的 run 关联到属于 task_exec_1 的 rev_w1_1（`tests/agent-space-domain.test.ts:1879`），错误 fixture 因此被当成成功证据。

通过标准：复用或对齐 W1 快照的 run/revision/task/scope 校验；不存在、其他任务、跨 scope 修订一律拒绝且无新增 basis/审计。修正 scheduled 正向夹具为真实匹配修订，并保留错配反例。此项不要求重写调度器，也不要求现在对齐生产旧 scheduled 任务注册。

### R9 [P2] 重试实际输入变化，注入记录仍声称是第一次

位置：`src/runtime/agent-space-context.ts:112`、`:183`；`src/services/agent-space/assembly.ts:215`。每次重试重新计算正文预算和工具集合，但 recordRunBasisInjection 遇到已有 injection_json 就直接返回，既不核对新注入，也不记录新尝试；调用方忽略该返回值，继续发送新 instructions。

独立复现：第一次正常注入方法正文（keptChars=19）；把 AGENT_SPACE_CONTENT_BUDGET_CHARS 改为 1，再用同 message/basisKey 调 builder。实际 prompt 已不含原正文，samePrompt=false，但 basis 的 injection 仍记录 keptChars=19。这会使“实际注入记录”无法解释真实请求。工具集合变化同样存在此代码路径，尚未单独动态复现。

通过标准：冻结解析与真实注入采用一致契约。可冻结并重用原注入方案（同时保留当前授权校验），或按执行尝试保存真实注入记录并关联同一冻结 resolution；不得静默返回旧记录却发送新内容。补预算变化、工具授权变化、失败恢复重试的模型边界/记录一致性断言，记录须能指向对应尝试。

### 下一轮执行与证据要求

- 定向修 R5–R9，保留本轮已通过的 scope 隔离、空依赖、固定版本和真空状态桩。
- 真正驱动 generic runner 的隔离入口，或明确说明目前只验证下游 handleMessage 接缝，不再把手动标注等同全入口覆盖。
- 当前“空 tools”断言检查的是 basis.injection.tools；外部 toolsets 是另一条传入模型的路径。下一轮在捕获请求中分别检查服务工具与外部数据工具，准确说明授权范围；不要把服务工具空集合表述成模型总工具集合为空，也不要求无差别禁用已获准的外部只读能力。
- 更新 W4-delivery 的已完成/未覆盖边界。仍只本地隔离验证，不部署、不迁移真实资产、不启动真实任务或推送。

## 第三次验收：c64b662（2026-09-20）

结论：**Partial，剩余返工收窄为 R5 通道段、R9 旧记录兼容及相应验证；W5 尚未放行。** 不重开已修好的身份选择与修订链问题。

### 复验结果

独立执行 `node --import tsx --test --test-force-exit tests/agent-space-domain.test.ts tests/agent-instructions.test.ts`，34/34 通过（31 域测试 + 3 指令测试）。读取本次完整相关 diff 与新测试；另用独立临时 DB 调用真实 builder，确认下述两条反例。临时探针及数据已清理。全仓 721/721、build/tsc 仍为执行方报告，本轮未重复运行。

| 项目 | 本轮判定 | 事实 |
| --- | --- | --- |
| R5 平台指令 | Partial | 平台身份/事实纪律/能力边界与新对象方法论已恢复；旧模式字符串拆分保持原结构。但新模式通道段仍缺失。 |
| R6 正文失败阻断 | 实现通过，入口证据待补 | method/skill catch 均改为抛错，恢复字节可重试。现有测试只直接调用 builder，未实际驱动失败入口；Skill 缺失反例尚未补齐。 |
| R7 稳定身份 | Pass | 删除按创建时间猜测；冻结身份复用、任务依赖绑定、无绑定多 Agent 拒绝、冻结 Agent 停用拒绝均有明确实现；相关测试通过。 |
| R8 修订链 | Pass | 修订存在/归属/scope 核验齐全，scheduled 正向夹具已修正；不存在和错配拒绝测试通过。 |
| R9 注入记录 | Partial | 新建记录的预算变化可保留历史与最新摘要；上一提交实际生成的旧 JSON 形态无法重试。 |

### R5 续：[P2] channel 参数传到了不使用它的函数

`src/runtime/agent-space-context.ts` 调用 `buildPlatformBaseInstructions({channel, agentSpaceAssembly:true})`。但 `src/runtime/agent-instructions.ts` 的该函数只返回 base，真正的 `buildChannelContextInstruction(channel)` 拼接仍只在旧入口 `buildAgentInstructions` 中。因此传参并没有让新模式包含通道段。

独立复现：仅一个 active Agent，分别用 `channel='web'`、`channel='weixin-mobile'` 调用 builder。两个输出均不含 `【通道上下文】`，也均不含对应 `buildChannelContextInstruction` 的完整返回值。现有新模式测试用 api 且只断言平台通用段；旧模式 channel 测试无法覆盖这个遗漏。

通过标准：在新模式明确组合对应通道政策，避免旧模式重复拼接；保留不发现旧 Workspace 的约束。用 web 与 weixin-mobile 的真实入口捕获最终 system prompt，分别断言实际通道规则存在；旧模式相同通道输出维持原样。交付文档的“通道规则完整保留”须在此验证通过后才能成立。

### R9 续：[P2] 旧 injection JSON 升级后重试直接崩溃

`src/services/agent-space/assembly.ts` 的 `recordRunBasisInjection` 把所有已有 injection_json 强制视作含 attempts 的对象，直接访问 `previous.attempts[previous.attempts.length - 1]`。上一提交 956f9bd 产生的合法结构只有 sections/tools/workspace/injectedAt，没有 attempts。TypeScript 类型断言不会转换已存数据。

独立复现：先正常生成 basis，再将其 injection_json 设为上一提交的合法结构（保留真实 sections、tools、workspace、injectedAt，去掉 attemptNo/attempts）；同请求再次调用 builder，抛 `TypeError: Cannot read properties of undefined (reading 'length')`。这属于本地既有 W4 数据的升级兼容问题，不声称生产已受影响。

通过标准：读取旧记录时无损归一化为第一条历史尝试，或提供幂等增量迁移；不得清库规避。旧时间戳、sections、tools、冻结 resolution 均保留；相同重试不崩溃，预算/工具变化后正确追加，重复升级不重复历史。增加带上一版实际 JSON 的升级重放测试。交付文档仍有“injection 一次性写入，重放返回既有”的旧描述，一并同步。

### 验证证据修正（沿用既有 R6/R9 标准，不扩大实现范围）

当前 R6 用例在假网关开启时直接调用 builder，然后断言捕获数不增长；builder 无论成功失败都不会调用模型，因此该断言不能证明“真实入口零模型调用”。恢复分支同样只检查返回字符串。R9 的预算变化也只在 builder 层验证，工具子集断言取的是较早的模型请求且当前注入清单为空。

下一轮补齐原返工单要求的窄验证：通过实际 runtime/scheduled 接缝触发 Method 校验失败及 Skill 内容缺失，断言装配模型调用未发生，恢复后同请求成功；对预算和非空服务工具授权变化，比较对应捕获请求与该次记录。若只验证 builder，报告中明确称为 builder 级证据，不能命名为模型边界证明。无需真实模型、生产任务或推送。

给执行 Agent：本轮只续修 R5/R9 两个具体遗漏、补上述既定验收证据并同步 W4-delivery；保留已通过实现，不另做平台扩展。仍保持默认关闭，不部署、不迁移真实数据。

## 第四次验收：ece123c（2026-09-20）

## Acceptance Verdict

Status: **Pass with caveats — W4 收口，放行 W5。**

W4 的本地、默认关闭接线目标已完成：三类模型边界均可走 Agent Space 装配，平台 L1 与通道政策未被 Workspace 退出一并删除，固定内容校验失败不再到达模型，任务/运行身份链、Agent 身份与注入记录也具备可解释的冻结和重试语义。未发现阻断 W5 的实现缺口。本结论不代表生产切换、真实迁移、调度启用或旧 Workspace 退出已发生。

## Acceptance Checklist

| Area | Requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| R5 平台与通道指令 | 新模式保留 L1 且不恢复旧目录默认发现；web/微信政策均实际注入 | Pass | `src/runtime/agent-instructions.ts`；round-3 假网关 web、weixin-mobile 测试 | `buildPlatformBaseInstructions` 统一组合通道段；旧模式测试也通过，未重复拼接。 |
| R6 固定正文失败 | 方法/技能内容校验失败阻断真实模型调用，恢复后可重试 | Pass | `src/runtime/agent-space-context.ts`；round-3 conversation 与 scheduled 假网关测试 | 域测试输出中 scheduled 会记录预期错误，但断言证明网关零调用、恢复后成功。 |
| R7 稳定执行身份 | 冻结重试不换 Agent；多 Agent 无可信绑定拒绝 | Pass | `resolveAssemblyAgentId`；R5-R9 测试 | 任务依赖单一 Agent 优先，已有 basis 复用冻结身份并检查仍 active。 |
| R8 run/revision/task | revision 存在、scope、归属均核验，失败不落 basis | Pass | `src/services/agent-space/assembly.ts`；R8 反例测试 | 同时修正了此前 scheduled 正向夹具的错误 revision。 |
| R9 逐尝试与升级 | 预算/授权变化保留实际注入历史；956f9bd 旧 JSON 可重试 | Pass | `parseInjectionAttempts`；round-3 升级重放测试 | 旧结构在读路径无损归一化为 attempt 1；相同重放不增历史，变化追加 attempt 2。 |
| 总体验证 | 相关隔离测试与平台指令测试可重复通过 | Pass | `node --import tsx --test --test-force-exit tests/agent-space-domain.test.ts tests/agent-instructions.test.ts` | 独立执行结果 35/35。执行方报告的全仓 722/722、build/tsc 本轮未重复，故不作为本轮独立证据。 |

## Caveats carried into W5

- generic automation 已验证到其下游 `handleMessage` 模型边界；未做 runner 的完整上游端到端驱动。该限制已在交付文档如实披露，不影响本轮确认的装配接缝。
- scheduled 真实生产 taskId 与 `automation_tasks` 的注册对齐仍是 W5 前置；装配模式保持默认关闭。
- W4 State Packet 仍是明确空桩。W5 必须把状态检索、预算、履约和执行结果接入，不得把本轮空结果包装成已具备长期记忆。

## Verification Performed

- 阅读 `ece123c` 的运行时、指令、装配与测试 diff。
- 独立重跑上述 35 项测试：全部通过。
- 复核第三轮此前的两项反例：web/weixin-mobile builder 输出含对应通道政策；旧 injection JSON 重试不再 TypeError，归一化保留原时间戳和内容。

## Follow-Up Checklist

- [ ] 按 [W5 执行稿](./W5-tasks-state-commitments.md) 落地任务 revision、状态与承诺闭环；保持 W4 装配开关关闭。
- [ ] W5 验收时单独核对 generic runner 上游调用链和 scheduled 任务注册，不将本轮隔离接线升级为生产证据。
