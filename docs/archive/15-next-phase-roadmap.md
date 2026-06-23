# 15 — 下一阶段路线图

> 创建于 2026-05-28。本文档是当前迭代的总计划入口，覆盖已完成工作和待办事项。
> 历史优先级和旧 Runtime 交接见 `docs/archive/14-project-handoff.md`，归档技术方案见 `docs/archive/tech-plan.md`。

---

## 本次迭代已完成（2026-05-27 ~ 05-28）

### 确定性服务能力扩展

| 能力 | 状态 | 说明 |
|------|------|------|
| `query_monitor_overview` | 已完成 | 聚合持仓、自选、提醒、预案、事件、巡检间隔 |
| `set_alert_rule` / `query_alert_rules` / `remove_alert_rule` | 已完成 | 支持目标价、支撑价提醒，股票名称解析 |
| `set_alert_interval` | 已完成 | 巡检间隔持久化到 settings 表，运行时动态调整 |
| `query_signal_config` / `update_signal_config` | 已完成 | 14 个系统信号统一管理，开关 + 参数可调 |
| `/api/reviews/daily` / `/api/reviews/query` | 已完成 | 复盘数据收集和 artifact 入口；复盘方法后续优先由 skill 驱动 |
| `query_stock_plan` / `set_stock_plan` / `remove_stock_plan` | 已完成 | 交易预案自然语言管理，支持股票名称解析 |

### 复盘闭环

- 复盘输出直接发给用户（不再提文件路径）
- 无预案股票自动输出建议（基于 K 线估算支撑/压力位）
- 有预案但价位偏移超 2% 输出调整建议

### Bug 修复

- 旧 Runtime 中 `lastMentionedStocks` 查询操作不更新 → 已在历史阶段修复；当前旧 Runtime 已删除
- 记忆被 alert 字段（indicator/threshold）污染 → `buildNextMemory` 清洗
- 复盘缓存返回旧数据 → 用户主动触发时 `force: true` 重新生成

### Dashboard 可操作看板

- `GET /api/dashboard` 聚合 API（含资金流数据）
- `GET /dashboard` 深色主题自包含 HTML（Tailwind CDN + 原生 JS）
- 模块：概览卡片、持仓池、自选池、交易预案、提醒规则、信号配置、提醒事件（按推送批次分组）、最近复盘、资金流向数据
- **可操作**：持仓/自选/预案/提醒/信号/巡检间隔全部支持网页端 CRUD

### 东方财富资金流接入

- `src/services/eastmoney.ts`：主力/超大单/大单/中单/小单净流入（并发限制 5）
- 资金流信号接入巡检（主力净流入、超大单净流入超阈值触发）
- Dashboard 展示持仓/自选股当日资金流向
- Dashboard 和巡检信号保留资金流；日复盘暂不纳入资金净流入分析

### Runtime Trace 历史

- `agent_traces` 表是旧 Runtime 阶段的历史追踪表，保留数据但不作为当前 Codex + skills 主链路的追踪方案。

### Codex + Skill 主链路增量进展（2026-06-01 ~ 06-03）

- 选股问答已拆为主 Skill + 行业/公司价值/护城河/技术位置/风险等子 Skill。
- 选股问答的代码级关键词路由已删除，改为由 Codex 根据 Skill 说明自主判断调用路径。
- 微信日复盘已切为异步流程：先回执“生成中”，再由服务托管 Codex 生成并回推结果。
- 提醒去重已从“价格感知冷却 + 每股每日上限”扩展为状态型去重，避免同一止损/破位信号按巡检频率重复推送。
- 自选池术语已统一：持久化池仅保留 `持仓池` 和 `自选池`。

### Codex ACP 主链路、Hermes 可选后端与平台化增量进展（2026-06-05）

