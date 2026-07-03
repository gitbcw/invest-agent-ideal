# 盘中巡检与定时任务分阶段实施方案

日期: 2026-06-28

状态: 阶段方案,阶段一已完成首轮主用户真实验收,阶段二设计已收敛

关联文档:

- `docs/watch-runtime-design-note.md`
- `docs/04-core-workflows.md`
- `docs/23-multi-user-sandbox-design.md`
- `docs/composite-indicator-system.md`
- `CLAUDE.md`
- `AGENTS.md`

## 1. 背景

盘中巡检存在一个核心成本与架构问题:如果每一次巡检都调用 Agent,在多用户、多条件、高频轮询下,调用次数和成本会迅速放大。

例如,按 1 个用户、5 个条件、每 5 分钟判断一次估算,单用户每天约 1,440 次判断;10 个用户就是约 14,400 次/天。即使每次调用很短,这种模式也会带来成本、延迟、稳定性和审计问题。

因此,盘中巡检需要先明确一条边界:

- 确定性规则由服务层执行。
- 主观判断和复杂解释由 Agent 执行。
- 定时任务、推送、状态记录、审计和失败兜底仍由服务层负责。

本方案不一次性实现完整智能盯盘,而是分三个阶段逐步收敛。

## 2. 总体目标

建立一套可逐步演进的定时任务与盘中巡检体系:

1. 先保证复盘推送和固定时间任务可靠承接。
2. 再实现服务层可程序化判断的明确盯盘规则。
3. 最后实现新闻/事件类主观盯盘:服务层低成本粗筛,命中后交给 Agent 做主观判断。

最终形态不是"每轮都叫 Agent",而是:

```text
服务层定时调度
→ 服务层确定性任务/规则判断
→ 必要时调用 Agent 做主观判断或用户可读解释
→ 服务层记录、去重、审计和推送
```

## 3. 阶段一:复盘与定时推送可靠承接

### 3.1 阶段目标

保证用户已经设定的复盘任务和盘中固定时间推送任务能够被稳定承接。

这个阶段的重点不是智能判断,而是任务可靠性:

- 用户设定了日复盘、周复盘、月复盘,系统能按时触发。
- 用户设定了盘中固定时间巡检或摘要推送,系统能按时触发。
- 任务触发、Agent 调用、结果保存、微信推送链路不能静默失败。
- 即使 Agent 没有产出有效内容,系统也要有错误记录和可排查线索。

### 3.2 范围

本阶段覆盖:

- `config/schedules.yaml` 中的复盘计划。
- `config/watch.yaml` / `config/schedules.yaml` 中的固定盘中巡检窗口。
- scheduler 对 `userId + instanceId` 的 scope 扫描。
- 定时任务调用 workspace-scoped ACP backend。
- 复盘报告保存和微信推送。
- 盘中定时任务的 NO_PUSH / 推送结果处理。
- 失败日志、trace、审计和重试可见性。

### 3.3 不做

本阶段不做:

- 结构化盯盘规则运行时。
- 价格、均线、成交量等程序化触发规则新增。
- 新闻/事件/情绪的正则粗筛。
- Agent 主观事件判断链路。
- SQLite alert 规则主源迁移。

### 3.4 验收标准

- 自动日复盘能在配置时间触发,并保存 report artifact。
- 自动周/月复盘能按配置触发,并能避免重复生成。
- 盘中固定窗口任务能在交易时段按配置触发。
- 无需推送时能稳定返回并处理 `NO_PUSH`。
- 有推送内容时能进入微信推送队列或推送回调。
- 每次后台任务都有可查询的 trace 或日志。
- Agent 超时、报错、空回复时不会造成 scheduler 卡死。

### 3.5 当前进展

2026-06-28 已完成一轮基于主用户 `primary / invest-agent-primary` 的真实验收:

- 使用 `POST /api/testing/scheduler/trigger` 立即触发 `daily-review`
- `scheduled_task_runs` / `codex_acp_traces` / `push_jobs` 链路闭环
- 主用户手机已确认收到复盘摘要
- 使用同一入口立即触发 `market-watch`
- Hermes 返回 `NO_PUSH`,数据库正确记为 `skipped`,未误推送

