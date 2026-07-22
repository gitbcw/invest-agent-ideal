# CLAUDE.md

本文件为 Claude Code 在本仓库内工作提供工程上下文。

本文件职责：集中记录可执行的工程事实，包括命令、环境、运行时架构、关键文件、API、数据库说明和本地操作。产品原则与投资输出红线写在 `AGENTS.md`；文档导航写在 `docs/README.md`；最快速的架构地图是 `docs/system-overview.md`。

## 项目概述

微信入口的 AI 投资决策助手。实验分支当前采用极简主链路：微信消息解析出用户、用户助手和 workspace 后，直接转发给在该 workspace 中运行的当前 ACP 后端，默认 Codex。当前产品语义是一用户一助手一 workspace；代码和数据库中的 `instanceId` / `instance_id` 只作为内部兼容与隔离键，不代表用户门户里可选择多个实例。服务层不再做普通微信消息的分流、快车道、onboarding 包装、复盘意图识别或上下文包拼装。本项目保留确定性能力：数据库、Platform 本地管理入口、行情数据、巡检、提醒、sandbox/API、落库和微信推送。Dashboard 已退役(2026-07-16),`/dashboard` 仅作为到 `/platform` 的 301 重定向保留,兼容期结束后移除。

## 常用命令

```bash
npm run dev          # 开发模式（tsx watch）
npm run build        # TypeScript 编译
npm run verify       # typecheck + 单测 + Agent 上下文检查 + 隔离 contract smoke
npm start            # 运行编译产物
npm run smoke        # 构建 + 运行 smoke 测试
npm run db:generate  # Drizzle 迁移文件生成
npm run db:migrate   # 执行数据库迁移
npm run smoke:mcp-service-tools  # 验证 Codex ACP 服务层 MCP 工具(读 + 第一批确认写)
npm run smoke:onboarding-draft-commit  # 验证 onboarding 草稿确认、冻结提交与重试
npm run smoke:platform-partner-auth    # 验证 Platform 账号、角色和 Partner 脱敏边界
npm run smoke:platform-partner-migration # 验证 Platform 账号数据迁移
```

本地管理入口：`http://localhost:22655/platform`（含用户助手、规则巡检审计、日志审计、数据源质量、成本统计、实例级微信连接；实例详情含投资状态摘要）。Platform 是内部管理面：Owner 有授权管理能力，Partner 仅可查看脱敏经营与质量摘要。
健康检查：`curl http://localhost:22655/health`
Dashboard 已退役;`/dashboard` 仅作为到 `/platform` 的 301 重定向保留。

本地只保留 `22655` 作为默认 invest-agent-ideal 服务端口。`22648` / `22652` 不应再作为本项目默认启动端口使用。

火山云运维端口约定：

- 火山云 `invest-agent` runtime 内部监听 `127.0.0.1:22655`，不作为普通用户门户。
- 本机访问火山云 Platform 使用 SSH tunnel：`ssh -L 22648:127.0.0.1:22655 claude@118.145.115.197`，然后打开 `http://127.0.0.1:22648/platform`。
- 火山云用户门户公网入口是 `http://118.145.115.197:22649/login`，由独立项目 `invest-agent-portal` 提供。
- 本机 `22649` 不用于 Platform tunnel，避免和火山云公网门户端口混淆。

## 项目专属 Skills

本仓库的工程/运维操作型知识放在项目内 `.codex/skills/`，不要迁到全局 skill 目录。普通当前事实仍在 `AGENTS.md`、本文件和 `docs/`；可重复执行的操作流程优先看对应 skill：

