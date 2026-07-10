# 交易策略实体设计(第一版)

> 状态:Approved / Implementing,2026-06-23
> 关联:[ideal-refactor-plan.md](./archive/ideal-refactor-plan.md)、[composite-indicator-system.md](./composite-indicator-system.md)、[04-core-workflows.md](./04-core-workflows.md)
> 范围:把"交易策略"从隐式字段(`stock_plans.notes` / `investment_profiles`)提为系统一等公民,支撑"策略 → 预案"的单向生成链路。

## 1. 背景与动机

当前架构中,"交易策略"在代码里不是实体,被拆散到三处:

- `stock_plans.notes`(单股策略备注)
- `investment_profiles`(整体风格 / 风险偏好)
- 用户脑子里的判断流程(完全没有承载)

后果:

- 用户陈述的策略无法被系统复用,每次设置预案都得重说一遍
- 复盘无法回溯"这条预案当初是基于哪套策略生成的"
- AI 起草预案时缺乏稳定的策略上下文,推理结果漂移

本设计的目标:在第一版引入显式的 **交易策略实体**,作为 AI 生成预案的稳定输入,把"用户陈述策略 → AI 起草预案 → 用户确认 → 落地"这条路打通。

## 2. 第一版范围声明

### 2.1 做

- 用户可以维护**多份**交易策略,每份含名称、适用场景、正文
- AI 基于策略起草预案,**两次用户确认**(策略匹配确认 + 预案草案确认)
- `stock_plans` 加 `strategy_key` 溯源字段
- 两种触发生成预案的场景:持仓新增、日复盘后

### 2.2 明确不做(产品红线 / 数据缺失)

- ❌ **不让机器自动迭代策略**。系统基于 AI,自动迭代等于让 AI 替用户做策略决策,越界。
- ❌ **不统计策略命中率**。系统不管用户实际交易(买没买、买多少、何时卖、盈亏多少),没有客观命中率输入,任何统计都是主观打分。
- ❌ **不让复盘反哺策略**。复盘只产出当日 `daily_plans` 和 markdown 报告,不改策略本体。
- ❌ **不自动落库预案**。AI 起草后必须用户确认才落 `stock_plans`。

未来如果决定接入"用户实际交易数据",再考虑反向闭环。在那之前,策略是**只读 + 手动修订**的稳定上下文。

## 3. 数据模型

### 3.1 策略本体:`workspace/config/trading_strategies.yaml`

策略是用户的私人制品,放工作空间 yaml,**不放 SQLite**。与 `composite_indicators.yaml`(L3a 规则树)、`risk_taxonomy.yaml`(信号优先级)的承载方式完全一致。这是项目 workspace 模型的硬性约定,详见 `docs/table-ownership.md`。

单文件多 entry,每份策略含:

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| key | string | 用户可读短标识,如 `breakout-pullback`,文件内唯一 |
| name | string | 显示名 |
| applicability | string | 适用场景,纯文字(第一版) |
| body | string | 策略正文,纯文字(第一版) |
| enabled | boolean | 默认 true |
| created_at | string | ISO 日期 |
| updated_at | string | ISO 日期 |

第二版若引入结构化副本,新增 `body_structured` 字段(JSON 子对象),不影响第一版 schema。

示例:

```yaml
- key: breakout-pullback
  name: 突破回踩
  applicability: 主板趋势股、波动率适中、有业绩支撑
  body: |
    突破 20 日线且量比 > 1.5 时关注,回踩 20 日线不破进场。
    止损进场价 -5%,目标 +15%。
  enabled: true
  created_at: "2026-06-23"
  updated_at: "2026-06-23"
```

### 3.2 `WorkspaceStore` 加方法

复用现有 `readYaml / writeYaml` 基础设施,加三个方法:

- `readTradingStrategies(): Promise<TradingStrategy[]>`
- `writeTradingStrategy(strategy: TradingStrategy): Promise<void>`(按 key upsert)
- `removeTradingStrategy(key: string): Promise<void>`