因此,阶段一当前重点从"链路是否可用"转为"继续观察自然调度与次日稳定性"。

## 4. 阶段二:明确规则盯盘由服务层落实

### 4.1 阶段目标

把能被程序明确判断的盯盘条件落到服务层,避免这类高频判断每次调用 Agent。

这一阶段的核心设计决策已经明确:

- 规则能力目录由服务层维护。
- 规则实例由服务层 API 创建、修改、停用、删除。
- Workspace 不作为高频变更的规则 schema 主承载面。
- Workspace skill 负责"理解用户想盯什么",再调用服务层 API 完成落库和启停。

也就是说,阶段二不是继续扩展 `watch.yaml` 去承载越来越多机器规则,而是让 Workspace 通过稳定 API 使用服务层规则运行时。

典型规则包括:

- 股价大于某个值。
- 股价低于某个值。
- 股价接近支撑位、压力位、目标位、止损位。
- 突破 20 日线。
- 跌破 5 日线。
- 成交量或量比超过阈值。
- 放量突破压力位。
- 跌破预案支撑位。

这些规则的共同特征是:输入数据明确、判断逻辑确定、结果可审计。

### 4.2 范围

本阶段覆盖:

- 定义服务层通用 Primitive 与规则目录。
- 提供服务层规则目录查询 API。
- 提供服务层规则实例 CRUD / 校验 / dry-run API。
- 使用行情、K 线、持仓、自选、预案等确定性数据执行规则。
- 生成标准化 alert candidate。
- 按 priority、cooldown、once-per-trading-day 去重。
- 将触发结果写入 `alert_events` 或对应运行记录。
- 对 P0/P1 结果决定是否推送或是否交给 Agent 整理文案。
- 让 Workspace skill 能先发现"当前系统支持哪些规则类型",再决定如何引导用户创建规则。

建议第一批 Primitive:

| Primitive | 说明 |
| --- | --- |
| `price_cross` | 价格上穿/下破固定阈值 |
| `percent_change` | 涨跌幅超过阈值 |
| `near_plan_level` | 接近支撑/压力/目标/止损 |
| `ma_cross` | 突破/跌破指定均线 |
| `macd_cross` | MACD 金叉/死叉 |
| `kdj_cross` | KDJ 金叉/死叉 |
| `rsi_threshold` | RSI 超买/超卖阈值 |
| `boll_break` | 突破/跌破 BOLL 轨道 |
| `wr_threshold` | WR 阈值 |
| `volume_ratio` | 量比超过阈值 |
| `breakout_with_volume` | 放量突破压力位 |
| `break_support` | 跌破支撑位 |

建议阶段二最小首发集,优先收敛到 3 个:

| Primitive | 第一阶段实现建议 |
| --- | --- |
| `price_cross` | 必做 |
| `ma_cross` | 必做 |
| `near_plan_level` | 必做 |

2026-07-02 当前实现已超过最小首发集:技术指标规则已扩展到 MACD/KDJ/RSI/BOLL/WR/量比。`breakout_with_volume`、`break_support` 仍更适合作为组合规则或系统信号复用场景,不应在没有明确状态机和数据窗口时用自然语言即兴执行。

### 4.3 规则目录与实例分层

阶段二要把"规则能力"和"用户实际启用的规则"分开:

| 层级 | 归属 | 说明 |
| --- | --- | --- |
| 规则目录 catalog | 服务层 | 系统当前支持哪些 rule type、每种规则需要哪些参数、有哪些默认值和示例 |
| 规则实例 instances | 服务层(SQLite) | 某个用户/实例当前真的在运行哪些监控规则 |
| 用户意图理解 | Workspace skill | 把自然语言需求映射成可用规则类型与参数 |
| 高频执行 | 服务层 scheduler | 每轮巡检执行实例化规则,记录命中、去重、推送 |

这样做的原因是:

- 新增一种规则能力时,优先改服务层目录与执行器,不需要频繁改 workspace schema。
- Workspace skill 只需要学会"先看目录,再发起调用",而不是硬编码所有规则类型。
- 调度器高频读写、去重、事件记录继续留在 SQLite,符合 `docs/table-ownership.md` 的现有边界。

