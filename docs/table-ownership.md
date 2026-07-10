# SQLite 表归属划分

> Created: 2026-06-21(工作包 0c)
> 真理来源:本文件 + `src/db/schema.ts` + `templates/workspace/config/paths.yaml`

## 背景

理想形态下,每用户一份工作空间(由 `templates/workspace/` 复制而来),投资判断、风格规则、方法沉淀、复盘产物、记忆事件都落到工作空间内的 yaml/jsonl。当前产品语义是一用户一助手一 workspace；SQLite 中的 `instance_id` 继续作为内部兼容与隔离键，不代表用户产品层支持一用户多助手。SQLite 持久层只保留模板覆盖不到的**系统性、时间化、平台级**职责。

本文档定义每张表归属哪一层,作为后续工作包(3 协议层合并 / 4 SQLite 写入冻结 + jsonl 双写 / 5 自演进闭环)的依据。

## 三类归属

### 🟢 服务层保留(20 张)

这些表承载平台基础设施,不与具体用户的投资判断耦合,继续留在 SQLite。

| 表 | 用途 | 留 SQLite 的理由 |
|---|---|---|
| `users` | 平台用户身份 | 跨项目共享;被 `channel_identities` 和 `ai_instances` 外键引用 |
| `channel_accounts` | 微信账号(桥接 SDK 侧) | 平台资源,与具体用户无关 |
| `channel_identities` | 微信外部身份 → 平台 userId | 接入层映射,跨用户注册查询频繁 |
| `channel_identity_instances` | 渠道身份默认用户助手绑定 | 路由查询高频,工作空间不擅长关系映射 |
| `ai_projects` | AI 项目类型注册表 | 平台元数据,跨用户 |
| `ai_instances` | 用户助手注册(历史表名) | 平台元数据 + 路由依据;产品语义上一用户一助手 |
| `settings` | 系统级 KV(signal_config、巡检间隔、复盘模板) | 平台默认值,跨用户共享 |
| `codex_acp_traces` | ACP 调用审计(历史表名保留) | 系统审计,与用户方法无关 |
| `conversation_sessions` | canonical conversation log 会话索引 | 用户门户与微信共享的权威对话历史索引;云端 portal 只保存镜像,本地 SQLite 是权威源 |
| `conversation_messages` | canonical conversation log 消息明细 | 用户门户 `conversation.list/get/chat` 和微信对话审计共用;需要分页、幂等和跨 channel 查询索引 |
| `sandbox_audit_logs` | 沙箱令牌调用审计 | 合规/安全审计 |
| `pending_sandbox_confirmations` | 待确认的沙箱操作 | 跨进程状态(微信消息 ↔ 沙箱执行) |
| `conversation_tasks` | 旧会话任务草案表 | 保留作考古；conversation-task 草案系统已于 2026-06-23 删除 |
| `push_jobs` | 微信推送队列(重试、调度) | 系统调度器职责 |
| `scheduled_task_runs` | 定时任务运行记录 | scheduler claim / 去重 / 状态审计,用于复盘与巡检任务运行观测 |
| `indicator_definitions` | 指标定义库(系统级) | 平台元数据,owner=system |
| `alerts` | 旧式提醒规则(legacy) | 已被 stage2 `watch_rules` / `alert_rules` 主通路取代;2026-07-09 起不再参与规则巡检、不再启动时镜像到 `alert_rules`,仅保留 SQLite 作旧 UI/API 兼容和历史回退 |
| `alert_rules` | stage2 watch-rule 规则实例(用户配置 + 调度器高频读) | 运行时规则巡检只执行 `relation_to_plan=stage2_watch_rule` 的规则实例;需要 SQL 索引;watch.yaml 的 `exception_rules` 是协议层文本,不作为机器规则源 |
| `alert_events` | 已触发提醒事件 | 系统调度器写入(`alert-check.ts`),数据量大(每交易日数百条),cooldown 去重查询需要 SQL 索引;用户 feedback 字段补丁通过 UPDATE 完成,迁移到 jsonl 需 read-modify-write 大文件(WP4.10 决策保留) |
| `alert_signal_states` | 跨进程去重缓存 | 调度器 + server 都访问,跨进程协同(类似 `push_jobs` 性质),必须在 SQLite(WP4.10 决策保留) |

### 🔴 迁移至工作空间(10 张)

这些表承载**用户的投资判断、风格规则、方法、复盘产物、记忆事件**,在工作空间内有 yaml/jsonl 对应物。迁移后,SQLite 写入冻结,新数据只写工作空间。

