# Mastra 候选架构基线

状态：工作底稿（v2，2026-08-15）——记录本分支**已验证的架构事实**与**已确认的方向**；逐层核对议程已走完（D18-D21），工程执行轮 E1/E3/E5/E6 已落地（D22）；**H1 验收已通过（2026-08-15）**。同日完成：D23 交互复用边界、D24/E10 开销统计（C1-C4）、**D25 模型选择器**（Portal 下拉 + conversation.chat 透传 + runMastraTurn 按回合解析，modelSource 标记 user-selection）、**E9 巡检可见性**（合成任务并入自动化面）。剩余：E2 接口化收拢（独立系列）、E4/E8（迁移验证门）、E7（低优先）。下一步入口：R1 发布讨论（须另行授权）
分支：`feat/mastra-migration`（并行探索分支，非合并候选）

> 本文描述**本分支（候选）的现实架构**。`docs/system-overview.md` 描述的是 main 基线的 ACP/Workspace 架构，在本分支不成立；两文在分支收敛前并存。
>
> 使用方式：每节末尾有「核对状态」。`✅ 已验证` = 本轮有代码/运行证据；`📌 已确认方向` = 用户已裁决；`⬜ 待核对` = 逐层核对会议的议题。

## 1. 架构原则（草案，待逐条核对）

| # | 原则 | 现状依据 | 状态 |
| --- | --- | --- | --- |
| P1 | 安全保证由服务层强制（确认门/审计/变更锁/scope），不依赖 prompt 或文档 | service-tools-core 50 工具全部过 `sandboxMutationSafe`/scope 分类；写操作需 confirmation | ✅ 已验证 |
| P2 | 推理内核可替换：应用层只见中性 runtime 接口 | `src/runtime/` 零 acp/codex/hermes 标识；Portal/微信/调度统一走 `createRuntimeAgent()` | ✅ 已验证 |
| P3 | 数据 service-owned：SQLite 投影为权威，受控文件根存字节 | 三投影表 + ledger + `mastra-projects/<digest>` | ✅ 已验证 |
| P4 | 通道无关：微信与 Portal 是同一 runtime 的两个入口 | 两通道共用 handleMessage 与工具面 | ✅ 已验证 |
| P5 | Agent 负责判断，服务负责确定性与事务；能力尽量经外部服务/MCP 外包、服务层保持窄边界 | 边界判据三分类定稿 + 44 工具终表（2026-08-14 议程 2，见 §5） | ✅ 已核对（外包 = 外部服务 + 服务薄壳；MCP 协议化非目标本身） |
| P6 | 用户体验契约显性化：藏在 prompt 里的呈现规则应成为可核对的契约 | web 通道 SVG/表格/xlsx 规则全部在 `buildChannelContextInstruction` 字符串里 | 📌 已确认方向（见 §10.3） |

## 2. 进程拓扑 ✅ 已验证

```
微信 ←─────────────┐
浏览器 → Portal(:23657, Next.js) ←→ Relay(:23658, WS)
                     │ connector 协议（token 鉴权）
                     ▼
         Runtime(:23656, node dist/index.js)
         ├─ Mastra Agent 内核（唯一内核；模型经 OpenAI-compatible gateway）
         ├─ Scheduler / Service tools(进程内) / 外部只读 MCP
         └─ SQLite（data/mastra-portal-local/runtime）+ 受控项目根
生产 main(22655) 与本拓扑完全隔离。
```

- 同仓独立进程（WP4 形态）；`apps/runtime` 物理迁移未做，runtime 仍在根 `src/`
- 可复现入口：`bash scripts/run-mastra-portal-local.sh`（bootstrap 默认项目根 → 起 Portal → 起 runtime）

## 3. 代码分层 ✅ 已验证（张力待核对）

```
channels/   微信桥、Portal connector
runtime/    中性应用层：agent 入口、prompt 构建、scheduled-tasks、trace、protocol
mastra/     内核层：agent-factory、model-gateway、run-turn、tools registry、workspace-registry
mcp/        工具注册层：service-tools-core(44) + scope 分类 + 外部 MCP 装配
services/   业务逻辑（58 文件）
lib/        数据后端：ACTIVE_BACKEND 三态切换 + mastra 投影 + workspace 兼容
db/         schema + drizzle
```

