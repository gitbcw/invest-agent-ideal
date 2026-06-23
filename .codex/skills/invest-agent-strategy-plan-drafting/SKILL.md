---
name: invest-agent-strategy-plan-drafting
description: Use when the user asks to draft or adjust a trading plan based on a strategy. Translates "用 X 策略给 Y 出预案" into a two-gate confirmation flow - first matching the right strategy, then drafting the plan. Reads trading_strategies.yaml via invest-agent service tools, drafts plan values that the user must confirm before any write.
---

# Invest Agent Strategy Plan Drafting

## Purpose

把"基于交易策略起草预案"这件事规范成**两道闸门**:

1. **策略匹配**:基于个股上下文,从 `trading_strategies.yaml` 里挑出最适用的 1 份 + 1-2 份备选
2. **预案起草**:基于选中的策略 + 行情 + 持仓上下文,产出 support/resistance/target/stopLoss/notes 草案

两次起草的产出都**不直接落库**,必须经过用户确认。这与产品红线"AI 不做自主落库"对齐。

## Required Context

Read first:

1. `AGENTS.md`
2. `docs/trading-strategy-design.md`(尤其是 §5 触发流程、§7 复盘边界声明)
3. 当前用户 workspace 里的 `config/strategy.yaml` 和 `config/trading_strategies.yaml`

调用 invest-agent 服务工具(见 `invest-agent-service-tools` skill):

- `GET /api/sandbox/strategies` — 读全部交易策略(只读 yaml)
- `GET /api/sandbox/dashboard` — 取持仓/自选/预案上下文
- 腾讯行情 API — 取最新价、近 20 日 K 线(已有的 stock 工具)

## Workflow

### 第一道闸门:策略匹配

输入 = 一只股票 + 当前上下文(行情、持仓角色、板块、波动率等可观察特征)。

判断维度:

1. **持仓角色**:长期持有 / 趋势仓位 / 短线交易 → 决定策略族
2. **趋势结构**:多头排列 / 震荡 / 下行 → 决定是否走突破逻辑
3. **波动率**:低 / 中 / 高 → 决定止损算法
4. **板块/市值**:蓝筹 / 成长 / 题材 → 决定持股周期
5. **策略 applicability**:与上述特征的匹配度

输出格式(必须遵守):

```markdown
## 策略推荐

**最适用**:[breakout-pullback] 突破回踩
**理由**:3-5 句话,引用上述 5 个维度的具体观察

**备选**:
- [value-reversal] 价值反转 — 一句话理由
- [momentum-following] 动量跟随 — 一句话理由

请确认采用哪份策略,或回复"跳过"取消起草。
```

### 第二道闸门:预案起草

输入 = 用户确认的策略 + 个股行情 + 持仓角色 + (调整类)现有预案 + 当天变化。

元素提取规则:

- **support**:从策略正文里找"支撑""回踩不破""均线"等关键词 → 推导具体价位
- **resistance**:从"压力""目标""阻力"等关键词推导
- **target**:策略正文里如有 "+X%" 表达,基于进场价换算
- **stopLoss**:策略正文里如有 "-X%" 表达,基于进场价换算
- **notes**:策略 key + 简短引用策略正文关键约束(如"突破 20 日线 + 量比>1.5")

**关键纪律**:

- 策略正文里"通常""一般""视情况"等模糊措辞**保留**,不要改成精确数字
- **不承诺收益**:目标位是"如果策略成立,理论达到的位置",不是预测
- 数字必须基于可观察的当前行情(K 线、均线),不能凭空生成
- 起草后明确告诉用户这是草案,需要确认才落库

输出格式:

```markdown
## 预案草案(待确认)

基于 [breakout-pullback] 突破回踩策略:

- **支撑位**:**.__(20 日线)
- **压力位**:**.__(近期高点)
- **目标位**:**.__(进场价 +15%)
- **止损位**:**.__(进场价 -5%)
- **备注**:[breakout-pullback] 突破 20 日线且量比>1.5 时关注,回踩不破进场

请确认是否落库,或告诉我要调整哪一项。
```