- `.codex/skills/volcano-ops`：火山云部署、回滚、生产健康与迁移。
- `.codex/skills/scheduler-push-debug`：定时复盘、盯盘、规则巡检、推送队列和微信 delivery 排障。
- `.codex/skills/service-api-change`：sandbox、portal、MCP、Platform 和服务 API 变更。
- `.codex/skills/db-migration`：SQLite schema、迁移、回填和表归属。
- `.codex/skills/invest-eval`：基于真实交互和服务审计的评估与问题归因。
- `.codex/skills/onboarding-flow-eval`：Onboarding 连续主流程运行、日志审计、workspace 落库检查和问题归因。
- `.codex/skills/screening-flow-eval`：选股、候选风险扫描、观察池写入和候选转自选的真实流程评估。
- `.codex/skills/eval-instance-cleanup`：评测结束后检查或永久清理保留的评测用户与 workspace。
- `.codex/skills/local-runtime-restart`：重启并验证本地 `22655` 端口的 PM2 托管运行时。

## 环境配置

复制 `.env.example` 为 `.env`。数据库为 SQLite，路径 `./data/invest-agent.db`。微信消息进入智能后端时由服务直接启动 workspace-scoped ACP 子进程，不需要单独手动启动 ACP HTTP endpoint。

Workspace 默认根目录**不是**仓库内的 `./data/workspaces`。当前默认值来自 `src/lib/config.ts`，会解析到 `../../my-data/projects/invest-agent-ideal/workspaces`，即本机通常对应 `/Users/combo/MyFile/my-data/projects/invest-agent-ideal/workspaces`。只有显式设置 `WORKSPACE_ROOT` 时才覆盖。排查“workspace 是否创建”时，请先看运行时 `WORKSPACE_ROOT`，不要只看仓库内 `data/workspaces/`。

微信桥接状态默认保存在本项目 `./.state/openclaw-weixin/`，也可通过 `INVEST_AGENT_WEIXIN_STATE_DIR` 覆盖。不要让本项目和全局 Claude Code 微信桥接共用同一个 `~/.openclaw` 登录态目录。

ACP 默认使用 `complex` 模型档位。`simple` 档位暂时关闭，只有显式设置 `ACP_SIMPLE_MODEL_ENABLED=true` 时才允许模型路由器选择 `CODEX_SIMPLE_MODEL`；否则聊天、onboarding 和定时 ACP 任务都走 `CODEX_COMPLEX_MODEL`。sandbox token 生产环境应显式配置 `INVEST_AGENT_SANDBOX_SECRET`；本地开发若未配置，会使用 `data/.sandbox-secret` 作为持久 secret，避免服务进程和评测进程验签不一致。

> **运行时语义纠正(2026-06-30)**：当前默认使用 Codex ACP 作为 workspace 后端承接。Hermes 仅保留为兼容/实验 backend；历史 `codex_acp_traces` 表名仅作为兼容存储保留。

## 架构：消息处理主链路

```
用户微信消息 → weixin-agent-sdk → InvestAgentMobileBridge
  → 解析 user / assistant(instanceId) / workspace
  → AcpAgent.handleMessage()
  → workspace-scoped ACP session(cwd = 用户 workspace)
  → Codex 使用 workspace 的 AGENTS.md + .codex/skills 进行推理和工具调用
  → Codex 只通过 invest-agent-service-tools MCP 调用确定性服务能力
  → 响应返回微信
```

主动提醒反向链路：`scheduler/index.ts` 每分钟扫描 workspace 的 `config/watch.yaml` / `config/schedules.yaml` → 命中后调用 workspace-scoped ACP backend 执行巡检或复盘 → 触发后通过微信推送队列发送。

> **2026-06-23 范围收缩**：本项目定位明确为“少数几个投资客户的精品投资助手”，不再承载多产品 AI 平台、饮食推荐、旁路桥、对话草案或多 bundle 抽象。WP A1+A2+A3+C 全部收尾:
> - 主链路微信桥只剩 `InvestAgentMobileBridge`（主桥）；`backend==="codex"` 是当前默认运行时后端标识
> - `src/platform/` 简化为 `project-registry.ts`（实例查询）+ `tool-registry.ts`（sandbox 工具白名单），不再有 project-type manifest / skill-bundle catalog
> - 技能说明以 workspace 模板中的 `AGENTS.md` 和 `.codex/skills` 为准；服务层不再注入固定 skill-bundle prompt
> - `/platform` 当前保留为轻量用户助手管理与微信运维入口；复杂平台化抽象仍已删除，`src/routes/platform.ts` 主要负责用户助手查询、workspace ensure 和助手级 weixin 管理
> - DB 表 `ai_projects` / `ai_instances` / `investment_profiles` / `conversation_tasks` 保留作考古，数据不迁出

