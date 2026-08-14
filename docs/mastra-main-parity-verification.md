# Mastra ↔ main 幂等验证

状态：进行中
分支：`feat/mastra-migration`（并行探索分支，非合并候选）
创建日期：2026-08-14

## 1. 目标

验证 Mastra 候选运行时与 `main` 生产运行时在**用户可感知的业务能力**上达到幂等。幂等的定义是：

> 给定相同的用户请求和相同的底层数据，两个运行时产生等价的业务结果（回复内容、数据变更、产物交付、副作用范围）。

达到幂等 + Mastra 内核模型可切换 + Workspace 重整 = 初步完成。

## 2. 幂等的边界

### 2.1 什么是幂等

| 维度 | 要求 |
| --- | --- |
| 用户回复 | 相同输入下，投资结论、事实依据、行动建议口径一致；呈现格式差异可接受 |
| 数据变更 | 相同操作对 portfolio/watchlist/plans/preferences 的最终写入等价 |
| 工具调用 | 覆盖相同的服务能力域（持仓、自选、预案、提醒、复盘、文件、自动化） |
| 副作用 | trace 记录、artifact 发布、确认流程、schedule 触发的范围和终态等价 |
| 错误处理 | 相同的错误条件（超时、取消、busy）产生相同分类和用户可理解的中性错误 |

### 2.2 什么不是幂等验证

- **不要求执行内核相同**：ACP/Codex subprocess vs Mastra Agent runtime 不影响幂等判断。
- **不要求工具名相同**：工具命名和粒度可以不同，只要覆盖的业务能力等价。
- **不要求性能相同**：响应时间差异单独跟踪（当前已知复杂回合约 162s）。
- **不要求代码相同**：架构重构（中性 `src/runtime/` 层、Mastra provider）是预期的。

### 2.3 能力幂等的真实层次

工具注册表一致（50 个工具同名同 case 骨架）只是最浅的一层。用户视角的能力幂等至少包含四层，每层都可能独立失配：

| 层 | 含义 | 典型失配（本分支实际发生） | 状态 |
| --- | --- | --- | --- |
| L1 工具可用性 | 同样的工具集合、参数 schema、prompt 指引 | 工具层无失配；onboarding 三工具被守卫阻断（G1-G3） | ✅ 已修复 |
| L2 数据可得性 | 同样的用户状态导致同样的读取/写入结果，而不是工具"能调通但读不到/写不进" | mastra backend 对缺失 projection 行读取抛错、写入抛错；新用户 onboarding 前所有持仓/自选/预案工具与 scheduler 复盘/到价链路硬失败，而 workspace 语义是空默认 | ✅ 已修复（空默认 + 惰性建行） |
| L3 端到端业务结果 | 相同用户请求 → 等价回复/数据变更/交付（含 confirmation gate、审计、幂等重试） | confirmation/audit/错误分类逐行一致；复杂回合 162s 性能差异单列 | ⚠️ 自动化证据已覆盖工具与数据层；Agent 回合级行为对照仍依赖 H1 抽查 |
| L4 边界与退化 | 超时/取消/busy/权限拒绝/revision 冲突的分类与用户可见结果一致 | 错误分类零差异；revision 乐观锁语义保留 | ✅ |

**判定纪律**：任何一层失配都构成能力缺口，与工具数量无关。L2 的教训是——case 骨架 diff 全绿仍可能整条链路不可用，必须用"新用户冷启动 + 既有数据双轨"两类真实状态驱动验证，而不是只比对代码形状。

## 3. 当前差异全景

### 3.1 架构层差异（预期内，不影响幂等）

| main | mastra 分支 | 性质 |
| --- | --- | --- |
| `src/acp/`（16 文件）| `src/mastra/`（16 文件）+ `src/runtime/`（10 文件）| 内核替换，预期内 |
| `createAgent()` → ACP stdio | `createRuntimeAgent()` → Mastra turn | 入口对称，预期内 |
| `recordAcpTrace` | `recordAgentTrace(agentBackend: "mastra")` | trace 中性化，预期内 |
| `src/services/codex-usage.ts` | `src/services/agent-usage.ts` | 命名中性化，预期内 |

### 3.2 工具体系差异（修正后）

> **重要修正（WP-P1 执行发现）**：初始分析误将 `runtime/tool-manifest.ts`（20 个旧工具名）当作 main 的工具全集。实际上两个分支的**活跃工具注册层**都是 `src/mcp/service-tools-core.ts`，且该文件在两个分支上几乎完全一致。

