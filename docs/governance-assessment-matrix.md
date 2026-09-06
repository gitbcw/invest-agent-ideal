# 治理评估矩阵

状态：治理基线草案（2026-08-22）；G1–G5 / L1–L4 总表已于 2026-09-06 校准（T-466），校准依据见文末复核记录

本矩阵用于把 [ai-system-governance-principles.md](./ai-system-governance-principles.md) 从原则转成可复核的项目状态。它是评估台账，不是执行任务清单；“下一步证据”表示需要补什么证明，不代表已经授权实施。

## 使用规则

- 每次复核只允许使用可定位证据：代码、测试、隔离运行记录、Trace、审计、发布记录或用户确认。
- `基础具备` 不代表永久通过；涉及运行行为的变更必须重新复核。
- `部分落地` 与 `缺证据` 不得作为扩大灰度或生产放行的依据。
- 任何安全、scope、事务一致性或重复副作用问题直接判为阻断，不用平均分抵消。

「已完成」与「仍未完成」的区分口径（2026-09-06）：等级判为 `基础具备` 即视为已完成但需持续复核——它必须有现存可定位证据，且「已知缺口」列写明持续复核项；「已知缺口」中尚无证据的条目即仍未完成，其「下一次复核证据」必须指向具体的未完成动作（含承接任务号），不得留空或写泛称。

## 评估等级

| 等级 | 含义 |
| --- | --- |
| 基础具备 | 有服务/代码契约和直接验证证据，仍需在变更后复核 |
| 部分落地 | 局部链路有证据，但覆盖、关联或终态不完整 |
| 缺证据 | 原则已写明，但当前无法提供可复核证据 |
| 阻断 | 存在安全、越权、事务不一致、重复副作用或不可回滚问题 |

## G1–G5 矩阵

（2026-09-06 校准；等级变化依据见文末「2026-09-06 矩阵状态校准」复核记录）

| 原则 | 当前等级 | 当前证据 | 已知缺口 | 下一次复核证据 | 责任边界 | 复核日期 |
| --- | --- | --- | --- | --- | --- | --- |
| G1 先建反馈，再谈优化 | 基础具备（2026-09-06 升） | [evaluation-assets-registry.md](./evaluation-assets-registry.md)：37 条登记、36 条 `executable`，六类优先失败模式全覆盖（EV-034~037 存量证据转正）；[failure-taxonomy.md](./failure-taxonomy.md) v1.1（16 类/6 层）为归因单一入口；Bad Case 台账 4 条（[bad-cases/](./bad-cases/)）；rubric 试点两份并落 2026-W36 首轮评分（`data/eval-rubric-scores/`） | 语义门已建立但首例 SCR 未走（T-472 发布时）；LLM Judge 维持 n.a.（启用前提已预写）；EV-009 唯一 candidate 挂起观察（owner 裁决） | 首份 SCR（T-472）+ rubric 周评延续 | 治理/评估 | 2026-09-13 |
| G2 最小化模型职责 | 基础具备（维持） | service-tools 授权面 fail-closed（EV-026）；scope/确认/revision/幂等确定性断言（EV-014/023/024）；read 面审计收口（EV-033） | 新变更把确定性规则重新塞回 Prompt 的风险持续存在 | 随每次涉及服务契约/工具清单的变更做边界审查 | 服务/MCP | 随变更 |
| G3 假设每层都会失败 | 基础具备（2026-09-06 升） | 四类隔离故障演练（F1–F4）全部有仓内可重复 fixture 与终态/副作用断言：[isolated-fault-drill-matrix.md](./isolated-fault-drill-matrix.md)、[isolated-fault-drill-record-2026-08-24.md](./isolated-fault-drill-record-2026-08-24.md)、EV-015/016/018；生产真实故障均有收敛与修复记录（2026-09-03 确认死锁三件套、2026-09-05 attempt 预算扩容 160d9b9） | 真实生产环境故障注入未执行（当前治理未要求）；涉运行时行为变更后需重跑对应演练子集 | 下次涉及调度/推送/装配/模型链的变更时重跑对应演练子集 | 运行时/依赖方 | 随变更 |
| G4 小步发布、可观测回退 | 基础具备（2026-09-06 升） | 真实发布全链记录 [release-record-20260824-dd072a15.md](./release-record-20260824-dd072a15.md)（快照→部署→九项验收→known-good→回滚口径）；`scripts/deploy-volcano.sh` 构建感知发布通道与白天发布纪律 | 2026-08-24 后的真实发布（8-28 main 晋升、8-31、9-3、9-5）未逐次产出独立发布记录（下次发布起恢复，扩大使用范围前置条件①）；7 天观测窗口已回填（[diagnostic-coverage-report-2026-09-06.md](./diagnostic-coverage-report-2026-09-06.md)：audit 8-25 起 100%、无重复推送） | 下次真实发布按模板出独立记录并回填本表 | 发布/运维 | 下次真实发布 |
| G5 只记录必要且可关联的事实 | 基础具备（2026-09-06 升） | 单 ID 端到端诊断链与缺失计数（`src/services/run-diagnostic.ts` + Platform 运行诊断视图 + EV-017）；生产覆盖率已实测（7 天窗口 99.6% 串通，见 [diagnostic-coverage-report-2026-09-06.md](./diagnostic-coverage-report-2026-09-06.md)）；S7 巡查项与处置三分法已上线（[customer-friction-signal-collection-design.md](./customer-friction-signal-collection-design.md)）；自动化 run 工具载荷落盘与任务修订编辑来源审计（T-459，EV-034） | GAP-1 微信通道反链断点（85 条工具调用+21 条消息，T-472）；GAP-2 平台指标 scheduler 口径未过滤 n.a.（T-472）；外部 MCP 降级链诊断样例 | T-472 修复发布 + 7 天覆盖率复测 | 观测/服务 | T-472 复测落档后 |

