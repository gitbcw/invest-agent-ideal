# mg 选股超时与数据批量能力修复方案

状态：本地实现与自动化验收完成；生产发布、只读 live probe 和 mg 真实请求验收待授权
日期：2026-08-10
范围：Invest Agent Runtime、正式 Portal、外部 `market-data-tool`

## 1. 问题基线

mg 用户在 2026-08-10 早晨对同一选股请求进行了两次尝试。两次 Runtime ACP 均运行到 1,200,000ms 后超时；外部数据调用本身通常只需要 4-7ms，并非数据源连接超时。

共同故障链如下：

1. 原预算按 `serverId + toolName` 识别重复调用，忽略股票代码等参数。
2. `get_hist_kline` 对不同股票的第 5 次调用被误判为同一工具重复。
3. Observer 将数字 JSON-RPC 请求 ID 转成字符串后返回，客户端无法关联预算错误；等待约 300 秒工具超时后才继续尝试，随后又达到每轮 12 次总调用上限。
4. ACP 和 Portal Relay 都配置为 1,200,000ms，外层 Relay 比 Runtime 的终态早约 20-34ms 超时。
5. Runtime 保存了失败助手消息，Portal mirror 只留下用户消息，形成对话视图不一致。

这不是正常的复杂任务耗时，而是预算误判、JSON-RPC 响应 ID 类型破坏、终止语义缺口和超时层级倒置共同造成的确定性故障。

## 2. 已完成能力

### 2.1 Runtime 预算维度修复

本轮已将相同调用定义为：

```text
serverId + toolName + SHA-256(canonical JSON arguments)
```

- 对象键排序后再计算签名；JSON-RPC `id` 不参与签名。
- 相同工具查询不同股票不再互相累计。
- 相同调用即使被其他工具穿插，仍按单轮累计次数限制。
- 内存预算状态只保存哈希，不保存原始参数；审计表仍不保存请求正文。
- 新配置为 `EXTERNAL_MCP_MAX_IDENTICAL_CALLS`；旧的 `EXTERNAL_MCP_MAX_CONSECUTIVE_CALLS` 仅作为兼容回退。
- 每轮总调用上限 12 暂时保留，防止失控循环；较大候选集通过批量数据接口降低调用数。
- 预算错误响应保留原始 JSON-RPC ID 的值和类型；审计使用单独的字符串 ID，不再影响协议关联。

### 2.2 数据源批量历史 K 线

`market-data-tool` 已实现 `get_hist_klines`，一次调用可获取多只 A 股在同一区间和周期下的历史 K 线。每只证券独立复用单证券降级链和历史池；单只失败不影响整批，只有全部证券失败时才返回 `DataNotFound`。

## 3. 目标与非目标

目标：

- 不再把不同证券的历史数据请求误判为重复调用。
- 预算耗尽后在分钟级超时前可靠收敛为回答或明确失败。
- 满足 `单次 ACP < 总执行预算 < Portal Relay` 的超时不变量。
- Runtime canonical log 与 Portal mirror 最终一致，且补偿过程幂等。
- 选股后的多个候选使用一次 `get_hist_klines` 获取确定性历史价格事实，并正确处理部分缺失和来源告警。

非目标：

- 数据工具不生成“建议买入价”；它只提供可追溯事实，判断仍由 Agent 负责。
- 不靠无限提高总调用数或执行时长解决问题。
- 不在本方案中修改真实 Workspace、生产数据库或用户方法文件。
- 不把外部 MCP 的逐工具逻辑复制到 Invest Agent 或 Portal。

## 4. 关键设计决策

### 4.1 批量历史 K 线冻结契约

批量历史数据能力属于 `/Users/combo/MyFile/projects/market-data-tool`。该项目已经在 service 层提供数据源降级、质量校验、缓存、来源元数据和逐项补齐，MCP 只是薄传输层；Invest Agent 继续通过动态 `tools/list` 发现工具，不增加逐工具适配器。

已实现工具：

```text
get_hist_klines(symbols, start?, end?, adjust="qfq", limit=100, period="day")
```

参数契约：

| 参数 | 契约 |
| --- | --- |
| `symbols` | 必填 `list[str]`；6 位股票代码；去重保序；最多 30 只，超出部分截断并告警 |
| `start` / `end` | 可选，支持 `YYYYMMDD` 或 `YYYY-MM-DD`；缺省时每只证券各自返回最近 `limit` 条 |
| `adjust` | `qfq`、`hfq` 或空字符串，默认 `qfq` |
| `limit` | 每只证券返回最近 N 条，默认 100，硬上限 1000 |
| `period` | `day/week/month/m1/m5/m15/m30/m60`，默认 `day`；分钟线仅腾讯源 |

返回为一张扁平列式 JSON 表，而不是 `items[]`：

```text
columns = [代码, 日期, 开盘, 收盘, 最高, 最低, 成交量, 成交额, 涨跌幅]
rows    = 按输入证券顺序、再按日期排列
```

`meta` 至少保留 `total`、`returned`、`truncated`、`source`、`source_breakdown`、`period`、`adjustment`、`data_range`、`history_pool.per_symbol_counts`、`fetched_at` 和 `evidence_level`。

