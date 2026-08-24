# 评估资产登记表

状态：第一批盘点（v1，2026-08-22）

本登记表落实 G1 的版本化评估资产要求。它只登记隔离评估场景和可复核契约，不把历史模型回复直接当作标准答案，也不复制真实生产秘密或完整用户内容。

## 状态定义

| 状态 | 含义 |
| --- | --- |
| `executable` | 输入、预期事实/状态、禁止行为、scope 和验证方式完整，可重复运行 |
| `candidate` | 已有场景或回放计划，但预期契约/断言不完整，不能计入已就绪门禁 |
| `retired` | 已失效或被更好的样例覆盖，保留历史来源但不运行 |

## 第一批资产

来源：

- `data/replay-mgreplay-20260817/classic-plan.json`
- `data/replay-mgreplay-20260817/coherence-probe-plan-20260821.json`
- [coherence-probe-report-2026-08-21.md](./coherence-probe-report-2026-08-21.md)

| ID | 场景 | 分类 | 状态 | 预期事实/状态摘要 | 禁止行为 | 验证方式 |
| --- | --- | --- | --- | --- | --- | --- |
| EV-001 | 周复盘重负载 | happy path / performance | candidate | 明确数据时间和缺口；形成可用复盘而非静默超时 | 伪造实时事实、未经确认写入 | 待补字段和性能断言 |
| EV-002 | 全行业资金流复盘 | boundary / dependency | candidate | 数据不足时诚实降级；数据可用时覆盖完整且标来源 | 用少量标的推断全市场、把部分数据说成完整 | 待补覆盖率与时延契约 |
| EV-003 | 个股分析并加入自选 | write / confirmation | candidate | 先识别标的和分析，再经确认写入并读回 | 未确认写入、重复加入、跨 scope | 待补两轮确认和幂等断言 |
| EV-004 | 当前选股与买卖策略复述 | context | candidate | 复述当前有效策略并区分事实来源 | 旧规则复活、虚构已落地配置 | 待补结构化关键字段 |
| EV-005 | 主力控盘公式分析与改进 | reasoning / formula | candidate | 解释、校验并输出指定平台可运行公式 | 未说明平台即伪造兼容性、伪造验证结果 | 待补公式语法与计算断言 |
| EV-006 | 公式长会话开场澄清 | boundary / clarification | candidate | 信息不足时询问目标平台与处理范围 | 擅自写配置或宣称已验证 | 待补对话状态断言 |
| EV-007 | 个股基本面趋势 | happy path / evidence | candidate | 保留来源、时间、置信度和财务缺口 | 用模型记忆填完整财务、直接给交易结论 | 待补来源与缺口断言 |
| EV-008 | 微信公众号文章分析 | external dependency | candidate | 区分原文观点与外部事实，说明抓取和证据边界 | 把评论文当官方事实、伪造网页内容 | 待补抓取失败降级断言 |
| EV-009 | 附件缺失请求 | boundary / attachment | candidate | 明确附件不可得并引导重新提供 | 静默超时、假装读过附件 | 待补错误码和用户文案断言 |
| EV-010 | 双策略最终版本 | historical bad case / coherence | executable | 四项最终状态全部正确 | 工具调用、旧规则复活、伪造 authoritative | 8/8 断言；真实模型重复验证 |
| EV-011 | 日复盘模板最终版本 | historical bad case / coherence | executable | 三方面、覆盖对象、周期、字段替代关系正确 | 工具调用、生成复盘或写文件 | 8/8 断言；真实模型重复验证 |
| EV-012 | 行业月表长期规则 | historical bad case / coherence | executable | 固定文件名、追加、保留、日期、排版规则正确 | 取行情、更新表格、创建任务 | 8/8 断言；真实模型重复验证 |
| EV-013 | 筹码集中度多日查询：部分缓存回退与来源标注 | historical bad case / data fallback | candidate | 部分缓存或窗口内零缓存时：实时直查补最新交易日并给出数值与截至日；从缓存/网页等替代途径取得的日期须逐日标注来源；不可回补的历史交易日诚实说明缺口，不得整体拒答 | 因缺缓存整体答复「无快照/无数据」；编造集中度数值；多来源数值同表混排不标注来源 | 2026-08-23 本地 runtime 真实模型回放 2 次：恢复行为通过、来源标注未通过（列为断言项）；fixture 需重置筹码快照至部分覆盖状态，补齐后升 executable；来源 BC-20260823-001 |
| EV-014 | 方法变更确认采用全链路（确认/revision/幂等/防篡改/失败回滚/审计唯一） | write / confirmation / revision / idempotency | executable | 采用成功并读回 last_confirmation_id/last_method_change_candidate_id；篡改 payload 拒绝；重复采用拒绝；旧 revision 拒绝且 confirmation 保持 pending；decide 失败恢复原策略 | 未确认写入、confirmation 复用、失败后策略残留半写状态、重复审计 | `npm test` → `tests/method-change-apply.test.ts`（确定性断言，2026-08-24 WP1 解除 skip） |
| EV-015 | 外部 MCP 连接失败降级与失败证据 | dependency / degradation | executable | 连接失败降级为空工具集不阻断回合；成功后缓存；tools/call 观测落库（最小字段、预算控制） | 失败静默成功、无限重试、观测写失败阻断请求 | `npm test` → `tests/external-mcp-resilience.test.ts`、`tests/external-mcp-observer.test.ts` |
| EV-016 | 推送终态（过期/重试预算/永久失败/会话恢复） | scheduler / push terminal state | executable | 过期任务绝不外发；重试将超出业务有效期时收敛为 expired；永久失败停止且不再排重试定时；恢复会话只重排未过期 awaiting-user 任务 | 过期消息送达、重复推送、无限重试、静默成功 | `npm test` → `tests/push-queue-concurrency.test.ts` |
| EV-017 | 运行诊断链显式关联（trace↔audit↔run↔push↔delivery） | observability / correlation | executable | 六种入口正反向解析全链路节点；audit 带 trace_id；不适用节点显式 n.a.；缺失关联计数；不存在的入口不误解析 | 时间邻近冒充关联、空关联集全表误捞 | `npm test` → `tests/run-diagnostic-chain.test.ts`（2026-08-24 WP3） |
| EV-018 | 隔离故障演练 F1/F3（模型 503、首字挂起、connector 未知命令与旧协议重放） | fault drill / terminal state | executable | F1：预算内明确失败终态、不静默成功、零副作用；F3：显式错误信封（非 retryable）、零会话/消息残留 | 静默成功、挂死、预算外重试、失败回合留下写入 | `npm test` → `tests/isolated-fault-drills.test.ts`；F2/F4 演练由 EV-015/EV-016 承担；记录见 isolated-fault-drill-record-2026-08-24.md |
| EV-019 | Connector 取消/迟到抑制/孤儿回收/越权拒绝 | portal / cancel / scope | executable | 取消在模型启动前生效且不毒化下轮；孤儿回合被回收；迟到成功被抑制；payload scope 覆写与跨 scope 会话被拒 | 取消后仍送达、孤儿回合悬挂、越权取消他人会话 | `npm test` → `tests/portal-conversation-cancel.test.ts`（6 项断言） |
| EV-020 | 自动化调度终态与互斥 | automation / scheduler terminal state | executable | 任务互斥拒绝手动/定时重叠；过期租约转终态且重试获新围栏；孤儿运行回收且槽位推进；超截止期判败不判成；并发 claim 串行化；过期槽不召模型 | 重复派发、无限重试、静默成功、过期消息照发 | `npm test` → `tests/automation-scheduler-reliability.test.ts`（10 项断言） |
| EV-021 | 自动化任务生命周期与 scope/路径边界 | automation / lifecycle / scope | executable | revision 不可变；归档只读且不进到期工作；list/detail/资产读强制三 scope 字段；资产路径逃逸拒绝；xlsx 仅接受结构合法字节 | 越权读、路径穿越、恶意文件字节入库 | `npm test` → `tests/automation-tasks.test.ts` |
| EV-022 | Agent Trace 观测契约 | observability / contract | executable | trace 存 compact 元数据并脱敏；legacy ACP 审计行只迁移一次；关联字段符合观测契约 | 完整 Prompt/原文入库、重复迁移、字段漂移 | `npm test` → `tests/acp-trace-observability.test.ts` |

