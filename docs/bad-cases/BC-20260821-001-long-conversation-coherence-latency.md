# BC-20260821-001：长会话连贯性修复后性能仍未达门槛

```yaml
case_id: BC-20260821-001
status: accepted-risk
severity: S1-high
first_seen_at: 2026-08-21
last_seen_at: 2026-08-21
reported_by: governance-review
scope: isolated-user/mgreplay
channel: portal
```

## 1. 场景与结果

- 场景名称：长会话最终有效规则复述
- 用户/隔离实例：`mgreplay`，真实 `mg`、生产 Workspace 和生产微信未使用
- 输入摘要：在已经积累多轮修订、确认和旧规则覆盖的复制会话末尾，要求复述双策略、日复盘模板和行业月表的最终有效规则；明确禁止取行情、调用工具和修改状态
- 预期事实/状态：关键字段准确率 100%，无旧规则复活，工具调用为 0，单次 30 秒内完成
- 首次实际结果：3 条探针中 2 条在约 241.5 秒后超时无回复，1 条在 16.1 秒成功
- 修复后逻辑结果：确定性断言 3/3 case、24/24 assertion；三轮真实长链合计 9/9 逻辑正确、9/9 无工具调用
- 修复后性能结果：第二轮为 15.8/25.5/39.5 秒；第三轮为 88.9/38.5/78.5 秒，且两条发生 45 秒首字超时后模型兜底
- 当前系统终态：逻辑修复已验证；性能门槛未通过
- 禁止行为：未发现工具误调用、写入、旧规则复活或 `authoritative` 伪造

## 2. 关联证据

```text
traceId: 不可得；当次远程 Portal trace 未完整采集
requestId: 不可得
conversationId: 见 data/replay-mgreplay-20260817/coherence-probe-results-20260821.jsonl 的隔离映射，不在本文复制
messageId: 不可得
runId: 不适用（交互探针）
taskId: 不适用（未创建任务）
artifactId / assetId: 不适用
deliveryId / pushJobId: 不适用
service audit id: 不适用（只读且禁止工具）
```

证据链接：

- 主要报告：[coherence-probe-report-2026-08-21.md](../coherence-probe-report-2026-08-21.md)
- 设计契约：[conversation-coherence-state-design.md](../conversation-coherence-state-design.md)
- 计划文件：`data/replay-mgreplay-20260817/coherence-probe-plan-20260821.json`
- 结果文件：`data/replay-mgreplay-20260817/coherence-probe-results-20260821.jsonl`

观测缺口：报告明确指出没有拿到远程 Portal trace 的完整工具阶段明细。本文不补造关联 ID；该缺口同时构成 G5 的未闭环证据。

## 3. 归因

主因：`model`

次因：`prompt`（修复前上下文组织不足）、`operations`（远程网关排队/首字超时可能参与）

根因证据：

- 修复前只注入有限原始历史，长修订链的早期规则可能被裁掉；工作态检查点实施后逻辑结果稳定到 9/9，证明上下文恢复是原始逻辑失败的重要因素。
- 修复后第三轮两条探针出现 45 秒首字超时并由 `gpt-5.6-terra` 兜底，说明剩余阻断主要是模型/网关时延，而非逻辑状态恢复。
- 由于缺少完整远程 Trace，无法把剩余延迟精确拆分为模型排队、上下文注入或其他运行阶段；该不确定性必须保留。

影响范围：多次修订、确认、覆盖旧规则的长会话；中短会话不能据此判定受影响。

## 4. 修复与验证

- 修复说明：在 assistant message metadata 保存可删除、可重建的 `ConversationWorkingStateV1`；注入相关工作态切片和最近原文；严格区分 `discussed`、`proposed`、`confirmed-in-conversation`、`authoritative`、`superseded`、`rejected`
- 安全收紧：派生内容作为不可信 user-level 数据；checkpoint + delta 限制 4 KB；只读 reducer 禁止生成 `authoritative` 和权威引用
- 确定性验证：3/3 case、24/24 assertion
- 隔离行为评估：三轮真实长链合计 9/9 逻辑正确、工具调用为 0
- 未通过项：单次 30 秒性能门槛
- 新增回归样例：双策略、日复盘模板、行业月表；未来样例集中保留为 historical bad case
- 是否需要故障演练：需要。对应 F1 模型首字超时，并需记录实际模型尝试和阶段耗时
- 回归绑定（2026-08-24，WP4）：双策略/日复盘模板/行业月表三项已登记为 EV-010/EV-011/EV-012（executable，真实模型回放，依赖本地 data/replay-mgreplay-* fixture——引用结果作放行证据须注明回放环境）；Prompt/连贯性类变更按登记表「变更门选择规则」必跑该子集

## 5. 处置结论

```text
是否允许灰度：only-isolated
灰度对象/allowlist：仅隔离复制用户或明确内部 allowlist
观测窗口：待取得完整 trace 后定义；当前无生产扩大灰度授权
回滚目标：保留现有历史路径作为 checkpoint 损坏/过期/scope 不符时的降级路径
未解决风险：性能波动；远程 trace 不完整；剩余延迟归因未闭合
复核人：待治理复核
关闭条件：核心 3 条探针重复 2 次共 6/6；关键字段 100%；工具调用 0；无 superseded 规则复活；单次 <=30 秒；记录实际 agent_model 和完整阶段证据
```

治理判定：

- 修复实现状态：已完成
- 逻辑验收状态：通过
- 性能验收状态：不通过
- G5 关联证据状态：部分满足
- 扩大灰度放行状态：不通过

