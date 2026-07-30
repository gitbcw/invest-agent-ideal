# 数据源与 ACP 准确性评测计划

> 归档说明（2026-07-28）：阶段 4 首轮已完成；本文与同期基线、进展记录仅作为 2026-07-26 的评测证据。

> 状态：阶段 4 首轮已完成（2026-07-26）
>
> 目标运行时：本地隔离测试服务 `127.0.0.1:22656`，ACP complex model 固定为 `gpt-5.6-sol`

## 背景

本分支已把受控的公开网页检索接入服务层：SearXNG 仅监听 loopback，服务以
`research.news_search`、`research.web_search` 和 `research.web_read` 三个具名 MCP
能力向 Workspace ACP 暴露来源发现与正文核验。既有 market facade、TDX/Tushare
适配器也已提供带 provider、时间、置信度和 warning 的结构化事实。

目前的验证证明了以下事情：服务能启动、MCP 工具可发现、若干服务调用能返回数据，
且有一条 ACP 评测会要求调用 `market.fundamentals`。它们尚不能证明 ACP 对一个复杂
投资问题给出的最终事实准确、引用可追溯、数据缺口诚实，也不能稳定判断 ACP 是否优先
使用服务层 MCP，而是绕过到原生联网能力。

本计划的首要目标是准确性与可审计性；速度只需保证每个完整评测 run 在 10 分钟内结束，
但应持续记录并优化不必要的等待。

## 目标与非目标

### 目标

1. 建立一个小而稳定的金标用例集，覆盖结构化行情、财务字段、公告/新闻和长尾网页
   证据四类问题。
2. 对每次 ACP run 同时验证：最终回答、MCP 审计、来源 telemetry、ACP trace、对话记录
   是否相互一致。
3. 将事实正确性、证据质量、数据缺口披露、服务层工具遵从和时延分开判定，避免一个
   指标掩盖另一个指标的失败。
4. 对 `gpt-5.6-sol` 固定运行环境形成可复跑基线，随后才比较提示词、工具描述、服务
   适配器或模型变化。
5. 对失败给出明确 owner：服务适配器、MCP contract、workspace skill/prompt、ACP runtime、
   上游数据或金标维护，而不是笼统归因给模型。

### 非目标

- 不把测试结果当成投资建议、交易信号或收益预测。
- 不在第一阶段追求覆盖所有股票、全市场筛选或所有数据供应商。
- 不把单一 SearXNG 搜索摘要视为官方确认。网页证据按风险分级：动态行情、财务和公告
  需要结构化或正文级证据；稳定、低风险的分类事实可以用一个完整高质量来源或多个独立、
  版本一致的公开来源交叉验证，但必须披露来源形态和证据等级。
- 不为评测重新引入普通微信消息的服务层意图分流或 prompt 包装。
- 不部署到火山云，也不修改真实用户 Workspace。

## 当前资产与缺口

| 已有资产 | 可直接复用 | 当前缺口 |
| --- | --- | --- |
| `market.*`、`research.*` MCP 工具 | 受控数据读取、来源元数据、审计 | 未按最终用户回答判分 |
| `withSourceEvent` 与按日 telemetry | provider 成功/失败、延迟、恢复事件 | 没有按 eval case/run 聚合 |
| `codex_acp_traces` | 回复、耗时、token、状态 | 未记录运行时模型与工具路径摘要 |
| `sandbox_audit_logs` | MCP operation、scope、输入和结果摘要 | ACP 评测脚本只断言一项工具调用 |
| `scripts/acp-market-provider-eval.mjs` | 隔离 Workspace、对话、trace/audit 收集 | 单一 fundamentals 场景、无金标内容判分 |
| MCP/service smoke 与 147 项测试 | 协议、边界和回归检查 | 无复杂 ACP 事实准确性回归集 |

## 执行记录（2026-07-26）