#### 3.2.1 两层工具声明的角色

| 层 | 文件 | 角色 | 是否在活跃运行时路径 |
| --- | --- | --- | --- |
| MCP 注册层 | `src/mcp/service-tools-core.ts` | Agent runtime 实际调用的工具 | ✅ 两个分支都在用 |
| Context packet 声明层 | `src/runtime/tool-manifest.ts`（main: `src/acp/tool-manifest.ts`）| 构建 context packet 时的工具清单描述 | ❌ `includeContextPacket: false`，两个分支都不在活跃路径 |

#### 3.2.2 MCP 注册层的精确差异

| | main | mastra 分支 |
| --- | --- | --- |
| 工具总数 | 49 | 50 |
| 唯一差异 | — | 新增 `spreadsheet.create` |

**两个分支共享 49 个完全同名的工具**。唯一新增是 `spreadsheet.create`，属于 mastra 分支的 Excel 交付能力增强，不影响幂等。

#### 3.2.3 context-packet 声明层的遗留旧名

`runtime/tool-manifest.ts` 仍保留 20 个旧工具名（`portfolio.query`、`alerts.check` 等），但它只在 `includeContextPacket: true` 时被使用。两个分支的 agent 入口都设为 `false`，因此这些旧名**不影响幂等**，但属于 WP6 清理对象。

#### 3.2.4 结论

工具注册层**已达到幂等**。幂等验证的重心不在工具注册层，而在：

1. **prompt 构建层**：`buildAgentPromptContext`（mastra）vs `buildAcpPromptContext`（main）的输出差异。
2. **执行层**：ACP budget convergence vs Mastra maxSteps 的行为差异。
3. **工具 schema 差异**：虽然工具名一致，但 inputSchema 可能有改动（需逐工具 diff）。

### 3.3 服务层差异

`src/services/` 两个分支几乎完全一致（58 vs 58 文件），仅命名中性化差异（`codex-usage.ts` → `agent-usage.ts`）。业务逻辑实现是共享的，幂等风险集中在 prompt 和执行层。

## 4. 验证工作包

### WP-P1：工具语义映射矩阵

**目标**：确认 main 的活跃工具在 mastra 分支都有业务等价覆盖，或标注为真实缺口。

**方法**：
- 区分两层工具声明：MCP 注册层（活跃）vs context-packet 声明层（不活跃）。
- 对照两个分支的 `src/mcp/service-tools-core.ts` 工具清单。
- 确认遗留旧工具名不在活跃运行时路径。

**验收**：MCP 注册层工具差集明确，遗留旧名确认不在活跃路径。

**发现**：
- 两个分支共享 49 个完全同名的工具（MCP 注册层）。
- mastra 分支唯一新增 `spreadsheet.create`，不影响幂等。
- `runtime/tool-manifest.ts` 的 20 个旧名在两个分支都因 `includeContextPacket: false` 不在活跃路径。
- 工具注册层已达到幂等。

**遗留项**（移交 WP-P3）：
- 49 个共享工具的 inputSchema 可能有逐工具差异，需在 WP-P3 回归场景中覆盖。
- `runtime/tool-manifest.ts` 旧名清理移交 WP6（历史兼容清理）。

**状态**：✅ 完成（2026-08-14）

### WP-P2：prompt 契约对照

**目标**：确认两个分支向 Agent 传递的 system prompt / channel context / attachment context 在语义上等价。

**方法**：
- 逐文件 diff prompt 构建链。
- 覆盖：`prompt-context-builder.ts`、`mobile-prompt.ts`、`buildChannelContextInstruction`、`buildChannelForwardPrompt`、`buildAttachmentPrompt`。

**验收**：prompt 差异清单，每个差异标注 `cosmetic` / `semantic` / `regression`。

**发现**：

| 文件 | 差异 | 分类 |
| --- | --- | --- |
| `prompt-context-builder.ts` | 移除 sandbox token 文件写入（`.sandbox-token`）| `accepted`：WP1 Workspace 运行环境退出的预期成果 |
| `mobile-prompt.ts` | 移除 `sandboxTokenFile` 字段 | `accepted`：同上 |
| `buildChannelContextInstruction`（web 通道）| 新增 `spreadsheet.create` prompt 指令 | `accepted`：新增能力指引，不改变已有指令 |
| `buildChannelForwardPrompt` | 无差异 | — |
| `buildAttachmentPrompt` | 无差异 | — |