| 表 | 工作空间对应物 | 备注 |
|---|---|---|
| `portfolio` | `config/portfolio.yaml`(holdings) | 持仓 |
| `watchlist` | `config/portfolio.yaml`(watchlist) | 自选 |
| `stock_plans` | `config/portfolio.yaml` 或新 `config/plans.yaml` | 交易预案 |
| `daily_plans` | `plans/daily/<date>.yaml` | 日复盘/预案状态(upsert by plan_date) |
| `investment_profiles` | `config/strategy.yaml`(profile + allocation + position_roles + rules) | 投资风格画像(workspace 模式下舍弃 customStyle / notificationPolicy / decisionPolicy) |
| `methodology_profiles` | `knowledge/methods/{fundamental,technical,macro,risk}.md` | 方法沉淀(workspace 模式下舍弃 sourcePolicy) |
| `method_change_candidates` | `memory/method_changes.jsonl` | 方法修订候选 |
| `review_viewpoints` | `memory/review_viewpoints.jsonl` | 观点记录(read-modify-write,按 sourceDate 整组替换) |
| `trade_actions` | `memory/behavior_events.jsonl`(event_type=action_confirmed) | 交易动作日志 |
| `indicator_results` | `reports/metrics/indicators/*.json` + `memory/source_events.jsonl`(元数据) | 指标计算结果 |

### ⚪ 丢弃(2 张)

| 表 | 丢弃理由 |
|---|---|
| `chat_history` | 历史会话状态;微信侧的会话记忆已切到 `memory/behavior_events.jsonl`(event_type=wechat_conversation_turn) |
| `agent_traces` | 旧自研 Runtime 历史表,`src/` 中已 0 引用,只有 docs/archive 提及 |

> `agent_traces` 当前 `src/` 引用计数为 0,可立即停止写入并冻结数据。
> `chat_history` 当前仅作为旧式对话记忆回退表保留;新用户可见对话历史以 `conversation_sessions` / `conversation_messages` 为 canonical conversation log。90 天后由 `scripts/drop-migrated-tables.mjs` 统一清理。

## 归属判断标准

判断一张表去哪一层,看下面四问:

1. **跨用户吗?** 跨用户共享(如 `users`、`ai_projects`)→ 服务层。
2. **跨进程吗?** 跨进程协同(如 `push_jobs` 在调度器和微信桥之间传递)→ 服务层。
3. **平台元数据吗?** 不含用户输入的判断(如 `indicator_definitions`)→ 服务层。
4. **以上都不是 + 含用户投资判断?** → 工作空间。

边界 case:
- `alerts` / `alert_rules` / `alert_events` / `alert_signal_states`(WP4.10 决策:全部保留 SQLite):`alerts` 已降级为 legacy 兼容表,不参与巡检;`alert_rules` 中 stage2 watch_rules 是当前规则巡检机器源。调度器高频读 / 大流量写入 / 跨进程协同 / cooldown 去重查询需要 SQL 索引,迁移收益不抵风险。历史讨论详见 `docs/archive/ideal-refactor-plan.md` WP4.10。
- `indicator_results`:既包含用户视角的指标计算结果,也复用 `indicator_definitions` 平台元数据。归到迁移,但平台元数据(定义)留在服务层。
- `daily_plans`:落 `plans/daily/<date>.yaml`(每 date 一份 yaml,upsert by plan_date)。语义是状态(非事件流),用 yaml 不用 jsonl。

## 迁移顺序(供工作包 3 / 4 / 5 参考)

迁移按"风险递增、依赖递增"分三波:

### 第一波(工作包 3,低风险)✅ 已完成

只读迁移,服务端 handler 改为读工作空间 yaml,SQLite 写入保持不变。

- ~~`investment_profiles` → `config/strategy.yaml`(单向读)~~ (待 4.x 后续)
- ~~`methodology_profiles` → `knowledge/methods/*.md`(单向读)~~ (待 4.x 后续)
- ~~`portfolio` / `watchlist` 读路径 → `config/portfolio.yaml`~~ ✅ 通过 WorkspaceStore 落地

### 第二波(工作包 4,中风险)✅ portfolio/watchlist/plan 已完成

SQLite 写入冻结,新增 yaml/jsonl 双写,旧表保留只读。

已完成(2026-06-21):
- ✅ `portfolio` 读写 → `config/portfolio.yaml`(holdings) — `portfolioBackend`
- ✅ `watchlist` 读写 → `config/portfolio.yaml`(watchlist) — `watchlistBackend`
- ✅ `stock_plans` 读写 → `config/portfolio.yaml`(stock_plans) — `planBackend`
- ✅ `trade_actions` 写 → `memory/behavior_events.jsonl`(event_type=action_confirmed)
- ✅ Dashboard CRUD API(/api/portfolio, /api/watchlist, /api/plans)已切到 backend
- ✅ 调度器 alert-check 已收敛到 stage2 watch_rules;scheduled market-watch 已切到 backend/workspace 配置读；自动 pre-market 推送已删除
- ✅ monitor / alert / review handler 已切到 backend 读
- ✅ `daily_plans` 读写 → `plans/daily/<date>.yaml` — `dailyPlanBackend`(2026-06-21 WP4.7)
- ✅ `method_change_candidates` 读写 → `memory/method_changes.jsonl`(版本快照,append-only) — `methodChangeBackend`(2026-06-21 WP4.9)
- ✅ `review_viewpoints` 读写 → `memory/review_viewpoints.jsonl`(read-modify-write,按 sourceDate 整组替换) — `reviewViewpointBackend`(2026-06-21 WP4.8)