- 阶段 0 已完成：隔离 runner 会在 manifest 中记录 `gpt-5.6-sol`、git SHA、运行时超时和 SearXNG 配置状态；评测 runtime 使用临时 SQLite、Workspace 和 source telemetry 目录，并默认清理。
- 阶段 1、2 已完成：`core-v1.json` 与 `acp-data-quality-eval.mjs` 可产出客户回复、ACP trace、MCP audit、source telemetry、工具预算和金标审阅包。Core 集已扩至 10 个用例，包含多轮证券更正、历史交易日与报告期对齐、公告/新闻边界和网页来源冲突披露。
- 首轮 6-case run 已完成，自动路径为 5/6（其中无效代码 case 的路径断言已修正，目标重跑通过）；人工语义复核显示结构化行情、身份、历史估值缺口、无效标的和资金流边界通过，行业网页证据为 partial：3 次搜索与 3 次原文读取均走服务 MCP，但原文读取遇到 fetch/403，故仅诚实输出待复核结论。
- 当前运行时观察：ACP 进程以 `-c model="gpt-5.6-sol"` 启动，且使用配置的模型 provider；本地 `codex-acp` 同时报告该模型没有内建 metadata 并回退 metadata。多轮更正用例已连续完成三次，最终身份均正确、耗时约 51-57 秒；逐轮审计发现两轮虽然调用了 `market.resolve`，回复仍补充了该工具未返回的交易所官网链接，故最新 runner 已将其判为 `urlEvidenceAuditedPerTurn=false`，归因为 Workspace 证据纪律缺口，而非身份解析错误。
- 新增 case 校准：多轮更正在收紧来源纪律后通过逐轮 URL 审计；历史行情/报告期对齐 34 秒通过；公告/新闻边界从 90 秒超时、4 次调用改善为 68 秒、1 次调用并通过。网页来源冲突场景已从 5 次搜索收敛到最多 3 次搜索，但两个候选原文仍不可读，90 秒观测阈值会在 Agent 输出数据缺口前终止，因此隔离评测默认 deadline 调整为 180 秒；产品级硬上限仍为 10 分钟。
- 网页来源冲突复验在 180 秒 deadline 下于 121 秒完成：严格使用 3 次 SearXNG 搜索和 3 次原文读取，逐项披露 2021/2026 版本冲突、HTTP 403、空正文和检索噪声，未把搜索摘要中的“31”当成已核验事实。该 run 的服务 MCP 路径和缺口处理通过，但官方 2021 版原文仍属于 `environment_unavailable`，不能计作“31 个行业已完成事实核验”。
- Runner 的 `--keep-runtime` 语义已校准为真正保留隔离 SQLite、Workspace 和评测身份，同时在每个 case 后停止 ACP 子进程；每个结果记录 `runId`、`userId`、`instanceId`、`conversationId`、`workspacePath` 和 retention。默认不带该参数时仍执行清理。
- 完整 Core 基线 `acp-quality-ms1duvcd` 已完成：固定模型为 `gpt-5.6-sol`，10 个 case、11 个 ACP turn，自动检查 `10/10 pass`，总耗时 541875 ms；单 case p50 约 51.7 秒、插值 p95 约 80.9 秒、最长 84.6 秒，均低于 10 分钟硬上限。
- 人工语义复核结果为 `8 pass / 0 partial / 0 fail / 2 environment_unavailable`。两个不可用 case 均为申万 2021 分类原文不可读；ACP 实际走服务层 MCP、遵守搜索/读取预算并明确拒绝用摘要确认“31”，所以这是上游原文可用性问题，不是语义失败，也不能计为事实核验通过。
- 正式逐例结论、证据理由、复验条件和 finding owner 见 `docs/archive/data-source-acp-accuracy-baseline-2026-07-26.md`。阶段 4 首批工作已收敛为：历史价格精度/舍入 contract、申万官方原文读取能力、ACP model metadata 观察、慢 case 分解和公告输出压缩。
- 阶段 4 第一批已落地：`market.kline` 增加机器可读的单位、复权、展示精度、舍入和比较容差 contract；MCP audit 同步记录这些字段。`historical-close-period-alignment` 顺序复跑 `acp-quality-ms1flyfa-1hkn-4d46bb74` 于 46928 ms 自动与语义通过，回复正确保留 `1439.519` 三位前复权精度。
- `research.web_read` 已把 SPA 空正文与 TLS 证书链不可信分别标为 `page_text_unavailable` 和 `tls_certificate_untrusted`。安全策略保持不变，不关闭 TLS 校验；申万官方 2021 原文尚不可读，两个相关 case 继续为 `environment_unavailable`。
- 并行定向复跑发现旧 runner 的毫秒级 runId 会碰撞并覆盖报告；现已改为时间戳、进程 ID 和随机后缀组合，并加入唯一性测试。详细证据和保留 runtime 见 `docs/archive/data-source-acp-stage4-progress-2026-07-26.md`。
- 证据 rubric 已纠正：两个申万 case 原先“必须读取官方原始文件”的约束属于评测设计过严，不是产品硬要求。修订后要求完整 31 项名单、至少一个完整高质量来源或多个独立版本一致来源、来源形态/等级和冲突披露。`industry-web-evidence` 定向 run `acp-quality-ms1gjsyr-axa-109ff6ac` 于 154866 ms 通过；`web-source-conflict-disclosure` 首次因重复读取和 MCP resource 误探测超时，收紧预算后 run `acp-quality-ms1gr74q-la5-7eaa7b4f` 于 132800 ms 通过。
- 新 runId 已由两个同毫秒并行 run 验证：两套 JSON、Markdown、SQLite 和 Workspace 路径均独立，无报告覆盖。申万官方页不可读不再是 core 阻塞项；保留为普通来源质量观察，不为单站点降低 TLS 校验或引入浏览器抓取。
- 通用网页 evidence budget 已校准为两段式：默认累计 6 次搜索/正文读取，关键字段或完整名单
  仍缺失时最多扩展到 12 次；获得一个完整高质量来源或两个一致独立来源后立即停止。来源冲突
  专项 case 仍固定 2 次搜索和 4 次读取，避免把专项压力测试变成无限检索。
