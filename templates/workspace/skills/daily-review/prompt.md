# 执行提示词：日复盘

读取当前项目的持仓、策略、方法、信息源、数据契约、证据策略、风险分类和操作确认规则。若持仓为空，转入新手引导。默认工作日 19:00 自动执行；用户也可以主动触发。若同一日期已由主动触发生成报告，自动任务不重复执行，除非用户确认刷新。

获取最新行情后，先标注 `data_as_of`、信息源和缺失数据，再计算持仓表。日复盘重点检查价格、盈亏、仓位、现金、买卖区间、观察仓距离、异常波动和风险分类，并按用户方法输出观点、理由、操作边界、验证点和失效信号。

行情事实优先使用 `invest-agent-service-tools` MCP 工具获取：先调用 `market.snapshot`，必要时补充 `market.quote` 或 K 线/行情相关工具；只有 MCP 工具不可用时，才用 workspace 根目录 `.sandbox-token` 授权的 HTTP sandbox API 兜底。必须使用返回的 `source`、`marketTime`、`confidence`、`warnings` 标注数据质量；若服务返回 `source.referenceUrl`，数据来源章节必须展示该外部 provider 引用。不要凭记忆编造精确价格，不要向用户展示工具名、本地 sandbox API、token、curl 或内部路径。

必须区分：

- 事实：行情、仓位、公告、财报或用户确认规则。
- 推断：基于用户方法得到的判断。
- 规则触发：是否触发用户确认过的买入、卖出、再平衡或风控条件。
- 不确定性：缺失、过期或冲突的数据。

必须输出：

- 今日是否需要操作。
- 今日是否需要关注。
- 今日是否需要用户确认。
- 组合健康检查：仓位纪律、集中度、现金安全垫、非核心复杂度、风险事件、风格漂移。
- 风险分级：按 `config/risk_taxonomy.yaml` 输出 P0/P1/P2。
- 固定章节 `## 数据来源与质量`，位置放在市场事实之后、持仓复盘之前。必须用表格列出关键数据来源、数据时间、置信度和状态，不要只在正文零散描述。
- 若建议买入、卖出或再平衡，只能在用户确认规则触发时输出操作确认单，不直接要求用户交易。

`## 数据来源与质量` 表格格式必须包含这些列：

| 数据 | 来源 | 外部引用 | 时间 | 置信度 | 状态 |
|---|---|---|---|---|---|

填表规则：

- 行情和指数来源使用服务 API 返回的 `source.provider` 和 `source.endpoint`；外部引用优先写 `source.referenceUrl`，没有时写 `source.endpoint`。时间优先用 `source.marketTime`，没有则用 `source.fetchedAt`。
- 自动日复盘若上下文 JSON 已提供 `sourceQuality`，必须直接使用其中的 `provider`、`endpoint`、`referenceUrl`、`time`、`confidence`、`status`，不要把它概括成“服务层行情源”。
- 只展示外部数据源引用，例如 `https://qt.gtimg.cn/q=...`、`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?...`、`https://hq.sinajs.cn/list=...`；不要展示 `http://127.0.0.1`、`/api/sandbox/...`、sandboxToken、curl 或内部文件路径。
- 用户持仓成本、数量、观察仓规则来源标为“用户确认配置”，时间使用 `config/portfolio.yaml` 的 `last_confirmed_at` 或报告生成时间，置信度标为 `user_confirmed`。
- 信息面若只来自新闻、研报或公告摘要，来源必须写成对应类别；未逐条核验时状态写“待核验”，不得写成已确认事实。
- 若 `warnings` 非空、行情缺失、数据过期、fallback provider、生效时间不清楚或来源冲突，状态必须显式写出，并在正文降低结论强度。
- 如果缺少关键来源，必须在本节写“缺失”，并在 `memory/source_events.jsonl` 记录 missing/stale/conflict 事件。

保存完整报告到 `reports/daily/YYYY-MM-DD.md`，并按 `config/data_contracts.yaml` 将核心观点写入 `memory/decisions.jsonl`。若出现数据源冲突或关键数据缺失，写入 `memory/source_events.jsonl`。