**结论**：prompt 正文（投资纪律、事实标准、确认流程、输出规则、附件处理、通道上下文）在两个分支**语义等价**。唯一差异是 WP1 预期的 sandbox token 移除和 `spreadsheet.create` 新增指引，均不影响幂等。

**状态**：✅ 完成（2026-08-14）

### WP-P3：核心业务流回归

**目标**：确认共享的 49 个工具在两个分支上的 service 函数绑定和 inputSchema 等价，发现行为差异。

**方法**：
- 对 `src/mcp/service-tools-core.ts` 做逐工具 diff（排除新增的 `spreadsheet.create`）。
- 确认 `ACTIVE_BACKEND` 条件分支是否引入了行为差异。

**发现**：

#### P3.1 工具 case 逻辑 diff

`service-tools-core.ts` 共 268 行差异：
- **248 行**属于新增的 `spreadsheet.create`（不影响幂等）。
- **20 行**属于 import 区（新增 `exceljs`、`mastra-portfolio-backend`、`MastraUserPreferenceStore` 等）。
- **共享的 49 个工具 case 逻辑骨架完全一致**（零行差异）。

#### P3.2 ACTIVE_BACKEND 条件分支

共享工具的 case 逻辑骨架一致，但内部通过 `ACTIVE_BACKEND === "mastra"` 做了条件分支。运行时默认 `ACTIVE_BACKEND = "mastra"`（`src/lib/data-backend.ts:44`），测试用 `WORKSPACE_BACKEND=workspace`。

| 工具 | mastra 模式行为 | workspace 模式行为（main 等价） | 幂等状态 |
| --- | --- | --- | --- |
| `portfolio.read` | 读 `mastraProjectProfiles` 表 | 读 YAML 文件 | ✅ 读取语义已等价（2026-08-14：缺失行返回空默认，不再抛错） |
| `portfolio.apply_changes` | 走 mastra projection 写入 | 走 workspace YAML 写入 | ✅ 写入语义已等价（缺失行惰性建行）；数据内容等价仍属 WP2 |
| `watchlist.read` / `watchlist.add` | mastraWatchlistBackend | workspaceWatchlistBackend | ✅ 同上 |
| `plans.read` / `plans.set` | mastraPlanBackend | workspacePlanBackend | ✅ 同上 |
| `onboarding.confirm_portfolio` | `openMastraOnboardingStore` 内存事务 + 三表 upsert | 正常执行 | ✅ 已补齐（2026-08-14） |
| `onboarding.confirm_step` | `openMastraOnboardingStore` 内存事务 + 三表 upsert | 正常执行 | ✅ 已补齐（2026-08-14） |
| `onboarding.complete_watch_setup` | `openMastraOnboardingStore` 内存事务 + 三表 upsert；DB 操作原样复用 | 正常执行 | ✅ 已补齐（2026-08-14） |
| `method_changes.apply` | mastraProjectProfiles 写入 | workspace YAML 写入 | ⚠️ 写入路径不同 |
| `preferences.apply` | `MastraUserPreferenceStore` | workspace YAML 写入 | ⚠️ 写入路径不同 |
| 其余 ~40 个工具 | 无 backend 分支，直接调共享 service 函数 | 同 | ✅ 等价 |

#### P3.3 幂等缺口分类

| 缺口 | 类型 | 影响 |
| --- | --- | --- |
| ~~onboarding 写操作 3 个工具抛错~~ | ~~`regression`~~ | **已补齐（2026-08-14）**：`src/services/onboarding.ts` 新增 `openMastraOnboardingStore`（缺失行返回默认空态 + persist 三表 upsert）；service-tools-core 三函数与 routes/sandbox 两路由移除守卫接入该工厂；`publishWorkspaceArtifacts` 加 `isWorkspaceBackend()` 守卫。证据：`tests/mastra-onboarding-confirm-write.test.ts` 覆盖新用户 confirm_portfolio（无 projection 行冷启动）、confirm_step(style)、complete_watch_setup(skip) 三流程 |
| portfolio/watchlist/plan/preferences 读写路径不同 | `pending-decision` | 依赖 WP2 数据 ownership 重整；需确认 mastra projection 与 workspace YAML 数据等价 |
| 其余 ~40 个工具 | 无缺口 | 共享 service 函数，行为等价 |

**状态**：✅ 完成（2026-08-14）

### WP-P4：副作用与错误分类对照

**目标**：确认 trace 记录、错误分类和 confirmation gate 在两个运行时下等价。

