# 诊断链生产覆盖率实测报告（2026-09-06）

状态：首轮实测（治理闭环 T2 / T-467）

本报告是 diagnosticCoverage 指标落地后的**第一次真实生产窗口测量**，用于回填 [release-record-20260824-dd072a15.md](./release-record-20260824-dd072a15.md) 承诺的 7 天观测窗口结论，并回答治理五问。

- 测量方式：SSH 只读连接生产库（`better-sqlite3 readonly:true`，与每日巡查同纪律），全部 SELECT，零写操作、零部署。
- 关联判定：**只用显式 ID 相等**（与 `src/services/run-diagnostic.ts` 契约一致），时间邻近不参与任何覆盖率计算。
- 观测窗口：`2026-08-30T00:00Z .. 2026-09-06T00:00Z`（7 个完整自然日）；趋势与历史归因另用 `2026-08-07` 起、以 `2026-08-24T07:00Z`（trace_id 叠加列上线时点）为切换点。

## 一、结论先行

1. **核心链路覆盖率健康**：audit trace 覆盖率 100%（321/321），automation 运行 trace 关联 99.0%（98/99），push/delivery 关联 100%（82/82、95/95），chat 轮次 trace→会话 100%（51/51）。
2. **发现一个既有设计断点（首次度量暴露）**：微信通道存在两套关联键——消息写入方与 MCP observer 用 `weixin-inbound:<信封ID>`，trace 表用 `wx-<时间戳>`。导致 85 条工具调用与 21 条助手消息无法显式反链到 trace。全部为 completed/sent，无失败被遮蔽。
3. **没有无法解释的新增缺口**：所有缺失都能归因到「历史数据 / 非适用节点 / 上述微信断点」三类之一；8-25 起 audit 日覆盖率逐日 100%，无一日回退。
4. 平台指标 `diagnosticCoverage` 的 scheduler 口径有失真（见 GAP-2），本报告按修正口径陈述。

## 二、窗口总览（W7 = 8-30 ~ 9-06 UTC）

| 实体 | 数量 | 显式关联情况 |
| --- | --- | --- |
| 模型轮次（agent_traces） | 151 | trace_id 151/151、conversation 151/151、message 键 151/151（automation 100 / 微信 31 / web 20） |
| automation 运行 | 99 | trace 关联 98/99；delivery 关联 69/69（68 sent + 1 待终态）；终态齐全 |
| 规则调度（scheduled_task_runs） | 20 | trace 反链 0/20（**n.a.**：全部为 rule-alert-check / data-quality-summary，无模型轮次）；push 关联 13/20 |
| 服务审计（sandbox_audit_logs） | 321 | trace_id 321/321（100%）；解析到 trace 行 318/321 |
| 外部 MCP 调用 | 737 | run_id 737/737；解析到运行实体 652/737（88.5%） |
| push job | 82 | origin 关联 82/82（100%）；终态 76 sent + 6 expired_while_awaiting_user（设计内挂起） |
| 投递尝试 | 95 | push 关联 95/95（100%） |
| 会话产物 | 22 | conversation 22/22；message 1/22（21 条为 reviews.save 定时产物，**n.a.**） |

模型参与的运行实体合计 250（151 轮次 + 99 automation run），可显式串到业务终态的 249（99.6%）；唯一例外为 1 条「模型启动前过期失败」的 automation run（见 §四）。

## 三、按入口的覆盖率

| 入口 | W7 覆盖率 | 说明 |
| --- | --- | --- |
| Portal（web） | 100% | trace→会话→消息全链显式可达（20/20） |
| 微信 | 正向 100% / 反链断裂 | trace→会话 31/31 可达；但工具调用（85 条）与助手消息（21 条）持信封 ID，无法反链 trace（GAP-1） |
| automation | 99.0% | 98/99 trace+终态可串；1 条模型前过期（n.a.，run 行自身即终态证据，runId 入口仍可解析） |
| scheduler 规则任务 | n.a. | 20/20 成功、13 条带 push；规则任务不产生模型 trace，按 n.a. 语义不计缺失 |
| MCP observer | 88.5% | 652/737 解析；85 条未解析全部为微信通道（GAP-1）；2 条指向过期 run 的读前置调用 |
| delivery | 100% | 95/95 |

## 四、缺失关联逐段归因