参考已有先例:`readPortfolio / readRiskTaxonomy`。

### 3.3 `stock_plans` 加 `strategy_key` 软引用字段

SQLite 里 `stock_plans` 表新增 `strategy_key`(text,可空):记录这条预案是基于哪份策略生成的。**SQLite 只存 key 字符串,策略本体永远在 yaml**。

可空:历史预案和手动预案没有策略来源。

策略被删除时,`stock_plans.strategy_key` **不级联清空**,保留为孤儿引用,Dashboard 标灰提示"原策略已删除"。

### 3.4 与现有 yaml 的关系

| yaml 文件 | 装什么 | 谁读写 |
| --- | --- | --- |
| `config/strategy.yaml` | 整体投资风格 + 不做什么(profile/allocation/rules) | Codex 在 onboarding 写,后续手动/Codex 改 |
| `config/trading_strategies.yaml` | 具体可执行策略(多份,每份有适用场景) | 用户/Codex 写,工具读 |
| `config/composite_indicators.yaml` | L3a 复合指标规则 | 用户/Codex 写,L3a 引擎读 |
| `config/risk_taxonomy.yaml` | 信号优先级映射 | 用户/Codex 写,alert-check 读 |

`trading_strategies.yaml` 和 `strategy.yaml` **平级,不合并**:

- `strategy.yaml` 是"我不做什么"(风险约束、仓位上限、不做的事)
- `trading_strategies.yaml` 是"我在什么条件下做什么"(具体进出场规则)

## 4. 策略实体形态

第一版采用**纯文字**,第二版演进到**混合(文字 + 结构化副本)**。理由:

- 用户写策略时不应被格式约束
- Codex 当前推理能力足够从纯文字提取关键要素(进场条件 / 止损算法 / 目标算法 / 仓位规则)用于起草预案
- 第一版先观察纯文字路径的稳定性;若发现 Codex 推理漂移,再启用结构化副本

第二版的 `bodyStructured` 草案(仅作记录,第一版不实施):

```json
{
  "entryConditions": ["突破20日线且量比>1.5", "回踩20日线不破"],
  "stopLossRule": "进场价 -5%",
  "targetRule": "进场价 +15%",
  "positionRule": "单股不超过总仓位 20%"
}
```

## 5. 触发流程

核心原则:**预案生成不与数据录入事件强绑定**。录入持仓是数据动作,生成预案是用户决策动作,两者之间必须有"用户主动同意"作为桥梁。

第一版支持三种触发入口,所有入口最终汇入 5.4 的两次确认流程。

### 5.1 场景 A:持仓新增后的"无预案提醒"

**不是"录入即生成"**,而是"录入后由用户决定是否进入生成流程"。

第一版的提醒方式(取最简,避免打扰):

- 录入成功的回复里附**轻量提示**:"该股暂无交易预案。需要的话告诉我,可以按你的策略起草一份。"
- 用户**下一次主动查询持仓/监控概览**时,系统在该股记录旁标注"暂无交易预案"
- **不主动推送额外消息**

用户回复"出预案"或类似同意表达后,进入 5.4 的两次确认流程。用户忽略或拒绝 = 不生成,纯持有。

### 5.2 场景 B:日复盘后的"预案补全/调整建议"

复盘产出后,系统在复盘报告末尾(或单独消息)附加**建议清单**,分两类:

- **新建**:无交易预案的持仓股,各推荐一份策略 + 一句话理由
- **调整**:已有预案但当日数据/趋势有显著变化的持仓股,提示"基于你的策略 X 和当日行情,建议重新评估 Y"

用户**主动**从清单中选择某一项,才进入对应的两次确认流程。系统不批量自动起草,不强制处理。

调整类与新建类走相同流程,只是 AI 起草时输入多了"现有预案 + 当天变化"作为上下文。

