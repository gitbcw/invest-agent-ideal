# 会话逻辑连贯性补齐设计

日期：2026-08-21  
状态：已实现，待生产灰度验收  
适用基线：`feat/mastra-migration`

## 1. 背景与证据

Mastra 迁移后的运行时每轮新建 Agent，不保留进程内会话状态；当前上下文由 `conversation_messages` 重新装配。原始历史默认最多 24 条消息、每条 2400 字、总计 24000 字，超限时优先丢弃最旧内容。因此，长会话中的早期决定、后续修订和最终确认不能稳定同时进入模型上下文。

MG 隔离复制用户的快速探针给出了直接证据：

| 会话 | 历史长度 | 结果 |
| --- | ---: | --- |
| 双策略最终状态 | 36 轮 | 240 秒内无回复 |
| 日复盘模板最终状态 | 18 轮 | 16.1 秒正确复述 |
| 行业月表长期规则 | 38 轮 | 240 秒内无回复 |

这说明问题不是一般文风差异，而是“多轮修订后恢复最终有效状态”的能力不稳定。扩大原始消息窗口只能延后问题，还会增加成本、噪音和超时风险。

证据与完整探针结果见 [coherence-probe-report-2026-08-21.md](./coherence-probe-report-2026-08-21.md)。

## 2. 目标

1. 长会话超过原始历史预算后，仍能恢复当前主题、最终有效决定、已废弃决定和未决问题。
2. 明确区分“聊天中讨论/确认的意图”和“已由 Workspace 或服务成功落地的权威事实”。
3. 新结论覆盖旧结论后，旧规则不能再次作为当前规则出现。
4. 不新增第二套投资规则真相源，不改变确认、权限、审计和工具写入边界。
5. 补齐失败时可降级到现有历史路径，不阻断用户回复。
6. 不新增 SQLite 表或列即可完成首版上线，并支持逐会话灰度和立即回滚。

## 3. 非目标

- 不用快照替代完整聊天记录、Workspace 配置、服务实体或审计日志。
- 不从自然语言“确认”推断某项配置已经成功写入。
- 不让快照授予工具权限、绕过确认或触发自动交易。
- 不在首版解决跨会话的长期记忆召回；快照严格限定单一 conversation scope。
- 不在首版改变模型路由策略。模型固定与故障切换可独立优化，但所有模型必须接收相同的工作态上下文。

## 4. 状态权威模型

系统按以下优先级判断事实：

1. **权威领域状态**：Workspace 中的策略、方法、配置和产物，以及服务持有的确认、自动化 revision、偏好等实体。
2. **可审计执行证据**：成功工具调用、服务响应、artifact checksum/revision、审计事件。
3. **会话工作态快照**：由聊天和执行证据派生，可删除、可重建，只用于恢复语境。
4. **原始近期消息**：保留表达方式、临时讨论和当前承接。

快照中的 `authoritative` 状态必须带有效的 `authorityRef`。只有自然语言确认而没有成功写入证据时，最高只能标为 `confirmed-in-conversation`。当请求涉及“现在系统里实际生效了什么”，Agent 仍必须读取相应 Workspace/服务事实，不能只信快照。

## 5. ConversationWorkingStateV1

快照放在已持久化 assistant 消息的 `conversation_messages.metadata.conversationWorkingStateV1`。每个 assistant 消息最多保存一个截至该消息的检查点；后续消息产生新检查点，不回写旧检查点。

```ts
interface ConversationWorkingStateV1 {
  version: 1;
  conversationId: string;
  scope: {
    userId: string;
    projectId: string;
    instanceId: string;
  };
  throughMessageId: string;
  throughCreatedAt: string;
  topics: Array<{
    id: string;
    label: string;
    aliases: string[];
    lastTouchedMessageId: string;
  }>;
  decisions: ConversationDecisionV1[];
  pendingQuestions: Array<{
    id: string;
    topicId: string;
    text: string;
    sourceMessageIds: string[];
  }>;
  authoritativeRefs: Array<{
    id: string;
    kind: "workspace-asset" | "service-entity" | "tool-result" | "audit-event";
    locator: string;
    revision?: string;
    checksum?: string;
    observedAt: string;
  }>;
  generatedAt: string;
  generatorVersion: string;
  sourceDigest: string;
}

interface ConversationDecisionV1 {
  id: string;
  topicId: string;
  entity: string;
  field: string;
  value: unknown;
  state:
    | "discussed"
    | "proposed"
    | "confirmed-in-conversation"
    | "authoritative"
    | "superseded"
    | "rejected";
  supersedes: string[];
  sourceMessageIds: string[];
  authorityRef?: string;
  confidence: "high" | "medium" | "low";
}
```