分层张力（阅读复杂度来源，按影响排序；2026-08-14 议程 6 核对定稿，D21）：
- T1 `ACTIVE_BACKEND` 三元分支实测散布 **28 个非测试文件**；`sqlite` 态实际死路径、`workspace` 态仅回滚保险 → **方向定稿**：backend 接口化收拢到 `lib/`（portfolio/watchlist/plans 三域已在 `data-backend.ts` 示范目标形态：接口 + 三元选择收在 lib），剩余域分批收拢；验收 = `ACTIVE_BACKEND` 直接引用只出现在 `lib/`。执行为工程项
- T2 投影行内多域共存（`profile_json` 兄弟键 + merge 写入约定）→ **定稿维持单行 + 兄弟键契约**（D20 移除画像键后仅剩 tradingStrategies 等少数兄弟域；merge-safe 语义 G12 已保障 + revision 乐观锁）；契约显性化记入本文即消除"隐式"
- T3 表命名双轨（`mastra_*` vs `chat_history`/`methodology_profiles` 活表）→ **定稿不改名**：候选→真实数据迁移阶段改表名的迁移成本大于一致性收益；命名差异文档化（§4）即可
- T4 onboarding 双实现 → **已消解**（D16 后 HTTP 路由与 MCP 工具共享 `services/onboarding.ts` 同一核心；Portal HTTP + Agent MCP 是通道复用，非重复实现）
- T5 runtime 未进 `apps/`，src 平铺 → 挂工程项（WP4 形态收尾），不阻断
- T6 观测层：trace `tool_calls` 系统性为空（G23）→ H1 前工程项（见 §8）

## 4. 数据架构 ✅ 已验证

| 层 | 内容 | 备注 |
| --- | --- | --- |
| service 表 | 用户/实例/对话/trace/调度/push/自动化/资产/审计/规则 | 与 main 共享 |
| mastra 投影 3 表 | `mastra_portfolio_states`、`mastra_project_profiles`（含 `tradingStrategies` 兄弟键）、`mastra_runtime_preferences` | 空默认+惰性建行语义（与 workspace 等价）；revision 乐观锁 |
| ledger | `mastra_review_memory_records`：日计划/周期复盘/方法变更/观点/service 事件 | append-only；行为统计已接入 |
| 受控文件根 | `data/mastra-projects/<sha256>`：资产版本字节/附件/staging | registry 主导，禁止回退 legacy 根 |
| legacy 双轨 | `WORKSPACE_BACKEND=workspace` 全套（回滚后端）；`chat_history`、`methodology_profiles` 为 mastra 模式活表 | 功能等价、命名未收敛（T3 定稿不改名）；**回滚后端拆除时机定稿（D21）：保留至真实数据迁移验证 + H1 验收通过，随后独立清理提交并以 convergence scan 防回潮**（与长工作包 WP5→WP6 顺序一致） |

## 5. 能力面：service tools 终表（44 个）✅ 已核对（2026-08-14 议程 2，D18）

**边界判据（定稿，P5 落地）——三分类**：

1. **事务/确认/调度/审计绑定** → 服务层（安全边界，不可外包）
2. **service-owned 数据读取**（投影表、快照、资产索引、对话历史）→ 服务层（ownership 边界；外部 MCP 无法访问服务 SQLite/字节根）
3. **纯外部能力代理**（搜索/解析/行情/文档生成）→ 外部服务 + 服务薄壳（校验/scope/审计留在 case 层）；是否走 MCP 协议按工程需要定，不作为目标本身

> 修正：原二分草案（"纯读取、纯内容生成优先外包"）会把 `assets.list` 这类 service-owned 读取误导向外包；原 B 批判断把"行情能力"与"快照读取"、"资产能力"与"资产索引读取"混在一起，三分类判据修正之。

**44 工具归属终表**：

| 归属 | 工具 | 判据 |
| --- | --- | --- |
| 服务核心·事务/确认（15） | portfolio.apply_changes、watchlist.add、plans.set、plans.watch_conditions、method_changes.propose/apply、preferences.apply、watch_rules.create、confirmations.request、onboarding.confirm_portfolio、onboarding.draft.get/upsert_step/request_confirmation、artifacts.publish、reviews.save | 类①；D14 A 批 + C5（reviews.save 为任务完成契约本体） |
| 服务核心·调度绑定（6） | automation.create/get/list/update/activate/pause | 类①；任务系统是调度权威 |
| 服务核心·数据读取（8） | portfolio.read、watchlist.read、plans.read、conversation.history、confirmations.pending、market_watch.snapshot、assets.list、assets.version.read | 类②；快照/资产索引为 service-owned 数据，行情事实本身已由外部 market-data-tool MCP 承接 |
| 服务核心·资产写侧（6） | assets.version.commit、assets.conversation.save、assets.attachment.save、assets.rename、assets.archive、assets.delete | 类①；资产生命周期 + 审计 |
| 外部代理薄壳（3） | research.news_search/web_search/web_read | 类③样板：case 层校验/scope/审计 + 委托外部 |
| 外部代理薄壳·实质达成（1） | file.parse | 类③；实现已是"服务读附件字节 + MinerU 外部解析"，维持现状，不做 MCP 协议化改造（无行为收益） |
| 进程内·文档生成（1） | spreadsheet.create | 类③能力，定稿维持进程内：生成+落库+审计一体、实测可用；两段式外包（外部生成字节→服务落库）收益不抵字节回传与外部依赖成本（D18） |
| 服务核心·规则读取/求值（4） | watch_rules.catalog、list、validate、dry_run | 类②/确定性求值；议程 4 定稿（D19）——规则定义是 service-owned 数据，validate/dry_run 为确定性求值 |