- Codex ACP 是当前主智能后端；Hermes 后端链路保留为可选 backend adapter，并已具备 launchd 自恢复、健康检查、日志路径和 `npm run smoke:hermes-service` smoke 覆盖。
- 客户输出边界已通过 `npm run smoke:customer-output` 覆盖，防止微信最终回复泄露 localhost、端口、API、内部组件、路径、token 或调试信息。
- `/platform` 已能总览 AI 项目、manifest、skill bundle、runtime/profile 兼容配置、tools、permissions、resource types、trace、audit 和 push queue 摘要。
- 周/月复盘 context 已上线：`/api/reviews/weekly-context`、`/api/reviews/monthly-context` 及 sandbox 版本可提供提醒统计、日复盘覆盖和结构化观点统计。
- 日复盘已能解析“观点追踪表”和“上一轮观点回测”，将观点写入 `review_viewpoints` 并回写 `validated / invalidated / pending` 状态。
- 盘前推送已接入最近日复盘摘要，包含昨日复盘要点、今日观察重点和 AI 生成的今日关注。
- Hermes 专项真实使用验收清单已沉淀为 [28-hermes-project-weixin-acceptance-checklist.md](./28-hermes-project-weixin-acceptance-checklist.md)，当前主路径验收以 Codex ACP、sandbox、Strategy Skill 和项目隔离为准。

### Code Review 修复

- XSS 修复（dashboard-page.ts：esc() 重写 + escapeHtml 包装）
- 11 个 POST 端点添加 safe() 错误处理
- plans/set 值=0 时正确处理（`??` → `!== undefined`）
- getCapitalFlowBatch 并发限制（worker pool，max 5）
- 空 catch 块添加日志、id 类型校验

---

## 待办计划

### ~~阶段二：Dashboard 可操作~~ — 已完成

### ~~阶段三：数据增强~~ — 已完成（资金流）

### 阶段四：复盘 / 选股 Skill 化

**目标**：复盘和选股问答的判断流程沉淀到 `.codex/skills`；服务只提供确定性数据、artifact 保存和推送能力。

| 编号 | 任务 | 优先级 | 状态 | 说明 |
|------|------|--------|------|------|
| D4-1 | 复盘模板可配置 | 中 | 已完成 | 模板存 settings 表，7 个章节开关 + 关注重点 + 自定义要求 |
| D4-2 | 删除旧 Runtime 主链路 | 高 | 已完成 | 删除 `src/agent/*`、`src/router/*`，避免两套脑子并存 |
| D4-3 | 盘前预案推送优化 | 低 | 已完成 | 盘前推送已接入最近日复盘摘要，包含昨日复盘要点 + 今日观察重点 |
| D4-4 | 提醒降噪 | 中 | 已完成 | 价格变化感知冷却(<1%不重复) + 每股每日上限8条 + 状态型提醒去重 |
| D4-5 | 日复盘 skill 驱动 | 高 | 进行中 | 服务已托管上下文注入、异步生成、保存和推送；复盘上下文已补上一份复盘摘要、结构化待追踪观点、状态回写和实例作用域 |
| D4-6 | 选股问答 skill 驱动 | 高 | 进行中 | 主 Skill + 多个子 Skill 已落地；Codex 自主分流，不走代码关键词路由 |
| D4-7 | 高频确定性 API 清单 | 中 | 暂缓 | 当前先搭闭环，不把更多确定性数据 API 作为前置条件；后续按真实高频需求补 |
| D4-8 | Codex ACP 可审计日志 | 高 | 已完成 | 当前 Codex ACP 主链路和 Hermes 可选后端链路已写入结构化 trace，平台后台可查看详情，sandbox token 只记录 tokenId/权限且 prompt 脱敏 |
| D4-9 | 客户输出边界加固 | 高 | 已完成 | 已加强客户文本清洗规则并新增 smoke，覆盖 localhost、端口、curl、API/admin/acp 路径、内部组件名、日志、文件路径、执行命令和 token |
| D4-10 | 复盘 Skill 质量迁移 | 高 | 进行中 | 已开始迁移 `jr-backend` 的观点追踪纪律：新增 `review_viewpoints`，日复盘可回写观点状态，周/月复盘 context 可统计观点状态、提醒和复盘覆盖 |
| D4-11 | 主力控盘数据源调研 | 中 | 已完成调研 | 结论见 `docs/20-main-force-control-data-research.md`；短期只做最后一节，不用资金净流入替代控盘 |
| D4-12 | 自定义指标/提醒/预案设计与地基 | 高 | 进行中 | 设计见 `docs/21-custom-indicator-alert-design.md`；已新增指标表、新版提醒规则表、只读指标接口、旧提醒镜像、预案观察条件接口和巡检指标快照，旧巡检保持兼容 |
| D4-13 | Hermes 可选后端链路实验 | 中 | 进行中 | 已创建本机 `invest-agent` Hermes Profile 兼容配置；launchd 自恢复、日志路径和健康检查已有 `smoke:hermes-service` 覆盖，真实使用验收清单见 28 号文档。该项不承载投资方法论 |