### 4.4 推荐 API 契约

API 命名不必逐字照搬,但职责边界建议固定。

#### 4.4.1 规则目录

- `GET /api/watch-rules/catalog`
  - 返回当前支持的规则类型清单
  - 每个条目至少包含:
    - `key`
    - `label`
    - `status`
    - `description`
    - `targetScopes` (`holding` / `watchlist` / `plan` / `manual`)
    - `paramsSchema`
    - `defaults`
    - `examples`
    - `cooldownCapabilities`
    - `supportsDryRun`

目录返回示意:

```json
[
  {
    "key": "price_cross",
    "label": "价格阈值触发",
    "status": "active",
    "targetScopes": ["holding", "watchlist", "manual"],
    "paramsSchema": {
      "operator": { "type": "enum", "required": true, "options": [">=", "<="] },
      "value": { "type": "number", "required": true },
      "cooldownMinutes": { "type": "number", "required": false, "default": 240 }
    },
    "examples": [
      {
        "stockCode": "600036",
        "params": { "operator": ">=", "value": 46.5, "cooldownMinutes": 240 }
      }
    ]
  }
]
```

#### 4.4.2 规则实例

- `GET /api/watch-rules?userId=&instanceId=`
- `POST /api/watch-rules`
- `PATCH /api/watch-rules/:id`
- `DELETE /api/watch-rules/:id`
- `POST /api/watch-rules/validate`
- `POST /api/watch-rules/:id/dry-run`

实例创建最小字段建议:

```json
{
  "userId": "primary",
  "instanceId": "invest-agent-primary",
  "ruleType": "ma_cross",
  "stockCode": "600036",
  "stockName": "招商银行",
  "targetScope": "watchlist",
  "params": {
    "period": 20,
    "direction": "break_above"
  },
  "cooldown": {
    "mode": "cooldown",
    "minutes": 240
  },
  "notification": {
    "priority": "P1",
    "push": true
  },
  "source": {
    "kind": "workspace_skill",
    "requestId": "..."
  }
}
```

### 4.5 Workspace skill 的责任边界

阶段二最重要的不是"把配置文件改得更复杂",而是让 Workspace skill 学会稳定地使用服务层规则系统。

Workspace skill 负责:

- 读取规则目录 API。
- 判断用户需求是否属于当前可支持的明确规则。
- 询问缺失参数,比如阈值、均线周期、作用股票、冷却时间。
- 在必要时要求用户确认。
- 调用规则实例 API 完成创建/更新/停用/删除。
- 在用户追问时解释"为什么是这个规则"、"它什么时候会触发"。

Workspace skill 不负责:

- 自己维护一套本地规则类型枚举。
- 每 5 分钟执行一次高频行情判断。
- 绕过服务层直接把结构化规则写进 workspace 文件并指望 scheduler 自己发现。

### 4.6 服务层责任边界

服务层负责:

- 规则目录注册与版本演进。
- 参数校验与 dry-run。
- SQLite 持久化。
- 高频巡检执行。
- 触发事件记录、去重、cooldown、push、审计。
- 与持仓、自选、预案、行情、K 线等确定性数据打通。

服务层不负责:

- 理解用户口语里的含糊表达。
- 生成高自由度投资方法论。
- 替用户做主观新闻判断。

### 4.7 与 Agent 的边界

本阶段 Agent 不负责高频判断条件是否触发。

Agent 可以负责:

- 把用户自然语言提醒需求整理成结构化规则草案。
- 调用服务层目录 API 先确认有哪些可用规则类型。
- 等用户确认后调用服务层规则实例 API。
- 对服务层触发结果做更自然的微信解释。
- 帮用户调整规则,但不能绕过确认直接启用高影响规则。

服务层负责:

- 拉取数据。
- 执行 Primitive。
- 判定是否触发。
- 去重和限频。
- 记录事件。
- 调用推送或必要时调用 Agent。

### 4.8 数据归属决策

阶段二建议继续遵循当前项目边界:

- `alert_rules` / `alert_events` / `alert_signal_states` 继续留在 SQLite。
- `watch.yaml` 继续保留为"盘中窗口、模式、说明性规则、人工备注"等低频配置。
- 不把 `watch.yaml` 升级成高频结构化规则数据库。