**B 批 MCP 外包专项取消**（D18）：market_watch.snapshot（读 service-owned 快照）、assets.list/version.read（读服务索引）定稿留服务层；file.parse 已实质外包；唯一真候选 spreadsheet.create 定稿维持进程内。工具面 44 为定稿基线（后续增减随具体能力变更重开议题）。

## 6. 调度与自动化 ✅ 复盘/盯盘已任务化（D10-D13）；规则巡检边界已核对（议程 4，D19）

**现状（2026-08-14 议程 4 盘点）**：

1. **已任务化**：日/周/月复盘（D11）与盘中盯盘（D12）走任务类型注册表（`scheduled-task-types.ts` 四类 typed task）；typed 任务权威、偏好路径防双发让位；P4a 幂等迁移脚本就绪。P4b（废除偏好散读点与 schedulerActivation）待全量迁移验证后执行。
2. **规则巡检（维持 v1 设计划界，议程 4 复核确认）**：`price_cross` 单类型（WP6 用户裁决：8 类非价格规则退役，非价格条件未来走外部量化筛选工具，qsse-qlib MCP 已注册默认关）；`shouldRunRuleAlertCheckTask`（scheduler/index.ts:472）按 `alert_check_interval_minutes` 间隔槽触发 + `claimScheduledTaskRun` 幂等领取；每次命中落 scheduled_task_runs 但**不在任务类型注册表——这是正确的**（"事件驱动条件评估"≠"节奏性工作"，v1 设计 §5 已划界不并入自动化任务）；与盘中简报同 tick 时抑制单独推送。
3. **优先级来源（D19 裁决）**：`HARDWIRED_PRIORITY_MAP`（alert-check.ts:595）原设计读 workspace `risk_taxonomy.yaml`、mastra 下恒走硬编码默认——定稿：硬编码映射升格为 service-owned 产品常量（稳定集合），删除 workspace yaml 死路径（随 T1 收敛执行）；不做 preferences 化（v1 设计已定"优先级/推送策略自成一体、从 preferences 解耦"）。
4. retention 清理、data-quality 等平台循环保持 scheduler 内部（非用户语义，不任务化）。

**watch_rules 工具归属（按 D18 判据定稿）**：catalog/list = service-owned 规则数据读取；validate/dry_run = 确定性求值——四件全定稿服务核心（§5 表已同步）。

**遗留工程项（不阻断核对）**：① risk_taxonomy.yaml workspace 死路径清理（随 T1 一并做）；② G21 巡检可见性——Portal 管理面设计时与任务列表同页呈现；③ 非价格条件外部化（qsse-qlib 对接）维持划界、按需开专项。

**已确认方向**：
- 复盘、盯盘并入自动化任务系统，scheduler 只保留触发器角色 ✅ 已实施（D10-D13）
- 调度激活语义：onboarding 完成 = 可调度 ✅ 已实现；巡检可见性（G21）为后续 Portal 设计点

## 7. 投资画像（investment profile）✅ 已确认移除（D5）；移除范围清单已盘点（议程 5，D20）

