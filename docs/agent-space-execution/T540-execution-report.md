# T-540 执行报告：失败问题处理对话与 Agent 纠错候选（P3）

状态：**执行完成，验收点全部达成。** 日期：2026-09-21。
契约：[T540-issue-conversation-correction-candidates-contract.md](./contracts/T540-issue-conversation-correction-candidates-contract.md)。

## 交付内容

### 1. 问题处理会话

`src/services/attention-items.ts` `openAttentionConversation`（复用 continueAutomationRunInChat 模式）：
- 会话 metadata 绑定 attentionItemId/taskId/runId（origin=attention_issue）；同一失败事项重开**复用**同一会话；
- system 注入脱敏失败摘要（发生时间/累计次数/直接影响/系统状态 + 人话解释与方案指引 + 「不要展示错误码、堆栈或内部版本号」边界指令）；
- Portal：待处理卡片「让 Agent 解释并处理」接通 → POST 创建/复用 → 跳转 `/chat?conversationId=…` 进入正常对话轮（Agent 在 scope 内解释，持久修改仍走各对象契约）。

### 2. 纠错候选模型工具面（端到端补齐）

- `src/mastra/tools/tool-specs.ts` + `registry.ts` MASTRA_EXPOSED_TOOL_IDS：`state.candidate.propose` / `state.candidate.revise`（交互会话面；**approve 永不暴露**）；
- `src/mcp/service-tools-core.ts` handler：**owner 由请求上下文强制派生**（conversation 优先、task 次之；模型不可自报）；无两者之一结构性拒绝（STATE_CANDIDATE_NO_OWNER_CONTEXT）——不存在脱离会话/任务的自主反思路径；workflow 强制 steps 数组；
- `service-tool-classification.ts`：分类 other-write；**不进 scheduled grant 白名单**（自动化轮默认无候选权；失败候选按设计发生在问题处理会话——交互轮）；
- 候选工具返回携带「已保存草稿、需用户批准、请向用户说明」的话术契约。

### 3. 候选审阅（Portal）

- `src/services/agent-space/state-portal.ts`：draft 读模型（触达分流 surface=conversation/task、此前同类被拒标记 previouslyRejected）、`portalApproveStateCandidate`（portal 凭证登记→approveStateCandidate 消耗，绑定 extraBinding.kind 对齐 R9）、`portalRejectStateCandidate`（rejected 终态）；
- connector：`attention.open_conversation` / `state.candidates.list / state.candidate.approve / state.candidate.reject`；
- 待处理页新增「待确认改进」低优先级区块（设计 §9.2 第三类触达：默认不微信提醒）：候选卡片（类型/标题/触发/处置/来源）+ 批准生效/拒绝按钮。

## 验证证据

- **结构性断言**（tests/agent-space-state-candidates.test.ts 6/6）：工具面只暴露 propose/revise 且无 approve；无上下文调用被拒；三个 scheduled grant 均不含候选工具；draft 不进 buildScopedStatePacket 默认注入（exclusions 留审计记录）；
- **生命周期**：会话内提案→draft（pending 可见）→portal 批准（凭证消耗）→进入有效状态面；拒绝终态 + 同 owner 同标题新草案标记 previouslyRejected（不重复打扰依据）；
- **问题会话**：metadata 绑定、脱敏 system 注入、重开复用；
- **全量**：主仓 `npm test` 752/752 全绿（新增 6 例；工具面一致性测试 44→46 更新）；Portal 53/53；双侧 tsc 零错误；
- **隔离环境端到端**（真实工具路径构造 + curl 走查）：失败事项→问题会话（attention-xxx 创建）→会话上下文内 propose（draft 落库）→Portal 候选列表可见（surface=conversation）→批准生效（pending 清空）→问题会话重开复用（reused=true）。

## 与契约的偏差（如实记录）

1. **自动化 task run 内提案未开放**：候选工具不进 scheduled grant 白名单（契约允许的受控范围内选择——设计 §9.2 失败候选附着「同一失败问题处理会话」即交互轮路径；task run 轮开放需 owner 显式授权加入 grant，执行报告记录待裁决）。
2. 当前对话候选「当前会话内展示」由候选工具返回的话术契约驱动（Agent 向用户说明），非独立卡片组件——会话内渲染属于聊天 UI 的自然文本流，与设计 §9.2「当前对话的候选卡片」语义一致但形式从简。
3. 候选批准后的「连接到方法/Skill/任务各自主管理入口」：lesson/workflow 候选批准后是 agent-space 状态对象（非方法/Skill 版本），其管理入口属 Agent 状态控制面（不向普通用户暴露）；本契约落地的是批准/拒绝动作与状态事实，对象级深链按设计 §9.2 由候选内容自述适用范围。若 owner 期望候选直接生成方法/Skill 版本草案，需另立任务扩展。
4. 拒绝后「重复打扰」控制当前为读模型标记（previouslyRejected）+ 工具话术提醒，未在工具层硬阻断同标题再提案（Agent 判断新事实场景属合法触发）。

## 遗留到 T-541

- 浏览器完整走查（含聊天页问题会话体验）；
- 生产发布建议清单。
