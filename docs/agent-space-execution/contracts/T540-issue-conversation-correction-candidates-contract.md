# T-540 实施契约：失败问题处理对话与 Agent 纠错候选（P3）

任务：os-mcp T-540（executor: agent）。前置：T-539（attention 事实与待处理页已就绪）。
设计依据：[正式设计 §7.3/§9](../../agent-space-user-product-design.md)；差距：[T537-gap-analysis D6/D7/A6/U7/U8](../T537-gap-analysis.md)。

## 目标

111 隔离环境打通两件事：① 失败事项 → 问题处理对话（受限上下文绑定、人话解释）；② Agent 纠错候选端到端（模型工具面 → 草案 → 用户审阅 → 批准生效链路），候选永不自动生效。

## 输入

- T-539 产物：attention_items 及 `attention.get` 读模型、待处理页「让 Agent 解释并处理」入口占位。
- 服务层已有：`state.ts` 的 `createStateCandidate / reviseStateCandidate / approveStateCandidate`（lesson/workflow 版本与批准机制）、`buildScopedStatePacket`（运行注入）；模型工具注册表现状（candidate 工具未暴露）。
- 会话链路：conversation.* connector 面、`buildAgentSpaceTurnOptions`（conversation 入口装配）。

## 工作内容

1. **问题处理会话**：
   - 会话绑定：conversation 增加轻量绑定（新表 `attention_conversations` 或会话标记，契约执行时按现有会话模型选最小方案）：attention_item_id + 受限上下文句柄（失败 run、任务、最近投递事实的**引用**而非原文）；
   - 创建路径：待处理卡片「让 Agent 解释并处理」→ Portal 创建/打开绑定会话；失败候选附着同一失败事项的会话；
   - 上下文注入：会话首轮注入失败事实摘要（用户语言，脱敏：无错误码/trace/工具调用/内部版本），Agent 在 scope 内解释并提出方案（重试/改任务/暂停/补资料/保存候选）；
   - 所有持久修改仍走各对象服务契约（复述设计 §7.3，不因会话存在而旁路）。
2. **纠错候选模型工具面**：
   - 在受 scope/入口约束的运行（交互会话与自动化 task run）工具集新增 `state_candidate_propose / state_candidate_revise`（仅 create/revise，无 approve）；
   - 服务端校验：候选必须绑定实际会话或任务运行 + 事实引用（run/outcome/attention id）；入口类型与 scope 校验失败即拒绝；
   - 无任务/无会话上下文的独立反思调度路径**不存在**（结构性保证，测试断言）。
3. **候选触达与审阅**：
   - 当前对话候选 → 当前会话候选卡片；失败运行候选 → 同一失败问题会话（不另发微信）；无当前影响候选 → 低优先级网页待确认改进（待处理页第二区块，默认不微信）；
   - 卡片字段：适用范围、事实依据、预期改变、影响；
   - 批准/拒绝连到既有 `approveStateCandidate` 与对应对象主管理入口（方法/Skill/任务各自页面显示批准结果）；拒绝后无新事实或实质变化不得重复打扰（去重键）。
4. **隔离验证数据**：在 T-539 失败反例上构造 1 条会话内候选 + 1 条失败附着候选 + 1 条低优先级候选；验证批准前 run-basis 默认注入不含候选内容（draft 不注入）。

## 边界（红线）

- 候选不直接改变默认行为、方法、Skill、任务、偏好、权限或工具范围；唯一生效口是用户显式批准（approveStateCandidate）。
- 禁止后台因失败另起 Agent 诊断/反思运行；后台只做既有事实记录与事项更新（T-539 面）。
- 问题会话不向用户显示原始内部日志；不把会话当成长期规则来源。
- 不改生产、不部署。

## 验收

- 隔离环境端到端（真实模型链路）：从失败卡片进入问题会话获得人话解释与方案；会话中 Agent 提出的候选出现在候选卡片；批准后对应对象状态变化可查（方法版本生效示例）；拒绝后同内容候选不再提示；
- 结构性断言（测试）：无会话/任务上下文时 candidate 工具调用被拒；approve 不在模型工具面；draft 不进 buildScopedStatePacket 默认注入；
- 三类触达路径的展示与不打扰规则经浏览器走查确认；
- `npm test` 全绿。

## 失败与上报

- conversation 模型加绑定字段的迁移风险超预期（会话表高频写）：改用独立绑定表并在报告说明取舍；
- 模型工具注册机制与 run 入口（thinking-depth-router 等）存在未预见耦合：停止并报告具体冲突，不得为接入而放宽 scope/入口校验。