## L1–L4 分层矩阵

（2026-09-06 校准）

| 层级 | 当前判断 | 应验证的事实 | 放行要求 |
| --- | --- | --- | --- |
| L1 确定性事实 | 基础较强（维持；EV-014/021/023/028/029 投影、任务、资产、投递读回断言持续全绿） | 投影、任务、资产、投递状态是否可读回且 scope 正确 | 关键写入有 revision/幂等/读回证据 |
| L2 Agent 智能 | 边界基本清楚（维持；EV-026 fail-closed 授权面 + EV-033 read 面审计收口） | Agent 是否只理解、规划、判断和选工具 | 不直接访问生产 DB、Workspace 路径或秘密 |
| L3 护栏与事务 | 核心失败面已收敛（四类演练终态断言 + 生产故障修复记录；真实环境注入未做） | 失败、取消、重试、过期和降级是否收敛 | 无静默成功、无限重试或重复副作用 |
| L4 反馈与观测 | 骨架已立，仍是最需投入的一层（诊断链+视图、巡查受阻信号 S1–S6、friction 台账、rubric 首轮评分；生产覆盖率实测与语义阻塞门未闭合） | Trace 是否串起业务终态，Bad Case 是否闭环 | 可从一次运行复盘并决定继续/回滚 |

## 复核记录

### 第一轮盘点（2026-08-22）

本轮依据当前治理基线、Mastra 观测契约、迁移验收记录、经典回归记录和连贯性探针完成文档级盘点；未读取生产数据库，未执行真实推送或故障注入。

| 项目 | 结论 | 证据 |
| --- | --- | --- |
| 治理原则是否已成文 | 已满足 | [ai-system-governance-principles.md](./ai-system-governance-principles.md) 已定义 G1–G5、L1–L4、评估资产、故障演练和发布门禁 |
| G1 评估资产 | 部分满足 | 当前日常回归为 9 条经典用例（见 [open-work-items.md](./open-work-items.md) 的经典回归节）；治理要求为 30–50 条版本化样例 |
| G2 服务边界 | 基础具备 | service-tools、scope/confirmation、revision/幂等测试；迁移验收 Gate C 通过 |
| G3 故障韧性 | 部分满足 | W4 连接韧性、W5/W6 排空与微信中断修复已有记录；四类隔离故障演练尚无完整报告，行情上游 313.5 秒仍未过 60 秒线 |
| G4 发布回退 | 部分满足 | 并行端口和生产零触碰已验证；迁移验收 Gate E 仍为 Partial，正式观测窗口和回滚演练未闭环 |
| G5 运行关联 | 部分满足 | `mastra-observability-contract.md` 已定义关联字段，observer/tool-call trace 已有实现；尚未有统一运行诊断视图的端到端报告 |
| 长链逻辑正确性 | 逻辑通过、性能阻断 | 连贯性探针 9/9 逻辑正确、工具调用为 0，但第三轮 38.5–88.9 秒，30 秒门槛未过 |

### 当前阻断项

以下任一项存在时，治理结论不得升级为“可扩大灰度”：

1. Trace、服务审计、scheduler/automation、artifact 或 delivery 无法按 ID 关联；
2. 出现安全、scope、事务一致性、重复写入或重复推送问题；
3. 四类隔离故障没有明确终态、重试边界和副作用核对；
4. 长链只证明逻辑正确，未满足约定的性能或资源门槛；
5. 发布缺少 allowlist、观测窗口、回滚目标或未解决风险记录。