### 用户确认 → 落库

只有用户**明确**回复"确认""就这样""落库"等表达后,才调:

```bash
curl -X POST http://localhost:22648/api/sandbox/plans/set \
  -H 'Content-Type: application/json' \
  -d '{
    "stockCode":"600036",
    "support":36.5,
    "resistance":40,
    "targetPrice":43,
    "stopLoss":33,
    "notes":"[breakout-pullback] 突破 20 日线且量比>1.5 时关注",
    "strategyKey":"breakout-pullback"
  }'
```

`strategyKey` 是溯源字段,落库后能在 Dashboard 看到。

## 不做的事(产品红线)

- ❌ 不自动迭代策略(系统不统计用户实际交易,没有客观命中率)
- ❌ 不批量自动起草(每只股票都要走两道闸门)
- ❌ 不绕过用户确认直接调 plans/set
- ❌ 不在预案里承诺收益或精确时间

## 触发场景

参考 `docs/trading-strategy-design.md` §5:

- 场景 A:用户刚新增持仓,系统提示"该股暂无交易预案",用户回复"出预案"
- 场景 B:日复盘后,系统在复盘报告末尾附"建议补全/调整预案"清单,用户选择某项
- 场景 C(兜底):用户直接说"用 X 策略给 Y 出预案"

所有场景最终汇入上面两道闸门流程。

## 与复盘的边界

复盘流程**不感知策略实体**(见 §7):

- 复盘不读 `trading_strategies.yaml`
- 复盘不改策略本体
- 复盘报告末尾的"建议补全预案清单"是**提示**,不是自动触发

如果未来要让复盘反哺策略,需要先解决"用户实际交易数据接入"的前置问题,届时另起 RFC。

## 模板示例

用户消息:"用突破回踩策略给赛轮轮胎出个预案"

Codex 行为(即便用户已指定策略名,**仍要走完两道闸门**):

1. 读 `/api/sandbox/strategies` 确认 `breakout-pullback` 存在
2. 读行情(K 线、量比、均线)和持仓上下文
3. **第一道闸门(不可跳过)**:向用户输出策略匹配说明
   - 确认采用 `[breakout-pullback] 突破回踩`
   - 用 2-3 句话解释为什么该策略匹配这只股票(引用持仓角色/趋势结构/波动率/板块特征)
   - 明确邀请用户确认("可以吗?确认后我起草预案")
4. **等用户回复确认**(不能在同一条消息里继续走第二道闸门)
5. 用户确认后进入**第二道闸门**:输出预案草案(support/resistance/target/stopLoss/notes)
6. 等用户对草案确认
7. 确认后调 `/api/sandbox/plans/set` 落库,带 `strategyKey: "breakout-pullback"`

如果用户说"出个预案"(没指定策略),第一道闸门还要多做一步:从 `trading_strategies.yaml` 里挑出最适用的 1 份 + 1-2 份备选,等用户选定。

**重要**:即便用户指定了策略名,也**不能**在第一轮回复里直接起草预案。必须先输出匹配说明 + 等确认。这是"双门流程"的硬约束。

## 预案字段边界(产品红线)

起草预案时**只**包含这 5 个字段:

- `support`(支撑位)
- `resistance`(压力位)
- `targetPrice`(目标位)
- `stopLoss`(止损位)
- `notes`(备注,引用策略 key + 关键约束)

**禁止**在草案或确认问题里出现以下内容(违反产品边界):

- ❌ 仓位上限 / 单票仓位比例 / 加减仓节奏
- ❌ 持仓金额 / 持股数量 / 总市值暴露
- ❌ 时间约束(如"持有不超过 X 天")— 策略正文里如果有时间措辞保留,但不要逼用户给具体天数
- ❌ 收益承诺 / "预计盈利 X%" / 胜率

这些字段系统**不存**,问了用户也填不进 `stock_plans` 表,只会让用户觉得你在引导操作。

如果用户主动追问仓位/金额,回复:"我只帮你记录每股的成本价(用于算浮亏比例),不存数量、金额、仓位价值。仓位决策由你自己掌握。"
