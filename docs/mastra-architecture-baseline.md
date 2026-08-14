# Mastra 候选架构基线

状态：工作底稿（v1，2026-08-14）——记录本分支**已验证的架构事实**与**已确认的方向**，作为逐层核对的议程基线
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
| P5 | Agent 负责判断，服务负责确定性与事务；能力尽量经 MCP 外包、服务层保持窄边界 | 现状 50 工具全部进程内（research.* 已走外部 MCP） | 📌 已确认方向 / ⬜ 边界待盘点（见 §6） |
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
mcp/        工具注册层：service-tools-core(50) + scope 分类 + 外部 MCP 装配
services/   业务逻辑（58 文件）
lib/        数据后端：ACTIVE_BACKEND 三态切换 + mastra 投影 + workspace 兼容
db/         schema + drizzle
```

分层张力（阅读复杂度来源，按影响排序）：
- T1 `ACTIVE_BACKEND` 三元分支散布约 20 文件；`sqlite` 态实际死路径、`workspace` 态仅回滚保险 → 收敛方向：backend 接口化收拢到 `lib/`，上层只见接口 ⬜ 待核对
- T2 投影行内多域共存（`profile_json` 兄弟键 + merge 写入约定）——隐式契约 ⬜
- T3 表命名双轨（`mastra_*` vs `chat_history`/`methodology_profiles` 活表）⬜
- T4 onboarding 双实现（routes/sandbox 内联 vs service-tools-core）⬜
- T5 runtime 未进 `apps/`，src 平铺 ⬜
- T6 观测层：trace `tool_calls` 系统性为空（G23）⬜

## 4. 数据架构 ✅ 已验证

| 层 | 内容 | 备注 |
| --- | --- | --- |
| service 表 | 用户/实例/对话/trace/调度/push/自动化/资产/审计/规则 | 与 main 共享 |
| mastra 投影 3 表 | `mastra_portfolio_states`、`mastra_project_profiles`（含 `tradingStrategies` 兄弟键）、`mastra_runtime_preferences` | 空默认+惰性建行语义（与 workspace 等价）；revision 乐观锁 |
| ledger | `mastra_review_memory_records`：日计划/周期复盘/方法变更/观点/service 事件 | append-only；行为统计已接入 |
| 受控文件根 | `data/mastra-projects/<sha256>`：资产版本字节/附件/staging | registry 主导，禁止回退 legacy 根 |
| legacy 双轨 | `WORKSPACE_BACKEND=workspace` 全套（回滚后端）；`chat_history`、`methodology_profiles` 为 mastra 模式活表 | 功能等价、命名未收敛 |

## 5. 能力面：service tools 盘点（50 个）📌 方向已确认，逐工具归属待核对

**已确认方向**：大部分能力应通过 MCP 外包；服务层能力需要明确边界。逐工具归属是后续核对议题。

按域分组现状（全部进程内、共享 case 骨架）：

| 域 | 工具 | 初步归属倾向（待核对） |
| --- | --- | --- |
| 读取类 | portfolio.read、watchlist.read、plans.read、conversation.history、confirmations.pending、watch_rules.list/catalog、market_watch.snapshot、file.parse | 状态读取属服务核心；market_watch.snapshot/file.parse 疑可外包 |
| 研究类 | research.news_search / web_search / web_read | 已是外部 MCP 装配 ✅ 外包样板 |
| 写入+确认类 | portfolio.apply_changes、watchlist.add、plans.set/watch_conditions、method_changes.propose/apply、preferences.apply、watch_rules.create、confirmations.request | 服务核心（确认门/事务/审计不可外包） |
| Onboarding | confirm_portfolio/step/complete_watch_setup + draft.* 9 个 | 服务核心（多域事务）；draft.* 9 个工具粒度可再盘 |
| 资产/文件 | assets.* 8 个、artifacts.publish、spreadsheet.create | 资产索引属服务核心；spreadsheet.create 疑可外包 |
| 自动化 | automation.create/get/list/update/activate/pause | 服务核心（调度绑定） |
| 复盘 | reviews.save | 随"复盘并入自动化"重审（见 §7） |

**边界判据（草案，待核对）**：凡需要 确认门/审计/锁/scope/事务提交/调度绑定的留在服务层；纯读取、纯内容生成（表格/解析/快照）优先外包为 MCP。

**预设模型落地后的收敛裁决案（2026-08-14，待用户确认）**：
- C5：`reviews.save` 定**服务核心**（任务完成契约本体，并入 A 批）；`market_watch.snapshot` 维持**外包候选**（B 批）
- C1：confirm 三件套已在 A 批（多域事务核心）；draft 七件套建议**收缩**——保留 `draft.get / upsert_step / request_confirmation`（对话式持仓导入仍需），`accept_step / skip_watch_rules / enqueue_commit / commit_status` 随新 onboarding 设计 Portal 化（节奏语义已由 applyPreset 承接，无需对话式灌输）
- 净效果：Agent 工具面从 50 收敛到约 46（若 B 批外包再实施则更少）

## 6. 调度与自动化 📌 方向已确认，重设计待核对

**现状**：两条并行线——
1. `src/scheduler/` 硬编码循环：market-watch（盘中简报）、review（日/周/月复盘预生成+触发）、alert-check（规则巡检）、retention 清理
2. 通用自动化任务系统：`automation.*`（schedule: daily/trading_days/weekdays/weekly + time + inputs 资产绑定 + output/delivery）

**已确认方向**：
- 复盘、盯盘（market-watch）并入自动化任务系统，scheduler 只保留触发器角色 ⬜ 待设计（注意：automation schedule 枚举缺 `monthly`；复盘的 kind 语义、预生成暂存、push 策略需映射为任务参数）
- 规则巡检（rule inspection）重新设计 ⬜ 之前已标记过重审；现状 = `price_cross` 单规则类型 + 调度器内确定性巡检 + mastra 下优先级硬编码
- 调度激活语义：onboarding 完成 = 可调度（已实现）；巡检可见性（Portal 管理面）为后续 Portal 设计点（G21）

## 7. 投资画像（investment profile）📌 已确认移除

- **证据**：运行时消费面仅 `routes/sandbox.ts` 的 GET/PUT profile 端点与 platform 快照；**Agent 工具面（50 工具）与 prompt 均不使用**；投资画像与方法变更（method_changes → `profile_json`）是两套东西
- 待核对：移除范围清单（HTTP 端点、`investmentProfiles` 表读写、`mastra_project_profiles` 中画像键的存废、platform 展示）

## 7.5 产品语义重构讨论（2026-08-14，未决，讨论中）

**问题提出**：onboarding 承载的"低打扰 + 复盘节奏"是一套面向特定用户群的产品语义（onboarding + 日/周/月复盘 + 盯盘机制），但 Portal 自动化使系统演化为支持更广义用户与个性化策略的通用框架，这套语义被涵盖。**方向假说**：不兼容现状，先立通用框架，把"低打扰复盘型"对象化为**可选初始化包（preset）**——与策略可选同级的一种"使用方式"，需要新的 onboarding 设计。

**偏好生效性核验（事实）**：
- 生效链（mastra 路径）：`schedules.daily/weekly/monthly_review` → 复盘触发（scheduler/review.ts:114 用 scope 实例）；`schedules.market_watch.default_windows` → 盯盘窗口（scheduler/index.ts:440 用 scope 实例）；notification mode + `watch.only_push_on_exception` → 盯盘推送模式（scheduled-tasks.ts:438-448）
- **缺陷**：scheduled-tasks.ts:440/453 与 scheduler/index.ts:550 三处用硬编码 `DEFAULT_INSTANCE_ID` 读偏好——非 primary 用户（其实例为 `invest-agent-<userId>`）读到空行回落默认，即**盯盘推送偏好对非默认实例用户不生效**；且与 review/market-watch 调度的 scope-aware 读取不一致
- 结构性问题：偏好→行为的应用点散落 5 处，无统一应用面

**D3 映射草案（偏好 → 自动化任务）**：notification mode → 任务 delivery policy；market_watch windows → 盯盘任务 schedule；review 节奏 → 复盘任务 schedule；only_push_on_exception → 任务 push policy / 全局投递策略；schedulerActivation → 被"任务存在即启用"取代（顺带解决 G21 可见性：任务列表即调度可见面）。

**影响**：第一轮 C1（onboarding 工具）、C5（reviews.save/market_watch.snapshot）挂起至预设模型定稿。

**讨论收口（2026-08-14 同日）**：用户确认按 D9 语义归属原则推进，讨论收敛为两份待审设计稿——预设对象体系（[preset-system-design.md](./preset-system-design.md)）与复盘/盯盘任务化+偏好映射（[scheduled-flows-to-automation-design.md](./scheduled-flows-to-automation-design.md)）。偏好读取 scope 缺陷（三处硬编码 DEFAULT_INSTANCE_ID）已当场修复。

## 8. 可观测性 ⬜ 待核对

- trace 链路：`agent_traces`（backend/model/status/usage/耗时）写入正常；**`tool_calls` 系统性为空（G23）**——run-turn 未捕获当前 Mastra 版本的 tool-call 事件形状
- 这是追踪契约（next-phase-plan 工作流 A）的地基缺口，优先级最高

## 9. 模型与网关 ✅ 已验证

- `model-gateway` 纯解析层（env/参数 → provider/model 描述符），回合级快照、切换只影响后续回合（有测试）
- 无静默 fallback；Platform 不见 key

## 10. 用户体验架构

### 10.1 通道矩阵 ✅

| 能力 | 微信 | Portal |
| --- | --- | --- |
| 对话（含附件识别） | ✅ 简洁 Markdown + 输出净化 | ✅ 结构化/表格/SVG |
| 文件 | — | 我的文件（版本/下载）✅、对话内直链 ❌（G22） |
| 自动化管理 | — | 任务/运行/模板 |
| 调度可见性 | — | ❌ 无承载（G21，后续设计） |

### 10.2 核心旅程 ✅（自动化证据）

上手（onboarding，完成即调度）→ 日常问答/确认写 → 盯盘简报 + 规则提醒 → 日/周/月复盘（含行为纠偏统计）→ 文件（Excel 交付→我的文件）。
断点：G22 对话内直链、复杂回合 162s、H1 未人工验收。

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

## 12. 逐层核对议程（建议顺序）

1. **预设与任务化设计稿审阅**（D9 关联两稿，含各自开放问题）——当前焦点
2. **能力面盘点与 MCP 外包边界**（§5，P5）——50 工具逐个定归属；C1/C5 在预设模型定稿后一并收敛
3. **架构原则定稿**（§1）——P1-P4 补充证据，P6 随 D7 落地
4. **规则巡检重设计**（§6 独立线）
5. **投资画像移除范围**（§7）
6. **数据层收敛**（§3 T1-T3、§4 双轨）
7. **观测层**（§8，G23）
8. **UX 断点**（G22 对话直链、G21 调度可见性——G21 由任务化设计 §3 一并解决大半）
9. 每轮核对后更新本文对应小节、§10.3 补丁地图与决策日志