原因:

- 调度器高频读取、事件写入、去重查询、本来就更适合 SQL。
- 如果每新增一种规则能力都要改 workspace schema,会让 Workspace 变成高频演进面,这和当前想要的稳定边界相反。
- 用户真正频繁变化的是"我要不要新增某个规则实例",这更适合 API + SQLite,而不是 YAML 人工结构扩展。

### 4.9 不做

本阶段不做:

- 新闻、公告、政策、舆情、市场情绪的正则粗筛。
- 主观事件是否实质性利多/利空的 Agent 判断。
- 任意复杂自然语言规则直接运行。
- 复杂脚本型 watch evaluator 的完整开放。
- 每新增规则类型都同步修改 Workspace 配置 schema。

### 4.10 验收标准

- 用户设置明确价格阈值后,服务层能在价格触发时产生提醒事件。
- 用户设置均线突破/跌破规则后,服务层能用 K 线计算并判断。
- 用户通过 Workspace skill 提出规则需求时,skill 会先读取服务层目录,而不是写死规则枚举。
- 新增一类规则能力时,无需修改 Workspace 配置文件 schema 即可被 skill 发现并使用。
- 同一规则在 cooldown 内不会重复打扰。
- 未触发时不调用 Agent。
- 触发记录包含事实、规则、数据时间、priority、dedupe key。
- Dashboard 或日志能看出"为什么触发"或"为什么未触发"。
- 针对主用户 `primary / invest-agent-primary` 的规则创建、dry-run、触发、推送链路可完成真实验收。

### 4.11 建议实施顺序

1. 先定义规则目录注册结构和最小 3 个 primitive。
2. 再补规则实例 CRUD / validate / dry-run API。
3. 让 scheduler 新增"读取规则实例并执行"主路径。
4. 再让 Workspace skill 改为"先读目录,再调 API"。
5. 最后补 dashboard 的只读展示,再决定是否做编辑界面。

### 4.12 当前落地进展

2026-07-02 当前代码已完成阶段二服务层落地和技术指标扩展:

- 已新增服务层规则目录:
  - `GET /api/watch-rules/catalog`
  - `GET /api/sandbox/watch-rules/catalog`
- 已新增规则实例 API:
  - `GET /api/watch-rules`
  - `POST /api/watch-rules`
  - `PATCH /api/watch-rules/:id`
  - `DELETE /api/watch-rules/:id`
  - `POST /api/watch-rules/validate`
  - `POST /api/watch-rules/:id/dry-run`
  - sandbox 对应接口同名挂在 `/api/sandbox/watch-rules*`
- 已让 scheduler 接入独立 `rule-alert-check` 任务,与 market-watch 定时简报分离:
  - 交易日按 `alert_check_interval_minutes` 采样,默认 5 分钟
  - 只按采样当刻可取得的最新价格/K 线/预案事实判断
  - 不回溯"盘中曾经触达",不做收盘确认变体
  - 触发事实写入 `alert_events` / `alert_signal_states` / `indicator_results`,运行记录写入 `scheduled_task_runs.task_type = rule-alert-check`
- 已接入当前规则目录:
  - `price_cross`
  - `ma_cross`
  - `macd_cross`
  - `kdj_cross`
  - `rsi_threshold`
  - `boll_break`
  - `wr_threshold`
  - `volume_ratio`
  - `near_plan_level`
- 已补服务层烟测:
  - `npm run smoke:stage2-watch-rules`
- 已补 Platform 专用审计页:
  - `/platform#rule-alerts`
  - `GET /api/platform/rule-alerts`

当前仍未完成的部分:

- Dashboard 还没有完整的 watch-rule 编辑界面；当前 Platform 只提供规则巡检审计和只读观察。
- 真实盘中触发验收仍需按具体用户/规则单独观察,尤其要区分"采样点未命中"与"规则未运行"。

## 5. 阶段三:新闻/事件类主观盯盘

### 5.1 阶段目标

实现对主观新闻事件、政策变化、财报风险、市场情绪变化等非纯数值条件的盘中盯盘。