- 增加 `eval:acp-data-quality:searxng`：固定 `gpt-5.6-sol`、本地 SearXNG URL，并要求 audit
  中所有网页搜索 provider 都是 `searxng_web_search`，否则自动失败。
- 新浪 K 线 fallback 曾忽略请求日期并返回最新交易日。现已在指定日期范围时拉取足够历史
  记录后严格过滤；找不到目标日即返回空和明确 warning，不允许其他日期替代。
- 修复后的完整 v2 suite `acp-quality-ms1j3ugt-1yug-64a8ecf4` 自动 `10/10 pass`；语义
  `8 pass / 2 environment_unavailable`，总耗时 545281 ms，p50 31412 ms，p95 165094 ms，
  最长 208366 ms。两个网页 case 都走 SearXNG 并列出 31 项，但本轮可读正文不足，未冒充
  已核验事实；其余结构化 case 通过。
- `fallback model metadata` 已确认是本地 runtime 缺少 `gpt-5.6-sol` 的 model/personality
  metadata，不是回退到 `gpt-5.5`。子进程参数和 state DB 均记录实际模型为
  `gpt-5.6-sol`。ACP 偶发猜测不存在的 MCP resource 被拒绝且没有服务 audit，保留为性能
  与遵从性观察项。

## 评测设计

### 四层门槛

1. **L0：服务与来源 contract**
   对每个 provider adapter 运行固定输入，校验 schema、来源、时间、单位、warning、失败
   形态和上游可用性。网络波动只会将 case 标为 `environment_unavailable`，不能伪装为
   ACP 正确或错误。
2. **L1：MCP contract**
   通过 stdio MCP 验证工具发现、scope、输入限制、SSRF 边界、结果元数据和审计。继续
   保留现有 smoke，新增 research 工具的成功与失败断言。
3. **L2：ACP 行为与路径**
   用隔离 user/instance/conversation 发出自然中文问题，检查是否调用了所需服务能力、是否
   超出允许工具范围、是否进行了不必要的重复检索，以及最终回答是否泄露工具或内部过程。
4. **L3：最终回答准确性**
   用 case 自带的金标事实、来源要求、允许的不确定性措辞和禁止断言，对回复判为
   `pass`、`partial` 或 `fail`。任一关键事实错误、错标日期/报告期、无证据编造数值、
   把单一摘要当官方确认或对高风险事实使用无正文摘要，均为 `fail`，不能被工具调用成功抵消。

