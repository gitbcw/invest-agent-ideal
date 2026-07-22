# Watch Runtime Design Note

日期: 2026-06-26

> 更新说明(2026-07-15):本文保留为讨论记录,其中"结构化规则放入 workspace 配置"的思路已不是当前首选。当前方向见 `docs/watch-runtime-phased-implementation.md`:服务层拥有规则目录与规则实例,Workspace Agent 只通过 `watch_rules.*` 具名 MCP 工具发现和创建规则。
> 运行时名称说明(2026-07-02):本文中的 Hermes 是历史讨论语境。当前默认 backend 是 Codex ACP,应按 workspace-scoped ACP backend 理解。
> 收敛说明(2026-07-09):当前运行时已不再执行 legacy `alerts` 规则,也不再启动时镜像到 `alert_rules`。明确规则巡检只执行 stage2 watch_rules(`alert_rules.relation_to_plan=stage2_watch_rule`)；本文后续关于 SQLite `alerts` / `alert_rules` 并存的讨论仅作历史背景。

本文记录盘中巡检规则问题的阶段性分析,用于晚间讨论后再决定是否执行。本文不是已落地设计,也不要求立即修改代码。

## 1. 背景

当前主链路是:服务层 scheduler 按配置触发 workspace-scoped ACP backend 执行一轮 market-watch 任务。服务层还保留确定性 API、行情数据、SQLite 事件记录、推送队列和微信连接。

这次暴露的问题是:

- 用户通过微信确认了新的到价提醒,回复中显示"已加入提醒条件"。
- 用户 workspace 的 `config/watch.yaml` 已出现自然语言规则。
- 但确定性巡检仍读取 SQLite `alerts` / `alert_rules` 中的机器规则。
- 结果是:人能看到规则,服务执行器看不到规则,出现"价格破位但未提醒"。

这个问题不是单个阈值漏写,而是规则源头分裂:workspace 文件、SQLite 规则表、Hermes 回复、scheduler 执行路径没有统一契约。

## 2. 当前讨论形成的判断

### 2.1 高频巡检不能每轮依赖 Agent 推理

盘中巡检可能是每 5 分钟或每 10 分钟一次。若每轮都让 Agent 读取文本、理解复杂规则、判断是否触发,会带来:

- 高延迟:模型调用慢于简单行情计算。
- 高成本:交易时段多用户多轮调用会放大 token 和模型限额压力。
- 不稳定:同一自然语言规则可能被不同轮次解释不同。
- 不可审计:很难解释"为什么这轮没触发"。
- 不可靠:模型超时、限额、空回复都会影响提醒。

因此,高频巡检必须把"运行时判断"尽量变成低成本、可重复、可审计的代码执行。

### 2.2 复盘与巡检不同

复盘频率低,且价值在复杂推理、归因、方法论修正和输出纪律。因此复盘应继续由服务层定时触发 Agent,服务层负责收集确定性上下文、保存 artifact 和推送摘要。

换句话说:

- 巡检:高频、低延迟、规则执行优先。
- 复盘:低频、高质量、Agent 推理优先。

### 2.3 服务层仍必须参与巡检触发

当前 Hermes stdio ACP 是由服务层托管和调用的子进程。它可以复用会话,但当前代码没有把 Hermes 当成每用户独立的常驻 cron runtime。

服务层具备 Hermes 不稳定具备的能力:

- 常驻在线。
- 微信推送和 push queue。
- 行情 API、数据库、审计。
- 调度、超时、重试、幂等。
- 多用户/实例 scope 枚举。

因此,服务层应继续负责"什么时候跑"和"跑完怎么记录/推送",但不应把所有投资判断硬编码进中心代码。

## 3. 推荐方向:服务层 Runtime + Workspace 可执行规则

推荐把系统拆成三层。

### 3.1 中心服务层:运行底座

中心服务只沉淀所有用户都会用、且必须稳定的通用能力:

- 调度:每 5 分钟 / 10 分钟 / 固定窗口。
- 数据:quote、kline、minute kline、持仓、自选、预案、最近提醒。
- 指标原语:price、涨跌幅、MA、MACD、KDJ、成交量、量比等。
- 执行:workspace 规则读取、脚本沙箱、超时、错误隔离。
- 状态:alert_events、alert_signal_states、push_jobs、sandbox_audit_logs。
- 输出:推送、去重、审计、运行日志。

中心服务不应为了某个用户新增大量专属规则类型。

### 3.2 Workspace:用户规则和脚本

用户个性化巡检规则应进入 workspace,而不是进入中心服务代码。

简单规则可以是结构化配置,例如:

```yaml
runtime_rules:
  - id: user_price_601058_target_12
    enabled: true
    stock_code: "601058"
    stock_name: "赛轮轮胎"
    trigger:
      type: price
      operator: ">="
      value: 12
    priority: P1
    once_per_trading_day: true
    source: user_confirmed
```

复杂规则可以是 workspace 脚本,例如:

```text
scripts/watch/sailun_ma_position.ts
scripts/watch/ganfeng_lithium_rotation.ts
```

脚本输入由服务层提供标准上下文:

