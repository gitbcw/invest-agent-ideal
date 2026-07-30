# 数据源 ACP 阶段 4 进展（2026-07-26）

> 归档说明（2026-07-28）：本文是阶段 4 首轮实施与复验记录，不作为当前数据源契约入口。

## 本轮目标

阶段 4 第一批工作聚焦三个已知风险：历史价格精度 contract、官方网页不可读时的故障
可解释性，以及隔离评测证据的唯一性。准确性和证据完整性优先，不以关闭 TLS 校验或
采用搜索摘要来换取表面通过。

## 已实现

### 历史价格 contract

`market.kline` 现在随结果返回 `priceConvention`：

- `unit=CNY_per_share`
- `adjustment=forward_adjusted|unadjusted|unknown`
- `displayDecimals`
- `roundingMode=half_up`
- `comparisonTolerance`
- `valuePolicy=preserve_provider_precision`

腾讯前复权日线会明确返回 `forward_adjusted`；fallback 无法保证复权口径时返回 `unknown`。
MCP audit summary 同步记录 adjustment、精度和容差，金标 case 已固定 2025-07-24 的
`1439.519`、3 位小数和 `0.0005` 比较容差。

### 网页失败诊断

`research.web_read` 现在区分：

- `page_text_unavailable`：HTTP 页面可打开，但只有客户端渲染空壳，未取得可引用正文；
- `page_fetch_failed:tls_certificate_untrusted`：Node 无法验证上游证书链。

申万官网当前同时存在 SPA 正文不可直接提取和证书链不稳定现象。本轮没有关闭 TLS 校验，
也没有把搜索摘要升级为原始证据。因此两个申万 case 仍保持 `environment_unavailable`，
但根因已从笼统 `upstream_error` 收敛为可操作的故障类型。

### Runner 证据唯一性

并行定向复跑暴露出 `Date.now()` 在同一毫秒生成相同 runId 的碰撞。两个进程的 SQLite 和
Workspace 仍各自隔离，但 JSON/Markdown 报告路径发生覆盖。runId 现改为
`timestamp + process id + random UUID suffix`，并增加并行唯一性测试。

## 定向复验

权威顺序复验：

- Run：`acp-quality-ms1flyfa-1hkn-4d46bb74`
- Case：`historical-close-period-alignment`
- Model：`gpt-5.6-sol`
- Automatic：`pass`
- Semantic：`pass`
- Elapsed：`46928 ms`
- Operations：`market.kline`、`market.fundamentals`
- K-line audit：`adjustment=forward_adjusted; displayDecimals=3; tolerance=0.0005; warnings=0`
- 回复事实：2025-07-24 收盘价 `1439.519 元/股`，明确前复权；报告期经营字段不可得且未替代
- Retention：`retain`
- Runtime root：`/var/folders/p2/y4mn140j4qs0dg3qflgghhm40000gn/T/acp-quality-ms1flyfa-1hkn-4d46bb74-5yVGs6`

碰撞探测产生的两个保留 runtime root 为：

- `/var/folders/p2/y4mn140j4qs0dg3qflgghhm40000gn/T/acp-quality-ms1fiuco-bBpnYG`
- `/var/folders/p2/y4mn140j4qs0dg3qflgghhm40000gn/T/acp-quality-ms1fiuco-PySrqZ`

它们共享旧 runId `acp-quality-ms1fiuco`，报告文件不作为权威证据；各自 SQLite trace/audit
仍可复核。两轮均在腾讯主源瞬时失败、fallback 返回错误日期时拒绝用 2026-07-24 替代
2025-07-24，属于正确的数据缺口处理。

## 阶段判定

- 历史价格精度 finding：实现完成，定向单测和真实 ACP case 均通过。
- 网页失败诊断 finding：实现完成；申万官方原文可用性仍未关闭。
- Runner runId 碰撞 finding：实现完成，需由下一次并行 run 验证报告不覆盖。
- ACP fallback model metadata：未处理，仍是 runtime owner 的观察项。
- 性能优化：尚未开始；先保持当前正确性基线。

