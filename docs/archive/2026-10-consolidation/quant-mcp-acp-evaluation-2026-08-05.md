# 量化选股 MCP 经 ACP 能力测试报告

## 1. 结论

本次通过 Invest Agent 的 ACP 消息入口，实际调用外部 `qsse-qlib` 量化选股 MCP，完成了两项测试：

- 历史截面选股：通过。`2026-07-01` 截面返回 5 只股票，计算覆盖率 `99.6928%`。
- 回测：通过。`2026-07-01` 至 `2026-08-04` 共 24 个交易日、25 次调仓、0 次跳过，返回完整净值和指标。

两项测试都按“能力探查 -> 表达式校验 -> 目标执行”的顺序调用了 MCP，ACP trace 与 MCP observer 共记录 6 次成功工具调用。量化工具本身的单次调用耗时约为 `0.07-6.66 秒`，但 ACP 端到端耗时分别为约 `5 分 44 秒` 和 `3 分 21 秒`，主要延迟来自 ACP 模型处理和会话等待，不是 MCP HTTP 转发本身。

## 2. 测试范围与证据

| 项目 | 内容 |
| --- | --- |
| 测试日期 | 2026-08-05 |
| ACP 入口 | `POST http://127.0.0.1:22656/acp/message` |
| 运行方式 | 临时隔离运行时；独立 SQLite、运行数据和 Workspace |
| userId / instanceId | `eval-quant-20260805-isolated` |
| Workspace | `/Users/combo/MyFile/projects/invest-agent-ideal/data/test-workspaces/eval-quant-20260805-isolated` |
| 数据库证据 | `/Users/combo/MyFile/projects/invest-agent-ideal/data/test-runtime/quant-eval.db` |
| retention | `retain` |
| ACP 运行 ID | `acp-quality-quant-20260805-isolated-screen`、`acp-quality-quant-20260805-isolated-backtest` |
| conversationId | `eval-quant-20260805-isolated-historical-screen`、`eval-quant-20260805-isolated-backtest` |

正式会话的 ACP manifest 均包含 `invest-agent-service-tools`、`market-data-tool` 和 `qsse-qlib`；实际 `quant_*` 调用均路由到 `qsse-qlib`。本报告未把直接 MCP 预检结果当作正式验收结果，正式验收证据以 `codex_acp_traces` 和 `external_mcp_tool_calls` 为准。

## 3. MCP 接口清单

实际 `tools/list` 返回 4 个量化工具：

| 工具 | 用途 |
| --- | --- |
| `quant_capabilities` | 查询数据源、字段、算子、最新数据日和历史长度 |
| `quant_validate_expression` | 校验表达式、字段引用和所需历史窗口 |
| `quant_screen_stocks` | 按单日截面执行 `top_n` 或 `filter` 选股 |
| `quant_backtest` | 按表达式逐日选 `top_n`、等权持有并计算轻量回测指标 |

本次使用的数据源是 `realtime`：滚动 60 日、近期行情、未复权。正式 ACP 返回的 `available_history_days=60`，`data_as_of=2026-08-05`，表达式所需历史窗口为 5 日，校验结果为历史充足。

## 4. 测试用例

### HS-001：历史截面选股

目的：验证 Agent 能否在指定历史交易日，使用当时可用的实时 60 日池数据执行横截面排名。

固定输入：

```text
data_source = realtime
expression = Mean($close, 5) / Ref($close, 5) - 1
mode = top_n
top_n = 5
market = all
date = 2026-07-01
order = desc
```

要求 ACP 严格依次调用：

1. `quant_capabilities(data_source=realtime)`
2. `quant_validate_expression(expression=..., data_source=realtime)`
3. `quant_screen_stocks(expression=..., mode=top_n, top_n=5, market=all, date=2026-07-01, order=desc, data_source=realtime)`

验收条件：表达式校验通过；目标日期被接受；返回 5 条排序结果；返回覆盖率；失败时不得改用 `cn_data` 或编造结果。

### BT-001：60 日实时池短区间回测

目的：验证 Agent 能否使用同一表达式和实时 60 日池执行短区间轻量回测。

固定输入：

```text
data_source = realtime
expression = Mean($close, 5) / Ref($close, 5) - 1
start_date = 2026-07-01
end_date = 2026-08-04
market = all
top_n = 5
order = desc
benchmark = none
```

要求 ACP 严格依次调用：

1. `quant_capabilities(data_source=realtime)`
2. `quant_validate_expression(expression=..., data_source=realtime)`
3. `quant_backtest(expression=..., start_date=..., end_date=..., market=all, top_n=5, order=desc, benchmark=none, data_source=realtime)`

验收条件：返回回测状态、调仓日数、跳过日数、净值和指标；失败时不得改用 `cn_data` 或编造净值；结果必须说明基准设置。

## 5. 测试结果

### HS-001 结果

| 字段 | 结果 |
| --- | --- |
| 状态 | 通过 |
| 数据源 | `realtime` |
| 数据最新日 | `2026-08-05` |
| 可用历史 | 60 个交易日 |
| 目标截面 | `2026-07-01` |
| 返回数量 | 5 |
| 股票池 | 5,207 |
| 计算成功值 | 5,191 |
| 空值剔除 | 16 |
| 有效值覆盖率 | `99.6928%` |

返回结果按值降序为：