- **证据**：运行时消费面仅 `routes/sandbox.ts` 的 GET/PUT profile 端点与 platform 快照；**Agent 工具面（44 工具）与 prompt 均不使用**；投资画像与方法变更（method_changes → methodology）是两套东西；Portal 代码零引用
- **移除范围清单（2026-08-14 议程 5 全量扫描）**：
  1. **HTTP**：`POST /api/sandbox/profiles/investment`（sandbox.ts:1311）整端点删除；`GET /api/sandbox/profiles`（1134）去掉 investmentProfile 字段（methodologyProfile/changeRows 保留）；`GET /api/sandbox/snapshot`（1066）去掉 investmentProfile/hasInvestmentProfile
  2. **mastra 投影**：`mastra_project_profiles.profile_json` 画像键（style/selectedStylePack/riskPreference/investmentHorizon/markets/allocation/positionRoles/buyRules/sellRules/rebalanceRules/notes）读写移除 + 一次性迁移剔除既有键；兄弟键 tradingStrategies/methodology 保留（merge 语义已由 G12 保障）
  3. **表**：`investment_profiles` 的 drizzle 定义（schema.ts:193）与 CREATE TABLE/ensureColumn/唯一索引（db/index.ts:228/1111/1230）候选分支移除；**生产表 drop 挂真实数据迁移阶段按 db-migration 规范执行**（红线：不得未经授权动生产 SQLite）；project-registry.ts:310 的行清理随之移除
  4. **Platform**：`GET /api/platform/instances/:id/investment-state`（platform.ts:1949）+ scope 分类条目（1155）+ admin owner UI view-instances 展示区块移除；userInstanceTables 清单（platform.ts:627）去掉该表
  5. **scope 处置**：`invest.profile.read/write` 保留（methodology 端点仍用），tool-registry 中 resourceType 由 `investment_profile` 改标 `methodology_profile`（tool-registry.ts:96/104）
- **实施为独立工程项**（不阻断核对）：按清单一次提交完成 + 回归

## 7.5 产品语义重构讨论（2026-08-14，未决，讨论中）

**问题提出**：onboarding 承载的"低打扰 + 复盘节奏"是一套面向特定用户群的产品语义（onboarding + 日/周/月复盘 + 盯盘机制），但 Portal 自动化使系统演化为支持更广义用户与个性化策略的通用框架，这套语义被涵盖。**方向假说**：不兼容现状，先立通用框架，把"低打扰复盘型"对象化为**可选初始化包（preset）**——与策略可选同级的一种"使用方式"，需要新的 onboarding 设计。

**偏好生效性核验（事实）**：
- 生效链（mastra 路径）：`schedules.daily/weekly/monthly_review` → 复盘触发（scheduler/review.ts:114 用 scope 实例）；`schedules.market_watch.default_windows` → 盯盘窗口（scheduler/index.ts:440 用 scope 实例）；notification mode + `watch.only_push_on_exception` → 盯盘推送模式（scheduled-tasks.ts:438-448）
- **缺陷**：scheduled-tasks.ts:440/453 与 scheduler/index.ts:550 三处用硬编码 `DEFAULT_INSTANCE_ID` 读偏好——非 primary 用户（其实例为 `invest-agent-<userId>`）读到空行回落默认，即**盯盘推送偏好对非默认实例用户不生效**；且与 review/market-watch 调度的 scope-aware 读取不一致
- 结构性问题：偏好→行为的应用点散落 5 处，无统一应用面

**D3 映射草案（偏好 → 自动化任务）**：notification mode → 任务 delivery policy；market_watch windows → 盯盘任务 schedule；review 节奏 → 复盘任务 schedule；only_push_on_exception → 任务 push policy / 全局投递策略；schedulerActivation → 被"任务存在即启用"取代（顺带解决 G21 可见性：任务列表即调度可见面）。

**影响**：第一轮 C1（onboarding 工具）、C5（reviews.save/market_watch.snapshot）挂起至预设模型定稿。

**讨论收口（2026-08-14 同日）**：用户确认按 D9 语义归属原则推进，讨论收敛为两份待审设计稿——预设对象体系（[preset-system-design.md](./preset-system-design.md)）与复盘/盯盘任务化+偏好映射（[scheduled-flows-to-automation-design.md](./scheduled-flows-to-automation-design.md)）。偏好读取 scope 缺陷（三处硬编码 DEFAULT_INSTANCE_ID）已当场修复。

## 8. 可观测性 ✅ 核对完成（议程 6/7 并入；G23 转工程项）

- trace 链路：`agent_traces`（backend/model/status/usage/耗时）写入正常；**`tool_calls` 系统性为空（G23）**——run-turn 未捕获当前 Mastra 版本的 tool-call 事件形状
- 核对结论（2026-08-14）：无架构争议，纯实现缺口——修复 = 在 `mastra/run-turn.ts` 按当前 Mastra 版本的事件形状捕获 tool-call 终态并写入 trace。列为 **H1 前工程项**（影响审计/调试，不影响用户功能；与 G22 并列）

## 9. 模型与网关 ✅ 已验证

- `model-gateway` 纯解析层（env/参数 → provider/model 描述符），回合级快照、切换只影响后续回合（有测试）
- 无静默 fallback；Platform 不见 key

## 10. 用户体验架构

### 10.1 通道矩阵 ✅

| 能力 | 微信 | Portal |
| --- | --- | --- |
| 对话（含附件识别） | ✅ 简洁 Markdown + 输出净化 | ✅ 结构化/表格/SVG |
| 文件 | — | 对话内附件卡片交付 ✅（G22 终态：deliveries/ + artifacts.publish 官方管线，D23）；我的文件（版本/下载）✅ |
| 自动化管理 | — | 任务/运行/模板 |
| 调度可见性 | — | ❌ 无承载（G21，后续设计） |