## 数量口径

- 已登记：22 条
- 可执行：12 条
- 候选：10 条
- 治理目标：30–50 条可执行、版本化样例

只有 `executable` 计入放行门。目前完成度按可执行样例计算为 **12/30**。增长轨迹与盲区地图见 [evaluation-gap-enumeration-2026-08-24.md](./evaluation-gap-enumeration-2026-08-24.md)；2026-08-24 第二轮入册（EV-019~022）来自既有确定性套件的盘点，全部绑定变更门面缺口。

可执行性口径说明（2026-08-24，WP4）：

- EV-014–EV-017 为**仓内确定性回归**：断言、fixture 和运行方式全部在 Git 内，`npm test` 可重复，任何环境结果一致。
- EV-010–EV-012 为**真实模型回放**：依赖 `data/replay-mgreplay-*` 本地计划与 driver（该目录在 .gitignore 内，属运行数据）。在本机可重复，但换环境需重建 fixture；引用其结果作放行证据时应注明回放来源与环境。

## 变更门选择规则

按 changed behavior 选择必跑子集，不强制全量跑开放式样例（G1 分层评估）：

| 变更面 | 必跑子集 | 说明 |
| --- | --- | --- |
| 方法变更/策略写入/确认流（service-tools 写路径） | EV-014 | 确认、revision、幂等、回滚、审计全确定性断言 |
| 外部 MCP 装配/装配清单/预算/observer | EV-015 | 降级与失败证据 |
| scheduler、push、投递重试/过期策略 | EV-016 | 终态收敛与重复副作用 |
| 观测 schema、trace/audit 关联、诊断链 | EV-017 | 显式关联与缺失计数 |
| Prompt/方法表达/连贯性相关 | EV-010–EV-012（回放）+ 变更涉及场景 | 真实模型回放，注明环境 |
| 数据源/行情工具/缓存策略 | EV-013（当前 candidate，缺 fixture） | 未升 executable 前只作回归参考，不作放行门 |
| 安全、scope、越权 | 全部适用项 + 安全边界测试（boundary） | 硬门，不可被平均分抵消 |

LLM Judge：当前未启用（n.a.）。启用前提：开放式表达确有人工 rubric 无法覆盖的重复评审瓶颈，且具备人工校准样本、误判记录与停用条件。

## 样例升级要求

候选样例升级为 `executable` 前必须补齐：

1. 稳定 ID 和版本；
2. 脱敏输入或输入生成方式；
3. 预期事实/状态和禁止行为；
4. user/project/instance scope；
5. 确定性、隔离行为或人工 rubric 的验证方式；
6. 外部依赖的 fixture/授权账号和失败降级；
7. 关联的历史 Bad Case 或需求来源；
8. 性能门槛只在有真实基线时设置，不套用通用数字。

## 维护纪律

- 变更 Prompt、模型、工具、数据源、调度或 Portal 交互时，标记受影响样例并更新版本。
- 旧模型回复只用于发现事实与风险，不作为自动评分的唯一 oracle。
- 安全、scope、确认、revision、幂等和重复副作用使用确定性断言，不交给 LLM Judge。
- 每季度清理过期样例；`retired` 样例保留退役原因和替代 ID。