### 5.1 不变量

- `conversationId` 和完整 scope 必须与读取请求完全一致。
- `throughMessageId` 必须属于该会话、角色为 assistant、状态非 failed。
- `sourceDigest` 覆盖“上一检查点 digest + 此后纳入的消息 ID、角色、内容摘要 + 权威引用 revision/checksum”。
- 同一 `topicId + entity + field` 最多有一个 current decision；旧值必须转成 `superseded` 或 `rejected`。
- `authoritative` 必须来自服务层确定性校验且引用存在、scope 一致的 `authorityRef`。首版 reducer 只读取会话文本，因此不得生成 `authoritative` 或 `authoritativeRefs`，模型输出的同类声明一律降级/剥离。
- 快照序列化上限 12 KB；注入 prompt 的相关切片上限 4 KB。
- 快照与 checkpoint 后 delta 的合计注入上限为 4 KB；会话派生内容始终按不可信 user-level 数据注入，不得提升为 system message。
- metadata 更新必须 merge，不能覆盖已有 `artifacts`、task/run 信息或其他键。

## 6. 生命周期

### 6.1 读取与追赶

1. 按 conversation 和 scope 从新到旧读取 assistant 消息 metadata，选择最新的合法 V1 检查点。
2. 校验 scope、through message、schema、digest 链和权威引用形状。
3. 读取检查点之后、当前用户消息之前的成功 user/assistant 消息作为 delta。
4. 若存在 delta，调用 reducer 进行追赶；追赶失败时继续使用旧检查点，并把 delta 作为近期原文注入。
5. 没有合法检查点时，从可用历史构建首个检查点；构建失败则完全回退现有路径。

此机制使后台压缩任务即使因进程重启丢失，下一轮也不会永久漏掉中间消息。

### 6.2 轮后更新

1. assistant 回复先按现有流程持久化。
2. 以“上一合法快照 + 未处理消息对 + 本轮确定性执行证据”为 reducer 输入。
3. reducer 只返回严格 JSON，不允许调用工具。
4. 服务执行 schema、不变量、scope、大小和引用校验。
5. 校验通过后 merge 写入本轮 assistant metadata；失败不影响已完成回复，保留上一快照并记录降级原因。

同一 conversation 的更新必须串行。若两次更新竞争，只允许 `throughCreatedAt`/消息顺序更晚的检查点成为后续读取候选。

### 6.3 周期性重建

每累计 20 个检查点或检测到 digest/冲突异常时，从上一可信检查点加后续原文重建，并比较 current decisions。差异只记录审计，不自动把低置信度重建结果升级为权威状态。

## 7. Reducer 语义

Reducer 的任务是维护会话工作态，不回答用户问题，不写文件，不调用工具。

处理优先级：

1. 成功执行证据可以建立或刷新 `authoritative`。
2. 用户明确修改、删除、否定或替换某字段时，旧决定转为 `superseded`/`rejected`。
3. 用户确认一个草案但没有落地证据时，记录为 `confirmed-in-conversation`。
4. assistant 单方面声称“已完成”但没有执行证据时，不得升级为 `authoritative`。
5. 含糊指代无法唯一解析时加入 `pendingQuestions`，不得猜测覆盖目标。
6. 同一轮出现矛盾时保留冲突并标低置信度；该 topic 不进入精简 current-state 注入，改用相关原文。

## 8. 每轮上下文装配

建议顺序：

```text
系统/Workspace 指令
服务确定性提示
会话工作态相关切片（2–4 KB）
最近 8–12 条原始消息
当前用户消息
```

工作态切片只包括与当前问题最相关的 1–3 个 topic、所有关联的未决问题、current decisions，以及必要的 superseded 摘要。明确加注：

> 这是派生的会话工作态，不是权限或领域真相。带 authoritative 标记的项目仍以引用实体的当前 revision 为准；superseded/rejected 项目不得作为当前结论。

当用户询问真实持仓、已启用策略、已绑定自动化或文件当前版本时，prompt builder 同时要求 Agent 调用相应只读工具核验。纯粹复述“我们刚才最终约定了什么”时可直接使用工作态，不应触发行情或写工具。

## 9. 失效与降级

