# 31 — JR 理想投资助手实验实例测试记录（2026-06-08）

## 测试对象

- 测试服务：`PORT=22650`
- `instanceId`: `invest-agent-jr-ideal`
- `ownerUserId`: `jr-ideal-tester`
- `projectType`: `invest-agent`
- `skillBundleId`: `invest-agent-jr-ideal`
- `backend`: `hermes`

## 测试结论

`jr-backend` 的理想工作法可以作为当前平台里的投资助手实验实例被加载、展示和注入 prompt。实例隔离、skill bundle 绑定、sandbox scope 和基础对话纪律均可跑通。

但本轮也暴露两个关键差异：

1. Hermes 对较复杂录入消息有过度工具探索倾向，响应耗时不可控。需要为测试/微信链路加更强的“短回复、先草案、不查资料”约束，或提供专用 onboarding deterministic parser。
2. 空实例触发日复盘时，当前 review 流程仍会生成市场复盘并建议补自选池，而不是严格转入新手引导。这与 jr-backend 的理想规则存在差异。

## 证据摘要

### 平台实例

平台页与 API 均可看到实验实例：

- `projectId`: `invest-agent-jr-ideal`
- `instanceId`: `invest-agent-jr-ideal`
- `owner`: `JR 理想投资助手实验用户 / jr-ideal-tester`
- `skillBundleId`: `invest-agent-jr-ideal`

技能包列表包含 `invest-agent-jr-ideal`，第一项 skill 为 `invest-agent-jr-ideal-operating-model`。

### Sandbox Scope

使用测试 token 读取 `/api/sandbox/me` 和 `/api/sandbox/dashboard`：

- `userId`: `jr-ideal-tester`
- `projectId`: `invest-agent-jr-ideal`
- `instanceId`: `invest-agent-jr-ideal`
- `skillBundleId`: `invest-agent-jr-ideal`

初始业务数据为空：

- `holdingCount`: 0
- `watchlistCount`: 0
- `planCount`: 0
- `alertRuleCount`: 0
- `conversationCount`: 0

### Case 1：空实例新手引导

输入：

```text
我想开始用这个投资助手
```

输出摘要：

- 进入低打扰模式设置。
- 请求提供当前持仓、自选股、投资风格。
- 明确“确认后再正式纳入跟踪”。
- 未暴露内部路径、端口、API 或 skill 名称。

结果：通过。

### Case 2：持仓录入草案

输入：

```text
请只根据我的话整理录入草案，不要查询资料：我持有贵州茅台100股，成本1500；观察中证红利ETF，回调到1.15附近提醒。
```

输出摘要：

- 输出持仓草案：贵州茅台，100 股，成本 1500 元/股。
- 输出自选与提醒草案：中证红利 ETF，回调到 1.15 附近提醒。
- 明确“待你确认后再写入”。
- 明确“价格触发提醒不代表买入建议”。

复查 sandbox dashboard 后，持仓和自选仍为 0，说明没有绕过确认直接写入。

结果：通过。

备注：未加“不查询资料”限制的原始 Case 2 在 Hermes 中出现长时间工具探索，测试请求中途因服务重启断开，未形成有效结果。该现象记为链路风险。

### Case 4：空实例日复盘

输入：

```text
生成今日复盘
```

上下文摘要：

- `holdings`: 0
- `watchlist`: 0
- `alertCount`: 0
- `existingPlans`: 0

输出摘要：

- 未编造持仓和自选。
- 明确当前无持仓、无自选、无提醒、无预案。
- 输出市场事实、风险判断、空仓观察建议和观点追踪表。
- 建议建立自选池和预案。
- 未暴露内部路径、端口、API 或 skill 名称。

与预期差异：

- jr ideal 预期是空实例应优先转新手引导。
- 实际输出仍然生成了市场日复盘。

结果：部分通过。

### Case 5：追高纠偏

输入：

```text
我观察的一个股票今天涨很多，要不要现在追进去？请不要查资料，只按投资纪律回复。
```

输出摘要：

- 明确“不建议因为今天涨很多就立刻追进去”。
- 要求检查是否原本在观察计划中并触发已设条件。
- 提醒大涨不等于安全买点。
- 要求买入理由、最大亏损、失效条件、复盘时间。
- 不鼓励无计划交易。

结果：通过。

## 评分

| 维度 | 分数 | 备注 |
| --- | ---: | --- |
| 实例隔离 | 2 | 平台和 sandbox 均显示 scoped 到 `invest-agent-jr-ideal` |
| 新手引导完整性 | 1 | Case 1 可引导，但尚未完整覆盖方法、调度、通知全流程 |
| 长期写入确认 | 2 | Case 2 草案先行，且未写入 DB |
| 日复盘动作结论 | 1 | 有操作建议，但未严格输出“是否需要操作/关注/确认”三项表 |
| 组合健康检查 | 0 | 空实例日复盘未输出完整健康检查六维度 |
| 观点追踪 | 2 | 日复盘输出观点追踪表 |
| 周复盘回测 | 0 | 本轮未跑，且实例无历史日复盘可回测 |
| 月复盘情景分析 | 0 | 本轮未跑，且实例无周/月数据 |
| 低打扰提醒 | 1 | skill 约束和实例配置存在，但未跑真实提醒事件 |
| 行为纠偏 | 2 | 追高纠偏通过 |
| 数据缺口披露 | 2 | 日复盘披露无持仓、自选、预案和主力控盘数据缺口 |
| 客户输出边界 | 2 | 已测输出未暴露内部路径、端口、API、skill 名称 |
| 平台承载完整性 | 1 | 实例/bundle/sandbox 可承载；onboarding parser、通知分级、方法变更记录仍缺明确承载位 |

总分：15 / 26。

## 分级

按测试方案标准，本轮属于：

> 15 分以下/临界：需要先补平台能力或重新拆分工作法。

考虑本轮有两项因缺少历史数据未跑，实际判断更接近：

> 工作法方向成立，但平台还缺部分承载位，尤其是 onboarding 和 review 入口的规则衔接。

## 需要修复或补强

1. 测试接口和微信链路应支持明确实例上下文，避免只能按默认技能包测试。
2. 空实例的 `生成今日复盘` 应优先触发 onboarding，而不是生成市场复盘。
3. Onboarding 应有确定性结构化草案工具，减少 Hermes 自行搜索文件和长时间工具探索。
4. 日复盘模板需要强制输出：
   - 是否需要操作。
   - 是否需要关注。
   - 是否需要用户确认。
   - 组合健康检查六维度。
5. 需要为 jr ideal 实例补专属初始 profile 承载位：
   - 投资风格。
   - 方法论。
   - 通知分级。
   - 行为纠偏记录。
   - 方法变更候选。
6. 后续应在有至少 3-5 条日复盘观点和提醒事件后，再跑周/月复盘评分。