### 10.2 核心旅程 ✅（自动化证据）

上手（onboarding，完成即调度）→ 日常问答/确认写 → 盯盘简报 + 规则提醒 → 日/周/月复盘（含行为纠偏统计）→ 文件（Excel 交付→我的文件）。
断点：复杂回合 162s；G22 已修（官方卡片管线，待用户重测确认）；H1 验收进行中（文件/资产库/自动化列表/审计已过）。

### 10.3 Prompt 补丁地图 📌 owner 自用（2026-08-14 扫描）

**目的（用户原话澄清）**：不是给用户看的契约文档，而是**产品 owner 自己的掌控清单**——所有注入 Agent 上下文的指令补丁散落在哪里、各控制什么。掌握这张地图，才能主动调整给用户的产品服务；否则每次行为调优都是"盲改某个文件里的字符串"。

全 src/ 的 prompt 注入点分布（按【】指令块密度排序）：

| 注入点 | 块数 | 控制什么 | 触发/通道 | 备注 |
| --- | --- | --- | --- | --- |
| `src/handlers/review.ts` | **26** | 复盘输出模板段标签（【AI 分析】【持仓分析】等）与推送简报文案（`buildScheduledReviewPush` 周/月）、决策/观点措辞 | 日/周/月复盘、定时推送 | **最重补丁聚集地**；~~第二 DeepSeek 模型路径~~ 已移除（2026-08-14，D8）：`safeAi`/`callDeepSeek`/两个 DeepSeek 大 prompt 已删，`services/deepseek.ts` 及 config/env 死配置一并清理；直接生成路径降级为纯事实整理（注明"完整分析走 Agent 路径"） |
| `src/runtime/scheduled-tasks.ts` | 5 | 定时任务人设与完成契约："你正在执行自动日复盘"、`reviews.save` 是唯一完成路径、失败不得输出用户内容 | scheduler 触发 | 任务 prompt 随 D3 并入自动化时要一起迁 |
| `src/runtime/agent.ts` | 4 | **通道上下文（UX 核心）**：web=SVG 协议/表格 7×5 限制/xlsx 规则/文件交付条件；weixin=手机友好措辞；附件处理指引 | 每条消息按 channel 注入 | 用户点名的隐藏 UX 所在地 |
| `src/runtime/mobile-prompt.ts` | 4 | 主 prompt 组装：`OUTPUT_VOLUME_POLICY`（结果数量与表格规则）、内部执行上下文、复盘上下文压缩 | 每个回合 | 与 `spreadsheet-output-policy.ts` 共享策略串 |
| `src/scheduler/alert-check.ts` | 3 | 规则触发推送文案与优先级措辞 | 规则巡检命中 | 随规则巡检重设计（D3）一并审 |
| `src/services/indicators.ts` | 3 | 指标解释/数据质量措辞 | 指标问答 | |
| `src/handlers/signal-config.ts` | 2 | 信号配置说明 | 信号配置 | |
| `src/server.ts` | 1 | （待核对具体内容） | | |
| `src/mastra/tools/registry.ts` | 44 条长描述 | **工具描述即行为补丁**：agent 如何选择/组合工具由这些描述引导 | 每个回合 | 随 §5 能力面盘点一起审 |
| `src/mastra/agent-factory.ts` | 1 | 默认 instructions 兜底（"You are an investment decision assistant."） | 兜底 | 正常路径不生效 |

**维护纪律（草案）**：新增/修改任何注入 Agent 上下文的文案必须在本文登记（文件+控制面+触发条件）；调度类 prompt 迁移时同步更新本表。⬜ 待核对

## 11. 决策日志（2026-08-14，本 session 用户裁决）

