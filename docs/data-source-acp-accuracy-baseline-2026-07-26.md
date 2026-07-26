# 数据源 ACP 准确性基线验收（2026-07-26）

## 当前统一基线（v2）

- Run：`acp-quality-ms1j3ugt-1yug-64a8ecf4`
- Fixture：`v2`
- 模型：`gpt-5.6-sol`
- 搜索路径：要求并实际观察到 `searxng_web_search`；两个网页 case 均无其他 search provider
- 自动检查：`10/10 pass`
- 人工语义复核：`8 pass / 0 partial / 0 fail / 2 environment_unavailable`
- 时延：总计 `545281 ms`；单 case p50 `31412 ms`，插值 p95 `165094 ms`，最长
  `208366 ms`；所有 case 均低于 10 分钟
- 隔离与留存：独立 SQLite、user、instance、conversation 和 Workspace；继承 MCP 已禁用；
  runtime root 由 manifest 保留

本轮两个网页 case 都返回了 31 个不重复的 2021 版候选行业，并明确区分旧版名称，但本次
没有取得一个包含完整名单的高质量可读正文，也没有取得两个包含完整名单的一致独立正文，
因此不能计为事实核验通过。这里的失败条件不是“没有申万官方原文”：官方正文、完整高质量
公开来源或两个一致独立来源都可满足 rubric；本轮只是正文可用性不足。

其余 8 项语义通过。特别是 `historical-close-period-alignment` 严格返回 2025-07-24 的腾讯
前复权收盘价 `1439.519`，没有被 fallback 的最新日期污染；PE、PB、换手率、量比和报告期
字段不可得时均明确披露，没有用其他日期或当前值替代。

网页 evidence budget 采用两段式：默认在累计 6 次搜索/正文读取内收敛；关键字段或完整名单
仍缺失时允许继续到最多 12 次；得到一个完整高质量来源或两个一致独立来源后立即停止。
专门测试冲突披露的 case 仍固定为 2 次搜索加 4 次正文读取，验证严格预算下的诚实降级。

运行日志中的 `fallback model metadata` 指本地 `codex-acp` 缺少该模型的 personality/model
metadata，ACP 子进程参数和本地 state DB 均记录实际模型为 `gpt-5.6-sol`；目前没有证据表明
请求回退到 `gpt-5.5`。ACP 偶发猜测不存在的 MCP resource，均被 `Method not found` 拒绝，
没有产生服务层操作；这属于路径和时延噪声，保留观察，不通过伪造 resource 绕过。

## 基线结论

以下为历史 v1 基线，保留用于比较，不代表当前统一结果。

- Run：`acp-quality-ms1duvcd`
- 模型：`gpt-5.6-sol`
- Git SHA：`7407225e8140432392df271f77b274eb3036b4a1`
- 隔离性：独立 SQLite、user、instance、conversation 和 Workspace；继承 MCP 已禁用
- 留存策略：`retain`；证据位于 manifest 记录的临时 runtime root
- 自动检查：`10/10 pass`
- 人工语义复核：`8 pass / 0 partial / 0 fail / 2 environment_unavailable`
- 时延：总计 `541875 ms`；单 case p50 `51666 ms`，插值 p95 `80938 ms`，最长 `84568 ms`
- 安全边界：11 个 ACP turn 全部成功；无写入、超时、工具预算超限或未审计 URL

自动检查只证明工具路径、预算、trace 和 URL 审计等硬约束。下表的人工结论依据
case 金标、客户可见回复、`sandbox_audit_logs`、`codex_acp_traces` 和 source telemetry
逐项复核，不把自动通过等同于事实准确。

## 逐例语义复核

| Case | 结论 | 复核依据 | 复验条件 |
| --- | --- | --- | --- |
| `calendar-weekend` | `pass` | 正确判定 2026-07-25 为周六且非交易日；日期、时区和 `market.calendar` 来源一致 | 日历 contract 回归 |
| `security-identity` | `pass` | `600519 / SSE` 正确；唯一解析、来源和无歧义说明与两项 MCP audit 一致 | 标的解析回归 |
| `historical-valuation-gap` | `pass` | 未用当前 PE/PB 倒灌历史日；换手率、量比和基本面缺口均明确；历史收盘明确标为前复权 | 增加价格精度契约后回归 |
| `industry-web-evidence` | `environment_unavailable` | 3 次服务层搜索、2 次原文读取均有 audit；官网正文为空或 fetch 失败，回答正确拒绝确认“31” | 可读取申万 2021 原始文件后重跑，必须由原文确认数量 |
| `invalid-security-gap` | `pass` | 没有给 `000000` 编造标的、收盘价或 PE；区分代码无效与数据源不可用 | 无效标的 contract 回归 |
| `capital-flow-boundary` | `pass` | 数值、来源、市场时间和非实时口径齐全；明确不能据此证明控盘、吸筹或后续涨跌 | 资金流 contract 回归 |
| `historical-close-period-alignment` | `pass` | 收盘价严格绑定 2025-07-24 和前复权口径；经营字段按独立报告期披露不可得 | 增加价格精度契约后回归 |
| `announcement-news-boundary` | `pass` | 正式公告、新闻和研报分层清楚；公告正文缺失时没有把媒体转述写成公司确认事实 | 保持证据边界，另做输出压缩回归 |
| `web-source-conflict-disclosure` | `environment_unavailable` | 3 次搜索、3 次读取全部走服务 MCP；官网不可读、百度 403、雪球反爬均逐项披露；未用摘要裁决 2021 版数量 | 官方原文可读后连续重跑 3 次；需确认版本、数量和原始 URL |
| `multi-turn-security-correction` | `pass` | 两轮分别调用 `market.resolve + market.stock_info`；最终从 `000858` 正确切换为 `600519 / SSE`，未沿用旧身份 | 多轮身份修正回归 |