### 5.3 场景 C:用户主动触发(兜底入口)

用户随时说"用突破回踩策略给赛轮轮胎出个预案"或"调整赛轮轮胎的预案",直接进入两次确认流程。保证用户对生成时机有完全控制。

### 5.4 两次确认流程(所有场景共用)

```
[AI 推荐适用策略] (读 trading_strategies + 个股上下文)
   │
   │ 输出:推荐策略 + 备选 1-2 份 + 简短理由
   ▼
[第一道闸门] 用户确认策略选择
   │ 用户可选推荐 / 改选备选 / 跳过(不生成)
   ▼
[AI 基于策略起草预案] (读策略 + 行情 + 持仓上下文;调整类还读现有预案 + 当天变化)
   │
   │ 输出:预案草案(support/resistance/target/stopLoss/notes)
   ▼
[第二道闸门] 用户确认预案
   │ 用户可改价 / 改备注 / 拒绝重起草
   ▼
写入 stock_plans (含 strategy_key 溯源)
```

两道闸门存在的意义:**AI 自主性被框死在两次起草之内,不做任何自主落库**。这与第 2 节"不自动迭代策略 / 不自动落库预案"的红线对齐。

**重要边界(2026-06-23 加固)**:即使用户在请求里**已指定策略名**(如"用趋势中继策略给赣锋锂业出预案"),也**不能跳过第一道闸门**。Codex 必须先:

1. 确认该策略在 `trading_strategies.yaml` 里存在
2. 输出策略匹配说明(2-3 句,解释为什么该策略匹配这只股票的当前特征)
3. **等用户回复确认**才能进入第二道闸门起草预案

如果用户指定的策略在 yaml 里**不存在**,**不要**用"通用版本"代替起草。先告知用户策略未找到,询问:(a) 让我按你的口述新建该策略,或 (b) 改用其他已存在的策略。

预案草案**只**包含 5 个字段(support / resistance / target / stopLoss / notes),**禁止**包含仓位上限、持仓金额、持股数量、时间约束(系统不存这些,问了用户也填不进)。详见 `AGENTS.md` "Strategy Plan Drafting (硬约束)" 段。

### 5.5 用户复盘输入吸收(待整理,不在第一版范围)

复盘时用户会讲:

- 自己当天的实际操作(买/卖/调整)
- 对个股的主观看法
- 对系统建议的反馈

AI 需要吸收这些信息,结合策略对预案做变更建议,且**用户意志优先级高于 AI 起草**。

这部分涉及面较广:

- 用户操作/看法的录入形式(自由文字 vs 结构化)
- AI 抽取并落库的口径
- 与 `stock_plans` 调整的桥接
- 与未来"用户交易数据接入"的边界划分

**第一版不实施**,先打通 5.1-5.4 的预案生成主路径。待主路径验证后,单独整理这部分的设计 RFC。

## 6. Codex 接入点

### 6.1 新工具

策略 CRUD 工具**内部调 `WorkspaceStore`,读写 `workspace/config/trading_strategies.yaml`,不直接访问 SQL**。预案起草工具的产出经用户确认后写 `stock_plans`(走现有 plan 后端)。

| 工具 | 用途 | 落点 |
| --- | --- | --- |
| `query_trading_strategies` | 列出当前用户所有策略 | 读 yaml |
| `get_trading_strategy` | 取单份策略详情 | 读 yaml |
| `set_trading_strategy` | 新建/更新策略(用户陈述 → AI 起草 → 用户确认后写入) | 写 yaml |
| `remove_trading_strategy` | 删除策略 | 写 yaml |
| `recommend_strategy_for_stock` | AI 给某只股推荐适用策略(场景 A/B 第一步) | 读 yaml + 推理 |
| `draft_stock_plan_from_strategy` | 基于策略起草预案草案(场景 A/B 第三步) | 读 yaml + 推理 → 草案不落库 |

### 6.2 新 SKILL

