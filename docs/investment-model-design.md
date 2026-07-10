# 投资模型设计(第一版)

> Status: v1 lightweight container, 2026-06-24

## 1. 背景

Invest Agent 的用户不是来分别维护一堆零散配置项,而是来把自己的投资模型放进系统里,让系统帮助执行、复盘和迭代。

因此 onboarding 和后续配置入口应从"投资风格 / 选股方法 / 交易策略"收敛为"配置投资模型"。选股方法、交易策略、风控规则和复盘规则仍然存在,但它们是投资模型的组成部分,不是用户心智里的多个并列入口。

## 2. 产品定义

投资模型是一套从选股到交易、复盘、交易结束的完整闭环:

- 选股:什么股票值得进入观察或持仓范围。
- 买入:什么位置或条件允许初始买入。
- 加仓:什么确认信号允许追加投入。
- 卖出/退出:什么情况证明原判断失效。
- 风控:什么情况禁止操作或必须降级处理。
- 复盘:事后如何验证模型是否被正确执行、是否有效、是否需要修改。

交易预案的主要出处是投资模型。交易策略是投资模型内部的执行模块,用于描述"在什么条件下做什么"。

## 3. 第一版原则

- 每个用户默认有一个 `user-default` 投资模型。
- 用户没有显式指定模型时,新方法、新策略、新预案都归属默认模型。
- 第一版不重构数据库,投资模型保存在 workspace `config/investment_models.yaml`。
- 第一版不删除 `trading_strategies.yaml`;交易策略继续作为可复用执行规则存在。
- 第一版先做组合容器和确认草案,不急于做模型绩效统计。
- 用户自由描述一整套想法时,Agent 应先整理成投资模型草案,等待确认后再写入。

## 4. Workspace 承载

路径:

```text
workspace/config/investment_models.yaml
```

示例:

```yaml
default_model_key: user-default
models:
  - key: user-default
    name: 默认投资模型
    status: active
    orientation:
      primary_basis: hybrid
      selection_basis: business_logic
      entry_basis: valuation
      add_position_basis: technical_confirmation
      exit_basis: logic_break_first
    methodology_refs: []
    trading_strategy_refs: []
    selection:
      rules: []
    entry:
      rules: []
    add_position:
      rules: []
    exit:
      rules: []
    risk:
      rules: []
    review:
      rules: []
      validation_questions: []
```

## 5. 与现有概念的关系

| 概念 | 第一版定位 |
| --- | --- |
| `investment_models.yaml` | 主对象,组合选股、交易、风控、复盘闭环 |
| `knowledge/methods/*.md` | 方法论细节与用户级 skill overlay 的来源 |
| `trading_strategies.yaml` | 模型内部可复用执行策略 |
| `stock_plans` | 单只股票的落地预案,未来应引用 `investment_model_key` |
| `method_change_candidates` | 模型或方法的候选修改,通过复盘验证后再确认 |

## 6. Onboarding 入口

冷启动时应引导用户配置投资模型,而不是让用户分散配置多个概念:

1. 选择默认投资模型模板。
2. 逐步配置选股、买入、加仓、卖出、风控、复盘规则。
3. 自由描述自己的投资想法,由 Agent 拆成模型草案并等待确认。

## 7. 渐进路线

### v1: 模型容器

- 模板新增 `config/investment_models.yaml`。
- `WorkspaceStore` 支持读写删除投资模型。
- 用真实交互审计复核模型配置场景，并将稳定方法论沉淀到 workspace Skill。

### v2: 预案来源上移

- 个股交易预案引用 `investment_model_key`。
- "策略 → 预案"改为"投资模型 → 预案,策略作为执行模块引用"。
- 第一道闸门从策略匹配升级为模型匹配。

### v3: 复盘验证

- 日/周/月复盘检查每次操作符合哪个模型。
- 复盘区分"模型错误"和"执行偏离"。
- 方法候选经过验证后升级为模型修改建议。
