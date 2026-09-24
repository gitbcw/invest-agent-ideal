# T-537 P0 差距清单：现有实现 vs 用户资产管理与失败告知设计

状态：**T-537 盘点结论，作为 T-538~T-541 契约的直接输入。**
对照基准：[正式设计](../agent-space-user-product-design.md) §3~§9 与隔离环境实测（见 [T537-p0-baseline.md](./T537-p0-baseline.md)）。
标记：`无差距` / `部分差距` / `零基础`；归属任务列给出承接契约。

## 1. 数据与表结构

| # | 对象 | 现状 | 设计要求 | 差距 | 归属 |
| --- | --- | --- | --- | --- | --- |
| D1 | agent_space 25 张表（methods/skills/agents/basis/state 等） | schema 与服务层齐备（scope 三元组、版本、审计、批准机制），W7 后生产三用户灰度装配 | §4/§9 的 GUI 数据底座 | `无差距`（底座够用） | — |
| D2 | 111 的方法/Skill 行 | **空集**（methods 0、skills 0、installations 0；W7 技能面空集设计内）。容器内存在旧形态文件：`methods/strategy-rules.md`、6 个 `skills/*/SKILL.md` | 我的方法/我的 Skills 页面要有真实对象可呈现 | `部分差距`：需在隔离环境**构造**方法体系与 Skill 对象（经服务层 createMethod/upsertSkill，形成版本/采用/安装链），或经 owner 裁决把容器文件正式导入；生产导入不属于本批任务 | T-538 |
| D3 | attention_item 独立对象 | 不存在。只有 `automation_tasks.status='needs_attention'` 与 fulfillment `failed_needs_attention` | §7 服务拥有的失败事项事实（去重、恢复、审计、跨端投影键） | `零基础`：需新建服务层对象（建议轻量表 + 幂等键），不暴露状态机给用户 | T-539 |
| D4 | 通知偏好 | 不存在任何用户偏好存储 | §8 微信提醒开关/静默时段/可提醒类别 | `零基础`：新增偏好存储 + 读取路径（不改变任务事实） | T-539 |
| D5 | T-479 恢复通知策略 | `automation-notify.ts`：恢复（succeeded ∧ 上一条是 failure）会发微信恢复通知 | §7.2 成功与自动恢复默认不主动提醒 | `部分差距`：调整 `notifyAutomationRunTerminal` 决策器 + 回归测试（失败/连败/恢复/微信失败/Portal 可见性五场景） | T-539 |
| D6 | 问题处理会话标记 | conversation_sessions 无「问题处理对话」类型/绑定字段 | §7.3 携带失败事实引用的受限会话，不混入闲聊 | `部分差距`：会话表加轻量标记或独立绑定表（设计在契约里定） | T-540 |
| D7 | state candidate 的模型工具面 | 服务层 `createStateCandidate/reviseStateCandidate` 存在；**模型工具注册表未暴露**（T-536 盘点确认） | §9.3 端到端：Agent 能在会话/任务运行中提交 lesson/workflow 草案 | `部分差距`：需新增受控工具路径（scope/入口/事实引用校验），非仅服务函数 | T-540 |

## 2. 服务 API（runtime 侧）

| # | 面 | 现状 | 设计要求 | 差距 | 归属 |
| --- | --- | --- | --- | --- | --- |
| A1 | agent_space 对象 API（method/skill/state） | **零 HTTP/connector 面**（routes 与 connector 均无；portal.ts 仅 5 端点） | §P1 方法与 Skill 的认证、scope 强制读模型 | `零基础`：connector 协议新增 `method.*` / `skill.*` 消息类型 + 服务层调用 + 响应脱敏（不漏 scope/checksum） | T-538 |
| A2 | asset.* | 全套已有（list/versions/rename/archive/restore/references/convert） | §5 文件关联 | `部分差距`：数据面够，缺「被自动化引用/所属任务结果」聚合读模型（references 已有基础） | T-538（文件关联小升级） |
| A3 | automation.* | 全套已有（create/update/pause/runs 等，scope 服务端派生，响应 redact） | §6 任务详情四块 | `部分差距`：缺「目标/依赖产物/分层结果/关联失败」聚合读模型（run_outcomes、task_dependencies 数据已有） | T-539 |
| A4 | attention/失败告知 API | 无 | §7 待处理列表 + 失败卡片 + 假投递下的微信投影事实 | `零基础`：与 D3 同步设计 | T-539 |
| A5 | 通知偏好 API | 无 | §8 | `零基础`：与 D4 同步 | T-539 |
| A6 | 问题会话 API | conversation.* 已有；无失败绑定 | §7.3 | `部分差距`：与 D6 同步 | T-540 |