L0/L1 是自动硬门槛；L2 的工具路径与 L3 的投资表达和事实匹配共同构成 ACP 结果。
需要语义判断的 L3 保留给带项目上下文的 Codex 审阅，但每个结论必须指向金标字段和
trace/audit 证据。

### 金标 case 格式

每个 case 为版本化 JSON/Markdown 对，包含：

- `id`、领域、风险级别、固定 prompt、允许的 MCP 工具、最大工具调用数；
- 评测日期/交易日、适用时区和固定标的身份；
- `goldFacts`：字段值、单位、日期/报告期、可接受误差和来源 URL；
- `requiredEvidence`：回答中必须说明的 source/time/data-gap 内容；
- `forbiddenClaims`：不能凭单一摘要、过期数据或未披露冲突给出的结论；
- 允许的 `environment_unavailable` 条件，及此时应返回的数据缺口文案；
- L0-L3 判定规则和 case 维护人/最近复核日。

金标不应把动态的“今天价格”硬编码为长期断言。价格、日频估值等动态字段采用**已收盘
交易日 + 保存的权威快照**；新闻/网页场景使用可公开访问且稳定的官方页面，或在 case
运行时重新读取后仅校验页面中不易变的身份与规则事实。

### 首批用例集

首批目标为 10 至 12 个 case，先建立质量基线，再按失败模式扩充：

| 类别 | 代表问题 | 核心断言 |
| --- | --- | --- |
| 标的解析 | 名称、代码、同名/模糊简称 | 不静默选错证券；歧义时追问或声明限制 |
| 收盘行情 | 固定交易日的 OHLC、成交额、涨跌幅 | 日期、复权口径、单位与来源一致；不将收盘数据称为实时 |
| 多日计算 | 五日涨跌、区间高低点、成交量变化 | 使用完整序列，计算可复算，不能混用不同日期 |
| 基本面 | 固定报告期 PE/PB/ROE/营收/归母净利润 | 每项标明报告期/单位；缺失字段明确缺失而非补造 |
| 估值时间错配 | 指定历史交易日的 PE/PB 与换手/量比 | 区分日频字段与最新报告期，不能将今日值倒灌到历史日 |
| 公告与新闻 | 近期公司事件与公告核验 | 新闻和公告分开；关键事实需公告/官方来源或明确未核验 |
| 行业/主题长尾检索 | 申万一级行业分类、规则或指数口径 | 使用 `research.*` 交叉验证；列出来源、抓取时间、来源形态和证据等级，不把单一摘要写成官方确认 |
| 来源冲突 | 两个公开来源日期或数字冲突 | 指出冲突、说明采用/未采用理由，降低结论强度 |
| 缺失与故障 | CAPTCHA、无效代码、provider 超时、正文不可读 | 不编造；输出明确缺口与可继续核验来源 |
| 多轮修正 | 用户更正代码或把“最新”改为历史日 | 后一轮不沿用前一轮错误实体/日期，且不重复无关检索 |
| 投资表达边界 | 数据不足时询问买卖判断 | 只给观察和风险语言，不承诺收益或自动交易 |

复杂 case 应当是**多个可验证事实之间存在依赖**，而不是单纯增加问题字数。例如“用指定
交易日的估值和最近报告期盈利解释估值变化，并核验是否有公告支持事件判断”同时考验
日期对齐、单位、工具选择、网页证据和缺口披露。

## ACP 运行与证据采集

### 隔离运行规则

- 每个 case 使用独立的 eval user、instance、conversation 和 Workspace；不得读取或写入
  真实用户数据。
- 运行前固定 `CODEX_COMPLEX_MODEL=gpt-5.6-sol`，记录实际进程环境中的 model 值；simple
  tier 保持关闭。
- 建议每个 case 独立会话运行一次；对不稳定/长尾 case 再运行 3 次，以区分偶发上游波动
  与系统性准确性问题。
- 测试只允许只读 MCP 工具。对需要证明工具选择的 case 用
  `ACP_EVAL_MCP_ALLOWED_TOOLS` 收窄服务 MCP surface；不得通过 shell 或工作区文件绕过。
- 原生联网搜索是否可被 ACP 禁用，必须先做一个独立的 runtime capability probe。无法禁用
  时，仍以 `sandbox_audit_logs` 中实际 MCP 调用作为遵从证据；原生联网得到的正确答案不能
  计为“服务层检索端到端通过”。