这类判断不能完全交给服务层硬编码,但也不能每轮全量调用 Agent。目标链路是:

```text
服务层低成本信息粗筛
→ 命中候选事件
→ Agent 主观判断事件是否重要
→ 服务层记录、去重、推送
```

### 5.2 范围

本阶段覆盖:

- 定义新闻/事件输入源。
- 定义粗筛关键词、正则或轻量分类规则。
- 将粗筛候选事件与用户持仓、自选、行业、策略关注点关联。
- 命中后调用 Agent 判断:
  - 是否影响持仓逻辑。
  - 是否实质性利多/利空。
  - 是否需要打断用户。
  - 与最近复盘观点是否冲突。
  - 后续验证信号是什么。
- 将 Agent 判断结果写入事件记录和复盘材料。

### 5.3 典型场景

- 持仓公司突发公告。
- 行业政策发生变化。
- 商品价格、汇率、利率等变量影响持仓逻辑。
- 财报或业绩预告出现异常。
- 市场风格发生明显切换,并与用户近期复盘观点冲突。
- 重大负面新闻可能改变公司基本面判断。

### 5.4 不做

本阶段仍不做:

- 自动交易。
- 承诺收益或预测精确走势。
- 未经确认自动修改用户策略。
- 将未经核验的传闻当作事实推送。
- 对所有新闻全量调用 Agent。

### 5.5 验收标准

- 未命中粗筛条件的新闻不调用 Agent。
- 命中粗筛但不重要的候选事件能被 Agent 判定为不推送或仅记录。
- 被判定为重要的事件能形成结构化记录和微信推送。
- 推送中能区分事实、推断、影响范围、用户是否需要确认、后续验证点。
- 事件能进入日/周/月复盘,用于后续判断当时观点是否正确。

## 6. 三阶段关系

三个阶段不是并行做完,而是递进:

| 阶段 | 核心价值 | Agent 调用策略 |
| --- | --- | --- |
| 阶段一 | 确保定时任务可靠 | 复盘和固定任务可调用 Agent |
| 阶段二 | 明确规则低成本执行 | 未触发不叫 Agent;触发后可选调用 |
| 阶段三 | 主观事件智能判断 | 粗筛命中后才叫 Agent |

阶段一解决"任务能不能稳定跑"。

阶段二解决"确定性盯盘不要浪费 Agent"。

阶段三解决"服务层无法主观判断的复杂事件如何低成本交给 Agent"。

## 7. 当前建议的实施顺序

1. 先验收并补强现有 scheduler、复盘、盘中固定窗口推送链路。
2. 梳理阶段一失败模式:未触发、重复触发、Agent 超时、推送失败、artifact 未保存。
3. 再定义阶段二服务层规则目录、规则实例 API 和 Primitive 输出格式。
4. 先落一个最小规则集合:价格阈值 + 均线突破/跌破 + 预案位接近 + cooldown。
5. 将 Workspace skill 改为通过 API 发现并管理规则实例。
6. 稳定后再设计阶段三的信息源、正则粗筛和 Agent 主观判断协议。

## 8. 关键原则

- 高频判断优先服务层执行。
- 低频总结、解释、主观判断优先 Agent 执行。
- 规则能力目录属于服务层,高频规则实例运行时也属于服务层。
- Workspace skill 通过稳定 API 使用规则系统,而不是频繁扩展 workspace schema。
- 每次推送都要能回溯触发原因。
- 未触发时不制造陪伴型噪音。
- 数据缺失时明确记录缺失,不能让 Agent 补想象。
- 所有可能改变用户长期规则或策略的方法论变更,都需要确认。

## 9. 待讨论问题

1. 阶段二新规则实例是直接扩展现有 `alert_rules`,还是新建专用 `watch_rule_instances` 表?
2. 阶段二 P1 事件是立即推送,还是只进入晚间汇总?
3. 阶段二触发后是否默认调用 Agent 整理微信文案,还是服务层先生成模板文案?
4. 规则目录是静态代码注册,还是支持部分数据库驱动扩展?
5. 阶段三新闻源从哪里来,先接公告/财报/研报/新闻中的哪一类?
6. 阶段三粗筛规则由平台默认模板提供,还是允许用户后续自定义?