## 3. Portal 前端

| # | 页面/组件 | 现状 | 设计要求 | 差距 | 归属 |
| --- | --- | --- | --- | --- | --- |
| U1 | 侧栏导航 | chat/automations/assets 三入口 + 用户菜单；无集中导航数组（`Sidebar.tsx`） | §3 待处理 / 自动化 / 我的文件 / 工作空间（双 Tab）+ 设置 | `部分差距`：加「待处理」「工作空间」入口；导航重构为集中定义避免三页漂移 | T-538（入口+工作空间）/ T-539（待处理） |
| U2 | 工作空间页面 | 不存在 | §4 我的方法列表/详情（采用/Diff/历史/任务影响）+ 我的 Skills 两区块/详情 | `零基础`：新页面 + 两个 Tab + 详情路由 | T-538 |
| U3 | /assets 我的文件 | 列表/上传/预览/下载/文件夹/搜索/来源筛选已有；rename/归档/版本恢复/引用 API 有 UI 未接 | §5 关联信息（来源、被自动化读写、所属任务、方法/Skill 跳转） | `部分差距`：补关联区 + 接已有 API；不做二次编辑入口 | T-538 |
| U4 | /automations 详情 | 任务 CRUD/暂停恢复/运行历史/run 详情/失败会话续聊已有 | §6 四块：目标 / 依赖与产物（跳转）/ 执行·产物·投递分层 / 需要注意 | `部分差距`：详情页改造 + A3 聚合模型 | T-539 |
| U5 | 待处理页 | 不存在（automations 模块内有「需要处理」筛选） | §7 全局失败告知卡片 | `零基础` | T-539 |
| U6 | 通知偏好设置 | 不存在（设置页本身也不存在） | §8 设置页管理提醒偏好 | `零基础`：最小设置页 | T-539 |
| U7 | 问题处理对话入口 | 失败 run「在对话中继续」已有（续普通会话） | §7.3 绑定失败事实的受限会话 | `部分差距`：改为/叠加问题处理会话（带上下文引用与脱敏） | T-540 |
| U8 | 候选卡片（lesson/workflow 草案审阅） | 不存在 | §9.2 候选按来源分流展示（当前对话/失败会话/低优先级网页） | `零基础` | T-540 |
| U9 | 聊天右侧旧「工作空间」面板 | `DocumentWorkspace.tsx` + workspace/files API（只读树） | §3 后续移除；会话附件/报告预览需替代路径 | `部分差距`：T-541 出替代与移除方案，不在本批实现 | T-541 |

## 4. 关键实现约束（从盘点固化，契约直接引用）

1. **scope 永不由浏览器指定**：connector 从注册 scope 派生（`automation-api.ts` 模式），新 API 必须沿用；响应 redact 内部字段。
2. **版本/生效分离的服务端强制**：采用/安装/启用/改绑是显式服务动作（methods.ts/skills.ts 已有状态机），GUI 只是调用方。
3. **通知与任务终态解耦**：T-479 已有幂等键 + quiet 包装模式，D5 的策略调整不得改变失败事实与重试语义（回归测试证明）。
4. **候选不自动生效**：`approveStateCandidate` 是唯一生效口（state.ts），D7 新工具只能 create/revise。
5. **111 隔离环境的构造纪律**：所有测试数据经服务层 API 构造（形成真实版本链），不手写 agent_space 表行；不向真实用户推送（环境本身 OFFLINE 兜底）。