| 决策 | 内容 |
| --- | --- |
| D1 | 走完 onboarding 即启用调度（已实现） |
| D2 | 确认后的 YAML 快照不作为用户交付物（YAML 非面向用户） |
| D3 | 复盘、盯盘并入自动化任务系统；规则巡检重新设计 |
| D4 | service tools 盘点：大部分能力 MCP 外包，服务层设边界 |
| D5 | 投资画像移除（系统未使用） |
| D6 | 架构文档与现实现对齐（本文即基线） |
| D7 | 建立 owner 自用的 prompt 补丁地图（所有注入 Agent 上下文的指令：位置+控制面+触发条件），目的是让产品 owner 掌握并主动调整产品行为；已扫描入 §10.3，后续增改需登记 |
| D8 | 移除 DeepSeek 第二模型路径（2026-08-14 已执行）：不同任务派发不同模型是后期方向，现阶段双管线不符合设计且过早。复盘分析统一走 Mastra Agent 回合；直接生成路径保留为纯事实回退 |
| D9 | 语义归属原则（2026-08-14）：系统只提供通用能力（身份/数据/自动化/投递/安全）；「通知偏好」等语义**只属于预设**（如低打扰复盘型），不是系统语义。策略包/节奏包等 = 同类对象，本质是**预设的一组配置数据**。落稿：[preset-system-design.md](./preset-system-design.md) + [scheduled-flows-to-automation-design.md](./scheduled-flows-to-automation-design.md) |
| D10 | 按"通用能力 + 个性化配置"落地第一增量（2026-08-14 已实施）：任务类型注册表 + schedule 扩展（monthly/windows）+ 任务表 task_type 列 + 预设注册表与 applyPreset（低打扰复盘型首个预设；任务 paused 创建 + compat 偏好双写保现网行为）。测试 `mastra-preset-apply.test.ts`；mastra 套件 77/77 |
| D11 | P2 复盘任务化接线（2026-08-14 已实施）：runner 按任务 taskType 授权（reviews.save 可用）；偏好驱动复盘在活跃 typed 任务存在时让位（防双发）；applyPreset 直接激活复盘任务（盯盘 P3）。mastra 77/77、调度/automation 回归 43/43 |
| D12 | P3 盯盘任务化接线（2026-08-14 已实施）：盯盘任务 wechat_on_condition 条件投递（NO_PUSH 语义）+ 激活；shouldRunMarketWatchTask 防双发。四类预设任务全部 active、任务驱动。mastra 77/77、调度契约 12/12 |
| D13 | P4a 偏好迁移脚本（2026-08-14 已实施）：`scripts/mastra-preferences-to-tasks-migration.mjs` 幂等迁移既有偏好为 typed 任务（保留用户实际时间，--dry-run 支持）；P4b（废除散读点与 schedulerActivation）待全量迁移验证后执行。mastra 套件 78/78 |
| D17 | O4 解散（2026-08-14 用户裁决）：截图识别/对话式策略=模型原生能力+普通对话，不专门建设；向导②粘贴文本确定性解析入草案。O1-O4 全部收口，进入用户体验检查时点 |
| D16 | O3 工具面收缩（2026-08-14 已实施）：按 D14 移除 6 个 onboarding 步骤类工具及 confirm-step 路由；确认契约测试改用存活写工具承载；applyPreset 补 activation 语义（P4b 前）。工具面 44；npm test 454/454 |
| D15 | O1+O2 新 onboarding 落地（2026-08-14 已实施并隔离候选端到端验证）：默认节奏幂等契约 + runtime/Portal 完成端点 + /onboarding 三步向导（③策略包真实生效）+ 微信轻指引门；首批策略包 2 个（趋势跟踪/价值回归）。mastra 套件 80/80 |
| D14 | 工具面裁决（2026-08-14，用户授权按最优判断）：A 批 14 个确认/事务类 + `reviews.save` 定服务核心；B 批（spreadsheet.create/file.parse 外包）挂 MCP 外包专项；assets 读写拆分（读侧外包候选、写侧生命周期留服务）；watch_rules 其余四件挂规则巡检重设计；纯读取四件套保留进程内；draft 七件套收缩为三（get/upsert/request_confirmation，其余四个随新 onboarding Portal 化——待实施）。工具面目标 50→46+ |
| D18 | 能力面定稿（2026-08-14 议程 2 核对，agent 按最优判断裁决落地、用户未逐项表态）：边界判据三分类（①事务/确认/调度/审计绑定→服务层 ②service-owned 数据读取→服务层 ③纯外部能力代理→外部服务+服务薄壳）；44 工具归属终表见 §5；spreadsheet.create 维持进程内；market_watch.snapshot 与 assets 读侧定稿留服务层；file.parse 已实质外包维持现状；**B 批 MCP 外包专项取消**。如需翻案，下次核对提出即可 |
| D19 | 规则巡检边界定稿（2026-08-14 议程 4 核对，agent 按最优判断落地）：维持 v1 设计划界——规则巡检不并入自动化任务（事件驱动条件评估 ≠ 节奏性工作），保持调度器内确定性 patrol + scheduled_task_runs 留痕；优先级定稿为 service-owned 产品常量（HARDWIRED_PRIORITY_MAP 升格，risk_taxonomy.yaml workspace 死路径随 T1 清理）；watch_rules 四件（catalog/list/validate/dry_run）定稿服务核心；非价格条件外部化（qsse-qlib）维持划界按需开专项；G21 可见性留待 Portal 管理面设计 |
| D20 | 投资画像移除范围定稿（2026-08-14 议程 5 核对，agent 按最优判断落地）：范围清单见 §7——三端点清理、投影画像键迁移剔除（兄弟键保留）、investment_profiles 表候选分支移除（生产 drop 挂真实数据迁移按 db-migration 规范）、platform investment-state 端点+UI 区块移除、invest.profile.read/write scope 保留但 resourceType 改标 methodology_profile；实施为独立工程项 |
| D21 | 数据层收敛定稿（2026-08-14 议程 6 核对，agent 按最优判断落地）：T1 backend 接口化收拢（28 文件实测，portfolio/watchlist/plans 已示范，验收 = ACTIVE_BACKEND 仅存 lib/）；T2 投影维持单行 + 兄弟键显性契约；T3 表命名不改（迁移成本 > 一致性收益）；T4 已随 D16 消解；T5 挂工程项。**workspace 回滚后端拆除时机：保留至真实数据迁移验证 + H1 验收通过后独立清理（convergence scan 防回潮）**；G23 修为 run-turn 事件捕获、G22/G23 均 H1 前工程项。逐层核对议程 1-8 全部走完，转工程项执行期 |
| D22 | 工程执行轮记录（2026-08-14）：E1/E3/E5/E6 已实施并各有 commit+测试证据（npm test 460/460）。**E2 全量收隆重定界为 H1 后独立提交系列**——两个 mastra 根解析器（resolveRegisteredMastraProjectRoot 返回 undefined vs resolveProjectStorageRoot 抛错）失败语义不同、各站点 workspace 回退细节各异，H1 前硬推属拿回归风险换可读性；本轮仅随 E3 落地 alert-check 增量。D20 清单执行修正：/investment-state 为 admin 持仓总览（非画像消费）保留；投影键剔除保守跳过与 StrategyYaml 同名的 allocation/notes/markets（来源不可区分，防数据丢失）。G22 落地形态为"工具结果+prompt 双重交付指引"，消息内资产卡片受 artifact 路径白名单限制留 E9 |
| D23 | **交互复用边界**（2026-08-15 用户裁决，G22 四轮收敛的产物）：重构主战场是 runtime；Portal 交互层是已实现资产**直接复用不重设计**。新 runtime 能力必须优先映射到既有交互契约（artifact 卡片/文件面板/自动化工作区/资产库）；本质需要新交互面才新增 UI 且须显式立项（先例 D15 onboarding）。G22 前两轮在门户端自创链接交付属越界（已撤销、门户恢复与正式仓字节对齐，仅剩 onboarding 增量）；校验手段 `diff -rq` 正式仓 src vs apps/portal/src。**补充（同日）**：架构驱动的交互演进是预期例外——为承接新 runtime 能力（按回合模型选择等）会有受控交互改变，首个在途实例为模型选择器（正式仓 WIP `local/ea43db2`/`4dd6d0d`，model 经 conversation.chat 透传；runtime model-gateway 已就绪），此类改变走"立项→合正式仓→导入候选"路径。落稿 [adr-mastra-runtime-portal-monorepo.md](./adr-mastra-runtime-portal-monorepo.md) 交互复用边界节 |
| D26 | **E9 v2 与模型选择器位置**（2026-08-15 用户反馈裁决）：① 规则巡检不放自动化任务列表（"太隐晦"）——**新增专属小页面** `/patrol` 专门管巡检，后续再评估归属；② 模型选择器放在**在线状态位置**（chat 顶栏左侧），不放输入框 |
| D25 | **模型选择器落地路径**（2026-08-15 用户裁决）：D23 的"立项→合正式仓→导入候选"路径对本项**例外**——模型选择器依赖候选 runtime 的按回合模型能力，正式仓主线没有也不需要；**直接在候选分支实现**（参照正式仓 WIP `local/ea43db2`/`4dd6d0d` 的交互与协议形态），正式仓保持不动。D23 边界校验的预期差异清单相应扩为：onboarding + 模型选择器。同日授权：巡检可见性（E9）自主设计落地、队列自主推进、硬缺口再上浮 |
| D24 | **开销统计重建**（2026-08-15 用户提出，仅记录待规划）：ACP 时代开销统计一直不准；换内核后须重建配套，含按不同模型计费。现状事实：token 用量已准（`usage_source=actual`，thought/缓存读分离），但 `agent_traces.cost_amount/cost_currency` 系统性为 null（网关不回传费用、无计价表），平台 admin 费用视图（`admin/platform-ui/owner/view-cost.ts`）依赖该字段。规划范围（待展开）：按模型计价表 → 从实际 usage 计算费用落 trace → 平台费用视图聚合。挂 E10 |