部分失败和边界通过结构化 warnings 表达：

- `missing_symbols`：单只证券全源失败或无数据；其他证券继续返回。
- `partial_fallback_used`：批次内不同证券由不同数据源提供，并附 `source_breakdown`。
- `too_many_symbols`：超过 30 只时截断，并附 `dropped`。
- 全部证券失败时才返回 `DataNotFound`。

调用规则冻结为：多只证券且区间、周期一致时使用 `get_hist_klines`；单只证券继续使用 `get_hist_kline`。只支持沪深主板、创业板、科创板和北交所股票代码，不支持可转债或基金。日/周/月降级链为 `tencent -> akshare -> baostock`，分钟线仅使用腾讯源。建议买入价仍由 Agent 基于这些事实判断，数据工具不输出投资建议。

### 4.2 预算耗尽必须是服务可执行状态

仅在错误文本里要求 Agent “停止调用”不构成可靠门禁。Runtime 应把预算耗尽建模为稳定事件：

```text
open -> budget_exhausted -> synthesis_only -> completed | terminal_failed
```

第一步先做 ACP 能力探针，验证当前 SDK 是否支持在同一轮关闭外部工具并要求最终综合。如果支持，预算事件后立即切换 `synthesis_only`，外部调用全部 fail closed，但允许模型用已取得的上下文完成回答。

如果 SDK 不支持同轮切换，则终止当前工具轮，并在同一 conversation 上启动一次禁止外部 MCP 的综合轮；综合轮不得获得新的工具预算。若无法保留先前工具上下文，必须快速返回稳定的 `TOOL_BUDGET_EXHAUSTED` 终态，不再等待至 ACP 总超时。不能用 Workspace prompt 作为唯一终止保证。

### 4.3 超时必须形成严格内外层级

普通 Portal 对话保留一次受限重试时，推荐生产值为：

| 层级 | 建议值 | 约束 |
| --- | ---: | --- |
| 单次 Portal ACP | 600,000ms | 每次尝试的硬上限 |
| Portal 总执行预算 | 1,200,000ms | 覆盖最多两次尝试和退避 |
| Portal Relay | 1,215,000ms | 比总执行预算多 15 秒终态持久化窗口 |

Runtime 启动时校验 `PORTAL_DIRECT_ACP_TIMEOUT_MS < PORTAL_EXECUTION_BUDGET_MS`。Portal 启动或健康检查验证 `PORTAL_CONNECTOR_REQUEST_TIMEOUT_MS >= PORTAL_EXECUTION_BUDGET_MS + 15,000`。配置非法时应 fail fast 或明确降级为安全默认值并记录错误，不能继续运行两个相等的超时。

### 4.4 Runtime 是对话终态的权威来源

Runtime `conversation_messages` 继续作为 canonical log，Portal 数据库是可重建 mirror。Relay 请求超时、连接中断或返回晚到时：

1. Portal 将本次发送标记为待协调，而不是假定没有助手消息。
2. 立即或在短退避后调用 `conversation.sync`，按稳定 `messageId`/`traceId` 拉取 Runtime 终态。
3. 页面重载和会话打开时再次执行增量协调。
4. upsert 必须幂等，不覆盖 Portal-only 展示状态，不重复插入助手消息。
5. 协调失败保留可重试状态和最小诊断，不伪造成功回复。

## 5. 执行工作包

### WP1：预算修复收尾与发布准备

- 完成当前 Runtime 预算代码、配置样例和回归测试。
- 增加 observer 路由集成测试：不同 symbol 可连续通过，相同参数达到阈值后返回既有审计错误类。
- 在部署说明中记录新变量和旧变量回退顺序。
- 运行 `npm test`、`npm run build`、`npm run test:boundary`、`git diff --check`。

验收：mg 场景中至少 5 个不同股票的 `get_hist_kline` 不产生 repeat-budget rejection；相同参数循环仍在阈值处被拒绝。

### WP2：预算终态与 synthesis-only

- 建立 ACP SDK 探针，记录同轮工具关闭、取消、conversation 上下文复用能力。
- 为每个 run 记录预算状态、首次耗尽时间、耗尽类型和耗尽后的工具调用次数。
- 按探针结论实现同轮或补充综合轮；综合轮禁止外部 MCP。
- 预算事件后设置短的收敛上限，超过即返回稳定终态。

验收：构造会持续重试的 Agent fixture，首次预算拒绝后不再产生上游数据请求，并在约定收敛上限内得到回答或 `TOOL_BUDGET_EXHAUSTED`，不得拖到 600/1,200 秒超时。

### WP3：批量历史事实接口集成验收（数据源实现已完成）

- 确认目标 `market-data-tool` 版本的 `tools/list` 和 `list_capabilities` 均包含 `get_hist_klines`，生产 HTTP MCP 暴露相同 schema。
- 用离线 fixture 和显式 live probe 核对扁平列式返回、输入顺序、日期顺序、来源元数据和历史池统计。
- 验证部分失败只产生 `missing_symbols`，混合来源产生 `partial_fallback_used`，超过 30 只产生带 `dropped` 的 `too_many_symbols`。
- 验证全部证券失败才返回 `DataNotFound`，单只失败不会丢弃其他证券结果。
- Invest Agent 不增加工具名映射；mg 场景中的多个候选使用一次批量调用，单只查询仍使用 `get_hist_kline`。