`.codex/skills/invest-agent-strategy-plan-drafting/SKILL.md`,内容:

- 推荐策略时的判断维度(板块 / 市值 / 波动率 / 行情趋势 / 持仓角色)
- 起草预案时的元素提取(进场位 / 支撑 / 压力 / 目标 / 止损 / 仓位建议)
- **不确定性必须显式表达**:策略正文里"通常""一般""视情况"等模糊措辞要保留,不能改成精确数字
- **不承诺收益**:目标位是"如果策略成立,理论达到的位置",不是预测

## 7. 复盘边界声明

复盘流程**不感知策略实体**,保持现状:

- 复盘输入:行情、资金流、持仓、自选、`stock_plans`、`alert_events`
- 复盘输出:当日 `daily_plans` + markdown 报告 + (新)建议补全预案的清单

**复盘不读 `trading_strategies`,也不写**。如果未来要复盘反哺策略,需要先解决"用户实际交易数据接入"这个前置问题,届时另起 RFC。

## 8. 未来扩展口子

- `stock_plans.strategy_key` 字段为未来"统计每份策略的历史预案表现"预留(在不接入交易数据的前提下,可以统计"该策略生成的预案是否被用户采纳 / 用户后续是否手动修改")
- `trading_strategies.body_structured` 字段为第二版混合策略形态预留
- 复盘报告里"建议补全预案的清单"为未来"批量生成预案"预留交互入口

## 9. 实施计划

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 | 测试基建:引入 `node:test`,加 `npm test` 脚本,加 `tests/` 目录约定 | `npm test` 能跑空套件不报错 |
| P1 | 模板 + 数据库小改:`templates/workspace/config/trading_strategies.yaml` 空模板 + `WorkspaceStore.readTradingStrategies / writeTradingStrategy / removeTradingStrategy`(TDD) + `stock_plans` 加 `strategy_key` 字段 | 模板存在,WorkspaceStore 单测全绿,DB schema 更新 |
| P2 | 服务工具层:`query/get/set/remove` 策略 CRUD(内部调 WorkspaceStore) | Dashboard 能管理策略,工具层单测全绿 |
| P3a | 策略匹配材料与人工审阅标准 | 材料由对应 workspace Skill 在需要时使用，不维护独立量化推荐 runner |
| P3b | Codex SKILL + 工具:`recommend_strategy_for_stock` + `draft_stock_plan_from_strategy` | 端到端跑通两次确认流程(场景 C 兜底入口)，由 Codex/用户审阅策略匹配理由与确认纪律 |
| P4 | 场景 A 触发:持仓录入回复里附"无预案"轻量提示 + 概览页标注 | 用户在录入回复和概览页能看到标注,smoke 通过 |
| P5 | 场景 B 触发:复盘报告末尾附"建议清单"(新建 + 调整两类) | 复盘报告含清单,用户选择后能进入流程,smoke 通过 |
| P6 | 文档更新:CLAUDE.md / docs/README.md / 04-core-workflows.md | 文档一致性 |

P0-P3b 是 MVP(打通策略管理 + 兜底入口 + 验证基建),P4-P5 是场景触发完善,P6 是收尾。

**用户复盘输入吸收(5.5 节)不在本实施计划内**,后续单独 RFC。

## 10. 测试策略

本项目当前没有测试框架,所有"测试"是 `scripts/*-smoke.mjs`(裸 Node + assert + 真实数据)。本次工作引入分层测试约定,后续模块复用。

### 10.1 分层原则

| 工作类型 | 测试方式 | 节奏 |
| --- | --- | --- |
| 纯逻辑 + 文件 IO(WorkspaceStore / yaml 解析 / 工具层薄包装) | `node:test` 单元测试 | **TDD**:先写测试看红,再实现看绿 |
| AI 推理(策略推荐 / 预案起草 / 复盘建议) | 评测集(eval set) | **后置验证**:实现完成后跑评测,人工 / 规则打分 |
| 端到端集成(触发场景 A/B / 微信桥接 / Dashboard) | `scripts/*-smoke.mjs` | **事后 smoke**:实现完成后跑一次确认不爆 |

