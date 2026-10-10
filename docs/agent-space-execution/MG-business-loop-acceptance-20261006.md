# MG 三个业务闭环验收记录

日期：2026-10-06  
验收范围：T-574 全持仓/关注对象筛选、可靠性降级、规则覆盖/提醒/策略改进闭环  
环境：本地 `production-mirror`，健康检查通过；本轮运行未挂载外部行情 MCP

## 验收结论

总体状态：`Partial`。

本轮完成了一次完整的全持仓 + 关注对象请求，16 个对象均进入结果，约 1 分 57 秒完成，且行动状态没有升级为准备行动；但这不是 T-574 的完整真实数据验收：`external_mcp_tool_calls=0`，本轮只挂载并调用了持仓、关注对象、预案读取和 `spreadsheet_create`，行情批量工具没有挂载。因此“批量行情进入证据包、重复行情被抑制”的关键验收项仍未通过。

## Acceptance Checklist

| 闭环 | 要求 | 状态 | 证据 | 判定 |
| --- | --- | --- | --- | --- |
| 全持仓筛选 | 16 个持仓/关注/预案对象完整纳入 | Pass | 会话 `web_ONdUV8Pk_fjpwhR4`；助手消息声明“16 个对象全部纳入，未截断” | 对象范围完整 |
| 全持仓筛选 | 股票批量行情与 ETF 分流实际进入证据包 | Fail | `.state/production-mirror/runtime.db` 的 `external_mcp_tool_calls` 对该会话为 0；trace 工具仅 `portfolio_read/watchlist_read/plans_read/svc_catalog/spreadsheet_create` | 未挂载行情 MCP，无法证明 |
| 全持仓筛选 | Agent 不重复取行情 | Unknown | 无外部行情调用，无法验证重复抑制；仅有程序侧单元测试 | 需在 MCP 已挂载环境重跑 |
| 交付时效 | 合理窗口内交付候选、原因、触发/失效条件、缺口 | Pass with caveats | 端到端 `116429ms`；结果含重点复核项、统一触发/失效条件和缺口 | 交付可用，但数据不是当前行情 |
| 可靠性 | 区分已核验、可参考、当前未知；代理/冲突不升级为行动 | Pass with caveats | 助手消息明确三层可靠性；全部为“继续观察/暂不处理” | 语义通过，真实行情路径未覆盖 |
| 可靠性 | 行情连接失败后阶段性降级 | Pass with caveats | T-570：连接阶段失败后无外部调用、保留阶段性只读结果 | 已验证连接失败，已建立会话中途断开仍 Unknown |
| 规则覆盖 | 持仓/关注/预案逐对象标记有规则、无规则、无需规则 | Partial | T-562 P1 对账记录：僵尸规则、裸关注、缺规则对象均已列出 | 尚未得到用户裁决，不自动改规则 |
| 提醒分层 | 观察、预案、硬风控分层，命中/抑制/失败/投递状态可区分 | Partial | T-562 P2 推荐策略 B；当前仅影子比较，无真实命中/投递分母 | 未进入配置或投递变更 |
| 策略改进 | 候选草案→确认→新版本→回读→回滚 | Partial | T-567 固定证据回放通过；候选仍未正式采用，未完成真实确认/回读/回滚 | 保持不生效 |
| 写入边界 | 只读请求不修改业务资产或规则 | Partial | 持仓/观察/预案/规则均无写入；但本轮意外生成了 transient XLSX artifact | 需修复“无文件请求不生成制品” |

## 本轮运行可见性证据

- 已挂载服务工具：`portfolio_read`、`watchlist_read`、`plans_read`、`svc_catalog`、`spreadsheet_create`。
- 实际调用：上述 5 个工具；`external_mcp_tool_calls` 为 0。
- 未挂载而无法验证：`market-data-tool.get_hist_klines`、`market-data-tool.get_realtime_quote` 及其他行情/筹码/资金流工具。
- 运行 trace：`portal-c9258610-72c0-47e6-8c39-7649a3fc6b6f`，模型 `glm-5.3-flash`，`elapsed_ms=116429`，状态 `success`。

## 已完成修复

`src/runtime/screening-preparation.ts` 现在会把运行时能力清单、程序实际预取调用和未挂载的关键行情工具显式注入全持仓上下文，并声明无文件请求时不生成表格制品；`tests/screening-preparation.test.ts` 已覆盖这些断言。

验证：

- `node --import tsx --test tests/screening-preparation.test.ts`：2/2 通过。
- `npm run typecheck`：通过。

## 后续验收门