未完成(残留双轨):
- `alerts` 表仍作为 legacy UI/API 兼容表存在,但不再镜像到 `alert_rules`,也不参与运行时巡检。当前运行时主通路是 stage2 watch_rules。

已完成(2026-06-21):
- ✅ `chat_history` 写入路径切到 `memory/behavior_events.jsonl`(event_type=wechat_conversation_turn);SQLite 表保留只读回退,由 `WORKSPACE_BACKEND` 切换

已完成(2026-06-21):
- ✅ `plan-conditions.setPlanWatchConditions` 切到 `planBackend.upsert`(`stock_plans` 不再直写;alertRules 写入保留,因为系统层未切)。`linkedAlertRuleIds` 统一为 `string[]`,与 PlanRow 接口对齐

已完成(2026-06-21):
- ✅ `investment_profiles` / `methodology_profiles` 读写 → `config/strategy.yaml` + `knowledge/methods/*.md`(当时由 `profile-context.ts` / `conversation-tasks.ts:applyInvestmentProfileTask` / `sandbox.ts:/api/sandbox/profiles*` 切到 WorkspaceStore,通过 `WORKSPACE_BACKEND` 切换)
  - 字段舍弃:`customStyle`、`notificationPolicy`、`decisionPolicy`、`sourcePolicy`(运行时无消费,语义已被 yaml 其他字段覆盖)
  - 2026-06-22 后续清理(方向 B 重构):`src/lib/profile-context.ts` 已删除,prompt 注入路径不再走"代码预拉数据塞 prompt",而是 ACP agent 直接通过 `/api/sandbox/profiles` / `/api/sandbox/reviews/*` 等 API 自取。`sandbox.ts` 不受影响,继续直连 WorkspaceStore。
  - 2026-06-23 范围收缩 WP A3:`src/lib/conversation-tasks.ts` 整文件删除,所有 Draft 中间层下线,`conversation_tasks` 表保留作考古。

切换方式:环境变量 `WORKSPACE_BACKEND=workspace` 开启 workspace 模式,默认仍走 SQLite。

### 第三波(工作包 5,高风险)⏳ 未启动

自演进闭环数据迁移,涉及日 → 周 → 月级联。

- 周复盘读 jsonl 回看日观点(viewpoints)
- 月复盘读 jsonl 回看周归因(method_changes)
- `alert_signal_states` / `indicator_results` 改为工作空间内运行时缓存
- `conversation_sessions` / `conversation_messages` 不迁移到 workspace:它们是用户门户、微信、审计和云端镜像对账共用的服务级 canonical conversation log。

## 旧表的处置策略

迁移完成后,**不立即 DROP**:

1. 新代码不再写入旧表(冻结)。
2. 旧表保留 90 天作为只读回退。
3. 90 天后由 `scripts/drop-migrated-tables.mjs`(待写)统一清理。
4. `chat_history` / `agent_traces` 在工作包 4 完成后即可清空(不需要保留)。

## 主用户数据不迁移(2026-06-21 决策)

**决定**:不做主用户数据迁移。SQLite 里 primary 用户的所有数据(806 条)视为**测试期积累**,不进入新工作空间。

理由:
- 工作空间模型的本意是"用户拿到清爽模板开始";迁移测试数据违背初衷
- 806 条中约 700 条是调度器自产噪声(alert_events/indicator_results/alert_signal_states)
- 剩余约 110 条用户手输数据也是测试期配置,真实使用时会重新输入
- 工作包 3/4 切 handler 到读工作空间后,primary 用户从空模板启动,正好验证冷启动

SQLite 数据库继续保留在 `./data/invest-agent.db`,需要查时直接 `sqlite3` 临时查询。注意 workspace 默认根目录不是仓库内 `./data/workspaces`,而是运行时配置 `WORKSPACE_ROOT`；未显式覆盖时,当前默认实现会落到 `../../my-data/projects/invest-agent-ideal/workspaces`。

## 这份归属文档的实际用途

调整定位:**不是为迁移服务,而是为 handler 切换服务**。

- 工作包 3/4 切换 handler 到读工作空间时,需要知道"这张表读哪个 yaml/jsonl"
- "迁移目标"列实际含义是"handler 切换后的目标格式"
- 真实用户通过 `ensureWorkspace` 自动复制空模板,与本归属文档无关
- 边界 case(alert_signal_states / indicator_results)的"工作空间运行时缓存"形式在工作包 4/5 落地

## 与 sandbox 的边界

工作空间内的 yaml/jsonl 写入,**不走沙箱审计**(用户自己写自己的工作空间)。只有当 ACP agent 通过沙箱 API 调用本服务、再由本服务回写工作空间时,才记录 `sandbox_audit_logs`(在服务层)。

这个边界来自 `docs/23-multi-user-sandbox-design.md` 的"工作空间是用户私有领域,沙箱只审计跨域调用"。