## 9.1 2026-07-02 当前边界与后续扩展

当前已打通的是阶段二服务层明确规则巡检,不是完整任意规则系统。

已验证范围:

- 服务层规则实例可通过 Workspace skill 创建。
- 当前规则集:
  - `price_cross`:价格上穿/下破阈值。
  - `ma_cross`:突破/跌破指定均线。
  - `macd_cross`:日线 MACD 金叉/死叉。
  - `kdj_cross`:日线 KDJ 金叉/死叉,可带阈值过滤。
  - `rsi_threshold`:RSI 高于/低于阈值。
  - `boll_break`:突破/跌破 BOLL 上下轨。
  - `wr_threshold`:WR 高于/低于阈值。
  - `volume_ratio`:量比或成交量相对均量阈值。
  - `near_plan_level`:接近预案支撑/压力/目标/止损位。
- 规则 dry-run 已改用服务层 market-data facade,返回行情来源、时间、置信度和 warnings。
- 主用户 `primary / invest-agent-primary` 已通过微信创建 `赣锋锂业 >= 66` 规则,落库为 `alert_rules.relation_to_plan = stage2_watch_rule`。
- u3 旧式 `config/watch.yaml` 价格提醒已迁移为服务层 watch-rule 实例,workspace 文件只保留迁移说明。
- 所有现有 workspace 与 `templates/workspace` 的 market-watch 规则资产已同步:明确价格/均线/预案位规则必须走 `/api/sandbox/watch-rules*`,不能用写 `config/watch.yaml` 冒充创建成功。
- Platform 已新增独立 `规则巡检` 菜单,用于查看 interval、规则、recent `rule-alert-check` runs 和 alert events。

当前只需要继续观察和验收:

- 规则巡检与定时盯盘是否互不混淆:market-watch 是固定窗口简报/摘要,rule-alert-check 是按采样间隔执行确定性规则。
- 规则巡检与复盘推送是否互不干扰:复盘只消费提醒与行情事实,不承担创建或执行明确价格规则。
- 触发时是否写入 alert event / push queue,未触发时是否不制造噪音。
- P0/P1/P2 的推送时机是否符合用户低打扰或严格推送配置。

后续可扩展方向,暂不纳入当前验收:

- **服务层巡检频率配置**:支持用户说"每 N 分钟巡检一次",由服务层 scheduler 读取 workspace `config/schedules.yaml` / `config/watch.yaml` 的窗口和间隔后执行,而不是让 Agent 自己轮询。
- **更多组合规则**:例如放量突破、突破后回踩、组合回撤、行业集中度等。新增前应先进入规则目录 catalog,再支持 validate/create/dry-run,并明确状态机、确认口径和数据窗口。
- **更复杂的组合规则**:例如"突破 20 日线且回踩 5 日线不破"这类多条件规则,需要明确状态机、确认口径和数据窗口,不能用自然语言直接即兴执行。
- **事件/文本粗筛**:公告、新闻、财报、政策等可先用服务层低成本规则或正则粗筛,命中后再交给 Agent 判断重要性。当前先不处理政策/新闻主观判断。
- **规则 UI / Dashboard**:后续可增加专用 watch-rules 列表、启停、dry-run 和触发历史视图。
- **规则迁移清理**:逐步把各 workspace 中可执行的 `custom_rules` 迁移为服务层 watch-rule 实例,`config/watch.yaml` 只保留窗口、低打扰策略和说明性规则。

## 10. 执行代理提示

Executor prompt:

```markdown
请基于 `docs/watch-runtime-phased-implementation.md` 实施当前指定阶段。严格遵守阶段范围和不做事项。先验证阶段一的定时任务与推送可靠性,不要提前实现阶段二/三。每个改动都需要对应验收方式,并保留现有 workspace-scoped ACP 直通主链路。
```

Reviewer prompt:

```markdown
请按 `docs/watch-runtime-phased-implementation.md` 审查执行结果。重点检查是否越阶段实现、是否破坏复盘/定时推送、是否无触发也调用 Agent、是否缺少 trace/日志/失败兜底。发现问题按阶段目标和验收标准列出。
```