1. 在同一 `production-mirror` 会话进程级桥接已授权的生产行情 MCP，重跑本请求；必须观察到 `get_hist_klines` 一次、ETF `get_realtime_quote` 一次（按实际对象类型），并在 trace/审计中可回读。
2. 重跑结果必须展示“已挂载能力 / 实际调用 / 未挂载能力”三段，并确认无重复行情调用。
3. 单独补已建立 MCP 会话中途断开演练；在此之前可靠性闭环保持 `Pass with caveats`，不升格为 Pass。
4. 由用户裁决 P1 覆盖表和 P2 策略 B 参数后，再做单一策略候选的真实确认→版本回读→回滚；此前不改正式规则或策略。

## 修复后回归（2026-10-06 12:56）

- 重启本地镜像并通过 `npm run mirror:health`：runtime、portal、relay 均 200/307/426。
- 发送明确“不要生成文件”的全持仓请求，`portal-cb82c309-4e50-4634-9c00-7267a5a80cc3` 在 `44.3s` 完成。
- 用户可见结果新增“本轮已挂载能力与实际调用”段，明确无外部行情工具，并列出三类只读服务调用。
- trace 中实际调用仅 `portfolio_read`、`watchlist_read`、`plans_read`；该回归窗口新增 artifact 数为 `0`，确认无文件副作用。
- 外部行情 MCP 仍未挂载，因此 T-574 的真实数据批量调用验收继续保持 `Partial`，不是通过。

## 授权接通后的真实 MCP 复验（2026-10-06）

### 根因与处理

授权本身有效，之前失败是本地镜像进程配置问题：启动时仍指向本地 `127.0.0.1:8000`，外部 MCP 开关未显式打开；首次临时启动命令还把远端 PM2 环境的 `NAME: value` 格式按 `NAME=value` 解析，导致 token 为空。注册器按 fail-closed 规则跳过外部 MCP，所以用户看到的是“未挂载”，不是“授权被拒绝”。

本轮没有写入 `.env` 或生产配置。通过临时 SSH 只读隧道访问生产 `22640/22648`，注入进程级环境变量后验证：market-data-tool 发现 38 个工具，`get_realtime_quote` 返回 `source=tencent`；MCP registry contract 14/14 通过。

### 真实流程结果

会话：`web_RqmTtbD-V4rPqtzM`  
Trace：`portal-7aaddf19-cdbe-49a5-905b-5eccb19701b1`

| 项目 | 结果 |
| --- | --- |
| 端到端耗时 | 220.268s（用户可见约 3m40s） |
| 外部行情审计 | 4 次成功：`get_hist_klines`、`get_realtime_quote`、`get_stock_profiles_chips`、`get_fund_flows` |
| 重复行情 | 未发现重复 `get_hist_klines` 或 `get_realtime_quote`；程序预取各 1 次 |
| 覆盖 | 14 只股票批量预取 K 线，2 只 ETF 实时快照；16 个对象全部纳入 |
| 交付 | 候选、原因、触发/失效条件、可靠性分层、缺口全部给出；无准备行动信号 |
| 写入/文件 | 无资产、规则、提醒写入；未生成文件 |
| 成本 | `0.511895 CNY`，本轮运行记录，不推导长期单价 |

### 保留项

- `get_hist_klines` 预取成功，但 Agent 后续通过目录调度补充 8–9 月窗口时有 3 次被拒，结果明确把 25 日均线、5/60 日均量当前状态列为未知；因此没有把候选升级为准备行动。
- 运行过程包含 11 次模型侧工具事件、4 次外部 MCP 成功调用，耗时仍偏长；本轮目标是证明接通、批量和不重复，不把耗时优化重新扩大为当前主线。
- T-574 数据编排：`Pass with caveats`；完整业务交付：`Pass with caveats`（真实数据已进入证据包，但 K 线窗口缺口和中途断开场景仍保留）。

## 已建立 MCP 会话中途断开演练（2026-10-06）

会话：`web_RmW1Jx6JjtsNqZJ_`  
Trace：`portal-e6b115ff-30dd-45e8-b4d3-7e7cf62cbb06`

- 在真实行情 MCP 已开始调用后切断本地 SSH 只读隧道。
- 已取得：16 个节前收盘行情快照、16 个筹码单期快照、单日主力资金流。
- 中断后：均量线、25/14 日均线、月/周线结构、资金流近 5 日序列、筹码历史序列均未取得；后续失败调用被记录并停止收敛。
- 最终状态：`success`，耗时 `194234ms`，回复 `1172` 字符；明确交付阶段性结果和数据缺口，没有把连接失败升级为当前事实或行动建议。
- 期间未写入资产、规则、提醒或策略；未生成文件。

判定：已建立会话中途断开 `Pass with caveats`。可靠性闭环的核心行为已通过；保留项是失败等待约 3 分钟，后续可作为体验优化单独处理，不再阻塞 MG 核心验收。