| 段 | 缺失量 | 归因 | 处置 |
| --- | --- | --- | --- |
| audit（8-24 前） | 1633 条无 trace_id | 历史数据（叠加列 2026-08-24 上线，旧行保持 NULL） | 登记不处置；API 侧已有缺失计数呈现 |
| audit（W7） | 3 条 trace_id 不解析 | 同一条 automation run（atrun_8bdd897b，2026-09-01）模型启动前过期失败：读前置审计已按 runId 落库，trace 未产生 | n.a.（run 行有终态）；巡查按签名去重 |
| automation trace | 1/99 | 同上（error_category=expired，不可重试，无 push） | n.a. |
| scheduled 反链 | 20/20 | 规则任务无模型轮次 | **度量口径缺陷**：GAP-2 |
| MCP 反链 | 85/737 | 微信通道关联键两套 ID 空间（`weixin-inbound:*` vs `wx-*`） | **GAP-1：立修复任务** |
| 消息→trace 反链 | 21/39 | 同 GAP-1（微信助手消息存信封 ID） | 并入 GAP-1 |
| artifacts message | 21/22 | reviews.save 定时产物无对应聊天消息 | n.a.（白名单来源） |

## 五、治理五问回答

1. **总运行数**：250 个模型参与实体（151 轮次 + 99 automation run）；另有 20 次规则调度、82 个 push、95 次投递。
2. **可从入口串到业务终态**：249/250 = 99.6%（automation 98/99 + 轮次 151/151）；push/delivery 100%。
3. **缺口最多的段**：微信通道工具调用/消息反链（85+21，同一根因）；其次是规则任务反链（20，属 n.a. 被口径计入）。
4. **缺口性质**：历史数据（8-24 前 audit）＋非适用节点（规则任务、reviews.save 产物、模型前过期）＋一个既有设计断点（微信 ID 空间，GAP-1）。**无新代码造成的缺口**。
5. **是否存在无法解释的新增缺口**：无。8-25 起 audit 覆盖率逐日 100%；automation 关联率稳定 98-100%。

## 六、阈值与巡查项（S7，落 [customer-friction-signal-collection-design.md](./customer-friction-signal-collection-design.md)）

日级只读查询（并入 19:15 巡查「受阻信号聚合」节）：

| 指标 | 告警阈值（基于本次基线，首轮 provisional） |
| --- | --- |
| 当日 audit trace 覆盖率（排除 2026-08-24 前历史行） | < 100%（出现非已知源缺失即告警） |
| 当日 automation trace 关联率（排除 error_category=expired 且无 trace 列的模型前失败） | < 99% |
| 当日 push origin 关联率 / delivery 关联率 | < 100% |
| 当日微信通道 MCP 未解析条数 | GAP-1 修复前作固定已知项记录趋势，不告警；修复后归零，再出现即告警 |

缺失关联处置规则（三分法）：

1. **历史数据**：登记、不处置、不计入当期覆盖率分母口径解释之外的新动作。
2. **非适用节点（n.a. 白名单）**：无模型轮次的规则任务（rule-alert-check、data-quality-summary）、reviews.save 定时产物、模型启动前过期失败的 run。度量时剔除并在报告标注；白名单变更需在本文档追加记录。
3. **新代码造成**：立案诊断（走 [ai-application-diagnosis](../.codex/skills/ai-application-diagnosis/SKILL.md)），当日完成 First Divergence 定位；期间相关变更不得扩大灰度。

## 七、本次登记的 GAP

| ID | 内容 | 状态 |
| --- | --- | --- |
| GAP-20260906-1 | 微信通道关联键两套 ID 空间：消息写入方与 MCP observer 用 `weixin-inbound:<信封ID>`，trace 用 `wx-<ts>`；85 条工具调用 + 21 条助手消息无法显式反链（均无失败遮蔽） | 已立修复任务（关联键统一），修复需白天发布窗口 |
| GAP-20260906-2 | `loadDiagnosticCoverage` 的 scheduler 口径未过滤 n.a. 任务类型，平台指标会长期显示 ~0% 造成误读 | 已立修复任务（口径过滤 + n.a. 标注） |

## 八、对本矩阵的回填

- G4：release-record-20260824 承诺的 7 天观测窗口（diagnosticCoverage 上升、无重复推送）由本报告回填——audit 覆盖率自 8-25 起稳定 100%，W7 无重复推送副作用（push 终态全收敛，6 条 expired_while_awaiting_user 为设计内挂起）。
- G5：诊断链从「能查」升级为「已实测 + 有基线 + 有巡查项」；微信断点为已知缺口，修复前不阻断放行（无失败遮蔽、正向链路完整）。

复测条件：GAP-1 修复发布后 7 天窗口复测一次；此后每季度或重大观测面变更时复测。