| 排名 | 代码 | 数值 |
| ---: | --- | ---: |
| 1 | `SH688432` | 0.4939658344 |
| 2 | `SH688596` | 0.3935727477 |
| 3 | `SH688233` | 0.3571670949 |
| 4 | `SH688669` | 0.3516364396 |
| 5 | `SH688115` | 0.3314842284 |

工具返回了代码、交易所、数值和排名，但没有返回股票名称。ACP 没有补写名称，并在结果中明确说明这一点，符合不编造事实的要求。

### BT-001 结果

| 字段 | 结果 |
| --- | ---: |
| 状态 | 通过 |
| 数据源 | `realtime` |
| 回测区间 | `2026-07-01` 至 `2026-08-04` |
| 调仓日数 | 25 |
| 跳过日数 | 0 |
| 实际收益交易日 | 24 |
| 基准 | `none` |
| 首个净值 | `2026-07-02`，`0.936039` |
| 最终净值 | `2026-08-04`，`0.675472` |
| 累计收益 | `-32.4528%` |
| 年化收益 | `-98.1173%` |
| Sharpe | `-5.6438` |
| 最大回撤 | `-39.0904%` |
| 波动率 | `66.0887%` |
| 胜率 | `37.5%` |
| 警告 | 无 |

这里的负收益是该表达式在本测试区间的策略表现，不是回测引擎失败。由于只覆盖 24 个收益交易日，年化收益和 Sharpe 不应被解读为长期稳定预测。

## 6. 耗时拆分

ACP trace 的 `elapsed_ms` 是从服务收到消息到最终回复的端到端耗时；`tool_calls` 中的耗时是 ACP 事件观察到的单次工具调用耗时；observer 的 `elapsed_ms` 主要反映本地 observer relay，不代表完整量化计算耗时。

| 用例 | ACP 端到端 | capabilities | validate | 目标工具 | MCP 工具耗时合计 |
| --- | ---: | ---: | ---: | ---: | ---: |
| HS-001 | 344,313 ms（约 5 分 44 秒） | 85 ms | 2,543 ms | screen 6,481 ms | 9,109 ms |
| BT-001 | 201,141 ms（约 3 分 21 秒） | 74 ms | 2,651 ms | backtest 6,663 ms | 9,388 ms |

observer 记录的 6 次调用全部为 `completed`，单次 relay 记录约 20-25 ms，没有失败或预算耗尽。两项用例的主要延迟来自 ACP 模型在工具调用之间的等待，而非外部 MCP 的 HTTP relay：HS-001 中工具调用之间存在约 80 秒和 50 秒间隔；BT-001 中存在约 43 秒和 33 秒间隔。

## 7. 能力边界与发现

1. **功能链路已打通。** ACP 能发现 `qsse-qlib`，按测试要求调用 `quant_*` 工具，并将结果整理成结构化 JSON；服务层 observer 能按 `userId`、`instanceId`、`conversationId` 和 `runId` 留存调用证据。
2. **实时池适合短窗口验证，不等于长期历史回测。** 本次实时池只有 60 个交易日、未复权；BT-001 只验证 24 个收益交易日。长期回测应使用接口声明的 `cn_data`，但它的时间范围和复权口径与 `realtime` 不同，不能混用结果。
3. **回测是轻量模型。** 当前接口不建模交易成本、涨跌停、停牌过滤和滑点。本次 `benchmark=none`，因此 `benchmark_metrics` 为空，不能从本次结果得出相对基准超额收益结论。
4. **股票名称缺失。** 历史截面结果只有代码和计算字段；如果要直接面向用户展示，应增加 MCP 返回名称，或在服务层使用同一截面日期的确定性代码映射，并标明映射来源。
5. **预检存在一次短暂不一致。** 正式 ACP 之前的直接 MCP screen 预检曾返回 `NOT_INITIALIZED`/503，而正式 ACP 中同一目标调用成功。说明 `quant_capabilities` 的“已初始化”状态和 screen 执行面的 readiness 还可能存在瞬时不一致，应补充 MCP 启动健康检查和重试观测。
6. **现有仓库 probe 目录需要收敛。** `scripts/mcp-acp-qsse-tool-call-probe.mjs` 的固定期望工具列表只包含前三个工具，未覆盖已经实际暴露的 `quant_backtest`。后续应改为动态检查并增加 BT-001，避免工具目录扩展后探针失真。
7. **本地运行时配置有独立问题。** 22655 的第一次正式入口请求因当前 `.env` 的 `CODEX_SOURCE_HOME` 指向不存在的实验目录而在 ACP 鉴权阶段失败；这不是量化 MCP 失败。正式测试使用 22656 隔离运行时和有效 Codex 配置源完成，已避免污染现有运行时和数据。

## 8. 建议的后续验证

1. 修正本地/部署环境的 `CODEX_SOURCE_HOME`，并为 ACP 长耗时请求提供至少 10 分钟的客户端超时或异步任务状态接口。
2. 把 `quant_backtest` 纳入 ACP 真实 probe，工具目录采用动态发现，验收中同时检查 tool-call trace 和 observer 记录。
3. 为 `quant_screen_stocks` 增加 readiness 失败的明确错误分类和有限重试，区分“数据尚未初始化”和“执行服务不可用”。
4. 在回测接口或报告层明确标注轻量回测假设，并为实时池提供可选基准或明确禁止输出“跑赢基准”的措辞。
5. 增加一条结果展示契约：代码、名称、截面日期、数据源、复权口径和覆盖率必须同时出现；名称缺失时不得静默补全。
