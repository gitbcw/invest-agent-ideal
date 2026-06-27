# AI 按需扩展能力协议

本协议用于约束 AI 在用户空间内按需新增能力模块的流程。

模板项目默认只提供投资助手骨架、长期记忆、报告目录、数据契约、安全边界和最小执行内核。当用户提出当前模板未覆盖的新能力时，AI 可以识别能力缺口，并在用户确认后，为该用户空间新增配置、skill、代码模块、schema、报告模板或数据接口。

核心原则：

- 模板保持轻量，不预置所有投资方法。
- 用户空间可以按需生长能力。
- AI 不得静默新增长期能力。
- 新能力必须可审计、可回滚、可解释。
- 涉及投资方法、交易规则、提醒规则、数据源和记忆结构的变更，必须先出草案，经用户确认后再落盘。

## 适用场景

当用户提出以下需求，而现有 `skills/`、`config/`、`src/` 无法完整支持时，应进入能力扩展流程：

- 新投资方法，例如量价信号、网格策略、ETF 轮动、可转债双低、红利因子。
- 新数据处理能力，例如行情接口、财报因子、估值表、公告解析。
- 新提醒规则，例如特定技术指标触发、组合回撤提醒、估值分位提醒。
- 新报告类型，例如行业复盘、主题跟踪、策略回测。
- 新记忆结构，例如信号记录、交易计划、观察池评分。
- 新自动任务，例如盘中扫描、周度候选池刷新。

不适用场景：

- 普通问答。
- 单次报告生成。
- 不需要长期保存的临时分析。
- 非投资市场相关需求。
- 用户未确认的策略或方法改动。

## 能力缺口识别

AI 收到用户需求后，必须先判断：

```text
1. 现有能力是否已覆盖？
2. 是否只是配置变更？
3. 是否需要新增 skill？
4. 是否需要新增代码模块？
5. 是否需要新增数据源？
6. 是否会写入长期记忆或改变投资规则？
7. 是否涉及买卖信号、仓位建议或提醒触发？
```

判断结果应输出为结构化草案，而不是直接修改文件。

## 扩展草案格式

AI 必须先生成如下草案：

```yaml
extension_name: ""
user_request_summary: ""
capability_type: "skill/config/code/schema/data_source/report/task"
investment_domain: "technical/fundamental/macro/risk/selection/watch/report"
current_gap: []
proposed_solution: ""
new_files: []
modified_files: []
data_requirements: []
memory_write_impact: []
schedule_impact: []
risk_boundary: []
confirmation_required: true
rollback_plan: []
acceptance_checks: []
```

字段说明：

- `extension_name`：新增能力名称。
- `user_request_summary`：用户原始需求摘要。
- `capability_type`：新增能力类型。
- `investment_domain`：所属投资分析领域。
- `current_gap`：当前模板缺失点。
- `proposed_solution`：拟实现方式。
- `new_files`：需要新增的文件。
- `modified_files`：需要修改的文件。
- `data_requirements`：所需行情、财报、公告、新闻或用户输入。
- `memory_write_impact`：是否写入 config、knowledge、memory。
- `schedule_impact`：是否新增自动任务或提醒频率。
- `risk_boundary`：投资建议边界。
- `confirmation_required`：必须为 true，除非只是一次性非持久分析。
- `rollback_plan`：如何撤销该能力。
- `acceptance_checks`：完成后如何验证。

## 用户确认规则

以下扩展必须用户确认：

- 新增或修改投资方法。
- 新增或修改买入、卖出、加仓、减仓、止损规则。
- 新增或修改盯盘提醒规则。
- 新增或修改数据源可信度。
- 新增自动任务。
- 新增 memory schema。
- 修改日、周、月复盘输出逻辑。
- 任何可能影响操作建议的规则。

用户确认前，AI 只能输出草案和解释，不能落盘。

确认话术建议：

```text
我会把这个需求扩展为一个新能力模块。
它会新增/修改以下文件，并影响以下报告或提醒。
请确认是否按这个草案写入当前用户空间。
```

## 标准落盘结构

新增能力优先按以下结构落盘：

```text
config/{capability_name}.yaml
skills/{capability-name}/manifest.json
skills/{capability-name}/skill.md
skills/{capability-name}/prompt.md
src/invest_assistant/{capability_name}.py
schemas/jsonl/{record_name}.schema.json
reports/{capability_name}/
```