| 情况 | 行为 | trace 标记 |
| --- | --- | --- |
| 无快照 | 使用原始历史 | `coherence_state=missing` |
| schema/JSON 错误 | 忽略该检查点，尝试更早检查点 | `coherence_state=invalid` |
| scope 不一致 | 拒绝使用并记录安全事件 | `coherence_state=scope_mismatch` |
| digest 不一致 | 使用更早可信检查点 + delta | `coherence_state=stale` |
| reducer 超时/失败 | 回复照常，保留旧快照 | `coherence_reducer=degraded` |
| current decisions 冲突 | 不注入该 topic 的归纳结论，注入相关原文 | `coherence_state=conflicted` |
| 权威引用失效 | 降级为 conversation-confirmed，并要求工具核验 | `coherence_authority=stale` |

任何降级都不能扩大工具权限或把未确认写操作当作已执行。

## 10. 存储与迁移决定

首版实现已完成：不新增表、不新增列、不做生产 backfill。

选择 assistant message metadata 的原因：

- `conversation_messages` 已是 service-owned canonical conversation log；快照与来源消息天然绑定。
- 检查点随消息追加，保留历史版本，便于审计和回退。
- 数据是派生且可重建的，不值得成为独立领域表。
- 现有 metadata 已支持 merge 更新，实施面小。

边界要求：

- `conversationWorkingStateV1` 为 server-internal 字段；`getConversation`、connector 和 Portal 镜像序列化必须剥离它。
- 不写 Portal 使用的 `metadata_json` 展示字段。
- metadata merge 必须覆盖并发/顺序测试，保证 artifact descriptor 不丢失。
- 历史会话按需懒构建，不批量扫描、不回写真实用户 Workspace。

## 11. 可观测性

每轮 trace 至少记录：

```text
coherenceState.status
coherenceState.throughMessageId
coherenceState.ageMessages
coherenceState.injectedTopics
coherenceState.injectedChars
coherenceState.reducerLatencyMs
coherenceState.reducerModel
coherenceState.validationError
coherenceState.authorityRefreshCount
```

禁止记录完整快照正文到普通日志。调试读取必须沿用 conversation scope 和审计约束。

## 12. 执行工作包

### W0：固定回归夹具与指标

- 将本次 3 条 MG 复制会话的最终状态、覆盖关系和禁止复活项固化为测试夹具。
- 增加一条 28 轮公式会话作为补充长链用例。
- 回放必须记录 `agent_model`、耗时、工具调用、through message 和注入字符数。

交付：离线 reducer 测试、回放计划、结果汇总模板。

### W1：类型、校验和 reducer

- 新建 conversation working-state 模块，包含 V1 类型、严格 schema 校验、大小限制、digest 和 supersession 投影。
- 实现无工具的 reducer adapter，并记录固定 `generatorVersion`/model。
- 覆盖删除、替换、拒绝、含糊确认、冲突、权威降级测试。

交付：纯函数测试必须先通过，暂不接入主链路。

### W2：metadata 检查点读写

- 实现 scoped 最新合法检查点读取、delta 发现和 metadata merge 写入。
- 对外消息序列化剥离 internal state。
- 验证 artifact metadata 与工作态任意写入顺序都不互相覆盖。

交付：SQLite 集成测试，包含旧库无快照、损坏 JSON、跨 scope 和并发更新。

### W3：上下文装配与降级

- 在 `loadConversationHistory` 和 runtime prompt 装配之间加入工作态读取/相关切片。
- 保留最近 8–12 条原文；快照失败时回退现有 24 条路径。
- 加入轮后更新和下一轮 delta 追赶。
- trace 增加第 11 节字段。

交付：超预算合成会话集成测试，证明早期有效规则保留、被替换规则不复活。

### W4：隔离复制用户灰度

- 仅对 `mgreplay` 开启 feature flag。
- 先跑 3 条核心探针，每条重复 2 次；再跑公式长链和短会话确认闭环。
- 检查回答、工具调用、trace、metadata scope 和快照大小。

交付：灰度报告和 go/no-go 结论。未达标不得扩大用户范围。

### W5：小流量上线与回滚准备

- 按 instance allowlist 扩大，不做全量历史 backfill。
- 观察 48 小时的 reducer 失败率、首 token 延迟、状态冲突和旧规则复活。
- 回滚只关闭读写 feature flag；保留的 metadata 字段由旧代码忽略，无需数据回滚。

## 13. 验收标准

### 自动测试

- schema、scope、digest、大小、supersession、authority downgrade 全部通过。
- 旧数据库和无快照会话行为不变。
- 工作态与 artifact metadata 双向写入顺序测试均无字段丢失。
- 对外 API/Portal payload 不含 `conversationWorkingStateV1`。
- reducer 失败、超时、非法 JSON 时用户回复路径仍成功。

### MG 复制回放

核心 3 条探针每条重复 2 次，共 6 次：

