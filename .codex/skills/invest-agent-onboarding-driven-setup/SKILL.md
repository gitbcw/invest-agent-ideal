---
name: invest-agent-onboarding-driven-setup
description: Drive the user through layered onboarding (quick_30s → standard_3m → advanced) when they show intent to configure holdings, style, or methods. Read templates/workspace/config/onboarding.yaml for the level definitions and templates/workspace/config/style_packs.yaml for selectable style packs. Persist holdings/watchlist via service tools; style and methods via workspace yaml + knowledge/methods/*.md. Use after the welcome message when the user engages with setup.
---

# Invest Agent Onboarding Driven Setup

## Purpose

承接 `invest-agent-onboarding-flow` 输出的欢迎语之后,把用户驱动到 `templates/workspace/config/onboarding.yaml` 定义的三层冷启动:

- `quick_30s` — 上传持仓 + 选风格包 + 确认低打扰 → 第一份今日持仓复盘可用
- `standard_3m` — 补现金 / 观察仓 / 单一标的或资产仓位上限 / 提醒偏好
- `advanced` — 沉淀基本面 / 技术面 / 宏观 / 风控方法

每层完成后落盘到对应 workspace 文件,然后才推进下一层。**advanced 不是日常对话的前置条件**——`onboarding.yaml` 里有 `do_not_block_first_report_on_advanced_methods: true`,即使用户没补方法,第一份日复盘也必须能跑通。

## When To Use

- 用户在欢迎语后开始提供持仓 / 自选 / 风格 / 方法等配置信息
- 用户主动说"我想配置一下""帮我设置一下""我应该怎么开始"
- Dashboard 检测到 workspace 状态文件标记 `level: quick_30s` 未完成

不要在每次对话都触发——只有用户表达配置意愿时才驱动。

## Layer 1: quick_30s

目标:**让用户当天就能拿到第一份持仓复盘**。

步骤:

1. **录持仓**:用户用文字或截图给持仓。解析为 `[{name, code, cost_price?}]`。每股成本价可选,数量和金额不收。
2. **选风格包**:读 `templates/workspace/config/style_packs.yaml`,把 3 个默认风格包(稳健价值型 / 指数配置型 / 趋势辅助型)的 `suitable_for` 简短列出,让用户选一个 key,或描述自定义风格。
3. **确认低打扰模式**:读 `templates/workspace/config/notification.yaml`,确认默认 `only_push_on_exception: true` 是否可接受。

落盘:

- 持仓 → 调用 service tool `/api/sandbox/portfolio/add`(参见 `invest-agent-service-tools`),不直接写 yaml
- 风格包选择 → 写 `workspace/config/strategy.yaml` 的 `profile.selected_style_pack`(通过 WorkspaceStore,等价 service `/api/sandbox/profiles/strategy`)
- 通知偏好 → 写 `workspace/config/notification.yaml`(同上)

完成 quick_30s 后,主动触发一次 `generateDailyReview`(或建议用户在 Dashboard 触发),让用户立刻看到价值。

## Layer 2: standard_3m

目标:**补齐可用盯盘和仓位判断**。

步骤:

1. **现金**:可选录入(同样只收数字,不收金额明细),用于算安全垫。
2. **观察仓**:用户给自选股列表,解析为 `[{name, code, trigger?}]`。`trigger` 是用户对该股的观察条件(如"回到 20 日均线""破前高")。
3. **单一标的或资产仓位上限**:只收百分比或描述(如"单股不超过 30%"),不收数量金额。
4. **提醒偏好**:让用户描述什么场景必须当天推(参见 `templates/workspace/config/risk_taxonomy.yaml` 的 P0/P1/P2 模型)。

落盘:

- 观察仓 → service tool `/api/sandbox/watchlist/add`
- 上限 → 写 `workspace/config/decision_policy.yaml`
- 提醒偏好 → 写 `workspace/config/notification.yaml` 的 P0/P1 列表

## Layer 3: advanced

目标:**沉淀个性化方法**。

按 `onboarding.yaml` 的 `advanced.writes` 写 4 个文件:

- `workspace/knowledge/methods/fundamental.md`
- `workspace/knowledge/methods/technical.md`
- `workspace/knowledge/methods/macro.md`
- `workspace/knowledge/methods/risk.md`

让用户用自然语言描述每一类方法,Codex 整理成结构化草案(分"原则 / 信号 / 失效条件 / 复盘周期"四块),**必须用户确认后才写盘**。不允许 silent write。

写入后,在 `workspace/memory/method_changes.jsonl` 追加一条变更记录,便于后续 weekly/monthly review 引用。

## Style Pack 选择细节

`templates/workspace/config/style_packs.yaml` 定义:

- `steady_value` 稳健价值型(上班族、低频、长期持有)
- `index_allocation` 指数配置型(不想研究个股、ETF 为主)
- `trend_assisted` 趋势辅助型(接受波动、技术面辅助节奏)
- `custom_style` 用户自定义

让用户选 key 后,把 `default_rules` 写入 `workspace/config/strategy.yaml` 的 `buy_rules` / `sell_rules` / `risk_rules`,同时记 `profile.selected_style_pack`。如果用户描述自定义风格,在 `custom_style` 字段下写 `name` / `description` / `focus` / `rules`,且 `profile.selected_style_pack: "custom"`。

## Privacy Boundary(强制)

- 收持仓只收 `name + code + 可选 cost_price(单价)`
- **不收数量、金额、仓位价值**(用户隐私,系统不存)
- 收现金时只收一个汇总数字,不收账户明细
- 收仓位上限时只收百分比或文字描述,不收持仓金额

如果用户主动说"我持有 1000 股赣锋锂业成本 70 总共 7 万",**只存 name=赣锋锂业, cost_price=70**,其余丢弃并在回复中告知"数量和金额不存,这是你的隐私"。

## Persistence Rules

| 资源 | 落盘方式 |
|------|----------|
| 持仓 holdings | service tool `/api/sandbox/portfolio/add`(走 SQLite + workspace 双写) |
| 自选 watchlist | service tool `/api/sandbox/watchlist/add` |
| 交易预案 stock_plans | service tool `/api/sandbox/plans/set` |
| 风格包 / 自定义风格 | workspace/config/strategy.yaml(profile + rules) |
| 通知偏好 | workspace/config/notification.yaml |
| 决策边界 | workspace/config/decision_policy.yaml |
| 投资方法 | workspace/knowledge/methods/*.md |
| 方法变更记录 | workspace/memory/method_changes.jsonl |

任何 long-term state 写入前,先输出结构化草案等用户确认。

## State Tracking

每个用户 workspace 的 `config/onboarding.yaml` 末尾会被 Codex 追加 `current_state`:

```yaml
current_state:
  level: "quick_30s"  # 或 standard_3m / advanced
  completed_steps: ["holdings", "style_pack", "notification"]
  pending_steps: []
  last_advanced_at: "2026-06-22T19:30:00+08:00"
```

下次进入驱动式 onboarding 时,先读 `current_state` 判断从哪一步继续。

## 不该做的事

- 不要把 advanced 设成日常对话的前置条件
- 不要在用户没说"配置"时主动推 onboarding
- 不要直接写 yaml 绕过 WorkspaceStore / service tool
- 不要追问数量 / 金额 / 仓位价值
- 不要把风格包选择做成必答题——用户说"先不选"也允许,记 `selected_style_pack: null`
- 不要 silently 写方法文件——必须先草案再确认