## 12. 逐层核对议程（建议顺序）

1. ~~预设与任务化设计稿审阅~~ ✅ 收口（D9-D17，2026-08-14）
2. ~~能力面盘点与 MCP 外包边界~~ ✅ 核对完成（2026-08-14 议程 2：三分类判据定稿、44 工具终表、B 批外包专项取消，D18）
3. ~~架构原则定稿~~ ✅ P1-P4 已验证、P5 判据随议程 2 定稿（§5）、P6 由 §10.3 补丁地图承载（契约化随维护纪律长期执行）
4. ~~规则巡检重设计~~ ✅ 核对完成（2026-08-14 议程 4：维持划界不任务化、优先级定 service-owned 常量、watch_rules 四件定稿服务核心，D19；遗留工程项记 §6）
5. ~~投资画像移除范围~~ ✅ 盘点完成（2026-08-14 议程 5：范围清单五项定稿，D20；实施为独立工程项）
6. ~~数据层收敛~~ ✅ 核对完成（2026-08-14 议程 6：T1-T6 逐项定稿、workspace 回滚后端拆除时机定稿，D21）
7. ~~观测层~~ ✅ G23 无架构争议，转 H1 前工程项（§8）
8. ~~UX 断点~~ ✅ G22 定 H1 前工程项；G21 留待 Portal 管理面设计（§6 遗留项）
9. 每轮核对后更新本文对应小节、§10.3 补丁地图与决策日志