**方法**：
- 对照 trace 写入函数和表。
- 对照错误分类函数（`classifyTaskError`）。
- 对照 agent 入口的 catch 块错误映射。

**发现**：

#### P4.1 错误分类

`src/services/task-execution.ts`（`classifyTaskError`）在两个分支**完全一致**（逐行 diff 零差异）。

| 错误条件 | 分类 | code | 用户消息 | retryable | 两分支一致 |
| --- | --- | --- | --- | --- | --- |
| 超时 | timeout | `TASK_TIMEOUT` | "任务处理时间较长…" | true | ✅ |
| 取消 | cancelled | `TASK_CANCELLED` | "这项任务已停止…" | false | ✅ |
| 其他 | error | 动态 | 动态 | 动态 | ✅ |

mastra 分支额外增加了 `MASTRA_TURN_BUSY` → `MASTRA_TURN_BUSY` 映射（`runtime/agent.ts:189-194`），main 无此分支（ACP 无 busy 概念）。

#### P4.2 trace 记录

| | main | mastra 分支 |
| --- | --- | --- |
| 写入函数 | `recordAcpTrace` | `recordAgentTrace` |
| 写入表 | `codex_acp_traces` | `agent_traces` |
| truncate 逻辑 | 一致 | 一致 |
| 环境变量名 | `ACP_TRACE_STORE_*` | `AGENT_TRACE_STORE_*` |
| agentBackend 字段 | `acp_backend` | `agentBackend` |
| model 字段 | `acp_model` | `agentModel` |

trace 写入了**不同的表**。这不影响幂等判断（trace 是审计记录，不是业务结果），但历史数据查询需要一次性迁移。两张表在当前分支 DB schema 中并存（`codex_acp_traces` + `agent_traces`）。

#### P4.3 confirmation gate

confirmation gate 逻辑在 `service-tools-core.ts` 的共享 case 中（WP-P3 确认 case 骨架零差异），两个分支一致。

**状态**：✅ 完成（2026-08-14）

### WP-P5：幂等差距清单与处置决策

**目标**：汇总 WP-P1 到 WP-P4 发现的所有差距，分类处置。

**差距分类**：
- `accepted`：预期内的架构差异（如内核替换、命名中性化），不影响幂等。
- `regression`：mastra 分支丢失了 main 的业务能力，需要补齐。
- `intentional-change`：mastra 分支有意改变了行为，需用户确认是否接受。
- `pending-decision`：依赖其他工作包（WP2 数据 ownership）才能判定。

#### 差距清单