### 阶段五：新用户引导

**目标**：新用户首次打开 Dashboard 有引导流程。

| 编号 | 任务 | 优先级 | 状态 | 说明 |
|------|------|--------|------|------|
| D5-1 | 首次配置向导 | 低 | 待做 | 引导添加持仓/自选、设置预案、配置关注信号 |
| D5-2 | 使用示例提示 | 低 | 待做 | Dashboard 侧边栏展示"你可以这样跟 Agent 说话" |

### 阶段六：多 AI 项目平台化

**目标**：把当前 Codex ACP 主链路、Hermes 可选后端链路、sandbox、push queue、多实例隔离等能力上移为“多 AI 项目运行平台”。投资助手是第一个 project type，后续可以承载饮食管理、会议纪要、个人知识库等互不干扰的 AI 项目。

设计与执行文档：

- 架构共识：[24-ai-instance-platform-architecture.md](./24-ai-instance-platform-architecture.md)
- Registry 与 manifest 设计：[25-ai-project-registry-and-manifest.md](./25-ai-project-registry-and-manifest.md)
- 分阶段执行计划：[26-ai-project-platform-execution-plan.md](./26-ai-project-platform-execution-plan.md)

| 编号 | 任务 | 优先级 | 状态 | 说明 |
|------|------|--------|------|------|
| D6-0 | 文档语义冻结 | 高 | 已完成 | 明确 AI Project 是产品隔离单位，`instance_id` 是当前工程兼容字段 |
| D6-1 | Project Type Manifest 常量 | 高 | 已完成 | 已新增 `invest-agent` project type manifest，Dashboard API 和 sandbox context 可读取默认 skills、tools、权限和 dashboard 类型 |
| D6-2 | Project Registry Helper | 高 | 已完成 | 已新增 `AiProjectRuntimeContext`，Dashboard 当前项目和默认项目创建已改为从 registry helper 获取 |
| D6-3 | 平台项目列表 API | 高 | 已完成 | 已新增 `/api/platform/projects` 和 `/api/platform/projects/:projectId`，返回项目运行摘要且不返回投资业务明细 |
| D6-4 | 旧 handler project scope 收敛 | 高 | 已完成 | 已收敛持仓、自选、预案、提醒、监控、复盘和定时入口的主要 `userId + instanceId` 查询/写入路径 |
| D6-5 | 历史数据归位 | 中 | 已完成 | 已备份数据库，并通过幂等迁移将非 primary 用户历史数据从主实例归位到各自默认实例 |
| D6-6 | Platform Dashboard 雏形 | 中 | 已完成 | 已新增 `/platform` 管理页，可总览 AI 项目、通道、追踪、推送、审计、manifest、skills、tools、权限和资源类型 |
| D6-7 | Tool Registry 与权限收束 | 中 | 已完成 | 已新增 Tool Registry，并让 sandbox API 按 tool id 校验 project type allowedTools 与 token permissions |
| D6-8 | 饮食推荐助手演示项目 | 中 | 已完成 | 已新增 `diet-recommendation` project type、共享实例 `diet-recommendation-shared`、饮食推荐 skill 和 `/admin/diet-weixin` 项目微信绑定页，支持多微信用户绑定同一项目 |
| D6-9 | AI Project 分发模型 | 高 | 已完成需求 | 需求见 `docs/29-ai-project-distribution-requirements.md`；明确投资助手走独享实例分发，饮食推荐助手走共享实例多用户绑定 |
| D6-10 | Platform 创建投资助手实例 | 高 | 待做 | 在 Platform 新增创建独享投资助手实例的 API 和表单 |
| D6-11 | Instance-aware 微信绑定 | 高 | 待做 | 微信二维码生成必须明确绑定到选中的 project instance，而不是只按 backend 推断 |

