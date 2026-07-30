# 交易策略当前契约

本文件区分已实现的交易策略实体、预案关联与产品交互红线。历史方案和未实现的推荐/起草工作流见
[`archive/trading-strategy-design-pre-consolidation-2026-07-28.md`](./archive/trading-strategy-design-pre-consolidation-2026-07-28.md)。

## 已实现的数据模型

策略实体存于：

```text
workspace/config/trading_strategies.yaml
```

单项字段：

| 字段 | 必需 | 含义 |
| --- | --- | --- |
| `key` | 是 | Workspace 内稳定标识 |
| `name` | 是 | 用户可见名称 |
| `applicability` | 否 | 适用条件 |
| `body` | 否 | 策略纪律与执行说明 |
| `enabled` | 否 | 是否启用 |

`stock_plans.strategy_key` / `strategyKey` 是指向策略 key 的软引用。删除策略不会级联删除预案；读取或审计层应将孤儿引用暴露出来，而不是静默改写历史预案。

`WorkspaceStore` 提供策略读取与写入。兼容 sandbox HTTP 路由提供 list/set/remove，其中写入服从当前 scope、确认和资源锁契约。MCP 或其他入口若增加相同能力，必须复用同一确定性服务语义。

## 策略与预案的边界

- 策略是可复用的方法与纪律；预案是面向具体股票的一次实例化结果。
- 预案可以记录策略来源，但不能因策略后来变化而自动覆盖已有预案。
- 策略文本不能替代行情事实、风险披露或用户确认。
- 系统不保存仓位上限、持仓金额、持股数量或时间约束时，不得在结构化预案中伪造这些字段。

## 策略预案两道闸门

用户要求“用 X 策略给 Y 股票出预案”时：

1. 先确认策略，并用 2-3 句解释为什么匹配该股票，等待用户确认。
2. 用户确认后，输出 `support`、`resistance`、`target`、`stopLoss`、`notes` 草案。
3. 再次等待用户确认后才允许落库。

即使用户已经指定策略名，也不能在第一条回复中直接起草预案。若策略 key/name 在当前 Workspace 不存在，先说明未找到，并询问是按用户口述新建，还是改用已有策略；不得临时编造“通用策略”。

这项交互纪律属于当前产品契约。服务层仍必须独立执行写入确认，不能只依赖 Skill 文本。

## 当前未实现能力

以下内容在历史设计中出现过，但没有代码证据表明已成为当前产品能力：

- 自动为股票推荐策略的 `recommend_strategy_for_stock`；
- 自动从策略生成预案的 `draft_stock_plan_from_strategy`；
- 持仓录入或日复盘后自动触发完整策略推荐流程。

实现这些能力前，应重新核对当前 MCP、Workspace Skill 与确认边界，不能直接按归档路线图施工。

## 权威实现

- `src/lib/workspace-store.ts`
- `src/lib/workspace-plan-backend.ts`
- `src/lib/sqlite-plan-backend.ts`
- `src/routes/sandbox.ts`
- `src/mcp/service-tools-core.ts`
- `src/db/schema.ts`

验证策略实体或预案关联变更时，运行相关单元测试、sandbox/MCP smoke 和 `npm run verify`；具体脚本以 `package.json` 为准。
