# 34 — JR 方法参考层决策

## 背景

`jr-backend` 的强项是把投资助手的工作法文档化：低打扰、强确认、日/周/月复盘闭环、观点追踪、行为纠偏和方法进化。

在当前 Invest Agent 平台中继续原样运行这套文档工作区，会和已有架构产生重复：

- `jr-backend` 有 `config/knowledge/memory/reports`。
- Hermes 有自己的对话记忆和 skill 调用。
- Invest Agent 有 SQLite、Strategy Skill 实例展开、Profile 兼容摘要、sandbox、trace、Dashboard/Workbench、微信推送和保存的 review artifacts。

如果三套机制同时承担“长期策略、记忆和报告沉淀”，系统会很难判断哪个是真相源。

## 决策

采用方案 B：把 JR 降级为方法论参考层。

JR 不再作为一个完整运行框架进入 Invest Agent。它只提供可迁移的投资工作纪律：

- 低打扰盯盘。
- 强确认写入。
- 日/周/月复盘闭环。
- 观点追踪和回测。
- 风险雷达。
- 用户行为纠偏。
- 方法改进候选，而不是自动改方法。

## 单一事实源

运行时事实按以下优先级处理：

1. 当前实例服务数据：持仓、自选、预案、提醒、复盘、观点、审计和推送状态。
2. Strategy Skill 的受保护骨架和已确认/待处理的实例展开候选。
3. Profile 运行时兼容摘要，例如旧接口兼容字段、偏好摘要和路由残留；不承载新的方法论职责。
4. 项目方法论文档。
5. Hermes 对话记忆，仅作为对话连续性和短中期上下文。
6. JR 参考材料，仅作为质量标准和工作纪律。

Hermes 记忆或任意对话中如果出现会改变投资风格、通知策略、买卖规则、仓位规则或方法论的内容，不能直接当成正式策略；必须转成实例展开草案，并经确认后进入 `method_change_candidates`，不得静默修改受保护的 Strategy Skill 骨架。

## 对现有实验实例的影响

`invest-agent-jr-ideal` 保留为实验样本，但语义从“JR 理想投资助手实验实例”调整为“JR 方法参考实验实例”。

它的作用不是证明 JR 文件工作区能原样跑通，而是验证：

- JR 方法纪律能否融入当前 Invest Agent。
- Strategy Skill 实例展开候选是否足以承载用户策略和方法进化。
- Hermes 记忆、skill、Profile 兼容摘要、服务数据之间是否仍然存在冲突。

## 后续原则

- 不恢复 JR 文件工作区作为运行时存储。
- 不让 skill 文本承载可变用户策略。
- 不让 Hermes 记忆覆盖 confirmed strategy skill instance expansion。
- 不让 AI 自行写入长期投资状态。
- 保留 Strategy Skill instance expansion candidate、method change candidate、viewpoint tracking 和 sandbox audit 作为平台承载层；Profile 只保留兼容摘要。