> **2026-06-28 阶段一验收更新**：
> - 主用户助手 `invest-agent-primary` 已完成一轮真实验收
> - `POST /api/testing/scheduler/trigger` 可立即触发 `daily-review` / `market-watch`
> - `daily-review` 已真实推送到主用户手机
> - `market-watch` 在无异常时已正确返回 `NO_PUSH` 并记为 `skipped`

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/acp/agent.ts` | ACP 入口；微信消息只添加最小通道上下文，并代理到 workspace-scoped ACP 后端 |
| `src/acp/stdio-agent.ts` | stdio ACP 托管器；微信直通路径使用按 workspace cwd 隔离的 ACP 会话 |
| `src/routes/watch-rules.ts` | 阶段二明确规则 HTTP adapter(原 dashboard.ts 内重复定义已迁出) |
| `src/mcp/invest-agent-service-tools.ts` | Codex ACP 会话挂载的 stdio MCP server；不依赖 shell 网络 |
| `src/mcp/service-tools-core.ts` | MCP 工具实现核心，复用服务层后端和 facade 并记录审计 |
| `src/services/deepseek.ts` | DeepSeek API 封装，支持 light（flash）和 deep（pro+thinking）两种模式 |
| `src/services/stock.ts` | 腾讯行情 API：实时报价、日 K、股票搜索 |
| `src/services/stock-resolver.ts` | 股票名称/代码模糊解析 |
| `src/services/eastmoney.ts` | 东方财富资金流 API：主力/超大单/大单净流入 |
| `src/services/indicators.ts` | L1 技术指标算子：MA/EMA/MACD/KDJ/BOLL/RSI/WR/OBV（参数化，可独立调用） |
| `src/services/chip-distribution.ts` | L1 筹码分布算子：`computeChipDistribution`/`winner`（reliability=experimental） |
| `src/services/rule-expression.ts` | L3a 安全表达式解析器：tokenizer + 递归下降，禁 eval/Function/函数调用语法 |
| `src/services/composite-indicator-engine.ts` | L3a 规则树引擎：YAML 加载、combine 四模式（and/or/majority/weighted_sum）、阈值表达式求值 |
| `src/services/script-indicator-engine.ts` | L3b 沙箱引擎：isolated-vm 隔离区 + esbuild 编译缓存 + 64MB/5s 熔断 |
| `src/services/sandbox-runtime.ts` | L3b helpers 桥（白名单 L1 算子导出给沙箱，无 Node API 依赖） |
| `src/handlers/signal-config.ts` | 信号配置工具：14 个系统信号（含资金流信号、盘中放量滞涨/滞跌）开关和参数管理 |
| `src/handlers/review.ts` | 复盘工具（`handleReviewTool`）：日/周复盘生成，含资金流数据和预案调整建议 |
| `src/db/schema.ts` | 全部 Drizzle 表定义：settings、watchlist、portfolio、alertRules、stockPlans、chatHistory、dailyPlans、alertEvents、tradeActions、agentTraces(legacy `alerts` 表 2026-07-16 已 drop) |
| `src/scheduler/alert-check.ts` | 规则巡检执行器：只执行 stage2 watch_rules / `alert_rules.relation_to_plan=stage2_watch_rule`，按采样当刻行情/K 线/预案事实写入 alert events / signal states / indicator results |
| `src/scheduler/index.ts` | 定时任务调度：market-watch 定时简报、rule-alert-check 独立规则巡检、复盘、数据质量汇总 |
| `src/routes/portal.ts` | 用户门户本地调试 API：权威对话日志健康检查、会话列表、会话详情、网页消息入口 |
| `src/portal/connector.ts` | 云端用户门户 Relay 的本地 connector：注册、心跳、会话列表、会话详情和聊天转发 |
| `src/services/conversation-log.ts` | 权威对话日志：`conversation_sessions` / `conversation_messages` 读写，以及网页消息进入 workspace ACP |
| `src/admin/platform-page.ts` | 本地 Platform 前端(用户助手、规则巡检、日志审计、数据源质量、实例级微信连接、投资状态摘要) |

## 服务保留的确定性能力

这些能力应保留在本项目中，供 Platform、巡检和当前 workspace ACP 工具调用使用。

**Codex 服务层 MCP 工具：**
- `invest-agent-service-tools` 在 `session/new` 时由 `src/acp/stdio-agent.ts` 挂到 Codex ACP 会话。
- 读取工具：`market.snapshot`、`market.quote`、`market.kline`、`market.indices`、`market.capital_flow`、`market.sector_theme`、`market.stock_info`、`market.resolve`、`market.calendar`、`market.health`、`portfolio.read`、`watchlist.read`、`plans.read`、`watch_rules.catalog/list/validate/dry_run`。
- 确认工具：`confirmations.pending`、`confirmations.request`；前者读取当前会话待确认项，后者在询问用户前登记精确写入草案。
- 确认写入工具：`onboarding.confirm_portfolio`、`onboarding.confirm_step`、`watchlist.add`、`plans.set`、`plans.watch_conditions`、`method_changes.propose`、`watch_rules.create`。用户下一轮明确确认后，调用时必须同时带服务端签发的 `confirmationId` 和 `confirmedByUser: true`；确认绑定 scope、operation、payload，且只能消费一次。
- `onboarding.complete_watch_setup` 是流程收口工具：用户明确跳过首次规则，或本会话内所有指定规则已分别确认创建并有成功审计后，直接完成 onboarding，不再要求“确认完成”。
- `reviews.save` 允许 scheduled daily-review 由 Agent 主动发布完整 Markdown `content`、独立微信 `pushBrief` 和可选 `decisionRecords` / `sourceEvents`，是当前唯一不要求交互式 confirmation record 的写入例外。服务层只负责忠实保存、索引和审计，不再把 Agent 最终微信回复自动当作完整报告。删除、关闭、主动推送、强制调度暂不开放为 MCP 写工具。
- 生产/部署 smoke：`npm run smoke:mcp-service-tools`，会验证 stdio MCP 协议、工具列表、行情快照和 watch-rule 校验。

**持仓与自选：**
- `query_holding_pool` / `add_holding_stocks` / `remove_holding_stocks`
- `query_watchlist` / `add_watchlist_stocks` / `remove_watchlist_stocks`

**监控与提醒：**
- `query_monitor_overview`：聚合监控全貌
- `GET /api/watch-rules/catalog` / `POST /api/watch-rules` / `PATCH /api/watch-rules/:id` / `DELETE /api/watch-rules/:id`：阶段二明确规则盯盘 API（服务层主通路），当前 catalog 包含 `price_cross`、`ma_cross`、`macd_cross`、`kdj_cross`、`rsi_threshold`、`boll_break`、`wr_threshold`、`volume_ratio`、`near_plan_level`
- `GET /api/platform/rule-alerts`：Platform 的独立规则巡检审计视图数据源
- `set_alert_interval`：规则巡检采样间隔调整（分钟，持久化，默认 5 分钟）

**微信投递可观测性：**
- `weixin_delivery_attempts`：记录 scheduler 推送和 Platform 手动探测的结果、失败分类、最近入站时间与间隔；用于实测微信会话/context 的有效窗口。
- `GET /api/platform/instances/:instanceId/weixin/status`：除连接状态外返回 `delivery`，含最近入站和近期投递样本。
- `POST /api/platform/instances/:instanceId/weixin/push/test`：管理员显式手动探测；不会自动保活或静默向用户发送消息。

规则巡检当前语义：scheduler 在交易日按 `alert_check_interval_minutes` 形成采样点，执行 `rule-alert-check`；每次只用采样当刻可取得的最新价格/K 线/预案事实判断 stage2 watch_rules，不读取 legacy `alerts`，不回溯“盘中曾经触达”、不做收盘确认变体。market-watch 是定时简报/摘要任务，和 rule-alert-check 是两条独立调度线；若同一 scheduler tick 同时命中 market-watch 和规则巡检，规则仍记录事件，但单独规则推送会被压制，避免同分钟重复微信打扰。

**信号配置：**
- `query_signal_config` / `update_signal_config`：14 个系统信号开关和参数管理（price_change、near_support/resistance/target、stop_loss、breakout_with_volume、break_support、turnover、volume_ratio、macd、bid_ask_imbalance、capital_flow_main、capital_flow_super_large、volume_price_divergence）

**预案与复盘数据：**
- `query_stock_plan` / `set_stock_plan` / `remove_stock_plan`：交易预案管理(含可选 `strategyKey` 溯源字段)
- workspace Agent 通过 MCP `reviews.save` 保存定时复盘产物；复盘方法与输出纪律优先沉淀到 workspace skills。Dashboard 时代的 `/api/reviews/*` HTTP 聚合已删除。

**Onboarding 确定性能力：**
- 新版 workspace Agent 使用 MCP `onboarding.draft.get/upsert_step/request_confirmation/accept_step/enqueue_commit`；每一步确认只定稿服务层草稿，最后由后台 worker 按冻结快照统一写入并校验 Workspace。不得从模板或 skill 发现并调用 HTTP、token 或本地文件兜底。
- 旧 `onboarding.confirm_portfolio` / `onboarding.confirm_step` 和 HTTP adapter 仅保留给兼容调用；新版模板不得使用它们。
- MCP 和 HTTP 适配器复用 `src/services/onboarding.ts` 的校验和最终配置投影；草稿状态、确认、异步提交和通知由 `src/services/onboarding-drafts.ts` 管理。
- 以下 sandbox 路由仅保留给非 Agent 兼容调用和工程诊断：
- `GET /api/sandbox/onboarding/state`：读取当前 workspace onboarding 进度。
- `POST /api/sandbox/onboarding/confirm-portfolio`：用户确认持仓/观察仓草案后，一次性写入 `config/portfolio.yaml`，并把 `config/onboarding_state.yaml` 推进到 `current_step=style`。
- `POST /api/sandbox/onboarding/confirm-step`：确认 `style`、`review_schedule`、`market_watch_schedule`、`notification`、`watch_rules` 等步骤，写入对应 workspace 配置并记录 `sandbox_audit_logs`。

**交易策略实体（第一版）：**
- `workspace/config/trading_strategies.yaml` 存放用户多份策略（每份含 key/name/applicability/body/enabled）；与 `strategy.yaml`（整体投资风格）平级，不合并。workspace 模板不内置示例，由用户或 workspace ACP backend 自建。
- workspace Agent 通过 MCP 确认工作流管理策略与预案；旧 `/api/strategies*` Dashboard CRUD 已删除。`/api/sandbox/strategies/*` 仅是非 Agent 兼容适配器，不应写入 workspace prompt 或 skill。
- `stock_plans.strategy_key` 是策略 → 预案的溯源软引用（可空，策略删除不级联清理）。
- 策略推荐和预案起草按 `AGENTS.md` 的“策略预案起草”流程执行，两道闸门（策略匹配 + 预案起草），不做 AI 自主落库。
- 复盘流程**不感知策略实体**

**选股问答：**
- 选股推理由 workspace skills 承载，服务层不内置固定 skill。
- 服务只保留未来需要高频复用的确定性数据 API，例如行情、资金流、持仓/自选上下文和股票解析。

## Platform / 领域 HTTP adapter

Dashboard 退役后,投资数据修改只能通过用户对话 + MCP 确认流程;Platform 仅提供只读摘要和运维入口。HTTP adapter 列表:

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/watch-rules/catalog` | GET | 查询阶段二明确规则目录 |
| `/api/watch-rules` | GET/POST | 查询或创建阶段二明确规则 |
| `/api/watch-rules/:id` | PATCH/DELETE | 更新或删除阶段二明确规则 |
| `/api/watch-rules/:id/dry-run` | POST | 对单条阶段二明确规则做 dry-run |
| `/api/watch-rules/default-scope` | GET | 查询当前请求默认 userId/instanceId scope |
| `/api/platform/instances/:instanceId/investment-state` | GET | 紧凑只读投资摘要(持仓/自选/预案/规则/最近复盘) |
| `/api/platform/rule-alerts` | GET | Platform 规则巡检运行记录、规则、事件审计 |
| `/api/platform/source-quality` | GET | Platform 数据源质量和服务层数据源告警 |
| `/api/sandbox/snapshot` | GET | Bearer sandbox token 保护的实例投资摘要；权限名 `invest.snapshot.read`，仅供兼容调用和工程诊断 |

旧 Dashboard CRUD(`/api/portfolio*`、`/api/watchlist*`、`/api/plans*`、`/api/strategies*`、`/api/alerts/set|toggle|remove`、`/api/signals/update`、`/api/interval/set`、`/api/acp-backends*`、`/api/reviews/*` 旧聚合、`/api/indicators*`、`/api/users*`、`/api/dashboard`)已于 2026-07-16 随 Dashboard 一并删除。投资数据写入请使用 MCP 确认工作流,不再提供绕过对话的 HTTP CRUD。

全局 `/api/weixin/status|connect/start|listener/start|connect/stop|push/test` 已删除。管理端微信操作只使用实例级 `/api/platform/instances/:instanceId/weixin/*`；`/admin/weixin` 暂时仅 301 到 `/platform#instances`。

本地隔离验收可设置 `INVEST_AGENT_OFFLINE_MODE=true`。该模式禁用微信恢复、Portal connector、Platform 微信 listener、ACP、scheduler 和 push queue worker，只保留 HTTP 服务与本地路由，已有到期 push job 也不会被处理。

## 用户门户本地边界

用户门户是独立云端入口，本仓库只提供本地运行时、权威对话日志和 connector。不要把 `/platform` 改造成公网用户门户。

| 端点/命令 | 说明 |
|------|------|
| `GET /api/portal/health` | 本地 portal 能力健康检查 |
| `GET /api/portal/conversations` | 查询权威对话日志会话列表 |
| `GET /api/portal/conversations/:conversationId` | 查询会话消息 |
| `POST /api/portal/conversations/:conversationId/messages` | 写入网页用户消息并调用 workspace ACP 生成回复 |
| `npm run portal:connector` | 启动本地 connector，主动连接云端 Relay |
| `npm run smoke:portal-conversation-log` | 权威对话日志 / portal 本地接口烟测 |

相关环境变量：`PORTAL_RELAY_URL`、`PORTAL_CONNECTOR_TOKEN`、`PORTAL_USER_ID`、`PORTAL_INSTANCE_ID`、`PORTAL_ASSISTANT_ID`、`PORTAL_PROJECT_ID`、`PORTAL_CONNECTOR_ID`、`PORTAL_CONNECTOR_DISPLAY_NAME`、`PORTAL_CONNECTOR_REFRESH_MS`。

## 数据源

| 数据 | 来源 | 说明 |
|------|------|------|
| 实时行情 | 腾讯行情 API | 最新价、涨跌幅、成交量、换手率 |
| 日 K 线 | 腾讯行情 API | 120 日历史，计算 MA/MACD/量比 |
| 资金流向 | 东方财富 emdatah5 | 主力/超大单/大单/中单/小单净流入 |
| L1 筹码分布 | 自研近似模型 | `src/services/chip-distribution.ts` 提供 `computeChipDistribution` / `winner`（reliability=experimental，需走告知协议）；workspace 沙箱脚本示例已移除，需要时由用户或 workspace ACP backend 自建 |

数据源决策见 `docs/data-source-policy-decision.md`：MVP 默认市场数据现金预算为 0 RMB/年，本地可靠数据服务优先，AI 外部搜索只作为补充证据，无法取得可追溯来源时必须明确说明数据缺口。服务级数据源遥测与质量报告位于 `data/source-telemetry/` 和 `data/source-quality/`，不写入用户 workspace。

## 复合指标系统（5 层）

服务侧 L1 算子、L3a/L3b 引擎和告知协议门禁完整保留在 `src/services/`，workspace 模板不内置示例 yaml/ts，需要时由用户或 workspace ACP backend 在 workspace 内自建。完整 RFC 见 `docs/composite-indicator-system.md`。

| 层 | 形态 | 落点 | 适用 |
|---|---|---|---|
| L1 | 技术指标算子（MA/EMA/MACD/KDJ/BOLL/RSI/WR/OBV/chipDistribution/winner） | `src/services/indicators.ts` + `chip-distribution.ts` | 标准指标 + 参数 |
| L2 | 系统信号 | `src/handlers/signal-config.ts`（14 个）+ 巡检 | 标准触发条件 |
| L3a | 规则树复合（YAML） | workspace `config/composite_indicators.yaml`（用户自建） | 标准信号 + 标准算子的布尔/加权组合 |
| L3b | 沙箱脚本（isolated-vm） | workspace `scripts/indicators/<key>.ts`（用户自建） | 循环/递归/多源融合 |

新建复合指标时，先判断能否用 L1/L2 标准能力表达；无法表达再走 L3a 规则树；仍无法表达（需要循环、递归或多源融合）再走 L3b 沙箱。

**告知协议（强制）**：experimental 算子 / 数据源缺失 / 经验系数 / 建仓决策依据，必须让用户显式确认后才能写入 `user_acknowledged: true`。校验门禁在 `src/services/indicator-acknowledgement.ts`。

**冒烟测试**：`npm run smoke:indicators`（L1 算子）/ `smoke:composite-indicator`（L3a 引擎）/ `smoke:script-indicator`（L3b 引擎）/ `smoke:indicator-acknowledgement`（告知协议）。

**缓存清理**：`npm run cache:clear-indicator`（默认 dry-run 30 天，加 `-- --apply` 实际删除）。


## 设计原则

1. 不恢复旧关键词路由，也不恢复或扩展自研 Agent 运行时。
2. Workspace-scoped Codex 是对话总控。invest-agent 只做确定性查询、落库、巡检和推送。
3. 用户不需要记指令，不需要提供股票代码。股票名称通过 `stock-resolver` 解析。
4. 不确定时追问；能从上下文判断时不多余确认。
5. 投资输出必须说明不确定性，不承诺收益，不自动交易。
6. 定性推理和工作流应沉淀到 workspace 模板的 `AGENTS.md` 与 `skills/`，由 workspace-scoped ACP backend 在 workspace 内读取。
7. `agent_traces` 是旧运行时历史表，可保留数据，不作为当前对话追踪方案。

## 数据库

SQLite + Drizzle ORM。`src/db/index.ts` 负责初始化，内含 `CREATE TABLE IF NOT EXISTS` 和 `ALTER TABLE` 增量迁移。`settings` 表是 KV 存储，存储以下内容：
- `signal_config` — 14 个信号配置 JSON
- `alert_check_interval_minutes` — 巡检间隔（默认 5 分钟）
- `review_template`、复盘推送时间等服务配置

`conversation_sessions` / `conversation_messages` 是用户门户和微信共享的权威对话日志，本地 SQLite 是权威源，云端门户只做镜像。`agent_traces` 表仅作为旧运行时历史记录保留。

## 文档

产品文档在 `docs/` 目录，以 `docs/README.md` 为唯一导航入口；新手先读 `AGENTS.md`、`CLAUDE.md`、`docs/system-overview.md`。SQLite 表归属划分（服务层 / 工作空间 / 丢弃 三类）见 `docs/table-ownership.md`。历史重构计划、DeepSeek 分流、快车道、旧运行时交接和平台化设计都在 `docs/archive/`，仅作考古使用，不作为当前实现依据。

评估体系以 Agent/Skill 驱动：workspace Skills、当前上下文和真实服务审计是质量基线。语义判断由执行评估的 Codex 与用户完成；确定性代码只守护稳定服务契约。Platform 不承载评测功能。