| # | 来源 | 差距 | 分类 | 处置 |
| --- | --- | --- | --- | --- |
| G1 | P3.2 | ~~`onboarding.confirm_portfolio` 在 mastra 模式抛错~~ | `fixed` | ✅ 已补齐：`openMastraOnboardingStore` 多域事务，测试 `mastra-onboarding-confirm-write.test.ts` |
| G2 | P3.2 | ~~`onboarding.confirm_step` 在 mastra 模式抛错~~ | `fixed` | ✅ 已补齐：同 G1 |
| G3 | P3.2 | ~~`onboarding.complete_watch_setup` 在 mastra 模式抛错~~ | `fixed` | ✅ 已补齐：同 G1；DB 侧 confirmation/rule/audit 操作原样复用 |
| G4 | P3.2 | portfolio/watchlist/plan 读写走不同存储（mastra projection vs workspace YAML） | `partially-fixed` | 读写**语义**已等价（2026-08-14）：缺失行返回空默认、首次写入惰性建行（`mastra-portfolio-backend.ts`），新用户 `portfolio.read`/`watchlist.read`/`watchlist.add`/`plans.set` 及 scheduler 复盘/到价链路与 workspace 行为一致。**数据内容**等价（迁移用户 YAML ↔ projection 逐字段一致）仍属 WP2 |
| G5 | P3.2 | preferences/method_changes 写入路径不同 | `partially-fixed` | preferences 读写已走 `MastraUserPreferenceStore`（缺失行空默认 + 惰性建行，与 G4 同语义）；method_changes 的等价性验证随 WP2 |
| G6 | P4.2 | trace 写入 `agent_traces` 而非 `codex_acp_traces` | `accepted` | 预期内；历史数据迁移属独立工作 |
| G7 | P1 | `runtime/tool-manifest.ts` 保留 20 个旧工具名 | `accepted` | 不在活跃路径；移交 WP6 清理 |
| G8 | P2 | sandbox token 文件写入已移除 | `accepted` | WP1 预期成果 |
| G9 | P2 | web 通道新增 `spreadsheet.create` prompt 指令 | `accepted` | 新能力指引 |
| G10 | P1 | 新增 `spreadsheet.create` 工具 | `accepted` | 新能力，不影响已有功能 |
| G11 | 代码盘点 | automation-task-migration 备份无条件写 legacy workspace 根，mastra 模式硬失败 `AUTOMATION_WORKSPACE_NOT_FOUND` | `fixed` | ✅ 已修复（2026-08-14）：备份根改走 `workspacePathForScope`（mastra → 注册项目根），与其他资产写入点一致 |
| G12 | 代码盘点 | 策略库 CRUD 在 mastra 模式返回 `MASTRA_STRATEGY_LIBRARY_NOT_READY`（routes/sandbox.ts 三路由）；`config/trading_strategies.yaml` 无 mastra 投影 | `fixed` | ✅ 已修复（2026-08-14）：新增 `src/lib/mastra-strategy-library.ts`——策略列表存于 `mastra_project_profiles.profile_json.tradingStrategies` 兄弟键，读写/删除语义与 `WorkspaceStore`（按 key upsert、`created_at` 保留、`enabled` 默认 true、孤儿引用不级联）逐条对齐；三路由接入 mastra 分支（审计与 confirmation gate 复用）；同步修复 `writeMastraStrategyProjection` 整体覆盖问题（改为与既有 payload 合并，方法变更写入不再抹掉兄弟域）。证据：`tests/mastra-strategy-library.test.ts`（空默认/惰性建行/upsert 戳记/兄弟键保留/非法形状 fail-closed） |
| G13 | 代码盘点 | 复盘行为统计 `collectBehaviorStats`（handlers/review.ts）mastra 恒 `available:false`；行为事件无 mastra 数据源（`chat_history` 有数据但未接入） | `fixed` | ✅ 已修复（2026-08-14）：新增 `collectMastraBehaviorStats`——`action_confirmed` 从 `mastra_review_memory_records` 的 service_event 聚合（`recordTradeAction` 写入，payload `event_type` 标记与 reviews.save 的 decision 记录天然区分；按业务时间排序，同毫秒插入不受行序影响）；`conversationTurnCount` 从 `chat_history` 的 user 行计数（mastra 每轮写 user+assistant 两行）；`out_of_scope_query` 两个 backend 均无写入方，计数 0 是诚实值。周/月复盘 context 的 `behaviorStats` 在 mastra 下 `available:true`。证据：`tests/mastra-review-behavior-stats.test.ts`（范围过滤/轮次计数/decision 记录排除/最近动作详情） |
| G14 | 代码盘点 | 微信对话记忆 mastra 模式回落 legacy `chat_history` 表（weixin-conversation-memory.ts:49-68），WP4.6”消除 chat_history 主路径写入”未在 mastra 达成 | `accepted` | ✅ 关闭（2026-08-14 核对）：`chat_history` 是 service-owned SQLite，满足目标 ownership（方向已从”消除表”反转为”SQLite 为权威”）；读写完整且已被 G13 行为统计消费。并入 mastra 台账属 WP2 整理项，非能力缺口 |
| G15 | 代码盘点 | methodology profile 读写在 mastra 回落 legacy `methodology_profiles` 表（routes/sandbox.ts:214/1541）；investment profile 有 `mastra_project_profiles` 投影而 methodology 没有 | `accepted` | ✅ 关闭（2026-08-14 核对）：`methodology_profiles` 同为 service-owned SQLite，读写完整；是否并入 profile 投影属 WP2 命名收敛，非能力缺口 |
| G16 | 代码盘点 | `method_changes.apply` 的 change_log 追加在 mastra 跳过（service-tools-core.ts:1867），仅剩 sandbox audit | `accepted` | 审计走 DB 表；若需用户可见变更历史再补投影 |
| G17 | 代码盘点 | 确认类操作（onboarding/preferences/method-change/portfolio）的 `publishWorkspaceArtifacts` 在 mastra 为空，无文件快照交付（reviews 有 conversation artifact 补偿） | `accepted` | ✅ 按用户裁决关闭（2026-08-14）：YAML 配置文件本身不是面向用户的交付物，main 上"确认后 Portal 可下载 config 快照"只是 workspace 实现的副产品，实际价值不大；mastra 下配置经 SQLite 投影生效，不需要等价文件交付 |
| G18 | 代码盘点 | 调度激活门控：mastra 下 scope 需 `schedulerActivation === "enabled"` 才可调度，onboarding 默认 disabled 且无用户自助开启路径；schedules 空默认使定时任务永不触发（workspace 模板默认时间不存在） | `fixed` | ✅ 已按用户裁决落地（2026-08-14）：**走完 onboarding 即可调度**。两条完成路径（draft commit / confirm 工具）在 onboarding state 变 `completed` 时将 `schedulerActivation` 置 `enabled`；中途步骤保持原值/默认 disabled；迁移导入的 target 仍保持显式启用语义（脚本路径不变）。onboarding 的 review_schedule / market_watch_schedule 步骤会写入默认时间表，完成后定时任务即可命中 |
| G19 | 代码盘点 | 卫生项：file-retention 空附件目录修剪只扫 legacy 根；file-retention.ts:6 死导入；backfill 治理作业不感知 mastra 根 | `accepted` | 纯 cosmetic / 一次性作业范围，不阻断 |
| G20 | 代码盘点 | `preparedReviewPath` 依赖已注册项目根；scope 启用调度但未注册项目时预生成阶段每日常态 error 日志 | `verified` | 设计上闭环：onboarding 完成发生在会话内（confirm 工具需 conversationId），而会话路径 `ensureConversationRuntime` 在 mastra 模式先 bootstrap 项目根，故完成 onboarding 的 scope 必有已注册项目根。兜底行为：预生成失败记 error 并回落 `runScheduledReviewTask`，非致命 |
| G21 | 产品决议记录 | 巡检（scheduler/automation 运行）需要**可见性**便于管理，但当前 Portal 无对应承载页面 | `future-design` | 用户已确认属后续 Portal 设计点：调度/巡检运行状态、最近结果、手动触发与启停的管理面。在 Portal 同仓契约矩阵（B2）扩展时一并设计，不算当前幂等缺口 |
| G22 | Portal 实测 | 对话内文件交付缺直链：`spreadsheet.create` 成功后助手回复中的链接是模型虚构的 `sandbox:/mnt/data/...` 格式，消息 metadata 无 artifact 附件；文件仅能从 Portal「我的文件」访问（已验证可见、可下载） | `fixed` | ✅ 已修复（2026-08-14 E5）：工具结果新增 delivery 指引（指名文件 + 「我的文件」入口，明令禁止编造 sandbox:/mnt/data 或任何 URL 直链）+ web 通道指令同步强化；测试 `mastra-spreadsheet-delivery-guidance.test.ts`。消息内资产卡片（artifact 附件）受发布路径白名单限制，留 G21/E9 Portal 设计一并考虑 |
| G23 | Portal 实测 | trace `tool_calls` 系统性为空：候选 DB 全部 13 条 trace 均无工具终态记录（`run-turn` 的事件映射未捕获当前 Mastra 版本的 tool-call 流形状） | `fixed` | ✅ 已修复（2026-08-14 E6）：根因为 Mastra≥1.5x 聚合/流 chunk 将数据包在 `payload` 对象内而映射器只读顶层字段；现已 payload 解包 + `toolCalls`/`toolResults` 聚合按 toolCallId 合并出终态（isError→success/error、输出尺寸、完成时间）+ v5 tool-input/tool-output 流事件识别；测试 `mastra-turn-tool-call-capture.test.ts`（4 例） |

