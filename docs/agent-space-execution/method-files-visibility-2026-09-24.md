# 策略相关文件的显性化清单（owner 审阅稿 v2）

日期：2026-09-24。状态：**边界已由 owner 两次裁决冻结；本地隔离环境（primary）已按最终口径执行并验证**。dyk/mg 本地副本与种子源固化待 owner 确认后执行；生产不在本稿范围。
v2 修订：按 owner 2026-09-24 对边界原则的纠正重排（见 §0），推翻 v1 中"系统支撑不显性化"的划法。

## 0. 边界原则（owner 口述纠正，冻结为判定依据）

**不是"系统提供的就不给看"，而是：**

> 凡是系统提供、注入运行、**用户有可能自己定义并生效**的上下文，都要给用户看，并明确标注"这是系统提供的"。
> 只有用户**不需要管、不会管、也不能管**的系统机制，才隐藏。

参照「我的 Skills」的既有实践：6 个系统自带技能里只隐藏了 automation-task-designer（任务设计机制，用户通过自动化 UI 管任务，不直接管技能正文）；其余 5 个领域技能（基本面/技术面/宏观/风控/候选筛选）全部给用户看，标"系统自带"。因为用户完全可能有自己的玩法并要求生效。

对应的判定问句：**"这份文件塑造模型的投资判断吗？用户会不会想按自己的偏好改它？"** 两个都答"是"→ 给看 + 标注；都答"否"（纯系统机制）→ 隐藏。

## 1. 判定矩阵

### 1.1 给用户看（第一档：用户自己的内容，无需"系统提供"标注）

| 用户 | 文件 | 事实 | 现状 | 动作 |
| --- | --- | --- | --- | --- |
| mg | `methods/strategy-rules.md` | 无模板源头，mg 版独立字节；W7 决策 hold（D2） | **不可见**（唯一真正看不见的用户策略文件） | 导入文件夹，标「策略」；可见 ≠ 运行采用 |
| mg | `methods/控盘度综合评分.md` | 用户方法（D1 已采用的正文资产） | 可见，散在「未分类」 | 挪入文件夹 + 打标 |
| mg | `methods/控盘度指标V1.0.md` | 用户方法（D3 历史定位） | 不可见 | 导入，标「技术面」，来源注「历史定位」 |
| dyk | `methods/strategy-rules.md` | dyk 版独立字节（D4 撤回语义） | 可见，散在「未分类」（W7 正文资产） | 挪入文件夹 + 打标 |
| 111 | `methods/strategy-rules.md` | 111 版独立字节（D6 拆分中） | 已在「我的方法」（9-23 导入） | 保留 + 打标 |

### 1.2 给用户看（系统模板类：打「系统模板」标签，badge 渲染，不写进文件名）

| 用户 | 文件 | 事实 | 动作 |
| --- | --- | --- | --- |
| mg/dyk/111 | `assets/migrated/knowledge/methods/` 四件套（fundamental/technical/macro/risk.md） | 系统模板源头在 `templates/workspace/knowledge/methods/`；分化情况：mg 分化 2 件（fundamental、technical）、dyk 分化 2 件（risk、fundamental）、111 四件全部为模板原字节、macro 三用户均未分化 | **全部副本给看**：名称保持干净（「基本面分析方法」等），由 `user_assets.tags` 打「系统模板」标签，portal 文件列表渲染徽章。`策略规则` 是用户自己的内容，明确不打此标 |

标签实现（2026-09-24 已落地本地）：`user_assets.tags`（TEXT，JSON 字符串数组，additive migration `ensureColumn`）；服务层 `setUserAssetTags`/`createUserAsset(tags)`；连接器描述符透传；portal「我的文件」文件行渲染「系统模板」徽章。标签是展示语义，不是安全边界。

### 1.3 隐藏（owner 两次裁决后：系统机制与用户不会改的配置，全部不给用户看）