### 首次 Bad Case 演练

- 案例：[BC-20260821-001：长会话连贯性修复后性能仍未达门槛](./bad-cases/BC-20260821-001-long-conversation-coherence-latency.md)
- 闭环状态：修复实现和逻辑验证已完成；性能与完整 Trace 证据未闭环
- 治理价值：验证了“实现完成、逻辑通过、性能未过、灰度不放行”必须分开记录
- 放行结论：`only-isolated`
- 对矩阵的影响：G1 保持“部分落地”；G3 增加 F1 模型首字超时演练输入；G5 保持“部分落地”

### 第一批评估资产登记

- 登记表：[evaluation-assets-registry.md](./evaluation-assets-registry.md)
- 已登记：12 条，其中 `executable` 3 条、`candidate` 9 条
- 数量口径：只有 `executable` 计入 30–50 条治理门，当前为 3/30
- G1 结论：仍为“部分落地”；下一步证据是把候选样例补齐为有明确事实、禁止行为、scope 和验证方式的可执行契约

### 2026-08-24 文档基线收口（T-361 / WP0）

```text
日期：2026-08-24
复核范围：治理文档基线（T-357 主报告 WP0 的 Invest Agent 半边）
证据链接：docs/AI应用复杂系统管理落地方案.md（文首 ⚠️ 定位声明 + 22 处节级非规范性标注）；docs/README.md（领域 Profile 入口说明）；docs/next-direction-governance-analysis-2026-08-22.md（状态更新）
等级变化：无（G1–G5、L1–L4 等级维持，本包不改变运行行为）
新增缺口：无新增；确认既有缺口中 WP1（T-362）为下一证据门
是否阻断发布：维持既有阻断项不变
下一复核条件：WP1 完成后复核 G2（method_changes.apply 投影读回）与发布入口（verify 全绿、快照基线）
```

### 2026-08-24 运行诊断链贯通（T-363 / WP3）

```text
日期：2026-08-24
复核范围：L4 一次运行诊断链（trace↔audit↔conversation↔artifact、scheduler run↔trace↔push↔delivery 显式关联）
证据链接：src/services/run-diagnostic.ts（诊断查询 + 缺失计数）；GET /api/platform/audit/run-diagnostic；sandbox_audit_logs.trace_id 叠加列；scheduler 回合 runId=taskKey 穿线；tests/run-diagnostic-chain.test.ts（Portal 链 + scheduler/push 链 + 反向入口 + n.a. + 缺失计数）；docs/run-diagnostic-view-contract.md 实现状态注
等级变化：G5「部分落地」证据增强（首次具备单 ID 端到端诊断与缺失计数，两条样例链入回归）；L4 从「表都存在」进到「一次运行可复盘（样例范围内）」
新增缺口：旧数据 audit 无 trace_id、旧 scheduler trace 无 runId——按缺失计数呈现，不作为治理证据；外部 MCP 降级链与推送过期链样例属 WP4/WP5
是否阻断发布：维持既有阻断项不变
下一复核条件：WP4 评估资产回归接入诊断链证据；WP5 故障演练引用诊断链缺口计数
```

### 2026-08-24 故障与发布演练证据（T-365 / WP5）

```text
日期：2026-08-24
复核范围：G3 四类隔离故障演练（F1–F4）、G4 隔离发布演练（快照→部署→known-good→代码回退→workspace 受控回退）
证据链接：docs/isolated-fault-drill-record-2026-08-24.md（四份演练记录 + 发布演练门类表 + Go/No-Go）；tests/isolated-fault-drills.test.ts（F1/F3 新 fixture）；F2/F4 复用 external-mcp-resilience/observer、push-queue-concurrency；release-snapshot-smoke 当前工作树重跑通过；EV-018 入册（executable 8/30）
等级变化：G3 由「部分落地」证据增强（四类故障均有仓内可重复 fixture 与终态/副作用断言）；G4 证据增强（隔离全链发布演练闭环，生产灰度仍未发生）
新增缺口：真实远端部署路径（volcano-ops）未在演练中覆盖，以下次真实发布的独立发布记录为准；F1 多模型轮内兜底的端到端回放为可选增强
是否阻断发布：维持既有阻断项不变；生产发布需独立记录与用户授权
下一复核条件：下一次真实代码发布时按 release-governance-evidence 模板出记录并回填 G4 复核
```

### 2026-08-24 真实发布 G4 回填（release 20260824T065229Z-dd072a15）