#### 幂等结论

**工具注册层和 prompt 层已达到幂等。** 49 个共享工具的 case 逻辑骨架零差异，prompt 正文语义等价，错误分类完全一致。

**G1-G3 已补齐（2026-08-14）**：onboarding 三个写操作在 mastra 模式下经 `openMastraOnboardingStore`（内存事务 + `mastra_portfolio_states`/`mastra_project_profiles`/`mastra_runtime_preferences` 三表 upsert）执行；新用户无 projection 行时按 workspace 语义给默认空态。工具层（service-tools-core）和 HTTP 层（routes/sandbox 两个 onboarding 路由）均已解除阻塞。

**G4-G5 读写语义已等价（2026-08-14）**：`mastra-portfolio-backend` 此前对缺失 projection 行读取抛 `MASTRA_PROJECTION_NOT_FOUND`、写入抛错——与 workspace 的"返回空默认、写入即建文件"语义不一致，导致 mastra 模式新用户在完成 onboarding 前所有 portfolio/watchlist/plan 工具和 scheduler 复盘/到价链路硬失败。现已改为空默认读取 + 惰性建行写入，乐观锁（revision conflict）语义保留。证据：`tests/mastra-onboarding-confirm-write.test.ts` 第二个测试（新用户冷读取返回空、首次 watchlist.add 惰性建行）、`tests/mastra-service-owned-read-adapter.test.ts` 更新后的期望。