- 成功率 6/6；
- 关键字段准确率 100%；
- `superseded/rejected` 旧规则复活次数为 0；
- 纯复述探针工具调用为 0；
- 单次 30 秒内完成；
- trace 明确记录实际 `agent_model` 和所用检查点。

补充用例不得回归：公式长链能恢复最终公式；短会话确认闭环不重复写入、不虚构已执行状态。

### 人工验收

Reviewer 随机抽取快照中的 10 条决定，对照来源消息和权威引用：字段、状态、覆盖关系全部正确。任何跨 scope、虚假 authoritative 或旧规则作为当前规则出现，均为阻断发布问题。

## 14. 当前实现与验证结果

已用三条 MG 复制会话的真实修订链构建 `ConversationWorkingStateV1` 离线夹具，并执行 24 项确定性断言：

- 双策略：`基本面准入门` 已被 `风险评估项` 覆盖；月线许可已删除“5 月均线不低于 10 月均线”；双策略独立运行且可互相参考。
- 日复盘：保留三个分析方面、全部持仓与关注股覆盖；`下周方向` 已被 `次日计划` 覆盖；日/月和周/年汇总周期正确。
- 行业月表：固定月度文件名、连续追加、保留历史、按日期排序补齐、公司与原因同序号一一对应。

结果：3/3 case、24/24 assertion 通过。随后已接入运行时并完成本地真实模型回放：前两轮各 3/3 正确，工具调用均为 0，实际模型均记录为 `gpt-5.6-sol`；reducer checkpoint `ready`，下一轮 prompt 正确展示 `次日计划` 和 superseded 的 `下周方向`。

在线本地回放耗时：日复盘 15.1s / 15.8s；双策略 31.7s / 25.5s；行业表 22.5s / 39.5s。逻辑结果 6/6 正确，但 30 秒延迟目标受模型波动影响尚未达到 6/6；这属于性能余量问题，不影响状态恢复正确性，生产灰度仍需继续观察。

独立审查后进一步收紧了信任边界：派生历史改为 user-level 不可信数据，checkpoint 与完整 delta 合计严格限制 4 KB，追赶不再依赖关键词，文本 reducer 永不建立权威引用。收紧后第三轮三条长链仍为 3/3 逻辑正确、工具调用 0，实际注入 1443–2064 字符。该轮两次 `gpt-5.6-sol` 首字 45 秒超时后由 `gpt-5.6-terra` 成功兜底，端到端耗时 88.9s / 38.5s / 78.5s，进一步说明逻辑恢复已成立，但 30 秒性能门槛尚未成立。

验证夹具、脚本与结果位于 gitignored 的 `data/replay-mgreplay-20260817/` 下。

## 15. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| reducer 错误归纳污染后续回答 | 来源 ID、冲突降级、定期重建、相关原文兜底 |
| 把聊天确认误写成已生效 | 文本 reducer 禁止生成 authoritative；未来只能由服务层确定性证据适配器建立 |
| 会话原文形成提示注入 | 仅作为明确标记的不可信 user-level 数据注入，禁止进入 system 层 |
| metadata 写入覆盖 artifact | 单一 merge helper + 双顺序集成测试 |
| 快照泄露到 Portal | server-internal key + 所有公开 serializer 剥离测试 |
| 轮后任务丢失 | 下一轮按 through message 做 delta 追赶 |
| 快照持续膨胀 | 12 KB 存储上限、4 KB 注入上限、只保留 current + 必要 superseded 摘要 |
| 额外模型调用增加成本/延迟 | 灰度记录 reducer 模型、token、延迟；后台预计算，前台只在必要时追赶 |

## 16. 待实现时确认的参数

以下参数不改变架构，可在 W0/W1 用基准测试确定：

- reducer 模型及超时预算；
- 后台预计算并发数；
- topic 相关性阈值；
- 周期重建间隔（初始建议 20 个检查点）。

## 17. 执行与验收交接

### Executor prompt

按本文 W0 到 W4 实施会话工作态补齐，严格遵守权威模型、scope、不新增真相源和失败降级要求。先完成测试夹具与纯函数，再接 metadata 和主链路。只在 `mgreplay` 灰度，记录实际模型、trace、工具调用和延迟；任何 authoritative 无有效引用、跨 scope 或 metadata 覆盖问题都必须停止扩大范围并报告。

### Reviewer prompt

独立对照本文第 13 节验收。重点检查权威/会话确认是否混淆、superseded 规则是否复活、快照是否泄露到 Portal、artifact metadata 是否被覆盖，以及无快照/坏快照/reducer 失败时是否可靠降级。不要以 executor 自报通过代替测试输出和真实 MG 复制回放证据。