| 类别 | 事实 |
| --- | --- |
| `AGENTS.md` | 运行环境提示词——与被隐藏的 automation-task-designer 同性质 |
| `assets/migrated/knowledge/*.md` 协议 7 份（decision_protocol、watch_protocol、selection_protocol、source_audit、privacy_and_tenant_isolation、capability_extension_protocol、product_metrics_protocol） | 系统方法论协议。**owner 2026-09-24 裁决：不给用户看**（用户看不懂、也不会去改）；协议本身是否可靠可用另立任务评估（本地 primary 曾短暂导入过一套供审阅，已删除） | 不导入；评估任务见 OS 任务 |
| `assets/migrated/config/*.yaml` 策略行为配置 5 份（observation_pool、selection、risk_taxonomy、decision_policy、style_packs；mg 另有 decision_evolution） | **owner 2026-09-24 二次裁决：同样不给用户看**（实际上用户也不会改这些）；曾导入本地供审阅，已删除 | 不导入 |
| 系统运维 config：`data_contracts` / `evidence_policy` / `interaction_policy` / `mvp` / `onboarding` / `paths` / `privacy` / `product_metrics` / `skills` / `sources` / `tenant` / `daily_review_template` / `weekly_review_template` | 工程契约、隐私租户、引导流程、路径、产品度量、调度模板——用户不改、改了也不该生效 |
| `memory/`、`schemas/`、`src/`、`templates/`、`tools/` 及 `._*` 垃圾文件 | 运行机制与垃圾 |
| legacyWorkspace（上一代 `workspaces/<user>/` 全部，含旧 `config/strategy.yaml` 64 项） | 8-17 后无运行时读者，考古层整体不动，另行归档 |

### 1.4 已可见、无需动作

三用户既有可见资产（mg=85、dyk=61、111=69，含每日复盘/表格/附件/mg 控盘度公式文档系列）：已在「我的文件」，后续只支持打标，不重复导入。

## 2. 与既有体系的关系（不改变的口径）

- 本次显性化**只创建/移动用户可见资产**：不改 agent_space 装配、不做采用、不碰 W7 冻结的三用户运行口径。
- W7 方法正文底座就是 user_asset 版本（contentRef 按 versionId 引用），挪文件夹不影响引用链。
- 「我的方法」降级为普通文件夹；**owner 2026-09-24 裁决：工作空间「我的方法」聚合页明确移除废弃，落点=「我的文件」的原生文件夹视图（已验证 17 项在本地方块的 /assets 页正常可见）**；工作空间路由与聚合组件的代码移除另立改动。
- 标签是筛选辅助，不是运行语义；"文件被哪个任务/方法引用"靠引用查询呈现。
- "系统提供"标注是信息，不是锁：用户可以编辑第二档文件（走既有工作副本/新版本流），编辑后的版本链留在用户资产里。

## 3. 待 owner 圈定的问题

1. ~~协议文档 7 份给看还是隐藏？~~ **已裁决（2026-09-24）：隐藏**；协议可靠性与可用性评估另立任务（OS T-544）。
2. ~~标注形态~~ **已裁决（2026-09-24 二次）：不用括号注记，改「系统模板」标签徽章**；已实现（`user_assets.tags` 字段 + portal 文件行徽章）。用户日后编辑带标文件时，标签是否追加"已修改"为后续小决策，推荐保留原标 + 追加徽标。
3. mg 的 `strategy-rules.md` 显性化 = 用户可见但不是运行采用（与 D2 解耦），确认无异议？
4. ~~文件夹名称沿用「我的方法」，还是更直白（如「我的策略文件」）？~~ **已裁决（2026-09-24）：「我的策略文件」**；surface 脚本与本地 primary 已按此口径执行（旧文件夹已改名，脚本幂等）。
5. ~~策略行为配置 5 份 yaml~~ **已裁决（2026-09-24 二次）：同样隐藏**（用户实际上也不会改）。

## 4. 确认后的执行口径（预告，未执行）

本地隔离环境先行（111 → dyk → mg）：按 §1.1 导入/挪入 + §1.2 导入/标注 + 打标；导入前按 sha256 对该用户全部可见版本去重；全部动作留审计与指纹记录。生产执行另行申请，不在本稿范围。