不是所有文件都必须创建，只创建完成该能力所必需的最小文件。

## 能力注册规则

新增 skill 的 `manifest.json` 至少包含：

```json
{
  "name": "",
  "description": "",
  "triggers": [],
  "inputs": [],
  "outputs": [],
  "requires_confirmation_for_memory_write": true
}
```

新增能力如果需要被日复盘、周复盘、月复盘或盯盘调用，应同步更新：

```text
config/skills.yaml
config/paths.yaml
```

涉及自动执行时，同步更新：

```text
config/schedules.yaml
```

## 数据源规则

如果新能力依赖外部数据，必须声明：

```yaml
required_data:
  - name: ""
    type: "market_price/ohlcv/financial_report/announcement/news_policy/research/user_input"
    minimum_history: ""
    freshness_requirement: ""
    fallback_policy: ""
```

没有数据源或数据不足时，必须降级：

- 不输出精确价格结论。
- 不输出买卖确认单。
- 只输出“数据不足，等待验证”。
- 记录 `memory/source_events.jsonl`。

## 投资建议边界

新增能力不得绕过项目既有边界：

- 不输出确定性收益预测。
- 不直接要求用户交易。
- 买入、卖出、加仓、减仓、再平衡必须先生成确认单。
- 必须区分事实、推断、规则触发和不确定性。
- 必须标注数据来源、数据截止时间、置信度和缺失项。
- 不能因单次信号改变长期策略。
- 不能把未确认的新规则写入用户方法论。

## 审计记录

能力扩展落盘后，必须写入：

```text
memory/change_log.jsonl
```

建议字段：

```json
{
  "change_type": "capability_extension",
  "capability_name": "",
  "user_confirmed": true,
  "changed_files": [],
  "reason": "",
  "rollback_plan": "",
  "created_at": ""
}
```

如果新增自动任务、模型切换、数据源变更，也应写入：

```text
memory/audit_events.jsonl
```

## 回滚要求

每个扩展草案必须包含回滚方案：

```yaml
rollback_plan:
  - "删除新增 skill 目录"
  - "删除新增 config 文件"
  - "从 config/skills.yaml 移除能力注册"
  - "保留历史 reports 和 memory，不做静默删除"
```

历史报告和审计记录默认不删除，除非用户明确要求并确认。

## 示例：技术信号能力扩展

```yaml
extension_name: "technical_signal"
user_request_summary: "用户希望基于 25 日均线、5 日均量线、60 日均量线生成建仓、加仓、低吸、预警和卖出信号。"
capability_type: "skill/code/config/schema"
investment_domain: "technical"
current_gap:
  - "当前无 OHLCV 行情接口"
  - "当前无均线和均量线计算模块"
  - "当前无技术信号记录 schema"
  - "当前 market-watch 无技术指标触发源"
proposed_solution: "新增技术信号模块，读取日线行情，计算 MA5、MA14、MA25、VOL_MA5、VOL_MA60，并输出 observe/buy_candidate/sell_candidate/risk_warning 信号。"
new_files:
  - "config/technical_signals.yaml"
  - "skills/technical-signal/manifest.json"
  - "skills/technical-signal/skill.md"
  - "src/invest_assistant/technical_signals.py"
  - "schemas/jsonl/signal_record.schema.json"
modified_files:
  - "config/skills.yaml"
  - "config/paths.yaml"
  - "src/invest_assistant/task_engine.py"
data_requirements:
  - "至少 60 个交易日的收盘价和成交量"
  - "数据截止时间不晚于最近一个交易日收盘后"
memory_write_impact:
  - "可写入 memory/decisions.jsonl"
  - "可新增 memory/signal_records.jsonl"
schedule_impact:
  - "可接入 daily_review"
  - "可接入 market_watch"
risk_boundary:
  - "信号只作为候选，不直接要求交易"
  - "买入、卖出、加仓、减仓必须生成确认单"
  - "数据不足时降级为观察"
confirmation_required: true
rollback_plan:
  - "移除 technical-signal skill 注册"
  - "删除 config/technical_signals.yaml"
  - "停止 task_engine 调用 technical_signals"
  - "保留历史审计和信号记录"
acceptance_checks:
  - "给定样例 OHLCV 数据可计算信号"
  - "数据不足 60 日时不输出买卖信号"
  - "信号报告能区分事实、推断、规则触发和不确定性"
```
