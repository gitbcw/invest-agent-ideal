# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

微信入口的 AI 投资决策助手，实验分支当前采用极简主链路：微信消息解析出用户、实例和 workspace 后，直接转发给在该 workspace 中运行的 Hermes stdio ACP 后端。服务层不再做普通微信消息的 triage、快车道、onboarding 包装、复盘意图识别或上下文包拼装。本项目保留确定性能力：数据库、Dashboard、行情数据、巡检、提醒、sandbox/API、落库和微信推送。

## 常用命令

```bash
npm run dev          # 开发模式（tsx watch）
npm run build        # TypeScript 编译
npm start            # 运行编译产物
npm run smoke        # 构建 + 运行 smoke 测试
npm run db:generate  # Drizzle 迁移文件生成
npm run db:migrate   # 执行数据库迁移
```

统一看板：`http://localhost:22648/dashboard`（含持仓/自选/预案/提醒/信号/巡检/微信连接）
健康检查：`curl http://localhost:22648/health`

## 环境配置

复制 `.env.example` 为 `.env`。数据库为 SQLite，路径 `./data/invest-agent.db`。微信消息进入智能后端时由服务直接启动 workspace-scoped Hermes ACP 子进程，不需要单独手动启动 ACP HTTP endpoint。

微信桥接状态默认保存在本项目 `./.state/openclaw-weixin/`，也可通过 `INVEST_AGENT_WEIXIN_STATE_DIR` 覆盖。不要让本项目和全局 Claude Code 微信桥接共用同一个 `~/.openclaw` 登录态目录。

> **运行时语义纠正(2026-06-26)**：当前统一使用 Hermes stdio ACP 作为 workspace 后端承接。Codex 不再作为 invest-agent 产品运行时 backend 注册或默认选项；历史 `codex_acp_traces` 表名仅作为兼容存储保留。

## 架构：消息处理主链路

```
用户微信消息 → weixin-agent-sdk → InvestAgentMobileBridge
  → 解析 user / project / instance / workspace
  → AcpAgent.handleMessage()
  → workspace-scoped Hermes ACP session(cwd = 用户 workspace)
  → Hermes 使用 workspace 的 AGENTS.md + .codex/skills 进行推理和工具调用
  → Hermes 按需调用 invest-agent 的 sandbox / Dashboard / 行情等确定性 API
  → 响应返回微信
```

主动提醒反向链路：`scheduler/index.ts` 每分钟扫描 workspace 的 `config/watch.yaml` / `config/schedules.yaml` → 命中后调用 workspace-scoped Hermes 执行巡检或复盘 → 触发后通过微信推送队列发送。