```text
日期：2026-08-24
复核范围：G4 真实代码发布全链（快照→部署→验收→known-good）
证据链接：docs/release-record-20260824-dd072a15.md（变更范围/适用门/验收九项/回滚口径/Go-No-Go）；快照含 verify 555 用例 0 skip；发布后 health/Portal/微信/connector/推送队列全部收敛；发布过程修复备份脚本两层深度口径缺陷（b43edd2、dd072a1 随发布验证）
等级变化：G4 证据从「隔离演练」升级为「真实发布记录」（手册第 8 节九项验收 + known-good 标记 + 回滚目标明确）
新增缺口：生产首条真实回合落 trace_id 后复查 diagnosticCoverage；远端 origin 未推送（用户指示），审计以 committed-local-baseline 为准
是否阻断发布：无新增阻断
下一复核条件：观测窗口 7 天（调度 runId 落库、audit trace_id 覆盖率、无重复推送）
```

### 2026-09-06 矩阵状态校准（治理闭环 T1 / T-466）

```text
日期：2026-09-06
复核范围：G1–G5、L1–L4 总表状态校准（文档级复核；未读生产库、未执行注入、未发布）
证据链接：evaluation-assets-registry.md（33 条登记 / 32 executable / 唯一 candidate EV-009 属 owner 裁决观察）；failure-taxonomy.md v1.1；docs/bad-cases/ 3 条闭环记录；evaluation-rubric-industry-review.md + evaluation-rubric-intraday-watch.md + data/eval-rubric-scores/2026-W36-*（首轮评分）；isolated-fault-drill-matrix.md + isolated-fault-drill-record-2026-08-24.md + tests/isolated-fault-drills.test.ts；release-record-20260824-dd072a15.md；src/services/run-diagnostic.ts + tests/run-diagnostic-chain.test.ts + Platform 运行诊断视图；T-459（fe387ff/5b48bca 工具载荷与修订来源审计）；T-462（160d9b9 attempt 预算 840s）
等级变化：G1 部分落地→基础具备；G3 部分落地→基础具备；G4 部分落地→基础具备；G5 部分落地→基础具备；G2 维持基础具备；L3「局部成熟」→「核心失败面已收敛」；L4「当前最弱」→「骨架已立，仍是最需投入的一层」
新增缺口：①2026-08-24 后真实发布未逐次出独立发布记录；②生产诊断覆盖率从未实测（该记录承诺的 7 天观测窗口未回填）；③语义回归无统一阻塞门——分别由 T-467（覆盖率实测+巡查项）、T-468（优先失败模式资产）、T-469（受阻信号最小实现）、T-470（语义回归门）承接，当日按序执行
是否阻断发布：不新增阻断；既有阻断项清单维持有效
下一复核条件：T-467 覆盖率报告落档后复核 G4/G5 观测窗口项；T-470 完成后复核 G1 语义门；下次真实发布按 release-governance-evidence 模板恢复逐次记录并回填 G4
```

### 2026-09-06 治理放行复核（治理闭环 T6 / T-471）

```text
日期：2026-09-06
复核范围：治理闭环包 T-466~T-471 全量成果 + G1–G5/L1–L4 全局状态 + 扩大使用范围前置条件（零代码变更、零部署、生产只读）
证据链接：governance-review-2026-09-06.md（放行复核主记录：门类证据表、G/L 逐项结论、Go/No-Go、扩大范围三前置条件、下次复核触发清单）；diagnostic-coverage-report-2026-09-06.md（G4 观测窗口回填 + G5 覆盖率基线 + S7 巡查项）；evaluation-assets-registry.md（EV-034~037 转正 + 优先失败模式覆盖视图）；customer-friction-signal-collection-design.md §八（语义信号四源/移交格式/走通案例）；semantic-change-regression-gate.md（两级语义门，运营环未决问题 2 关闭）；BC-20260904-001（空壳简报立案，语义失败范式案例）
等级变化：无（维持 2026-09-06 校准等级）；G4「7 天观测窗口未回填」缺口关闭，G5 缺口更新为 GAP-1/GAP-2（T-472）
新增缺口：无新增；在办：T-472（GAP-1/GAP-2）、BC-20260904-001 修复待 owner 裁决、taxonomy 两条增补建议（9-3 确认死锁 / 9-4 内容空转）待 ED-P1 周一初稿
是否阻断发布：不新增阻断；本治理包 go、生产维持现范围 go；扩大使用范围三前置条件满足前 = no-go（①下次发布出独立记录 ②T-472+SCR+7 天复测 ③BC-20260904-001 裁决）
下一复核条件：T-472 发布+复测；BC-20260904-001 裁决；下次真实发布记录落档；2026-10-06 季度例行；任何阻断项清单事件立即复核
```

每次更新矩阵时追加：

```text
日期：
复核范围：
证据链接：
等级变化：
新增缺口：
是否阻断发布：
下一复核条件：
```