**待验证（G4-G5 剩余部分）**：迁移用户的数据内容等价（workspace YAML ↔ mastra projection 逐字段一致）属 WP2 数据 ownership 重整的验收范围，不属于运行时语义缺口。

**代码盘点新增缺口（2026-08-14，G11-G21）**：对 src/ 全部 Workspace 引用按 mastra 模式行为逐路径扫描后新增 11 项。其中 G11、G12、G13、G18 已当场修复（G18 按用户裁决"走完 onboarding 即可调度"落地）；G17（确认后文件快照交付）按用户裁决关闭——YAML 本就不是面向用户的交付物；G21（巡检可见性）记录为后续 Portal 设计点。运行环境层结论：35 处 `WorkspaceStore` 实例化全守卫、`ensureWorkspace` 全隔离、mastra 路径零 AGENTS.md/cwd 读取——WP1 的"无 Workspace Agent 运行时"经代码级验证成立（详见 ownership-inventory 代码路径盘点节）。

**初步完成判定**：

> 工具 + prompt + 错误 + 数据读写语义四层与 main 达到能力幂等，全部 `regression` 级缺口已修复或经产品裁决关闭；G14/G15 经核对为 service-owned SQLite，关闭。剩余：G22/G23（H1 前置实测发现的对话内直链与 trace 工具终态观测，`pending-fix`）、WP2 迁移数据内容等价验证（G4/G5 剩余部分）、G21 巡检可见性（后续 Portal 设计）。

**状态**：✅ 完成（2026-08-14）

## 5. 执行顺序

```
WP-P1（工具映射）→ WP-P2（prompt 对照）→ WP-P3（业务回归）→ WP-P4（副作用对照）→ WP-P5（差距汇总）
```

WP-P1 是其余所有 WP 的基础：只有先确认工具语义映射，才能定义回归场景和断言点。

## 6. 进度记录

