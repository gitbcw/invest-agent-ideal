# 普通对话上下文优化设计

## 背景

当前普通消息在进入 workspace ACP 前，会由服务层构造 `ContextPacket` 并拼入 prompt。它包含最近对话、待确认事项、最新产物和状态摘要。它已经有长度限制，但仍存在三个问题：

- 正常消息每轮都依赖服务层读取和 prompt 拼装，而不是 workspace ACP 会话与 MCP 的权威查询。
- 最近对话默认按 user/instance 获取，不以 `conversationId` 过滤，可能把同一用户另一个聊天窗口的内容带入当前轮。
- 服务层与 workspace skill 同时承担“短句恢复、待确认识别、事实读取”的部分语义，难以判断最终行为由谁定义。

本设计的目标是消除普通消息的 packet 注入，不牺牲多轮对话、微信短句回复、确认流程和会话恢复能力。

## 目标

- 普通微信和门户聊天以 ACP 原生 `conversationId` 会话上下文为第一来源。
- 发生上下文依赖时，workspace skill 通过 MCP 读取权威历史和待确认项，而不是相信预注入摘要。
- 正常问答不增加额外服务查询，不降低首轮和多轮回复速度。
- 日/周/月复盘、scheduler 等显式数据工作流继续允许传递其专用、确定性的数据上下文。
- 不恢复服务层关键词路由、意图分类或 onboarding 短路。

## 非目标

- 不改变 MCP 工具、sandbox 确认流程或数据库所有权。
- 不改变 ACP 会话复用键、微信桥接和 portal connector 协议。
- 不在此改动中删除 `.sandbox-token` 兜底机制；它在 MCP 不可用时仍可由 workspace 使用，后续再单独收敛能力票据传递。
- 不把“确认/继续”改回服务层分类器。

## 目标运行时

```text
普通用户消息
  -> 微信/portal 解析可信 user + instance + workspace + conversationId
  -> workspace-scoped ACP 原生会话（conversationId）
  -> workspace AGENTS.md / skill
       -> 会话足够：直接回答
       -> 指代或确认不明确：MCP conversation.history + confirmations.pending
       -> 需要事实：对应 MCP read 工具
  -> 回复
```

服务层只传运行时元数据，不将业务状态、历史正文、待确认摘要或固定工作流指令拼入用户 prompt。`conversationId`、用户/实例和 workspace 仍作为受控 ACP/MCP 上下文传递，但不作为用户可见内容。

## 关键行为

### 1. 正常多轮聊天

ACP session 继续按 `conversationId` 复用。模型的原生会话历史是默认上下文，因此“它怎么样”“第二个展开说”不需要额外数据库读取。

### 2. 短句确认与会话恢复

workspace `AGENTS.md` 增加确定性工作约定：当原生会话不足以唯一确定“确认”“继续”“就这个”“第二个”等指代时，先调用：

1. `confirmations.pending`，检查当前 scope 的未确认写入；
2. `conversation.history`，仅查询当前 `conversationId`；
3. 仍有多个候选或无候选时，向用户澄清，不能猜测或写入。

这不是服务层分流。触发判断属于 workspace skill 对当前对话的判断，MCP 结果是权威依据。

### 3. 新会话与跨端对话

新 `conversationId` 不读取另一个聊天窗口的短期对话。若产品未来要求跨微信/门户的连续会话，应由用户显式选择“继续某会话”，并以该会话 ID 查询历史，不得隐式串接最近消息。

### 4. 专用工作流例外

仅以下路径可以保留专用 prompt 数据：

- scheduler 触发的日/周/月复盘；
- 明确构造的 review 数据采集结果；
- 不可通过 MCP 高效重取、且内容本身是本轮任务输入的确定性批处理数据。

例外 payload 必须命名为任务输入，不得复用为普通聊天 packet，也不得包含跨会话对话历史。

## 分阶段实施

### Phase 0: 先量化，不改默认行为

- 在 `src/acp/prompt-context-builder.ts` 记录 packet 的字段来源、字符数和是否跨会话命中，仅写内部 trace，不把内容写入日志。
- 用真实脱敏会话样本和服务审计建立比较基线：普通追问、多个候选、明确确认、会话重启、微信与门户并存。
- 通过一个仅开发/测试可用的开关让 packet 不注入 prompt，保留同一 ACP session，比较输出与 MCP 调用。

通过条件：无跨会话历史注入；正常追问无需新增 MCP；明确确认不会误写。

### Phase 1: MCP-first 可灰度