验收：10 个候选一次调用完成，结果按输入顺序和日期排列；一个证券无数据时其余结果仍成功；`limit=1000` 和 30 只边界可测；第 31 只被截断并明确列入 `dropped`；来源、时间、evidence、history pool 和 warnings 完整。

### WP4：超时配置收敛

- Runtime 恢复 ACP 600 秒、总预算 1,200 秒，并增加配置关系校验。
- 正式 Portal Relay 恢复 1,215 秒，并增加健康检查/启动日志中的脱敏配置摘要。
- 用 fake clock 或短测试值覆盖第一次超时、一次重试、总预算耗尽和 Relay 缓冲。

验收：Runtime 在 Relay 截止前持久化并返回终态；Portal 不再先于 Runtime 超时；非法配置无法静默启动。

### WP5：Portal 消息协调

- 定义 pending reconciliation 状态和幂等 upsert 契约。
- 在 Relay timeout、网络断开、页面重载和会话打开四个入口触发增量 sync。
- 补充“Runtime 已有失败助手消息、Portal 只有用户消息”的 fixture。

验收：fixture 最终补齐且只出现一个助手消息；重复 sync 无变化；跨用户、assistant 和 conversation scope 不可串写。

### WP6：端到端回归与生产观察

- 使用 mg 原请求的脱敏固定用例：基于 2026-08-07 收盘数据执行“选股工具 2.0”并给出建议买入价格。
- 离线 fixture 先验证预算、批量、超时和消息一致性，再做显式生产只读验收。
- 发布后观察 ACP 时长、总/相同调用预算拒绝、批量 partial rate、Relay timeout 和 reconciliation lag。

验收：请求产生完整终态；不同股票不触发相同调用预算；无 20 分钟边界竞态；Runtime 与 Portal 消息数和 messageId 一致。任何真实数据缺口必须明确披露，不能用成功状态掩盖。

## 6. 顺序、发布与回滚

执行顺序为 `WP1 -> WP3 -> WP2 -> WP4 -> WP5 -> WP6`。WP3 不再包含 schema 决策或数据源实现，只做版本暴露、动态发现和契约验收；它可与 WP2 并行。WP4 与 WP5 应在同一发布窗口联调，避免只调整一侧超时后形成新的竞态。

发布拆成三次可回滚变更：

1. Runtime 预算维度与观测。
2. 已实现的 `market-data-tool` 批量接口发布/验收及 Runtime 终态处理。
3. Runtime/Portal 超时配置和 Portal 协调。

每次发布均从已提交的本地 `main` 生成快照，普通发布只同步代码和构建输入；不覆盖生产 `.env`、SQLite、Workspace、`reviews/`、`.state/` 或微信状态。配置变更单独备份和核对。回滚时优先关闭新批量工具使用和 synthesis-only feature flag，再回滚代码；消息协调采用追加式幂等设计，无需删除生产消息。

## 7. 完成定义

- 当前预算维度专项、全量测试、构建和边界测试全部通过。
- `get_hist_klines` 已通过动态发现、离线 contract 和生产只读 probe 验收；Invest Agent 无逐工具映射。
- 预算耗尽后的停止行为由服务/ACP 编排强制，不依赖提示词服从。
- 三层超时关系有自动化校验和生产配置证据。
- Portal mirror 可从 Runtime canonical log 自动恢复。
- mg 固定场景在生产完成一次成功或数据有界降级的验收，并保留 trace、工具统计和消息一致性证据。

## 8. 本次本地执行记录（2026-08-10）

- WP1：相同调用按 `serverId + toolName + SHA-256(canonical arguments)` 预算；不同证券不再互相累计，JSON-RPC ID 保持原始类型。
- WP2：ACP 能力探针确认当前 SDK 无同轮工具撤销标准能力；首次预算拒绝后取消当前轮次，并在 `ACP_BUDGET_CONVERGENCE_MS` 内返回稳定的 `TOOL_BUDGET_EXHAUSTED` 终态。预算快照进入 Runtime trace。
- WP3：`get_hist_klines` 完成离线合同验收，覆盖动态发现、顺序、部分失败、来源告警、30/31 只边界和全部失败语义；Invest Agent 未增加逐工具映射。
- WP4/WP5：Runtime 校验 `PORTAL_DIRECT_ACP_TIMEOUT_MS < PORTAL_EXECUTION_BUDGET_MS`；Portal 校验 Relay 缓冲、持久化待协调标记，并在超时/断线、connector 恢复及会话打开时幂等补齐 canonical messages。
- 未执行：生产代码发布、生产 HTTP MCP 只读 probe、mg 脱敏固定请求和生产观测。它们需要单独的生产凭据与发布授权，且本次没有修改真实 `.env`、SQLite、Workspace 或微信状态。