`environment_unavailable` 表示当前环境不足以完成目标事实核验，但 ACP 的工具路径和缺口
处理符合预期；它不计为事实通过，也不计为 ACP 语义失败。

## Finding Backlog

| 优先级 | Owner | Finding | 建议动作 | 关闭条件 |
| --- | --- | --- | --- | --- |
| P1 | 金标 / MCP contract | 历史收盘返回 `1439.519`，现有 case 未定义价格展示精度、舍入方式和允许误差 | 为价格字段增加原始值、复权口径、展示小数位和容差契约 | 两个历史行情 case 在契约下确定性通过 |
| 已纠正 | 评测 rubric | 旧 case 把申万 2021 官方分类文件设为强制前置条件 | 改为风险分级与多来源交叉验证；单一摘要不得冒充官方确认 | 两个修订 case 定向语义通过 |
| 已纠正 | Market adapter | 新浪 K 线 fallback 忽略请求日期并可能返回最新日期 | 指定日期时最多读取 500 条后严格按起止日期过滤；没有目标日则返回空和明确 warning | 单测覆盖命中和错日期拒绝；真实 ACP 历史日期 case 通过 |
| 观察 | ACP runtime | `codex-acp` 对 `gpt-5.6-sol` 使用 fallback model metadata | 保留实际子进程参数和 state DB model 证据；不把 metadata fallback 误报为模型 fallback | runtime 内建对应 metadata，且路由证据保持 `gpt-5.6-sol` |
| P2 | 性能 / Workspace prompt | v2 最慢网页 case 208.4 秒，含无效 MCP resource 猜测和多次不可读正文 | 优先减少无效 resource 探测和重复候选，不压缩必要证据读取 | 正确性不退化，重复 run 的 p95 有可复现下降 |
| P3 | Workspace skill / prompt | 公告与新闻边界正确，但客户回复明显偏长 | 收紧“先结论、再关键证据、最后缺口”的输出结构 | 同 case 保留全部边界且显著缩短输出 |

## 阶段判定

阶段 3 的“首份基线报告、finding backlog、每项 finding 的复验 case”已经具备。当前不能把
两个 `environment_unavailable` 用例宣传为“申万 31 个行业已经端到端核验成功”；可以确认的
是服务 MCP 路径、检索预算、原文失败披露和防幻觉边界有效。

下一阶段进入阶段 4：先补价格精度 contract 和官方原文读取能力，再做有针对性的重复运行与
时延优化。网络依赖 live suite 暂不进入 CI；稳定的 fixture/schema 和无网络 contract 可进入
常规测试。

## 后续 Rubric 纠正（2026-07-26）

本报告的 `8 pass / 2 environment_unavailable` 是旧 rubric 下的历史结果。旧 rubric 把两个
申万 case 约束为“必须读取官方原始文件”，超出了产品对稳定、低风险分类事实的实际证据
要求。该约束已经纠正为风险分级：一手来源优先但非强制；官方页面不可读时，可用一个完整
的高质量公开来源或多个独立、版本一致的来源交叉验证，并明确标注正文、转载、搜索索引及
对应证据等级。单一摘要仍不能冒充官方确认；动态行情、财务和公司公告仍要求结构化或正文
级证据。

纠正后的两个定向 run 均给出正确的 31 项完整名单：

- `industry-web-evidence`：`acp-quality-ms1gjsyr-axa-109ff6ac`，自动与语义 `pass`，154866 ms。
- `web-source-conflict-disclosure`：`acp-quality-ms1gr74q-la5-7eaa7b4f`，自动与语义 `pass`，132800 ms。

因此，“申万官方原文不可读”不再是 core 准确性阻塞项。旧 baseline 数字不回写为同一次 run
的 `10/10`；当前可以表述为“原 8 个 case 通过，两个修订后的网页 case 定向通过”，等待下一次
完整 suite 形成统一的新基线。

统一 v2 suite 已由本文开头的 `acp-quality-ms1j3ugt-1yug-64a8ecf4` 补齐。它证明 SearXNG
路径强制断言、两段式预算、结构化数据边界和日期 fallback 修复有效；本轮网页环境仍只支持
`8 pass / 2 environment_unavailable` 的语义结论，历史定向网页成功 run 继续作为能力证据，
不与本轮统计混算。
