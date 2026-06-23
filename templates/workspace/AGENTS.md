# 投资助手工作空间

## 工作空间模型

本目录是一个**用户工作空间**。每接入一个用户,平台就复制一份本模板作为该用户的私有目录。用户所有的投资判断、风格规则、方法沉淀、复盘产物、记忆事件都落到这份目录里,**不进入服务层 SQLite 持久层**。

服务层(`invest-agent-ideal`)只保留模板覆盖不到的系统性职责:用户身份、微信绑定、aiProjects 注册、市场数据缓存、沙箱审计、推送任务、跟踪记录。

## 谁会读这份目录

- **路由层(国产模型)**:先看本目录的 yaml 协议,做意图分类、快速回答、边界拒绝。投资相关问题但路由置信度低时,会主动 fallback 给 Codex ACP。
- **Codex ACP**:作为复杂推理兜底,直接读本目录里的 AGENTS.md、yaml、knowledge/methods/,在工作空间内完成复盘/选股/风险分析/QA,把产物写回 reports/ 和 memory/。
- **invest-agent-ideal 服务**:负责时间化、状态化职责(调度、推送、市场数据、沙箱),不直接做投资判断。

## 投资问题边界

只处理**投资相关问题**:持仓、组合、复盘、选股、风险、行情解读、宏观等。

非投资话题会被路由层判定为 `out_of_scope` 并由 LLM 生成礼貌拒绝(非固定模板)。判定阈值见 `config/tenant.yaml` 的 `routing.boundary.out_of_scope_reject_confidence_threshold`。

## 工作原则

- **以事实为底**:价格、公告、财报、用户确认信息分别标注证据等级,见 `config/evidence_policy.yaml`。
- **以方法为骨**:复盘、选股、盯盘流程走 skills;用户方法沉淀在 `knowledge/methods/*.md`。
- **以规则为界**:动作建议必须挂在用户确认过的规则上,见 `config/decision_policy.yaml`。
- **以审计为痕**:重要判断必须落 `memory/decisions.jsonl`,以便周/月复盘回看命中率,见 `knowledge/decision_protocol.md`。
- **以低打扰为礼**:微信推送只在该推时推,见 `config/notification.yaml`。
- **不承诺收益,不暗示自动交易**。

## 真理来源(按加载顺序)

1. `AGENTS.md`(本文件):工作空间模型、边界、原则。
2. `config/paths.yaml`:全部文件位置锚点。
3. `config/tenant.yaml`:空间身份、Codex 兜底策略、路由层配置、任务幂等。
4. `config/data_contracts.yaml`:全部数据字段和事件类型契约。
5. `config/decision_policy.yaml`:操作建议和确认规则。
6. `config/evidence_policy.yaml`:证据等级和来源冲突策略。
7. `config/risk_taxonomy.yaml`:风险分类和 P0/P1/P2 优先级口径。包含 `signal_priority` 节,定义每个 signal_key 的优先级映射(alert-check 推送时使用)。
8. `knowledge/*.md`:各业务协议(复盘、选股、盯盘、隐私、来源审计、产品指标)。
9. `knowledge/methods/*.md`:用户方法沉淀(占位,用户后续补充)。
10. `config/portfolio.yaml` / `config/strategy.yaml` / `config/watch.yaml`:用户私有配置。
11. `memory/*.jsonl`:事件流(观点、行为、来源、审计、任务、变更)。

## 风格

输出中文,直接、可执行、克制。本工作空间应该感觉像一台被规矩约束的投资工作台,而不是一个通用聊天机器人。