| 日期 | WP | 动作 | 结果 |
| --- | --- | --- | --- |
| 2026-08-14 | — | 创建本文档，完成初始差异全景分析 | 工具映射矩阵待建 |
| 2026-08-14 | WP-P1 | 执行工具语义映射 | ✅ 完成：MCP 注册层 49 工具共享，仅新增 spreadsheet.create；旧 tool-manifest 20 名不在活跃路径。工具层已幂等，重心转向 prompt 和执行层 |
| 2026-08-14 | WP-P2 | 执行 prompt 契约对照 | ✅ 完成：prompt 正文语义等价；唯一差异是 sandbox token 移除（WP1 预期）和 spreadsheet.create 新增指引（新能力），均不影响幂等 |
| 2026-08-14 | WP-P3 | 执行核心业务流回归 | ✅ 完成：49 个共享工具 case 骨架零差异；发现 onboarding 写操作 3 处抛错（G1-G3 regression）+ portfolio/watchlist/plan/preferences 存储路径分支（G4-G5 pending-decision） |
| 2026-08-14 | WP-P4 | 执行副作用与错误分类对照 | ✅ 完成：错误分类完全一致；trace 写入不同表（accepted）；confirmation gate 一致 |
| 2026-08-14 | WP-P5 | 汇总差距清单 | ✅ 完成：10 项差距，3 个 regression（G1-G3），2 个 pending-decision（G4-G5），5 个 accepted。幂等结论：工具+prompt 层已幂等，真实缺口在 onboarding 写操作 |
| 2026-08-14 | G1-G3 补齐 | 实现 onboarding 写操作 mastra 模式 | ✅ 完成：新增 `openMastraOnboardingStore`（onboarding.ts）；service-tools-core 三函数 + routes/sandbox 两路由去守卫接入；新测试 `tests/mastra-onboarding-confirm-write.test.ts` 覆盖三流程（新用户冷启动/风格确认/跳过规则收尾）。typecheck/build/相关回归全通过 |
| 2026-08-14 | 模型切换验证 | 跑既有按回合模型语义测试 | ✅ 通过：`tests/mastra-facade.test.ts` 12/12，含"配置按回合快照、切换只影响后续回合"；真实双模型网关实测记为外部条件（H1 前） |
| 2026-08-14 | L2 数据可得性 | 修复 mastra backend 缺失行语义 | ✅ 完成：`mastra-portfolio-backend.ts` 改为空默认读取 + 惰性建行写入（revision 乐观锁保留）；新增新用户冷读取/首次写入测试；`mastra-service-owned-read-adapter.test.ts` 期望同步更新；全部 74 项 mastra 测试通过 |
| 2026-08-14 | 测试基线修正 | `mastra-tools.test.ts` 工具计数 49→50 | ✅ 修正：eade549 加入 `spreadsheet.create` 时测试未同步（预存失败，与本次改动无关，已用干净 HEAD 副本验证）；补 `spreadsheet.create` 存在性断言 |
| 2026-08-14 | Workspace 引用全量分类 | 三路并行扫描 src/（scheduler/services/lib+platform） | ✅ 完成：运行环境层代码级验证通过（35 处实例化全守卫）；新增 G11-G20 缺口条目；G11（automation-task-migration 备份根）当场修复（`workspacePathForScope` 导出复用，workspace 模式 34/34 回归通过）；ownership-inventory 增补代码路径盘点节 |
| 2026-08-14 | G18 产品裁决落地 | onboarding 完成即启用调度 | ✅ 完成：用户裁决"走完 onboarding 就能用起来"；`prepareMastraOnboardingDraftCommit` 与 `openMastraOnboardingStore` 两条路径在 state=completed 时置 `schedulerActivation=enabled`（中途保持 inert，迁移脚本语义不变）；G20 同步 verified（会话路径先 bootstrap 项目根）；G21 记录巡检可见性为后续 Portal 设计点。全部 74 项 mastra 测试通过 |
| 2026-08-14 | G12 策略库补齐 | mastra 策略库 CRUD | ✅ 完成：新增 `src/lib/mastra-strategy-library.ts`（`profile_json.tradingStrategies` 兄弟键存储，语义逐条对齐 WorkspaceStore）；sandbox 三路由（list/set/remove）接入 mastra 分支，审计与 confirmation gate 复用；顺带修复 `writeMastraStrategyProjection` 整体覆盖（合并保留兄弟域）。mastra 套件 75/75、method-change/strategy-import 回归 7/7、typecheck/build 通过 |
| 2026-08-14 | G13 行为统计补齐 | mastra 复盘行为纠偏统计 | ✅ 完成：`collectMastraBehaviorStats` 从 `mastra_review_memory_records` service_event（action_confirmed，按业务时间排序）+ `chat_history` user 行（对话轮次）聚合，语义对齐 workspace 的 behavior_events 聚合；周/月复盘 `behaviorStats` 在 mastra 下 available:true。mastra 套件 76/76、workspace 复盘回归 20/20、typecheck/build 通过 |
| 2026-08-14 | G17 产品裁决 | 确认后文件快照交付 | ✅ 关闭：用户裁决 YAML 本就不是面向用户的交付物，main 上的 config 快照下载只是 workspace 实现副产品、实际价值不大；mastra 下配置经 SQLite 投影生效即为目标形态 |
| 2026-08-14 | 全量回归 | `npm test` 完整基线 | ✅ 451/451 通过。过程中发现并修正 `service-tool-grant.test.ts` 的预存陈旧断言（`REGISTERED_TOOLS` 清单缺 `spreadsheet.create`，与此前 `mastra-tools.test.ts` 同源，均系 eade549 加工具时未同步；干净 HEAD 副本验证为预存失败）。本 session 全部改动（G1-G3、G4/G5 语义、G11-G13、G18、模型切换验证）经全量基线确认零回归 |
| 2026-08-14 | H1 前置实测 | 重启隔离候选（加载本 session 构建）+ Portal 真实回合 | ✅ 完成：`spreadsheet.create` 经 Portal 对话真实调用成功（审计 success、6945 字节、xlsx mime 正确）；「我的文件」可见且版本端点可下载完整字节；Mastra 回合 success / gpt-5.6-terra / 27.4s（简单回合）。发现两个新缺口：G22（对话内下载直链缺失，回复含虚构 `sandbox:/mnt/data/` 链接、消息无 artifact 附件）、G23（trace tool_calls 系统性为空）。同时按 ownership 核对关闭 G14/G15（均为 service-owned SQLite，非能力缺口） |

## 7. 暂停门

本验证只覆盖幂等判断。以下不属于本验证范围：

- 不判断模型切换是否可用（单独验证）。
- 不判断 Workspace 重整是否完成（单独验证）。
- 不授权部署、合并、端口切换或生产数据迁移。
- 不要求用户完成人工回归；自动化证据为主，人工只做最终抽查。