- 为 `buildAcpPromptContext()` 增加普通聊天模式：`legacy-packet`、`mcp-first`。默认继续 `legacy-packet`，仅指定测试助手启用 `mcp-first`。
- 在 `mcp-first` 下，普通聊天只保留用户文本和最小运行时元数据；移除 `formatContextPacketForPrompt()` 与固定服务工具指令的 prompt 注入。
- 把固定 MCP 使用规则迁移到 workspace 模板 `AGENTS.md` 和相关 skills，确保新建 workspace 同步获得规则。
- 保持 review/scheduler 调用 `reviewContext` 的路径不变。

通过条件：P0 case、onboarding workflow、短句确认和 portal/微信会话恢复全部通过；回复中不出现 MCP、token、内部路径。

### Phase 2: 默认切换与删除遗留注入

- 以助手实例为粒度灰度 `mcp-first`，先覆盖内部测试实例，再覆盖少数真实用户。
- 监控澄清率、错误写入、超时率、首 token 延迟和每轮 MCP 调用数。
- 指标稳定后令 `mcp-first` 成为默认，删除普通聊天的 packet 注入与对应的服务层 prompt 规则。
- `ContextPacket` 若仍供 model router、trace 或显式 debug 使用，必须不再含对话正文，并明确为非 prompt 数据结构。

回滚：实例级改回 `legacy-packet`，不改变数据库或 workspace 数据，因此可即时恢复。

## 实现边界

| 位置 | 变更 |
| --- | --- |
| `src/acp/agent.ts` | 普通消息选择 context mode；仍传受控 `UserContext` 给 ACP/MCP。 |
| `src/acp/prompt-context-builder.ts` | 分离 capability 准备与 prompt 构造；mcp-first 不调用普通 `buildContextPacket()`。 |
| `src/acp/mobile-prompt.ts` | 普通聊天不再附加服务层固定工作流文本；复盘 prompt 保持专用输入。 |
| `templates/workspace/AGENTS.md` | 写明 MCP-first 的事实、确认、历史恢复规则。 |
| `templates/workspace/skills/*` | 在 QA/onboarding/plan 相关 skill 中引用相同的澄清和确认纪律。 |
| `src/acp/context-packet.ts` | 如保留，仅用于非 prompt 的模型路由/trace；历史读取必须显式按 conversation scope。 |
| Tests/smoke | 覆盖 native session、MCP 恢复、跨会话隔离、无 packet 普通问答和 review 例外。 |

## 验收标准

- 普通 `mcp-first` 消息的发送 prompt 不包含“最近对话”“待确认事项”“状态摘要”或历史业务正文。
- 同 `conversationId` 连续追问在不调用 `conversation.history` 时仍正确理解引用。
- 原生会话丢失时，“确认/继续”等短句先读取当前会话的 MCP history 和 pending confirmations；歧义时只澄清、不写入。
- 不同 `conversationId` 的内容不会被隐式带入当前 prompt。
- 复盘和 scheduler 专用数据输入保持现有质量和输出约束。
- portal conversation smoke、WeChat memory smoke、MCP service-tools smoke 均通过；普通对话行为由真实交互和审计日志复核。
- 灰度指标相对 legacy：错误写入为零，P0 输出无回退，正常追问的中位回复延迟不劣化超过 10%。

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| ACP session 重启导致上下文缺失 | skill 通过 `conversation.history` 恢复；无法唯一恢复时澄清。 |
| 模型忘记调用 MCP | workspace AGENTS.md 明确规则；在 P0 case 中加入 session-miss 场景。 |
| MCP 调用增加延迟 | 仅在原生会话不足或需要权威事实时调用；正常追问不调用。 |
| 旧 workspace 未获得规则 | workspace 模板升级/迁移时补写最小规则，并在灰度前检查版本。 |
| 灰度不稳定 | 实例级开关即时回退到 legacy-packet。 |

## 执行交接

Executor prompt:

> 按本文档实施普通聊天的 MCP-first 上下文模式。不要恢复服务层意图分类或关键词路由。保留 review/scheduler 的专用确定性输入。以实例级开关灰度，并为 session 内连续追问、session 丢失后的确认恢复、跨 conversation 隔离添加自动验证。

Reviewer prompt:

> 依据本文档验收实现。重点检查普通 prompt 是否仍注入业务状态或跨会话历史，短句确认是否只依赖当前 scope 的 MCP 权威数据，以及 review/scheduler 是否被误伤。验证 P0 cases、onboarding、portal 和 MCP smoke。