**逐层核对议程已全部走完（2026-08-14）。后续为工程项执行期 + H1 验收门：**

| # | 工程项 | 来源 | 状态（2026-08-14 执行轮） |
| --- | --- | --- | --- |
| E1 | 投资画像移除实施（五项清单） | D20/§7 | ✅ 已实施（commit；清单修正：/investment-state admin 总览保留——读的是持仓/预案非画像；投影键剔除迁移保守跳过与 StrategyYaml 冲突的 allocation/notes/markets） |
| E2 | T1 backend 接口化收拢（ACTIVE_BACKEND 仅存 lib/） | D21/§3 | ⏸ 重定界为 H1 后独立提交系列（见 D22）；本轮仅落地 alert-check 增量（随 E3） |
| E3 | risk_taxonomy.yaml workspace 死路径清理 | D19/§6 | ✅ 已实施（loadPriorityConfig 收敛为 SERVICE_PRIORITY_CONFIG 常量） |
| E4 | P4b 偏好散读点与 schedulerActivation 废除 | D13 | 🔓 已解锁（2026-08-15 真实数据迁移验证通过，P4a 幂等实证）→ 待执行 |
| E5 | G22 对话内文件交付修复 | §10.1 | ✅ 已实施（终态：`spreadsheet.create` 走官方 artifact 管线——deliveries/ 落盘 + publish 绑定 turn + assetId 链接资产库，回复挂标准附件卡片；经四轮收敛，中间两轮自创链接方案已撤销，见 D23；门户与正式仓字节对齐） |
| E6 | G23 trace tool_calls 事件捕获修复 | §8 | ✅ 已实施（Mastra≥1.5x payload 包装形状解包 + toolCalls/toolResults 聚合合并出终态；4 测试证据） |
| E7 | runtime 进 apps/ 物理迁移 | T5 | ⏸ 低优先 |
| E8 | workspace 回滚后端拆除 | D21/§4 | 🔓 门已开（2026-08-15 迁移验证 + H1 双门满足）→ 待执行（独立系列） |
| E9 | G21 巡检可见性 | §6 | ✅ v3 已实施（2026-08-15，两轮用户反馈演进）：专属 `/patrol` 页（PortalSidebar 同构布局）含**规则管理**（新建/编辑/启停/删除/试运行，经 rule_patrol.rules.* connector 命令直连 watch-rules 服务，写操作落审计）、状态卡、运行历史、立即巡检（不推送）。端到端实测 create/list/update/disable/dry-run/delete 全通 |
| E10 | **开销统计配套（按模型计费）** | D24 | ✅ 已实施（2026-08-15，C1-C4）：[cost-statistics-design.md](./cost-statistics-design.md)——per-model 费率注册表（临时值）、trace 写入时计价、幂等回填（候选历史 11 条已补）、admin 视图服务端化+按模型视图；费率终定后换表即可 |
| — | **Gate H1 本地最终体验验收** | 长工作包 | ✅ **已通过（2026-08-15）**：用户核验对话/文件/表格卡片交互/自动化任务列表/审计；长工作包完成，下一步为 R1 发布讨论（须用户另行授权） |