> **2026-06-23 范围收缩**:本项目定位明确为"少数几个投资客户的精品投资助手",不再承载多产品 AI 平台 / 饮食推荐 / 旁路桥 / 对话草案 / 多 bundle 抽象。WP A1+A2+A3+C 全部收尾:
> - 主链路微信桥只剩 `InvestAgentMobileBridge`(主桥);`backend==="hermes"` 是当前唯一运行时后端标识
> - `src/platform/` 简化为 `project-registry.ts`(实例查询)+ `tool-registry.ts`(sandbox 工具白名单),不再有 project-type manifest / skill-bundle catalog
> - 技能说明以 workspace 模板中的 `AGENTS.md` 和 `.codex/skills` 为准；服务层不再注入固定 skill-bundle prompt
> - `/platform` 后台页 + `/api/platform/*` admin REST 已下线;`src/routes/platform.ts` 只保留 weixin 工厂和自动恢复
> - DB 表 `ai_projects` / `ai_instances` / `investment_profiles` / `conversation_tasks` 保留作考古,数据不迁出

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/acp/agent.ts` | ACP 入口；微信消息只添加最小通道上下文并代理到 workspace-scoped Hermes |
| `src/acp/stdio-agent.ts` | Hermes stdio ACP 托管器；微信直通路径使用按 workspace cwd 隔离的 Hermes session |
| `src/services/deepseek.ts` | DeepSeek API 封装，支持 light（flash）和 deep（pro+thinking）两种模式 |
| `src/services/stock.ts` | 腾讯行情 API：实时报价、日 K、股票搜索 |
| `src/services/stock-resolver.ts` | 股票名称/代码模糊解析 |
| `src/services/eastmoney.ts` | 东方财富资金流 API：主力/超大单/大单净流入 |
| `src/services/indicators.ts` | L1 技术指标算子：MA/EMA/MACD/KDJ/BOLL/RSI/WR/OBV（参数化，可独立调用） |
| `src/services/chip-distribution.ts` | L1 筹码分布算子：`computeChipDistribution`/`winner`（reliability=experimental） |
| `src/services/rule-expression.ts` | L3a 安全表达式解析器：tokenizer + 递归下降，禁 eval/Function/函数调用语法 |
| `src/services/composite-indicator-engine.ts` | L3a 规则树引擎：YAML 加载、combine 四模式（and/or/majority/weighted_sum）、阈值表达式求值 |
| `src/services/script-indicator-engine.ts` | L3b 沙箱引擎：isolated-vm 隔离区 + esbuild 编译缓存 + 64MB/5s 熔断 |
| `src/services/sandbox-runtime.ts` | L3b helpers 桥（白名单 L1 算子导出给沙箱，无 Node API 依赖） |
| `src/handlers/signal-config.ts` | 信号配置工具：14 个系统信号（含资金流信号、盘中放量滞涨/滞跌）开关和参数管理 |
| `src/handlers/review.ts` | 复盘工具（`handleReviewTool`）：日/周复盘生成，含资金流数据和预案调整建议 |
| `src/db/schema.ts` | 全部 Drizzle 表定义：settings、watchlist、portfolio、alerts、stockPlans、chatHistory、dailyPlans、alertEvents、tradeActions、agentTraces |
| `src/scheduler/alert-check.ts` | 盘中巡检引擎（涨跌幅/预案价位/放量突破/资金流信号等触发条件） |
| `src/scheduler/index.ts` | 定时任务调度：巡检间隔动态可调（settings 表持久化） |
| `src/routes/dashboard.ts` | Dashboard API（聚合数据 + CRUD 端点）和页面路由 |
| `src/admin/dashboard-page.ts` | 统一看板前端（侧边栏导航，含持仓/自选/预案/提醒/信号/巡检/微信连接，自包含 HTML + Tailwind CDN） |

## 服务保留的确定性能力

这些能力应保留在本项目中，供 Dashboard、巡检和未来 Hermes 工具调用使用。

**持仓与自选：**
- `query_holding_pool` / `add_holding_stocks` / `remove_holding_stocks`
- `query_watchlist` / `add_watchlist_stocks` / `remove_watchlist_stocks`

**监控与提醒：**
- `query_monitor_overview`：聚合监控全貌
- `query_alert_rules` / `set_alert_rule` / `remove_alert_rule`：提醒规则管理
- `set_alert_interval`：巡检间隔调整（分钟，持久化）

**信号配置：**
- `query_signal_config` / `update_signal_config`：14 个系统信号开关和参数管理（price_change、near_support/resistance/target、stop_loss、breakout_with_volume、break_support、turnover、volume_ratio、macd、bid_ask_imbalance、capital_flow_main、capital_flow_super_large、volume_price_divergence）

**预案与复盘数据：**
- `query_stock_plan` / `set_stock_plan` / `remove_stock_plan`：交易预案管理(含可选 `strategyKey` 溯源字段)
- `/api/reviews/daily` / `/api/reviews/query`：复盘数据收集、生成入口和 artifact 查询。复盘方法与输出纪律应优先沉淀到 workspace 内 skills。

**交易策略实体(第一版):**
- `workspace/config/trading_strategies.yaml` 装用户多份策略(每份含 key/name/applicability/body/enabled);与 `strategy.yaml`(整体投资风格)平级,不合并。workspace 模板不内置示例,由用户/Hermes 自建
- `/api/strategies` / `/api/sandbox/strategies/*`:策略 CRUD endpoint
- `stock_plans.strategy_key` 是策略 → 预案的溯源软引用(可空,策略删除不级联清理)
- 策略推荐 + 预案起草按 `AGENTS.md` 的 Strategy Plan Drafting 流程,两道闸门(策略匹配 + 预案起草),不做 AI 自主落库
- 复盘流程**不感知策略实体**

**选股问答：**
- 选股推理由 workspace skills 承载,服务层不内置固定 skill。
- 服务只保留未来需要高频复用的确定性数据 API，例如行情、资金流、持仓/自选上下文和股票解析。

## Dashboard CRUD API

Dashboard 可直接操作数据，不经过 Hermes：

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/portfolio/add` | POST | 添加持仓（支持名称/代码） |
| `/api/portfolio/remove` | POST | 移除持仓 |
| `/api/watchlist/add` | POST | 添加自选 |
| `/api/watchlist/remove` | POST | 移除自选 |
| `/api/plans/set` | POST | 创建/编辑预案(支持 `strategyKey` 溯源) |
| `/api/plans/remove` | POST | 删除预案 |
| `/api/strategies` | GET | 列出交易策略 |
| `/api/strategies/set` | POST | 创建/更新策略 |
| `/api/strategies/remove` | POST | 删除策略 |
| `/api/alerts/set` | POST | 创建提醒规则 |
| `/api/alerts/toggle` | POST | 启停提醒 |
| `/api/alerts/remove` | POST | 删除提醒 |
| `/api/signals/update` | POST | 切换信号开关/参数 |
| `/api/interval/set` | POST | 设置巡检间隔 |

## 数据源

| 数据 | 来源 | 说明 |
|------|------|------|
| 实时行情 | 腾讯行情 API | 最新价、涨跌幅、成交量、换手率 |
| 日 K 线 | 腾讯行情 API | 120 日历史，计算 MA/MACD/量比 |
| 资金流向 | 东方财富 emdatah5 | 主力/超大单/大单/中单/小单净流入 |
| L1 筹码分布 | 自研近似模型 | `src/services/chip-distribution.ts` 提供 `computeChipDistribution` / `winner`（reliability=experimental，需走告知协议）；workspace 沙箱脚本示例已移除，需要时由用户/Hermes 自建 |

## 复合指标系统（5 层）

服务侧 L1 算子、L3a/L3b 引擎和告知协议门禁完整保留在 `src/services/`，workspace 模板不内置示例 yaml/ts，需要时由用户/Hermes 在 workspace 内自建。完整 RFC 见 `docs/composite-indicator-system.md`。

| 层 | 形态 | 落点 | 适用 |
|---|---|---|---|
| L1 | 技术指标算子（MA/EMA/MACD/KDJ/BOLL/RSI/WR/OBV/chipDistribution/winner） | `src/services/indicators.ts` + `chip-distribution.ts` | 标准指标 + 参数 |
| L2 | 系统信号 | `src/handlers/signal-config.ts`（14 个）+ 巡检 | 标准触发条件 |
| L3a | 规则树复合（YAML） | workspace `config/composite_indicators.yaml`（用户自建） | 标准信号 + 标准算子的布尔/加权组合 |
| L3b | 沙箱脚本（isolated-vm） | workspace `scripts/indicators/<key>.ts`（用户自建） | 循环/递归/多源融合 |

新建复合指标时,先判断能否用 L1/L2 标准能力表达;无法表达再走 L3a 规则树;仍无法表达(需要循环/递归/多源融合)再走 L3b 沙箱。

**告知协议（强制）**：experimental 算子 / 数据源缺失 / 经验系数 / 建仓决策依据，必须让用户显式确认后才能写入 `user_acknowledged: true`。校验门禁在 `src/services/indicator-acknowledgement.ts`。

**冒烟测试**：`npm run smoke:indicators`（L1 算子）/ `smoke:composite-indicator`（L3a 引擎）/ `smoke:script-indicator`（L3b 引擎）/ `smoke:indicator-acknowledgement`（告知协议）。

**缓存清理**：`npm run cache:clear-indicator`（默认 dry-run 30 天，加 `-- --apply` 实际删除）。


## 设计原则

1. 不恢复旧关键词路由，也不恢复/扩展自研 Agent Runtime。
2. Hermes 是对话总控。invest-agent 只做确定性查询、落库、巡检和推送。
3. 用户不需要记指令，不需要提供股票代码。股票名称通过 `stock-resolver` 解析。
4. 不确定时追问；能从上下文判断时不多余确认。
5. 投资输出必须说明不确定性，不承诺收益，不自动交易。
6. 定性推理和工作流应沉淀到 workspace 模板的 `AGENTS.md` 与 `skills/`(Hermes 在 workspace 内读取)。
7. `agent_traces` 是旧 Runtime 历史表，可保留数据，不作为当前对话追踪方案。

## 数据库

SQLite + Drizzle ORM。`src/db/index.ts` 负责初始化，内含 `CREATE TABLE IF NOT EXISTS` 和 `ALTER TABLE` 增量迁移。`settings` 表是 KV 存储，存储以下内容：
- `signal_config` — 14 个信号配置 JSON
- `alert_check_interval_minutes` — 巡检间隔（默认 5 分钟）
- `review_template`、复盘推送时间等服务配置

`agent_traces` 表仅作为旧 Runtime 历史记录保留。

## 文档

产品文档在 `docs/` 目录，以 `docs/README.md` 为文档索引和接手入口。SQLite 表归属划分（服务层 / 工作空间 / 丢弃 三类）见 `docs/table-ownership.md`。历史重构计划、DeepSeek triage、fast lane、旧 Runtime 交接和平台化设计都在 `docs/archive/`，仅作考古使用，不作为当前实现依据。