### 已归档执行计划

以下文档已从“当前入口”移动到 `docs/archive/`，只保留历史参考：

- [archive/19-skill-loop-hardening-plan.md](./archive/19-skill-loop-hardening-plan.md)：Skill 闭环加固计划，核心结果已进入 D4-8/D4-9/D4-10。
- [archive/22-multi-user-data-isolation-plan.md](./archive/22-multi-user-data-isolation-plan.md)：多用户数据隔离前置计划，核心结论已并入 sandbox 和平台架构。
- [archive/27-in-progress-acceleration-queue.md](./archive/27-in-progress-acceleration-queue.md)：集中推进队列已阶段完成，结果已并入本文和 28 号验收清单。

---

## 优先级排序建议

1. ~~**文档同步**~~ — 已完成
2. ~~**阶段二 Dashboard 可操作**~~ — 已完成
3. ~~**阶段三 数据增强**~~ — 已完成
4. ~~**D4-4 提醒降噪**~~ — 已完成（价格感知冷却 + 每股每日上限）
5. ~~**D4-1 复盘模板可配置**~~ — 已完成
6. ~~**D4-2 删除旧 Runtime 主链路**~~ — 已完成
7. ~~**D6-1 Project Type Manifest 常量**~~ — 已完成，投资助手已成为明确 project type
8. ~~**D6-2 Project Registry Helper**~~ — 已完成，Dashboard 当前项目和默认项目创建已从 registry 取上下文
9. ~~**D6-3 平台项目列表 API**~~ — 已完成，平台项目运行摘要接口已可用
10. ~~**D6-4 旧 handler project scope 收敛**~~ — 已完成，主要业务 handler 和定时入口已按实例 scope 收敛
11. ~~**D6-5 历史数据归位**~~ — 已完成，旧测试数据已从主实例归位到各自默认实例
12. ~~**D6-6 Platform Dashboard 雏形**~~ — 已完成，平台后台和投资助手业务看板已初步拆开
13. ~~**D6-7 Tool Registry 与权限收束**~~ — 已完成，sandbox API 已接入服务端 tool-level 权限校验
14. ~~**D4-8 Codex ACP 可审计日志**~~ — 已完成，平台后台可查看 ACP trace 详情并排查异常回复
15. ~~**D4-9 客户输出边界加固**~~ — 已完成，客户输出边界已有自动 smoke 覆盖
16. **D4-5 日复盘 skill 驱动** — 继续把客户最常用输出做到稳定、可审计；当前已补上一份复盘/结构化观点追踪/状态回写上下文
17. **D4-10 复盘 Skill 质量迁移** — 已开始吸收 `jr-backend` 的观点追踪纪律，周/月复盘 context 已能消费结构化观点统计
18. **D4-6 选股问答 skill 驱动** — 已进入持续打磨阶段
19. **D4-7 高频确定性 API 清单** — 暂缓，后续按真实高频需求补
20. **D4-11 主力控盘数据源调研** — 已完成调研，后续先做低置信代理指标原型
21. **D4-12 自定义指标/提醒/预案设计** — 已完成设计，后续可进入数据模型改造
22. ~~**D4-3 盘前推送优化**~~ — 已完成，盘前推送包含最近复盘要点和今日观察重点