### 10.2 `node:test` 约定

- 目录:`tests/<module>.test.ts`
- 命令:`npm test`(走 `node --test --import tsx tests/`)
- 节奏:实现前先写测试,看到红灯;实现后看绿灯;重构保持绿灯
- 不 mock 文件系统:用 `os.tmpdir()` 真实写盘,因为 WorkspaceStore 本身就是文件 IO,假 mock 没意义

P1 的 WorkspaceStore 测试用例(起草):

- 空 yaml → `readTradingStrategies()` 返回 `[]`
- `writeTradingStrategy({key, name, body, ...})` 新增 → 再读能读出来
- 同 key 调 `writeTradingStrategy` → upsert,字段覆盖,数量不增
- `writeTradingStrategy` 不传 `created_at` → 自动填当前日期
- `removeTradingStrategy(key)` → 再读不含该 key
- `removeTradingStrategy(不存在的 key)` → 不报错,返回 false

### 10.3 评测集约定

- 目录:`tests/eval/<capability>/`,含 `fixtures.yaml`(输入) + `expected.yaml`(期望) + `run.mjs`(执行 + 打分)
- 评测对象:AI 推理工具,如 `recommend_strategy_for_stock`、`draft_stock_plan_from_strategy`
- 评测标准:
  - 推荐类:**top-1 命中率**(AI 推荐的策略是否在期望集合里)
  - 起草类:**关键字段命中**(support/resistance/target/stopLoss 是否落在期望区间)
- 不要求 100% 命中:AI 推理有合理波动,阈值(如 ≥ 60%)写在 `expected.yaml` 顶部
- 由 workspace Skill + Codex 在最小真实路径中审阅，不进入 CI，也不维护 `npm run eval:<capability>` 执行器

P3a 评测集内容(起草):

- 5 只股票(覆盖趋势 / 震荡 / 反转 / 大盘 / 中小盘)
- 3 份策略(突破回踩 / 价值反转 / 动量跟随)
- 期望表:每只股票 → 期望推荐的 top-1 / top-3 策略 + 一句话理由关键词
- 阈值:top-1 命中率 ≥ 60%(5 只中至少 3 只命中)

### 10.4 smoke 约定(沿用现有)

- 目录:`scripts/<scene>-smoke.mjs`
- 命令:`npm run smoke:<scene>`
- 真实数据 + 真实 API,只断言"不爆 + 关键产物存在"
- 不做精细断言(那是 node:test 和评测集的事)

## 11. 待确认 / 风险点

- **"合适节点提醒"的具体口径**:第一版取最简(录入回复里附提示 + 概览页标注),不主动推消息。实际使用后若发现提醒力度不够或过头,再调整。
- **策略数量上限**:用户会不会写几十份导致推荐时选择困难?第一版不限制,观察实际使用。
- **策略冲突**:同一只股套策略 A 出预案后,用户想换策略 B,第一版直接覆盖 `stock_plans`(保留历史在 `alert_events` 里),不维护版本。
- **推荐策略的准确性**:Codex 推断策略适用性依赖行情/板块数据,目前板块/市值标签缺失,第一版只能靠行情趋势 + 持仓角色粗判,可能不准。**第一道闸门存在的意义就是兜底这个不准**。
- **调整类建议的判定阈值**:已有预案的个股,什么程度的"当天数据变化"才触发"建议调整"?第一版可以保守(只提示显著变化,如跌破支撑、突破压力、单日波动 >5%),避免噪音。
- **适用场景的颗粒度**:第一版纯文字,未来若要支持系统机械匹配(避免每次都让 AI 推断),需要给个股打板块/市值/波动率标签,这是另一个工作包。