本轮最初建议寻找申万官网公开 API 或稳定一手附件；下方的后续 rubric 纠正确认这不应成为
低风险行业分类 case 的强制前置条件，也不应据此把通用 `web_read` 扩展为浏览器。

## 证据策略纠正与复验

后续复核确认，“必须读取申万官方原始文件”是评测 fixture 的过度约束，不是产品代码的
业务硬要求。Workspace 通用策略和两个 case 已改为风险分级证据：

- 稳定、低风险的行业分类或术语事实，可由一个完整高质量来源或多个独立、版本一致的公开
  来源交叉验证；必须披露来源形态和证据等级。
- 单一搜索摘要不能表述为官方确认。
- 动态行情、财务数字和公司公告仍要求结构化数据或正文级证据。

修订后的 `industry-web-evidence` run `acp-quality-ms1gjsyr-axa-109ff6ac` 在 154866 ms 内完成：
3 次搜索、3 次读取，完整列出 31 个不重复行业，说明官方页 TLS 失败及二级/索引证据边界，
自动与语义判定均为 `pass`。输出仍偏长，逐行业重复来源的表达已在后续 prompt 中移除。

首次并行 `web-source-conflict-disclosure` run `acp-quality-ms1gjsyr-axb-0720880d` 因重复读取、
7 次服务调用和无价值 MCP resource 探测在 180 秒超时，判为路径/性能 `fail`。收紧为最多
2 次搜索、4 次不同 URL 读取并禁止 resource list/read 后，顺序复验
`acp-quality-ms1gr74q-la5-7eaa7b4f` 于 132800 ms 通过：

- 精确列出 31 个不重复行业；
- 区分旧版“化工、采掘、商业贸易、休闲服务、纺织服装、电气设备”等名称；
- 正确采用 2021 版“基础化工、煤炭、石油石化、商贸零售、社会服务、纺织服饰、电力设备、
  环保、美容护理”等口径；
- 使用 2 次搜索和 4 次读取，未重复 URL，未再猜测 MCP resource。

两个并行 run 分别生成独立 JSON、Markdown、SQLite 和 Workspace，runId/report 覆盖修复已由
真实并行运行验证。申万官方页面可用性从 P1 阻塞项降为普通来源质量观察，不再要求为此增加
站点特例或浏览器能力。

## 最终统一复验

阶段 4 在新浪 fallback 日期过滤修复后完成一次完整 v2 SearXNG suite：

- Run：`acp-quality-ms1j3ugt-1yug-64a8ecf4`
- Model：`gpt-5.6-sol`
- Required/observed search provider：`searxng_web_search`
- Automatic：`10/10 pass`
- Semantic：`8 pass / 2 environment_unavailable`
- Total：`545281 ms`；p50 `31412 ms`；p95 `165094 ms`；max `208366 ms`

两个网页 case 均列出完整 31 项候选名单，但本轮没有取得一个完整高质量可读来源或两个
完整且一致的独立可读来源，因此按 rubric 诚实降级。该结果不表示重新要求申万官方原文；
此前两个定向 run 已证明高质量公开来源和多源交叉路径可以通过。

`historical-close-period-alignment` 返回 2025-07-24 的腾讯前复权收盘价 `1439.519`，说明
修复后的 adapter 不再以错误日期 fallback 替代目标日。新浪 fallback 现在在指定日期范围时
最多读取 500 条并严格过滤；若目标日期不存在，则返回空结果和
`fallback_date_range_unavailable`，由 ACP 明确披露缺口。

速度方面不再继续压缩 evidence budget。通用网页检索采用 6 次默认预算、必要时扩展至 12 次，
目标是先拿到完整数据，再停止无增益检索。最长网页 case 仍低于 10 分钟硬门槛；后续性能
工作只针对 ACP 猜测不存在 MCP resource、重复候选和不可读 URL，不降低证据完成度。

本地 `codex-acp` 的 fallback 警告是 model/personality metadata 缺失，不是请求模型回退。
子进程参数和 state DB 均记录 `gpt-5.6-sol`。偶发 `resources/read` 猜测均被拒绝且未形成
服务层 audit，作为 ACP 路径噪声保留观察。
