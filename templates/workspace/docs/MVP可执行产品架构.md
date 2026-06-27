# MVP 可执行产品架构

本工程从协议蓝图升级为可执行 MVP 模板后，分为三层：

## 一、协议层

协议层定义投资助手如何判断、表达和记录，主要由 `config/`、`knowledge/` 和 `skills/` 组成。

- `config/data_contracts.yaml`：观点、提醒、行为、信息源事件的数据契约。
- `config/evidence_policy.yaml`：证据等级、数据时效和降级策略。
- `config/risk_taxonomy.yaml`：P0/P1/P2 风险分类。
- `config/interaction_policy.yaml`：微信低打扰和确认单边界。
- `knowledge/decision_protocol.md`：事实、推断、规则触发和不确定性的表达协议。
- `knowledge/watch_protocol.md`：盯盘提醒触发、分级和去重协议。
- `knowledge/selection_protocol.md`：观察池、候选排雷和买入等待区协议。

## 二、执行层

执行层位于 `src/invest_assistant/`，用于跑通最小产品链路。

| 模块 | 作用 |
| :--- | :--- |
| `cli.py` | 命令行入口，支持日复盘和产品指标统计 |
| `task_engine.py` | 任务编排、幂等、报告生成和任务状态记录 |
| `data_sources.py` | 行情、公告、财报等数据源接口和空 provider |
| `memory_store.py` | JSONL 安全写入、基础 schema 校验和读取 |
| `config_loader.py` | YAML 配置读取和路径解析 |

当前可运行命令：

```powershell
$env:PYTHONPATH="src"
python -m invest_assistant.cli daily-review --date 2026-06-12
python -m invest_assistant.cli metrics --period 2026-06
```

在未接真实行情源时，日复盘会生成降级报告：不输出价格、盈亏和买卖触发，只记录缺失数据并默认不操作。

## 三、接入层

接入层由外部系统逐步补齐：

- Hermes：微信入站、出站、模型路由、失败重试。
- 数据 provider：行情、指数、ETF、公告、财报、交易日历、行业分类、新闻政策。
- 可视化：产品指标面板和报告查看页。

单个 AI 项目只处理当前项目沙箱内文件。用户空间创建、微信绑定和跨项目隔离由外层 SaaS 平台负责。

## MVP 优先级

### P0：可用 MVP

- 微信持仓录入和确认。
- 日复盘生成与落盘。
- 晚间微信简报。
- P0/P1/P2 盯盘提醒。
- 操作确认单。
- `memory/decisions.jsonl` 观点记录。

### P1：投资决策质量

- 可靠行情和公告源。
- 财报排雷卡片。
- 观察池管理。
- 周复盘回测日复盘观点。
- 行为纠偏。

### P2：产品护城河

- 个性化投资方法沉淀。
- 月度方法迭代。
- 用户风格画像。
- 观点命中率和失效归因。
- 多组合、多账户管理。
- 数据源可靠性评分。

## 产品主张

不是帮用户多看行情，而是帮用户只在该看的时候看；不是替用户买卖，而是帮用户按自己的规则做决定。