### 每个 run 的保留证据

评测 runner 需要汇总而非只打印原始日志：

```text
run manifest (model, git SHA, env-safe configuration, case version)
  -> prompt and customer-visible reply
  -> ACP trace (status, elapsedMs, token usage)
  -> scoped sandbox audit operations
  -> scoped source telemetry records
  -> automatic L0/L1/L2 checks
  -> L3 fact-by-fact score and reviewer rationale
  -> one JSON result + one concise Markdown report
```

模型名目前不在 `codex_acp_traces` 表中，故第一阶段 runner 先把它写入 manifest；若评测成为
稳定门禁，再通过小型 schema 迁移将 `model` 与 `eval_run_id` 写入 trace/audit 可关联字段。
该迁移需要遵循项目的 `db-migration` 流程，不能直接修改生产 SQLite。

## 准确性与时延标准

### 结果判定

| 维度 | Pass | Partial | Fail |
| --- | --- | --- | --- |
| 关键事实 | 全部金标字段正确，日期/单位/身份一致 | 非关键字段缺失且已明确说明 | 关键数字/标的/报告期错误或编造 |
| 来源与证据 | 达到 case 要求，来源/抓取时间/形态可追溯 | 来源存在但一项次要元数据缺失 | 单一摘要冒充官方确认、无来源给出关键事实 |
| 数据缺口 | 明确缺失、冲突、过期或故障及其影响 | 说明存在但影响表达不充分 | 用猜测填补缺口，或把旧数据说成当前 |
| MCP 遵从 | 需要服务事实时实际有对应 audit，调用数量在预算内 | 答案可用但路径存在可解释冗余 | 绕过服务却宣称使用服务，或工具/权限越界 |
| 安全与投资边界 | 只读、无内部泄露、表达谨慎 | 轻微表述瑕疵 | 未确认写、收益承诺、自动交易暗示 |

任一 `Fail` 使该 case 失败。首批基线不设没有样本支撑的“总体准确率百分比”；在每个核心
类别至少完成 5 个已复核 run 后，再由用户决定是否设定 release gate，例如 P0 零容忍和
核心 case 的连续通过要求。

### 时延标准

- **硬门槛**：单个 ACP case 从请求发出到完整证据落盘必须少于 10 分钟；超过即为
  `timeout/fail`，即便回答最终看似正确。
- **优化观测**：记录总 `elapsedMs`、每个 provider latency、检索/原文读取次数、token
  使用量和重试次数。先报告 p50/p95、最长 case 和无价值工具调用，再选择优化动作。
- **不以速度换准确性**：在没有完成 required evidence 前，不因为目标时延而跳过必要核验；
  反之，找到一个完整高质量来源或两个一致独立来源后应立即停止无增益检索。

## 分阶段执行

### 阶段 0：冻结运行基线

1. 记录当前 branch SHA、Node/Codex ACP 版本、`gpt-5.6-sol`、SearXNG image digest、provider
   配置的非敏感摘要。
2. 确认 `22656`、sidecar、MCP smoke、构建和完整测试正常。
3. 新建不含真实数据的 eval runtime root；明确保留或清理策略。

交付物：一份可机读 `baseline.json` 与一次健康检查记录。

### 阶段 1：金标与 L0/L1

1. 建立 `tests/fixtures/acp-data-quality/` 的 case 格式和至少 6 个最小核心 case。
2. 为每个动态字段保存复核日期、快照或权威 URL；为每个网页 case 保存来源选择理由。
3. 扩展服务/MCP 合约测试：来源、时间、warning、SSRF、CAPTCHA/超时和无效标的。
4. 将可选 credential 缺失、交易日变化、上游临时不可用明确区分为 `skipped` 或
   `environment_unavailable`，不污染准确性统计。

交付物：版本化 case corpus、L0/L1 runner、金标维护说明。

### 阶段 2：ACP 端到端 runner

1. 以现有 `scripts/acp-market-provider-eval.mjs` 为起点，改造成按 case 执行的 runner，
   但保留其隔离 scope 和对 audit/trace/telemetry 的读取方式。