```ts
{
  now,
  portfolio,
  watchlist,
  plans,
  quotes,
  klines,
  recentAlerts,
  latestReview
}
```

脚本输出标准提醒:

```ts
[
  {
    id: "ganfeng_breakdown_confirmed",
    stockCode: "002460",
    priority: "P1",
    fact: "...",
    inference: "...",
    actionNeeded: false,
    message: "..."
  }
]
```

脚本应是纯函数式 evaluator:只读输入,输出提醒候选;不直接推送、不直接写库、不直接访问任意文件或网络。

### 3.3 Agent / Skills:规则作者和解释器

Agent 不应该每 5 分钟都负责判断价格有没有破位。Agent 应该在低频时做:

- 把用户自然语言转成结构化规则草案。
- 等用户确认后写入 workspace。
- 为复杂需求生成或修改 workspace 脚本。
- 做 dry-run / 校验结果解释。
- 当服务层产生触发事件后,组织成用户能读懂的微信文本。

这能把高开销推理从高频运行时挪到低频配置/解释阶段。

## 4. 不改模板时的过渡办法

短期不改 `templates/workspace/` 也可以推进讨论:

- 在单个用户 workspace 的 `config/watch.yaml` 增加可选字段,例如 `check_interval_minutes` 和 `runtime_rules`。
- 老 workspace 没有这些字段时继续按原逻辑降级。
- 服务层 parser 对新字段做容错读取。
- Dashboard / Hermes 写入时只改用户 workspace,不改模板。

这能避免模板立刻变复杂,也能先验证真实用户体验。

## 5. 通用规则做什么,不做什么

建议中心服务只做"高复用原语",不做"用户策略全集"。

适合中心化的能力:

- price_cross
- percent_change
- near_plan_level
- ma_cross
- volume_ratio
- break_support
- breakout_with_volume
- cooldown / once_per_trading_day
- quote / kline / plan data provider

不适合中心化的能力:

- 某个用户专属交易法。
- 需要结合日复盘观点的文本判断。
- 多条件状态机。
- 行业逻辑、政策变化、财报解释。
- 需要持续演化的个人方法论。

判断标准:

- 三个以上用户都会复用:沉淀成中心原语。
- 只属于某个用户:放 workspace。
- 需要复杂组合或状态:放 workspace script。
- 需要稳定数据、调度、推送:服务层提供。

## 6. 与现有复合指标系统的关系

现有 `composite-indicator-system.md` 已经有类似分层:

- L1:平台算子。
- L2:标准信号。
- L3a:workspace YAML 规则树。
- L3b:workspace TypeScript 沙箱脚本。

盘中巡检可以复用这条思想,但需要面向"用户提醒规则"再定义更直接的 runtime contract:

- 输入上下文是什么。
- 输出提醒格式是什么。
- 脚本如何注册和启用。
- 如何 dry-run。
- 如何记录脚本版本/hash。
- 如何与 push/cooldown/audit 对接。

## 7. 待讨论问题

1. `runtime_rules` 放在 `config/watch.yaml` 里,还是新建 `config/watch_rules.yaml`?
2. workspace 脚本目录使用 `scripts/watch/` 还是复用 `scripts/indicators/`?
3. Agent 写脚本是否需要二次确认?脚本启用是否必须 dry-run 通过?
4. 服务层调用 Hermes 生成提醒文本的边界是什么?命中硬规则后是否总是叫 Hermes,还是 P0/P1 才叫?
5. SQLite `alerts` / `alert_rules` 是否降级为 legacy,还是继续作为 Dashboard 兼容层?
6. 每用户巡检频率是写 workspace,还是仍保留全局 settings 兜底?
7. 复杂文本规则是否允许"Agent 每 N 分钟解释一次",还是必须先转成脚本/结构化规则?

## 8. 初步执行思路

若晚间确认该方向,建议分阶段落地:

1. 先定义 runtime alert contract:输入、输出、priority、dedupe key、审计字段。
2. 让 scheduler 支持每用户 `check_interval_minutes`,默认仍按现有配置降级。
3. 增加 workspace 结构化规则读取,只覆盖 price_cross 这类最小场景。
4. 将微信新增到价提醒改为写 workspace 结构化规则,并做 dry-run 校验。
5. 把 SQLite `alerts` 规则源标为 legacy,巡检主路径改读 workspace。
6. 再评估是否引入 `scripts/watch/*.ts` 作为复杂规则扩展。
7. 最后整理 Dashboard,让它展示/编辑 workspace 规则而不是 SQLite 规则。

## 9. 临时结论

当前最稳妥的方向是:

- 服务层继续拥有调度、数据、执行、安全、推送和审计。
- Workspace 继续拥有低频配置、说明性规则和脚本扩展位,但不再是阶段二高频结构化规则的主承载面。
- Agent 负责把自然语言需求转成服务层规则实例调用,以及对触发结果做解释。
- 高频巡检运行时尽量不依赖 Agent 推理。
- 低频复盘继续依赖 Agent 推理。

这条路能避免中心服务为每个用户定制规则,也能避免每 5 分钟都把复杂判断交给模型。
