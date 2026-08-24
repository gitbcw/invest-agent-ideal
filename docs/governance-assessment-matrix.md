# 治理评估矩阵

状态：治理基线草案（2026-08-22）

本矩阵用于把 [ai-system-governance-principles.md](./ai-system-governance-principles.md) 从原则转成可复核的项目状态。它是评估台账，不是执行任务清单；“下一步证据”表示需要补什么证明，不代表已经授权实施。

## 使用规则

- 每次复核只允许使用可定位证据：代码、测试、隔离运行记录、Trace、审计、发布记录或用户确认。
- `基础具备` 不代表永久通过；涉及运行行为的变更必须重新复核。
- `部分落地` 与 `缺证据` 不得作为扩大灰度或生产放行的依据。
- 任何安全、scope、事务一致性或重复副作用问题直接判为阻断，不用平均分抵消。

## 评估等级

| 等级 | 含义 |
| --- | --- |
| 基础具备 | 有服务/代码契约和直接验证证据，仍需在变更后复核 |
| 部分落地 | 局部链路有证据，但覆盖、关联或终态不完整 |
| 缺证据 | 原则已写明，但当前无法提供可复核证据 |
| 阻断 | 存在安全、越权、事务不一致、重复副作用或不可回滚问题 |

## G1–G5 矩阵

| 原则 | 当前等级 | 当前证据 | 已知缺口 | 下一次复核证据 | 责任边界 | 复核日期 |
| --- | --- | --- | --- | --- | --- | --- |
| G1 先建反馈，再谈优化 | 部分落地 | 经典回归、连贯性探针、专项测试 | 30–50 条版本化样例、统一 Bad Case、固定 go/no-go | 评估资产清单、Bad Case 闭环记录、对照结果 | 治理/评估 | 待定 |
| G2 最小化模型职责 | 基础具备 | service-tools、scope/confirmation、revision/幂等测试 | 新变更可能把确定性规则重新塞回 Prompt | 变更边界审查、服务契约测试、越权测试 | 服务/MCP | 待定 |
| G3 假设每层都会失败 | 部分落地 | 超时/取消/重试/降级/排空实现 | 四类隔离故障演练、行情上游结构性失败证据 | 故障演练记录、终态和副作用核对 | 运行时/依赖方 | 待定 |
| G4 小步发布、可观测回退 | 部分落地 | 并行端口、生产零触碰、快照纪律 | 灰度对象、观测窗口、回滚演练未统一登记 | 发布证据模板、allowlist 记录、回滚结果 | 发布/运维 | 待定 |
| G5 只记录必要且可关联的事实 | 部分落地 | agent_traces、MCP observer、脱敏、成本计价 | 一次运行的跨表诊断视图和缺口告警 | 诊断查询、覆盖率报告、秘密扫描 | 观测/服务 | 待定 |

## L1–L4 分层矩阵

| 层级 | 当前判断 | 应验证的事实 | 放行要求 |
| --- | --- | --- | --- |
| L1 确定性事实 | 基础较强 | 投影、任务、资产、投递状态是否可读回且 scope 正确 | 关键写入有 revision/幂等/读回证据 |
| L2 Agent 智能 | 边界基本清楚 | Agent 是否只理解、规划、判断和选工具 | 不直接访问生产 DB、Workspace 路径或秘密 |
| L3 护栏与事务 | 局部成熟 | 失败、取消、重试、过期和降级是否收敛 | 无静默成功、无限重试或重复副作用 |
| L4 反馈与观测 | 当前最弱 | Trace 是否串起业务终态，Bad Case 是否闭环 | 可从一次运行复盘并决定继续/回滚 |

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