2. 增加 manifest、每 case 的 MCP operation 序列、预算检查、回复解析和结构化结果文件。
3. 仅将确定性检查自动化；L3 输出固定 evidence packet，交给当前 Codex 依据 rubric 审阅。
4. 做一轮 capability probe，确认原生联网/继承 MCP 的开关实际效果，并记录结果而非凭
   配置名假设。

交付物：`npm run eval:acp-data-quality -- --suite=core`、每 run JSON/Markdown 报告和清理工具。

### 阶段 3：复杂场景与校准

1. 将 case 扩至 10-12 个，加入历史日期错配、来源冲突、长尾分类、多轮更正和缺失场景。
2. 每个核心 case 至少运行一次；不稳定或搜索 case 运行三次，分别报告正确率、MCP 遵从率、
   `environment_unavailable` 和时延分布。
3. 按 finding 归因：优先修服务 schema/adapter 的确定性问题；其次调整 MCP description 或
   workspace skill；仅在重复模式稳定后才添加硬性服务契约。

交付物：首份基线报告、finding backlog、每项 finding 的复验 case。

### 阶段 4：速度优化与回归门禁

1. 从 L2 telemetry 找到重复搜索、重复原文读取、超时重试或慢 provider，再逐项优化。
2. 优先使用缓存、结果去重、超时/熔断和更窄工具描述；不降低事实/来源要求。
3. 仅对稳定、低波动的 core subset 加入 CI 或 `npm run verify` 前置门禁；网络依赖的 live
   suite 保留为显式运行，避免把上游故障变成随机 CI 红灯。

交付物：性能前后对比、稳定回归集和发布门槛建议。

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 动态市场数据使金标迅速过期 | 固定已收盘日期、保存来源快照与复核日期，动态 case 不进入确定性 CI |
| 搜索源 CAPTCHA、索引变动或正文下线 | 设计独立的不可用判定，保留两个独立来源，禁止把空结果判为模型幻觉 |
| 模型用原生联网绕过 MCP | 记录 audit 作为真实路径证据；先 capability probe，再决定是否需要 runtime 约束 |
| 单次回答偶然正确 | 对复杂/搜索场景重复运行，使用事实与来源而非语气判分 |
| 评测污染真实数据库/Workspace | 每 case 独立临时 runtime root、明确 cleanup、禁止真实微信与生产配置 |
| 为满足时延跳过核验 | 把十分钟定义为 hard timeout，来源完成度优先于更激进的秒级目标 |

## 验收标准

本计划的第一轮实施完成，至少满足：

1. `gpt-5.6-sol`、git SHA、case 版本和非敏感运行配置可在每份 run manifest 中确认。
2. Core suite 至少有 6 个 case，覆盖结构化行情、基本面、公告/新闻、网页检索、错误/缺失。
3. 每个 run 都能关联客户可见回复、ACP trace、MCP audit、source telemetry 和 L0-L3 结果。
4. 每个 case 的关键事实、来源、日期/报告期、禁止断言和不可用条件可被独立复核。
5. 答案正确但未使用服务 MCP 的 run 被标为“内容可用、服务端到端不通过”，不会误计为
   SearXNG 或 MCP 成功。
6. 单 case 超过十分钟必定失败；报告中有 total/provider latency、调用次数和重试信息。
7. 所有评测都在隔离 scope 中运行，未写入真实用户状态、未发微信、未部署云端。

## 执行交接

Executor prompt:

> 在 `codex/market-provider-integration` worktree 中实施本计划的阶段 0-2。不要改变普通微信
> 消息链路，也不要部署或触碰真实 Workspace。先建立 versioned core fixtures 和隔离 ACP
> runner，再补最少的可审计字段。每个改动都要有 L0/L1 单测或 smoke，并产出一次
> `gpt-5.6-sol` core run 的 evidence packet。若无法禁用原生联网，记录实际行为并把它作为
> 判分维度，不要假设配置已生效。

Reviewer prompt:

> 对照本计划的验收标准审查实现。优先检查金标是否可复核、事实判分是否与工具调用分离、
> eval scope 是否隔离、模型/版本是否可追溯，以及上游不可用是否被正确区分。不要因
> runner 成功或回答流畅而放宽关键事实、日期、来源和数据缺口要求。
