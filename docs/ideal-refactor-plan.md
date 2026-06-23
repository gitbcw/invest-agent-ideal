# 理想型重构计划:从现实骨架到理想型协议

> Created: 2026-06-21
> Last Updated: 2026-06-21(追加工作目录模型决策、调整工作包顺序)
> Status: Approved — 已对齐核心决策,准备执行
> Source of truth: 本文档是后续所有工作包的总纲,任何架构调整以本文档为准

## 一、背景与定位

### 1.1 两个项目的由来

| 项目 | 由来 | 特征 |
| :--- | :--- | :--- |
| **现实版**(invest-agent-ideal 当前状态) | 产品形态未定型时凭想法 + 实践积累出来 | 工程沉淀扎实:微信打通、Codex/Hermes ACP 接入、行情/资金流数据、Dashboard、Scheduler 全套;但规则散在代码里,所有用户数据堆在 SQLite,缺乏协议层与工作空间概念 |
| **理想型**(jr-backend 模板) | 产品重新讨论定型后的协议蓝图 | 协议完备:21 个 yaml 配置 + 10 个知识文档 + 8 个 skill 协议 + 8 个 jsonl 事件流;模板即工作空间,每用户一份拷贝,所有产物落目录文件,代码极简 |

### 1.2 重构总目标

在现实版已有的工程骨架之上,引入理想型的**协议分层 + 工作空间模型 + 闭环机制**,最终交付一个**协议完备、用户工作空间独立、CodeX 兜底、DeepSeek 分流、闭环可审计**的投资助手。

### 1.3 三个核心决定(本计划的前提)

1. **CodeX 一律兜底**:Hermes 不再作为产品语义的一部分,只保留代码作考古。所有复杂推理由 CodeX 处理。
2. **加入 DeepSeek 分流层**:在 CodeX 之前增加一层国产模型 API(DeepSeek 主 + 豆包/StepFun 备),快速响应简单情况,降低延迟与成本。
3. **用户工作空间 = 模板拷贝**:每个用户独立一份工作目录(基于 jr-backend 模板),所有用户私有产物(持仓/策略/复盘/记忆/审计)落工作目录文件,**服务层 SQLite 只保留模板覆盖不到的部分**(用户身份、连接管理、公共数据缓存、系统观测)。

### 1.4 工作空间模型(基石决策)

> 这一节是整个重构的核心,所有后续工作包都围绕它展开。

```
┌──────────────────────────────────────────────────────────┐
│  服务层(invest-agent-ideal 项目本身)                    │
│                                                           │
│  职责:运行时协调,不存用户私有产物                       │
│  SQLite 只保留:                                          │
│    • 用户身份、微信绑定(channelAccounts/Identities)      │
│    • aiProjects / aiInstances 注册表                      │
│    • 行情/资金流缓存(公共数据)                          │
│    • sandbox 审计、push 任务、调度状态                    │
│    • agentTraces / codexAcpTraces(系统观测)             │
└──────────────────────────────────────────────────────────┘
                         │
                         │  按 userId 解析出工作目录路径
                         ▼
┌──────────────────────────────────────────────────────────┐
│  用户工作目录(每用户一份,基于 jr-backend 模板拷贝)      │
│                                                           │
│  data/workspaces/<userId>/                                │
│    ├─ AGENTS.md          ← CodeX 进来第一眼看的           │
│    ├─ config/*.yaml      ← 持仓/策略/盯盘/风险规则        │
│    ├─ knowledge/*.md     ← 分析方法、决策协议             │
│    ├─ memory/*.jsonl     ← 决策/行为/审计/方法候选        │
│    ├─ reports/*.md       ← 日/周/月复盘                   │
│    ├─ financials/        ← 公司财报                       │
│    └─ skills/            ← 用户级 skill 配置              │
│                                                           │
│  所有用户私有产物都在这里,CodeX/DeepSeek 都直接读写      │
└──────────────────────────────────────────────────────────┘
```

**核心语义**:
- 服务层只做"协调 + 公共数据 + 系统观测"
- 用户私有产物一律落工作目录文件,**不进 SQLite**
- CodeX 在用户工作目录里工作(读 AGENTS.md → 写 memory/*.jsonl → 读 knowledge/methods)
- DeepSeek/豆包 分流层也读写用户工作目录(如帮用户录持仓 → 写 config/portfolio.yaml)

**模板源**:`templates/workspace/`(项目根下),每个新用户来时从这里拷贝一份到 `data/workspaces/<userId>/`。

**写入路径统一**:所有写入通过 handler 工具,不直接写文件。DeepSeek 决策"该写什么" → 调工具(如 `add_holding`)→ handler 同时落 yaml + jsonl,保证写入可审计、可回滚。

---

## 二、现状分析

### 2.1 当前消息路由(只有一条主链路)

```
微信消息
  ↓
weixin-mobile.ts
  ↓
isDailyReviewRequest(text)?  ← 唯一的路由判断
  ├─ 是日复盘 → 后台异步走 Codex(因为慢),先回一句"生成中"
  └─ 其他全部 → 同步等 Codex ACP
                ↓
              codexStdioAcpAgent.chat()
```

### 2.2 DeepSeek 的"失业"状态

`src/services/deepseek.ts` 接入完整(deepseek / stepfun / doubao 三 provider,light / deep 双档),但**主链路完全绕过它**:

| 文件 | 是否在主链路 | 状态 |
| :--- | :--- | :--- |
| `handlers/chat.ts`(24 行,通用对话) | ❌ 不在 | `agent.ts` 直接转发 Codex,不调用 |
| `handlers/screening.ts`(选股) | ❌ 不在 | 旧路径,主链路不走 |
| `handlers/portfolio.ts`(持仓解析) | ⚠️ 工具内部 | Codex 通过工具调到时才用 |
| `handlers/review.ts`(1538 行) | ⚠️ 部分 | review 工具内部 fallback |
| `scheduler/pre-market.ts` | ✅ 在 | 定时任务,非消息链路 |

**结论**:即便"你好""谢谢""某股票现价"这类极简问题,也全部走 CodeX,既慢又贵。

### 2.3 当前持久化现状(SQLite 一锅端)

现有 30+ 张 SQLite 表,全部带 `userId` 字段(默认 `primary`),**用户私有产物和系统职责数据混在一起**。这是工作空间模型要解决的核心问题(详细归属划分见工作包 0)。

### 2.4 关键文件清单(改造时涉及)

| 文件 | 现状 | 改造方向 |
| :--- | :--- | :--- |
| `src/acp/agent.ts` | 无条件转发 Codex | 加入分流层,先 triage 再路由;按 userId 解析工作目录 |
| `src/acp/codex-stdio-agent.ts` | 主智能底座 | 保留,作为兜底;以用户工作目录为 CWD |
| `src/acp/hermes-stdio-agent.ts` | 默认关闭 | 标记 `@deprecated`,主链路移除引用 |
| `src/services/deepseek.ts` | 完整接入但闲置 | 接回主链路,承担分流与轻对话;加 fallback 链 |
| `src/handlers/chat.ts` | 24 行,通用对话 | 复活,作为分流后的轻响应执行器 |
| `src/channels/weixin-mobile.ts` | `isDailyReviewRequest` 二分 | 移除二分,改由 triage 统一决策 |
| `src/acp/prompt-context-builder.ts` | 包含 Hermes 分支 | 移除 Hermes 分支;上下文从用户工作目录读 |
| `src/lib/user-context.ts`(新增依赖) | 已有多用户基础设施 | 复用 userId/projectId/instanceId,新增 workspace 路径解析 |

---

## 三、目标架构

### 3.1 三级分流总览

```
微信消息
  ↓
┌─────────────────────────────────────────────────┐
│  Triage Layer(分流层,新增)                    │
│                                                  │
│  Step 1: DeepSeek light 做意图分类(秒级)       │
│    输出:{ intent, confidence, route }           │
│    Provider 互备:DeepSeek → 豆包 → StepFun      │
│                                                  │
│  Step 2: 按路由分发                              │
│    ├─ route=deterministic → 直接走确定性 handler │
│    │   (持仓查询、行情查询、提醒查询等)          │
│    │                                              │
│    ├─ route=light_chat → DeepSeek light 直接回答 │
│    │   (闲聊、概念解释、简单 QA)                 │
│    │                                              │
│    └─ route=complex → CodeX 兜底(分钟级)       │
│        (日/周/月复盘、财报分析、选股、组合诊断)  │
│                                                  │
│  Fallback:任何异常 → 自动降级到 CodeX            │
└─────────────────────────────────────────────────┘
```

### 3.2 工作空间与服务层分层(对齐 1.4)

```
┌────────────────────────────────────────┐
│  接入层                                 │
│  微信 / Dashboard / Scheduler / API    │
└────────────────────────────────────────┘
                  ↓
┌────────────────────────────────────────┐
│  协调层(服务层核心)                   │
│  • Triage(分流决策)                   │
│  • 路由 deterministic/light/complex    │
│  • 工作空间解析(userId → workspace)    │
│  • Sandbox / 审计 / 推送队列           │
└────────────────────────────────────────┘
            ↓               ↓
┌──────────────────┐  ┌──────────────────┐
│  用户工作空间     │  │  服务层 SQLite    │
│  (文件,私有)    │  │  (系统职责)      │
│  config/*.yaml   │  │ users / channels │
│  memory/*.jsonl  │  │ aiProjects       │
│  reports/*.md    │  │ 行情缓存          │
│  knowledge/*.md  │  │ traces / 审计    │
│                  │  │ push / 调度       │
│  CodeX/DeepSeek  │  │                  │
│  直接读写        │  │                  │
└──────────────────┘  └──────────────────┘
```

### 3.3 三层产品架构(对齐 jr-backend MVP 文档)

| 层 | 职责 | 落地位置 |
| :--- | :--- | :--- |
| **协议层** | 定义规则、契约、知识 | 用户工作空间内 `config/*.yaml` + `knowledge/*.md` + `skills/*/` |
| **执行层** | 任务编排、分流、路由、记忆写入 | 服务层 `src/acp/triage.ts` + `src/acp/agent.ts` + `src/services/*` |
| **接入层** | 微信、行情、Dashboard、调度 | 服务层 `src/channels/*` + `src/scheduler/*` + `src/routes/*` |

---

## 四、分流策略(B 方案详解)

### 4.1 为什么不用规则匹配

- **僵化**:关键词无法覆盖用户表达多样性("这只能不能再买?"VS"现在入场合适吗?"VS"加仓机会到了吗?")
- **漏召回高**:每多一类意图,规则就要补一批词,维护负担线性增长
- **无法处理混合意图**:用户一句话里既有查询又有推理("先告诉我茅台现价,然后帮我分析下要不要减仓")
- **结论**:第一层必须让 AI(DeepSeek light)来分类,用规则只做"零成本短路"(如菜单、固定指令)

### 4.2 意图分类设计

DeepSeek light 的输出严格遵循以下 JSON 结构(用 `response_format` 强制 JSON,失败时降级到 CodeX):

```json
{
  "intent": "daily_review | weekly_review | monthly_review | company_analysis |
            portfolio_query | watchlist_query | alert_query | market_quote |
            light_chat | complex_analysis | out_of_scope",
  "confidence": 0.0 ~ 1.0,
  "route": "deterministic | light_chat | complex",
  "needs_tools": ["portfolio", "watchlist", "alert", "market_data"] | [],
  "reason": "一句话说明分类依据,用于审计"
}
```

### 4.3 路由判定规则(用户意图导向)

按"用户在要什么"分,不按"问题长短/关键词"分:

| 用户在... | route | intent | 例子 |
| :--- | :--- | :--- | :--- |
| 要**事实**(查得到的数据) | deterministic | portfolio_query 等 | "茅台现价""我有多少持仓""提醒列表" |
| 要**知识/闲聊**(模型已知) | light_chat | light_chat / out_of_scope | "什么是 PE""你好""谢谢" |
| 要**判断/推理/建议**(需综合分析) | complex | daily_review 等 | "要不要减仓""帮我复盘""这只能不能再买" |

**兜底原则**:模棱两可时一律归 complex,CodeX 兜底永远不出错。

| intent | route | 执行器 | 预期延迟 |
| :--- | :--- | :--- | :--- |
| `portfolio_query` / `watchlist_query` / `alert_query` / `market_quote` | deterministic | 直接调用对应 handler | < 500ms |
| `light_chat` | light_chat | DeepSeek light 直接答 | 1-3s |
| `daily_review` / `weekly_review` / `monthly_review` / `company_analysis` / `complex_analysis` | complex | CodeX ACP | 30s-3min |
| `out_of_scope` | light_chat | DeepSeek 礼貌拒绝 + 引导 | 1-3s |
| **任何异常 / confidence < 0.6** | complex | CodeX 兜底 | - |

### 4.4 多 Provider 互备与兜底机制

**Provider 互备链**(响应你 2026-06-21 反馈):
```
LLM_PROVIDER=deepseek(主)
LLM_FALLBACK_PROVIDERS=doubao,stepfun(逗号分隔备用链)
```

`triage` 调用按顺序尝试,任一成功即返回,全失败才降级 CodeX。已有的 `src/services/deepseek.ts` 三 provider 适配保留,只加一层 fallback 编排。

**异常兜底**:

| 异常场景 | 兜底策略 |
| :--- | :--- |
| 主 Provider(DeepSeek)分类超时(>5s) | 切豆包重试 |
| 豆包也失败 | 切 StepFun |
| 全部 Provider 失败 / 返回非 JSON / 解析失败 | 直接走 CodeX |
| `confidence < 0.6` | 直接走 CodeX |
| DeepSeek light 回答失败 | 直接走 CodeX |
| CodeX 也失败 | 返回固定话术 + 记录 `memory/audit_events.jsonl` |

**核心原则**:用户永远不应该看到"系统异常",只应该看到"稍等,我重新想想"。

### 4.5 成本与延迟预期(参考值)

| 场景 | 现状(全走 CodeX) | 目标(分流后) |
| :--- | :--- | :--- |
| "你好" | ~30s + CodeX token | ~2s + DeepSeek light token |
| "茅台现价" | ~30s + CodeX token | < 1s + 0(直接行情 API) |
| "生成日复盘" | ~2min + CodeX token | ~2min + CodeX token(不变) |
| "什么是 PE" | ~30s + CodeX token | ~2s + DeepSeek light token |

---

## 五、工作包分解

按依赖与价值排序,共 7 个工作包。

### 工作包 2:Hermes 退出主链路 ⭐ 第一个做

**目标**:落实"CodeX 一律兜底"决定,清理主链路对 Hermes 的引用。

| 任务 | 文件 | 动作 |
| :--- | :--- | :--- |
| 移除 agent.ts 中的 hermesProfile 引用 | `src/acp/agent.ts` | 删除 UserContext 中的 hermesProfile 字段及传递 |
| 移除 prompt-context-builder 中的 Hermes 分支 | `src/acp/prompt-context-builder.ts` | 删 Hermes 相关分支,保留 Codex 主路径 |
| 标记 hermes-stdio-agent 为 deprecated | `src/acp/hermes-stdio-agent.ts` | 文件顶部加 `@deprecated` 注释,不删代码 |
| weixin-mobile 中的 hermesProfile 清理 | `src/channels/weixin-mobile.ts` | 移除传递 |
| 文档更新 | `CLAUDE.md`、`AGENTS.md`、`docs/38-runtime-skill-evolution-strategy.md`(2026-06-22 WP6 已归档至 `docs/archive/`) | 删 Hermes 作为备用底座的描述 |
| 实验性 Hermes API 路由保留 | `src/routes/` | `/api/hermes/*` 保留作考古,不删 |

**产出**:主链路对 Hermes 零依赖。
**验收**:`grep -rn "hermes" src/acp/agent.ts src/acp/prompt-context-builder.ts` 仅剩注释。
**回滚**:git revert 单个工作包提交即可。
**预估**:0.5 天。

---

### 工作包 0:数据归属划分 + 工作空间机制 ⭐ 第二个做(基石)

**目标**:落地"工作空间 = 模板拷贝"模型,完成现有 SQLite 表归属划分与 primary 用户数据迁移。

#### 0a:模板原型设计

| 任务 | 文件 | 动作 |
| :--- | :--- | :--- |
| 新建模板目录 | `templates/workspace/` | 按 jr-backend 结构创建骨架 |
| 拷贝协议层 | `templates/workspace/config/*.yaml` | 21 个 yaml 全部搬入(内容微调以适配本项目) |
| 拷贝知识层 | `templates/workspace/knowledge/*.md` | 10 个方法/协议文档搬入 |
| 空 memory | `templates/workspace/memory/*.jsonl` | 8 个空 jsonl 文件(带 header) |
| 空 reports | `templates/workspace/reports/{daily,weekly,monthly,company,alerts,metrics}/` | 仅 `.gitkeep` |
| AGENTS.md 模板 | `templates/workspace/AGENTS.md` | 复用 jr-backend,加入本项目场景说明 |

#### 0b:工作空间路径解析与初始化

| 任务 | 文件 | 动作 |
| :--- | :--- | :--- |
| 新增 workspace 解析器 | `src/lib/workspace.ts` | `resolveWorkspacePath(userId) → /abs/data/workspaces/<userId>/` |
| 新增初始化器 | `src/lib/workspace.ts` | `ensureWorkspace(userId)`:不存在则从 `templates/workspace/` 拷贝 |
| 配置项 | `src/lib/config.ts` | `WORKSPACE_ROOT`(默认 `data/workspaces`)、`TEMPLATE_PATH`(默认 `templates/workspace`) |
| UserContext 扩展 | `src/lib/user-context.ts` | 增加 `workspacePath` 字段,自动解析 |

#### 0c:SQLite 表归属划分(已确认方向)

按"是否用户私有产物"分三类。完整划分、判断标准、迁移顺序见 **[`docs/table-ownership.md`](./table-ownership.md)**(本工作包产出),下表为摘要。

**🟢 服务层保留(13 张,系统职责,与用户私有无关)**
| 表 | 理由 |
| :--- | :--- |
| `users`、`channelAccounts`、`channelIdentities`、`channelIdentityInstances` | 用户身份与微信绑定 |
| `aiProjects`、`aiInstances` | 项目/实例注册表(管理用) |
| `settings` | 服务级配置(信号默认值、巡检间隔等) |
| `codexAcpTraces` | 系统观测,非用户产物 |
| `sandboxAuditLogs`、`pendingSandboxConfirmations` | sandbox 安全审计 |
| `pushJobs`、`conversationTasks` | 推送队列与会话任务状态(跨进程) |
| `indicatorDefinitions` | 公共指标定义(平台元数据) |

**🔴 迁移到用户工作空间(14 张,用户私有产物)**
| 表 | 迁移目标 |
| :--- | :--- |
| `portfolio` | `config/portfolio.yaml` 的 holdings |
| `watchlist` | `config/portfolio.yaml` 的 watchlist |
| `alerts`、`alertRules` | `config/watch.yaml` |
| `stockPlans` | `config/portfolio.yaml`(或新增 `config/plans.yaml`) |
| `dailyPlans` | `reports/daily/<date>.md` + `memory/decisions.jsonl` |
| `investmentProfiles`、`methodologyProfiles` | `config/strategy.yaml` + `knowledge/methods/*.md` |
| `methodChangeCandidates` | `memory/method_changes.jsonl` |
| `reviewViewpoints` | `memory/decisions.jsonl` |
| `alertEvents` | `reports/alerts/*.md`(+ `memory/audit_events.jsonl` 元数据) |
| `tradeActions` | `memory/behavior_events.jsonl`(event_type=action_confirmed) |
| `alertSignalStates` | 工作空间运行时缓存 `reports/metrics/signal_states.json` |
| `indicatorResults` | `reports/metrics/indicators/*.json` + `memory/source_events.jsonl` |

**⚪ 丢弃(2 张,不迁移)**
| 表 | 处置 | 理由 |
| :--- | :--- | :--- |
| `chatHistory` | 丢弃 | Codex ACP 自带会话状态;微信侧会话记忆不依赖此表 |
| `agentTraces`(旧 Runtime) | 删除 | `src/` 中已 0 引用,只有 docs/archive 提及 |

#### 0d:primary 用户数据迁移(已 skipped,2026-06-21)

**决策**:不做迁移。SQLite 里 primary 用户的所有数据(portfolio/watchlist/alerts/plans/viewpoints/trade_actions/alert_events/indicator_results 共 806 条)均视为**测试期积累**,不进入新工作空间。

**理由**:

- 工作空间模型的本意是"用户拿到一份清爽模板开始";迁移测试数据违背这个初衷
- 806 条里约 700 条是调度器自产噪声(`alert_events` 388 / `indicator_results` 284 / `alert_signal_states` 40),即使筛选也只是不同程度的污染
- 剩下约 110 条用户手输数据(portfolio/watchlist/plans/alerts/viewpoints/trade_actions)也是测试期配置,真实使用时会重新输入
- 工作包 3/4 切换 handler 到读工作空间后,primary 用户在新工作空间里重新输入,正好验证冷启动流程
- SQLite 数据库本身保留在 `./data/invest-agent.db`,需要查时直接 `sqlite3` 临时查询,不需要"导出工具"

**原计划产出的删减**:

- ❌ `scripts/migrate-primary-to-workspace.mjs`(已删除)
- ❌ `data/workspaces/primary/_migration-report.md`(不需要)
- ❌ `WORKSPACE_MIGRATION_ENABLED` 环境变量(不需要)

**对后续工作包的影响**:

- 工作包 3/4 切 handler 读工作空间时,primary 用户读到的是空模板 — 预期行为
- `docs/table-ownership.md` 里的"迁移目标"列改为"handler 切换后的目标格式",不是"立即迁移"
- 真实用户接入时通过 `ensureWorkspace` 自动复制空模板,与 0d 无关

**预估**:0a 半天 + 0b 1 天 + 0c 半天 = 2 天(比原计划少 1 天)。

---

### 工作包 1:分流层落地 ⭐ 第三个做

**目标**:实现 B 方案,DeepSeek 接回主链路,多 provider 互备,从工作空间读上下文。

**进度**(2026-06-21):

| 任务 | 文件 | 状态 |
| :--- | :--- | :--- |
| 新增分流决策器 | `src/acp/triage.ts` | ✅ 三出口 direct_reply / fallback_codex / reject 已实现,agent.ts:53-65 接入主链路 |
| 新增分流 prompt | `src/prompts/triage.ts` | ✅ 2026-06-21 拆出,export `TRIAGE_SYSTEM_PROMPT` |
| 新增 fallback 编排 | `src/services/llm-router.ts` | ✅ 2026-06-21 拆出,export `callLlmWithFallback`(通用 provider 互备层,deepseek→doubao→stepfun) |
| 改造 agent.ts | `src/acp/agent.ts` | ✅ `handleMessage` 先调 triage,按 kind 分发 |
| 复活 chat handler | `src/handlers/chat.ts` | ⏳ 未做(triage direct_reply 已覆盖轻量回答,chat handler 暂不复活) |
| 改造 weixin-mobile | `src/channels/weixin-mobile.ts` | ⚠️ `isDailyReviewRequest:848` 短路保留(控制日复盘后台异步),非简单收尾,见子工作包 1.1 |
| 工作空间上下文 | `src/acp/prompt-context-builder.ts` | ⏳ 未做(等 workspace 模式默认开启时再做) |
| 新增 trace 字段 | `src/acp/trace.ts` | ⏳ 未做 |
| 配置化(过渡) | `src/lib/config.ts` | ⏳ 未做(等工作包 3) |
| **边界文档** | `templates/workspace/AGENTS.md`(并入) | ⏳ 未做 |
| **triage prompt 边界能力** | `src/prompts/triage.ts` | ✅ 边界分类已内嵌在 SYSTEM_PROMPT 的 reject 规则中 |
| **拒绝 prompt** | `src/prompts/polite_reject.ts`(新增) | ✅ 改为 triage 内 LLM 一次性生成 reject text,未独立拆 polite_reject 文件 |
| **拒绝 handler** | `src/handlers/chat.ts` | ✅ 直接在 agent.ts:60-62 处理 reject kind |
| **行为事件记录** | `memory/behavior_events.jsonl` | ⏳ `event_type: out_of_scope_query` 落地待做 |

**子工作包 1.1**:日复盘路由重设计(单独排期)
- 现状:`weixin-mobile.ts:848` 用 `isDailyReviewRequest` 短路日复盘走后台异步;`triage.ts` 的 shortCircuit 也会识别日复盘但只返回 fallback_codex
- 目标:让 triage 输出新 kind `background_codex`,weixin-mobile 据此走后台异步,移除 weixin-mobile:848 的硬编码短路
- 影响面:消息路由主链路,需要 e2e 验证日复盘仍异步
- 不在收尾范围内,单独立项

**产出**:消息进来自动三级路由,DeepSeek light 接回主链路,多 provider 互备,投资无关问题友好拒绝。
**验收**:
- "你好" 2s 内回复,trace 显示 `route=light_chat`
- "茅台现价" < 1s,trace 显示 `route=deterministic`
- "生成日复盘" trace 显示 `route=complex`,走 CodeX
- DeepSeek API 故障时,自动切豆包,trace 显示 `fallback_reason=deepseek_timeout`
- 全部 provider 故障时,降级 CodeX,用户无感知
- "推荐个好看的电影" → 友好拒绝 + 引导回投资,trace 显示 `intent=out_of_scope, route=light_chat`,落 `behavior_events.jsonl`
- 边界模糊的("美联储加息对 A 股影响") → 不被误杀,正常路由

**回滚**:feature flag `TRIAGE_ENABLED=false`,立即回到全 CodeX 路径。
**预估**:2.5-3 天(含边界控制 +0.5 天)。

#### 5.1.1 边界定义(投资相关范围)

**✅ 投资相关(本助手处理)**:
- 标的:股票 / 基金 / ETF / 可转债 / 商品 / 黄金 / 外汇(影响投资)
- 行为:资产配置、组合管理、仓位控制、买卖决策、复盘、风控
- 分析:基本面、技术面、财报、估值、行业研究
- 宏观:利率、货币政策、汇率、地缘(影响投资的部分)
- 行为金融:投资心理、行为偏差、纪律

**❌ 投资无关(礼貌拒绝)**:
- 政治 / 娱乐 / 八卦 / 感情 / 生活
- 健康医疗 / 法律咨询(非投资相关)
- 编程技术(非量化投资相关)
- 数学题 / 知识问答 / 闲聊寒暄

**⚠️ 边界模糊的处理原则(关键)**:
- "茅台董事长被抓" → ✅(公司治理,投资相关)
- "美联储加息" → ✅(宏观)
- "中美关系" → ✅(默认影响投资)
- "房地产政策" → ✅(影响地产链)
- "今天的天气" → ❌(除非用户明确说在问农产品期货产地天气)
- **宁可放进投资相关让 CodeX 兜底,也不误杀**——这是边界模糊时的默认倾向

**判断阈值**:triage 输出 `intent=out_of_scope` 且 `confidence ≥ 0.7` 才走拒绝;低于 0.7 的归到 light_chat 或 complex,让 LLM/CodeX 自然处理。

#### 5.1.2 边界控制处理流程

```
用户消息 → triage(DeepSeek light)
            ↓
       判断 intent
            ↓
   ┌─────────────────────────────────┐
   │ intent = out_of_scope            │
   │ confidence ≥ 0.7                 │
   └─────────────────────────────────┘
            ↓
   route = light_chat(不走 CodeX)
            ↓
   handlers/chat.ts 检测到 out_of_scope
            ↓
   用 src/prompts/polite_reject.ts 调 DeepSeek light
            ↓
   返回友好拒绝 + 个性化引导例子
            ↓
   写入 memory/behavior_events.jsonl(event_type=out_of_scope_query)
```

**为什么用 LLM 生成拒绝话术而不是固定模板**:
- 固定模板冷冰冰,用户体验差
- LLM 能根据用户原话生成"你或许想问"的个性化引导
- 成本可忽略(DeepSeek light 一次调用几分钱)
- 实现简单,与现有 light_chat 路由一致

**拒绝话术骨架**(由 DeepSeek light 生成):

```
[1 句话对用户问题的简短友好回应]
+
"这个问题超出了我的能力范围。我主要帮你处理投资决策:
持仓查询、行情分析、复盘建议、风险提醒、财报解读等。

你或许想问:
• [根据用户原话提取的关键词,给 1-2 个相关投资问题的例子]
• '茅台今天表现怎么样?'
• '帮我生成今日复盘'
• '我现在的仓位合理吗?'"
```

**反作弊策略(本期不做,数据先攒)**:
- 同会话内连续 N 次 out_of_scope 升级提醒
- 数据全部落 `behavior_events.jsonl`,后续按需启用

---

### 工作包 3:协议层 yaml 落地到工作空间

**目标**:把 jr-backend 的协议层固化到模板,新用户初始化时自动获得。

**进度**(2026-06-21 拆分讨论后):

工作包 3 范围过大(6 子任务),拆成 3 个独立可验收的子工作包,按风险递增执行:

#### 决策记录(2026-06-21)

| 决策点 | 选择 | 理由 |
| :--- | :--- | :--- |
| config-loader 基础设施 | **方案 A:扩展 WorkspaceStore**,不新建 `src/lib/config-loader.ts` | WorkspaceStore 已经封装 yaml 读写 + readStrategy/readMethodology/readWatch,新建 loader 增加心智负担。未来类膨胀再考虑加 `config` namespace |
| 信号 enabled/params 存储 | **方案 3:仍走 SQLite**(`settings.signal_config` KV) | 信号是高频调整的个人偏好,与 portfolio/watchlist 同性质,应在 WP4.x 残留清理时统一处理(alerts/alert_rules 已知残留)。WP3 只挪 P0/P1/P2 映射和风险分类体系 |
| 拆分策略 | WP3a / WP3b / WP3c 三独立子包 | 三者解耦,可按优先级排,各自独立验收、独立回滚 |

#### 子工作包拆分

| 子包 | 范围 | 风险 | 工期 | 状态 |
| :--- | :--- | :--- | :--- | :--- |
| **WP3b triage 配置 yaml 化** | 新建 `config/triage.yaml` + `triage.ts` 读 yaml + feature flag `USE_YAML_CONFIG` | 低(纯配置抽取,行为不变) | 0.5 天 | ✅ 2026-06-21 完成 |
| **WP3a 信号风险分级** | `risk_taxonomy.yaml` 加 `signal_priority` 节(支持任意 signal_key,非硬编码 14 个) + `alert-check.ts` 按 P0/P1/P2 推送,severity 反推兼容数据库 | 中(影响巡检推送) | 1.5 天 | ✅ 2026-06-21 完成 |
| **WP3c 复盘风险分类落地** | 复盘报告生成时按 P0/P1/P2 分组提醒 + AI prompt 注入 risk_taxonomy 6 大类分析框架 | 中(影响复盘输出格式) | 1 天 | ✅ 2026-06-21 完成 |

执行顺序:WP3b(热身) → WP3a(核心) → WP3c(质量优化)。

#### 原任务映射(供参考)

| 任务(原) | 文件 | 子包 | 状态 |
| :--- | :--- | :--- | :--- |
| 模板 yaml 内容定稿 | `templates/workspace/config/*.yaml` | (跨子包) | ✅ 21 个 yaml 已就绪 + WP3b 新增 triage.yaml + WP3a 扩展 risk_taxonomy.yaml |
| ~~新增 config loader~~ | ~~`src/lib/config-loader.ts`~~ | (取消) | ❌ 不新建,扩展 WorkspaceStore |
| 信号 P0/P1/P2 映射(任意 signal_key) | `risk_taxonomy.yaml` + `WorkspaceStore.readRiskTaxonomy` | WP3a | ✅ 2026-06-21 完成 |
| triage 配置迁移 | `triage.ts` + `config/triage.yaml` | WP3b | ✅ 2026-06-21 完成 |
| 风险分级落地到巡检 | `alert-check.ts`(新增 priority 字段 + loadPriorityConfig + resolvePrioritySync) | WP3a | ✅ 2026-06-21 完成 |
| 复盘报告按风险分类 | `review.ts`(formatDailyAlertsByPriority + formatAlertSummary + AI prompt 注入 6 大类) | WP3c | ✅ 2026-06-21 完成 |
| 文档更新 | `CLAUDE.md`、`AGENTS.md` | (跨子包) | ⏳ 最后做 |

#### WP3b 完成证据(2026-06-21)

- ✅ `templates/workspace/config/triage.yaml` 已创建(confidence_threshold/reject_threshold/max_short_circuit_len/llm 参数/provider_chain)
- ✅ `WorkspaceStore.readTriageConfig()` 已加,返回 typed `TriageYaml | null`
- ✅ `triage.ts` 改造完成:`USE_YAML_CONFIG=true` 时读 yaml,默认 fallback 到 `DEFAULT_CONFIG`;yaml 缺失/字段错误不阻塞主链路
- ✅ `npm run build` 通过
- ✅ `node scripts/triage-smoke.mjs` 8/8 通过(默认模式和 yaml 模式行为一致)
- ✅ 关键证据:把 yaml 中 `confidence_threshold` 从 0.6 改成 2.0,简单问候从 `direct_reply` 变 `fallback_codex`,证明 yaml 值真实生效

#### WP3a 完成证据(2026-06-21)

- ✅ `templates/workspace/config/risk_taxonomy.yaml` 新增 `signal_priority` 节,包含 `default: P2` + `overrides` dict + `price_escalation_threshold_percent: 5`
- ✅ **关键设计决策**:不硬编码 14 个系统信号,而是按 signalKey 后缀查表,支持任意用户自定义信号(target-price/support-price/vol-price-div 等带参数信号走前缀匹配)
- ✅ `WorkspaceStore` 新增 `RiskLevel`/`RiskLevelDef`/`SignalPriorityConfig`/`RiskTaxonomyYaml` 类型和 `readRiskTaxonomy()` 方法
- ✅ `alert-check.ts` 改造:
  - `AlertItem` 新增 `priority: "P0"|"P1"|"P2"` 字段,保留 `severity` 字段(从 priority 反推)兼容数据库 `alert_events.severity` 列
  - 新增 `loadPriorityConfig()`(带模块级缓存 + `USE_YAML_CONFIG` feature flag + yaml 缺失/错误 fallback 到 `HARDWIRED_PRIORITY_MAP`)
  - 新增 `resolvePrioritySync(signalKey, cfg, absChangePercent?)`(支持精确匹配 + 前缀匹配 + 价格异动自动升级到 `:extreme`)
  - 12 个 push 点全部从硬编码 `severity` 改为查表得 priority + 反推 severity
  - 默认硬编码 map 与原 alert-check 行为等价(`stop-loss`/`break-support`/`breakout-with-volume`/`target-price`/`support-price` → P0,`near-*`/`capital-flow-*`/`vol-price-div` → P1,价格异动 ≥5% 升级到 `:extreme` → P0)
- ✅ `npm run build` 通过(类型零错误)
- ✅ `npm run smoke` 通过(Experimental MVP smoke test passed)
- ✅ priority 查表单测 12/12 通过(覆盖精确匹配/前缀匹配/价格升级/默认值四类用例)
- ✅ 端到端验证:`USE_YAML_CONFIG=true` 时通过 `WorkspaceStore.readRiskTaxonomy` → `loadPriorityConfig` → `runAlertCheck` 链路真实加载 yaml,日志 `signal_priority 配置从 yaml 加载: overrides<15> default<P2> escalation<5%>` 出现

**WP3a 设计要点(供后续 WP3c / 信号扩展参考)**:
- yaml 的 `overrides` 是 dict 不是 list,key 是 signalKey 后缀
- signalKey 后缀规则:`<code>:<suffix>` → 取 suffix;`<suffix>` 形如 `stop-loss`(单段)、`price:up`(双段)、`target-price:12.5`(带参数)
- 查表三段式:精确 suffix → 前缀(去末段) → `default`
- 新增信号不需要改 yaml 也不需要改代码,自动 fallback 到 `default: P2`

#### WP3c 完成证据(2026-06-21)

- ✅ `review.ts` 新增 `severityToPriorityLabel()`(high/medium/low → P0/P1/P2)+ `formatDailyAlertsByPriority()` 工具函数
- ✅ `formatAlertSummary()`(周复盘用)新增 severity 字段 + 排序(P0→P1→P2,同级按日期倒序)+ 表格新增"优先级"列
- ✅ `generateDailyReview` 的"今日提醒"段从无差别平铺改成 P0/P1/P2 三段分组(P0 全列;P1 列前 5 + 折叠;P2 仅计数)
- ✅ `generateDailyReview` AI prompt 重写:今日提醒按 `[P0] ${name} ${msg}` 格式注入;要求模型按 6 大风险类别(portfolio/market_structure/asset_specific/product_specific/behavior/data_quality)自检,无则跳过不编造;P0 事件必须明确回应
- ✅ `generateWeeklyReview` AI prompt 同步注入 6 大类自检要求
- ✅ `npm run build` 通过
- ✅ `npm run smoke` 通过
- ✅ 关键证据 1:塞 3 条 severity=high/medium/low 的 mock alertEvents,跑 `generateDailyReview`,输出:
  ```
  【今日提醒】
  P0(需确认):
    平安银行: [test] P0 跌破止损 10.5（pending）
  P1(关注): 1 条
    贵州茅台: [test] P1 主力净流入（pending）
  P2(沉淀): 1 条,详见 alert_events 表
  ```
- ✅ 关键证据 2:AI 段确认提及全部 6 大类(portfolio/market_structure/asset_specific/product_specific/behavior/data_quality 全部 YES)

**WP3c 设计决策**:
- 不引入 `WorkspaceStore.readRiskTaxonomy`(避免缓存链路 + 双写)。`alertEvents.severity` 是 WP3a 写入的 P0/P1/P2 反推别名,复盘直接读 SQLite 列即可
- 6 大类不通过 yaml 动态加载,而是固化在 AI prompt 中(分类体系稳定,变化频率低)
- P0 全列、P1 折叠、P2 计数的展示策略来自 `risk_taxonomy.yaml` 中 P0/P1/P2 的 `meaning` 描述("可能改变持仓逻辑"/"当天需要关注但不打断"/"用于复盘沉淀,不主动推送")





#### 5.3.1 14 个信号 P0/P1/P2 映射草案(待联调)

| 信号 | 建议等级 | 理由 |
| :--- | :--- | :--- |
| `break_support`(破位) | P0 | 持仓逻辑可能改变 |
| `stop_loss`(止损触发) | P0 | 用户确认过的硬规则 |
| `breakout_with_volume`(放量突破) | P1 | 关注但不打断工作 |
| `near_support` / `near_resistance` / `near_target` | P1 | 接近关键区间 |
| `price_change`(涨跌幅) | P1 | 看幅度,>5% 才考虑升级 |
| `volume_ratio`(量比) | P2 | 复盘沉淀 |
| `macd` | P2 | 复盘沉淀 |
| `bid_ask_imbalance`(盘口失衡) | P2 | 复盘沉淀 |
| `capital_flow_main`(主力净流入) | P1 | 资金异动 |
| `capital_flow_super_large`(超大单) | P1 | 资金异动 |
| `volume_price_divergence`(量价背离) | P1 | 潜在反转信号 |
| `turnover`(换手率) | P2 | 复盘沉淀 |

(具体阈值在工作包 3 落地时联调)

**产出**:核心规则配置化,新用户开箱即用,改规则不动代码。
**验收**:`templates/workspace/config/risk_taxonomy.yaml` 中新增一类风险,不需要改代码就能在复盘报告里生效。
**回滚**:保留旧硬编码常量一版本,通过 `USE_YAML_CONFIG` 开关切换。
**预估**:2 天。

---

### 工作包 4:SQLite 写入冻结 + jsonl 双写

**目标**:完成 SQLite → 工作空间的写入切换,所有用户私有产物走 jsonl。

**进度**(2026-06-21):

#### ✅ 4.1 portfolio 后端抽象(已完成)
- `src/lib/data-backend.ts`:PortfolioBackend 接口 + ACTIVE_BACKEND 选择器(`WORKSPACE_BACKEND=workspace` 切换)
- `src/lib/sqlite-portfolio-backend.ts`:原 SQLite 行为提取
- `src/lib/workspace-portfolio-backend.ts`:走 WorkspaceStore + behavior_events.jsonl
- `src/handlers/portfolio.ts`:走 backend
- `src/routes/dashboard.ts` 的 /api/portfolio/add 和 /api/portfolio/remove:走 backend
- 烟测:`scripts/portfolio-backend-smoke.mjs`,sqlite + workspace 双跑等价

#### ✅ 4.2 watchlist + plan 后端抽象(已完成)
- 同上模式扩展 WatchlistBackend / PlanBackend
- watchlist handler / plan handler / Dashboard /api/watchlist/* /api/plans/* 全切
- 同一份烟测覆盖三种 backend,51/51 通过

#### ✅ 4.3 scheduler / handler 读路径切换(已完成)
- `src/scheduler/pre-market.ts` / `alert-check.ts` 改读 backend
- `src/handlers/monitor.ts` / `alert.ts` / `review.ts` 改读 backend
- `data-backend.ts` 文件头注释更新:残留双轨已收窄

#### ✅ 4.4 profile-context / methodology 切工作空间(已完成)
- `src/lib/profile-context.ts`:`loadRuntimeProfileContext` 切到 `WorkspaceStore.readStrategy()` + `readMethodology()`,SQLite 保留作 fallback(由 `WORKSPACE_BACKEND` 切换)
- `src/lib/conversation-tasks.ts`:`applyInvestmentProfileTask` 拆为 sqlite / workspace 双路径;workspace 路径走 `WorkspaceStore.writeStrategy()` 合并写入,保留 strategy.yaml 其他字段
- `src/routes/sandbox.ts`:`GET /api/sandbox/dashboard`、`GET /api/sandbox/profiles`、`POST /api/sandbox/profiles/investment`、`POST /api/sandbox/profiles/methodology` 全部切到 workspace 双路径
- `src/lib/workspace-store.ts`:新增 `writeMethodology()` 公开方法,封装 md 文件覆盖写入
- 字段舍弃:`customStyle` / `notificationPolicy` / `decisionPolicy` / `sourcePolicy`(运行时无消费,语义已被 yaml 其他字段覆盖;Codex prompt context 仍以 `{}` 占位返回,shape 不变)
- 烟测:`scripts/profile-backend-smoke.mjs`(24/24 通过,workspace 模式)+ `scripts/portfolio-backend-smoke.mjs`(51/51 通过,无回归)

> **2026-06-22 后续清理(方向 B 重构)**:`src/lib/profile-context.ts` 已删除,prompt 注入链路不再走"代码预拉数据塞 prompt"。Codex 改为通过 `/api/sandbox/profiles` / `/api/sandbox/reviews/*` 等 API 自取。`src/lib/strategy-skill-context.ts` 同步删除(Codex 自己读 `.codex/skills/invest-agent-strategy-middle-trend/`)。`profile-backend-smoke.mjs` 烟测已废弃移除。`conversation-tasks.ts` 与 `sandbox.ts` 的写入路径不受影响,继续直连 WorkspaceStore。

#### ✅ 4.5 plan-conditions 切到 planBackend(已完成)
- `src/handlers/plan-conditions.ts`:`setPlanWatchConditions` 不再直写 `stockPlans` 表,改用 `planBackend.upsert`
- 保留对 `alertRules` 表的 SQLite 写入(系统层未切,这是 workspace 与 sqlite 共享的跨表引用)
- `linkedAlertRuleIds` 统一为 `string[]`,与 PlanRow / yaml schema 对齐(原代码隐式 number[] 是 type 漏洞)
- 烟测:`scripts/plan-conditions-smoke.mjs`(sqlite 10/10,workspace 11/11,均通过)

#### ✅ 4.6 chat_history 切 behavior_events.jsonl(已完成)
- `src/lib/weixin-conversation-memory.ts`:`rememberWeixinTurn` workspace 模式下 append `memory/behavior_events.jsonl`(event_type=wechat_conversation_turn,payload 含 user_text + assistant_text)
- `loadRecentWeixinMemory` 双路径:workspace 走 `WorkspaceStore.listBehaviorEvents`,sqlite 走原 SQLite 查询;limit 语义统一为消息条数(与原 SQLite 一致)
- `src/lib/workspace-store.ts`:新增 `listBehaviorEvents<T>()` 公开方法
- 字段格式:`{event_type, occurred_at, payload: {instance_id, conversation_id, user_text, assistant_text}}`
- SQLite 表保留只读回退,90 天后由 drop-migrated-tables.mjs 统一清理
- 烟测:`scripts/weixin-memory-smoke.mjs`(sqlite 10/10,workspace 10/10,均通过)

#### ✅ 4.10 alerts 系列决策:保留 SQLite(2026-06-22)
- 决策:`alerts` / `alert_rules` / `alert_events` / `alert_signal_states` 全部保留 SQLite,不迁移工作空间
- 理由:
  - `alerts`(旧式):已被 `alert_rules` 取代,仅 `alert-rules.ts:139` 一次性读 legacy 做迁移,保留 SQLite 作历史回退即可
  - `alert_rules`(新式):调度器每轮巡检都读全表(`alert-check.ts:73`),需要 SQL 索引;watch.yaml 的 `exception_rules` 是协议层文本数组,与字段化结构(stockCode/indicatorKey/condition/params/schedule/dedupe/severity)不对齐,迁移需扩展 yaml schema,工作量与收益不匹配
  - `alert_events`:调度器高频写入(`alert-check.ts:672`),数据量大(primary 用户 700/806 行),cooldown 去重查询(`alert-check.ts:658`)依赖 SQL 索引;用户 feedback 字段通过 UPDATE 完成,迁移到 jsonl 需 read-modify-write 大文件
  - `alert_signal_states`:跨进程协同(调度器 + server 都访问),与 `push_jobs` 性质一致,必须在 SQLite
- 文档动作:table-ownership.md 已更新,4 张表从"迁移至工作空间"重新归为"服务层保留",总表数 13 → 17,迁移数 14 → 10
- 后续:若 WP5 闭环自演进跑通后发现需把用户配置语义暴露给 Codex(让 Codex 读 alert_rules 调整判断),再评估是否做"只读迁移"(类似 WP3)

#### ✅ 4.7 daily_plans 切 workspace yaml(已完成,2026-06-21)
- `src/lib/workspace-store.ts`:新增 `DailyPlanYaml` 类型 + `readDailyPlan`/`writeDailyPlan`/`listDailyPlans` 三个方法
- `src/lib/daily-plan-backend.ts`(新建):`DailyPlanBackend` 接口 + sqlite/workspace 双实现 + `dailyPlanBackend` 出口(由 `ACTIVE_BACKEND` 选择)
- `src/handlers/review.ts`:5 处 dailyPlans 直读切到 backend(saveDailyPlan / getPreviousDailyReview / getDailyReviewCoverage / getLatestReviewPushSummary / getLatestReviewPreMarketContext / saveSkillDailyReview)
- `src/handlers/review-records.ts`:handleReviewRecordsTool 切到 backend.listInRange
- `src/scheduler/alert-check.ts`:loadLatestPlanMap 切到 backend.getLatest
- `src/routes/dashboard.ts`:recentPlans 切到 backend.listInRange
- `src/routes/sandbox.ts`:GET /api/sandbox/dashboard 切到 backend.listInRange
- 烟测:`scripts/daily-plan-backend-smoke.mjs`(sqlite 6/6 + workspace 6/6 通过,upsert/get/getPrevious/listInRange/getLatest 全等价)
- 关键设计:daily_plans 是"每 date 一份 upsert 状态"(非事件流),workspace 用 yaml 而非 jsonl(与 portfolio.yaml 一致),`plans/daily/<date>.yaml`

#### ✅ 4.9 method_change_candidates 切 workspace jsonl(已完成,2026-06-21)
- `src/lib/workspace-store.ts`:新增 `listMethodChanges<T>(options)`(去重版本,按 updated_at desc)+ `listMethodChangeVersions<T>(candidateId)`(全量审计)
- `src/lib/method-change-backend.ts`(新建):`MethodChangeBackend` 接口 + sqlite/workspace 双实现 + `methodChangeBackend` 出口(由 `ACTIVE_BACKEND` 选择)
- 4 个 src 调用方全部切到 backend:
  - `src/routes/sandbox.ts`:dashboard/profiles 2 处 list + propose + decide,id 类型放宽到 string | number
  - `src/routes/dashboard.ts`:Promise.all 内 methodCandidates 查询切到 `methodChangeBackend.list`
  - `src/lib/profile-context.ts`:SQLite 路径和 workspace 路径的 proposedRows 查询都切到 backend;`proposedMethodChanges.id` 类型从 number 放宽到 string
  - `src/lib/conversation-tasks.ts:applyStrategyInstanceExpansionTask`:insert 切到 `methodChangeBackend.propose`(ProposeInput 扩展可选 decisionNote 字段,task 上下文直接带进 propose)
- 烟测:`scripts/method-change-backend-smoke.mjs`(sqlite + workspace 全部通过,propose/get/list/decide + propose-with-decisionNote + 版本快照语义全等价)
- 关键设计:
  - jsonl 是 append-only,decide 操作不修改原记录,而是 append 一条新版本(status/decisionNote/confirmedAt 更新)
  - `listMethodChanges` 必须**先按 candidateId 去重(取最新版本),再应用 status 过滤**(否则旧版本会被错误返回)
  - `listMethodChangeVersions` 供审计追溯使用,返回单个 candidate 的所有版本
  - 字段命名:YAML/jsonl 用 snake_case(candidate_id/source_review_id/...),TypeScript Record 用 camelCase,通过 toYaml/fromYaml 转换
  - ProposeInput 支持可选 `decisionNote`(为 conversation-tasks task 上下文场景),不必为写入决策备注额外发 decide

#### ✅ 4.8 review_viewpoints 切 workspace jsonl(已完成,2026-06-21)
- `src/lib/workspace-store.ts`:新增 `readReviewViewpoints<T>()` / `writeReviewViewpoints(records)`(read-modify-write 模式,非 append-only)
- `src/lib/review-viewpoint-backend.ts`(新建):`ReviewViewpointBackend` 接口 + sqlite/workspace 双实现 + `reviewViewpointBackend` 出口(由 `ACTIVE_BACKEND` 选择)
- 3 个 src 调用方全部切到 backend:
  - `src/handlers/review.ts`:4 处函数改造(getOpenReviewViewpoints / syncReviewViewpoints / syncViewpointResolutions / getWeeklyViewpointSummary)
  - `src/lib/profile-context.ts`:SQLite 路径和 workspace 路径的 dueOpenViewpoints 查询都切到 backend
  - `src/routes/dashboard.ts`:Promise.all 内 3 处 reviewViewpoints 查询(全表 / open / open+due)切到 backend
- 烟测:`scripts/review-viewpoint-backend-smoke.mjs`(sqlite + workspace 全部通过,replaceByDate / resolve / list(by status / by date range / by expectedReviewDate) 全等价)
- 关键设计:
  - jsonl 是 **read-modify-write 模式**(非 append-only),因为 syncReviewViewpoints 是"按 sourceDate 整组替换"的 upsert 语义,不是事件流
  - 业务复合 key = `${sourceDate}#${viewpointId}`,viewpointId 是用户手写跨日期可能重复,必须用 sourceDate 消歧
  - `resolve(viewpointId, sourceDate?)`:不传 sourceDate 时按 viewpointId 找最新一条更新(兼容原 SQLite 的"按 viewpointId 不带日期"宽容语义);传 sourceDate 时精确匹配
  - replaceByDate 语义:删除该 sourceDate 全部记录 + 插入新记录(重跑日复盘时,旧观点被新观点替换,v2 不再出现时自动消失)
  - 与 method_changes(append-only 版本快照)和 daily_plans(upsert by date yaml)是不同模式,review_viewpoints 是"按 sourceDate 分组的状态集合"

| 任务 | 文件 | 动作 |
| :--- | :--- | :--- |
| JSONL 写入工具 | `src/lib/jsonl-store.ts` | 安全 append + schema 校验,参考 jr-backend `memory_store.py` |
| 改造 trace 写入 | `src/acp/trace.ts` | SQLite 保留作系统观测,同时 append 到 workspace `memory/audit_events.jsonl` |
| 改造决策写入 | `src/handlers/review.ts` | 复盘观点写 workspace `memory/decisions.jsonl`,符合 decision_record schema |
| 信息源事件 | `src/services/*.ts` | 行情/资金流缺失或冲突时,写 workspace `memory/source_events.jsonl` |
| 持仓/自选/提醒/预案 handler 改造 | `src/handlers/*.ts` | 写 workspace yaml,SQLite 对应表只读 ✅ portfolio/watchlist/plan 完成 |
| 行为事件捕获 | `src/acp/triage.ts`、`src/handlers/*.ts` | 频繁短线查询、重复刷新、规则外请求写 `memory/behavior_events.jsonl` |
| 日级预案产物切换 | `src/handlers/review.ts` 等 | ✅ WP4.7 完成:走 `plans/daily/<date>.yaml`,sqlite 双轨保留 |

**产出**:用户私有产物一律 jsonl,SQLite 只剩系统职责。
**验收**:跑一次日复盘,workspace `memory/` 下至少 3 个 jsonl(decisions / audit_events / task_runs)有新增,字段符合 schema。
**回滚**:JSONL 写入失败不阻塞主链路,catch 后只 logger.error。
**预估**:2-3 天。

---

### 工作包 5:闭环自进化

**目标**:跑通"日→周→月→方法候选"的反馈闭环(全部在工作空间内)。

| 任务 | 文件 | 动作 |
| :--- | :--- | :--- |
| 观点 outcome 字段补齐 | `src/lib/review-viewpoint-backend.ts` | ✅ WP5.1 完成:扩展 `ReviewViewpointRecord` 加 `invalidation_signals`/`confidence`/`task_type`/`decision_type`(对齐 decision_record schema)。workspace 路径真实持久化,sqlite 路径不动 schema(读时默认值) |
| 周复盘回测逻辑 | `.codex/skills/invest-agent-weekly-review/SKILL.md` + `src/handlers/review.ts` 字段透出 | ✅ WP5.2 完成(2026-06-22):代码层只透字段(`getWeeklyViewpointSummary` 加 invalidationSignals/confidence/expectedReviewDate,解析器加"日复盘观点回测"标题识别);回测判定全权交 Codex 通过 skill + 工具完成 |
| 月复盘归因 | `.codex/skills/invest-agent-monthly-review/SKILL.md` + `src/handlers/review.ts:buildMonthlyReviewContext` 字段透出 | ✅ WP5.3 完成(2026-06-22):代码层只透字段(methodChangeProposals 让 Codex 知道本月已有候选);偏差识别/归因全权交 Codex 通过 skill 完成;不需新解析器(Codex 直接调 `/api/sandbox/method-changes/propose`,API-first) |
| 方法候选流程 | `src/lib/method-change-backend.ts` + `/api/sandbox/method-changes/propose\|decide` | ✅ WP4.9 已完成 backend;WP5.3 已暴露 API 给 Codex,无需新增 |
| 用户确认入口 | `.codex/skills/invest-agent-monthly-review/SKILL.md` + `.codex/skills/invest-agent-service-tools/SKILL.md` | ✅ WP5.4 完成(2026-06-22):路径 A 微信原生,零代码改动。monthly-review skill 加"输出后行动指引",service-tools skill 加"候选确认对话模式"(4 种对话模式 + decide 二次确认 8 步流程)。基础设施(sandbox decide API + confirmation 机制)WP4.9 时已就绪 |
| 行为纠偏输出 | 周复盘 + 月复盘 | ✅ WP5.6 完成(2026-06-22):`src/handlers/review.ts` 加 `collectBehaviorStats` 读 `memory/behavior_events.jsonl` 按 event_type 聚合(action_confirmed / wechat_conversation_turn / out_of_scope_query 计数 + 最近 30 条 action_confirmed 详情)。workspace 路径真实持久化,sqlite 路径无 behavior_events 降级 `available=false`。weekly/monthly skill 加"行为纠偏"段,模式识别(追高/频繁短线/规则外请求/复盘节奏)全权交 Codex |

**产出**:理想型核心闭环跑通,系统开始"学习"。
**验收**:连续跑 1 周后,周复盘报告能给出"本周观点命中率 X%,偏差主要来自 Y"。
**回滚**:闭环不阻塞主链路,即使 outcome 没回测,复盘报告也能正常出。
**预估**:3-4 天。

#### WP5.1:观点字段扩展(2026-06-22 完成)

**变更范围**:
- `ReviewViewpointRecord` 加 4 个字段:`invalidationSignals: string[]`(失效信号,周复盘对照行情判断)、`confidence: "unknown" | "low" | "medium" | "high"`、`taskType: string`(默认 `daily_review`)、`decisionType: string`(默认 `viewpoint`)
- `ViewpointDraft` 加 2 个可选字段:`invalidationSignals?`、`confidence?`(taskType/decisionType 当前固定值,不需要 draft 传)
- workspace 路径:`ReviewViewpointYamlRecord` 加 4 个 snake_case 列,`toYaml`/`fromYaml` 完整 round-trip
- sqlite 路径:不动 schema(WP5.1 设计明确"字段扩展不动 SQLite"),`fromRow` 给默认值,`replaceByDate` 返回值透传 draft 字段(保证"写完读得到"语义,但 list() 因表无列只能给默认值)

**Why 不动 SQLite schema**:sqlite 是 legacy 兼容路径,WP5 闭环只在 workspace 模式下完整跑(否则该方法不会被采用)。如果 sqlite 路径加列,会和"主用户数据不迁移"决策冲突,徒增迁移脚本复杂度。

**烟测**:`scripts/review-viewpoint-backend-smoke.mjs` 扩展:
- workspace 路径断言 invalidationSignals/confidence 完整 round-trip
- sqlite 路径断言 list() 返回默认值(`[]` / `"unknown"`)

**已删除死代码**:`src/lib/viewpoint-store.ts`(240 行,2025-12 旧"review_viewpoints → decisions.jsonl 双写映射"实现,与 WP4.8 设计冲突)。当前 `viewpoints` 命名空间完全归 `review-viewpoint-backend.ts` 管理。

**下一步**:WP5.2 周复盘自动回测(读 `invalidationSignals`,对照行情判断 hit/miss)。

#### WP5.2:周复盘自动回测(2026-06-22 完成,方法论重构)

**核心方法论**:回测是 Codex 的活,不堆代码限制。代码只做"数据准备 + 解析回填",判定全权交给 Codex 通过 skills + 工具完成。

**变更范围**:

代码层(5-10 行):
- `src/handlers/review.ts:getWeeklyViewpointSummary` 透出完整字段:`invalidationSignals`、`confidence`、`expectedReviewDate`、`reason`、`action`(原只透 view/status/validation)
- `src/handlers/review.ts:formatWeeklyViewpointSummary` 加"待回测观点详情"段,把 open/pending 的回测字段(reason/validation/invalidationSignals)用 markdown 列表呈现给 Codex
- `src/handlers/review.ts:extractViewpointResolutions` 标题正则加 `日复盘观点回测|周观点回测`(原只识别"上一轮观点回测/观点回测表/历史观点回测"),解析规则不变(cells[0]=id, cells[1]=status)
- 导出 `syncViewpointResolutions` 供烟测验证(原 internal)

skills 层(主要工作):
- `.codex/skills/invest-agent-weekly-review/SKILL.md`:workflow 加第 5 步"对 open/pending 观点逐条回测",新增"观点回测判定"小节(规则、判定依据要落到行情事实、输出格式),报告模板"日复盘观点回测"表格列改为 `编号|判定|日期|原观点|失效信号|当周行情|依据`(前两列严格固定供解析)
- `.codex/skills/invest-agent-service-tools/SKILL.md`:Review APIs 段补 `/api/reviews/weekly-context` 和 `/api/reviews/monthly-context`,新增"weekly-context 返回字段"小节详列 viewpointSummary 各字段含义

烟测:
- `scripts/wp52-backtest-parse-smoke.mjs`:模拟 Codex 输出的周复盘报告(含"日复盘观点回测"表格),验证 `extractViewpointResolutions` 能正确识别新标题、解析 `v1|invalidated|...` 行、调 `reviewViewpointBackend.resolve` 回填。测试通过。

**不做的**(刻意保留给 Codex):
- ❌ 不新增 `runWeeklyBacktest` 函数
- ❌ 不在代码里手动拉 K 线、解析股票(Codex 自己调 get_quote/get_kline)
- ❌ 不单独发 LLM 调用(复用周复盘主 prompt)
- ❌ 不写"自动 resolve + 失败容错 + 审计前缀"防御代码

**闭环怎么工作**:
```
用户发"周复盘"
  → generateWeeklyReview → safeAi(prompt)  [已有]
  → Codex 读 weekly-review skill           [skills 更新]
  → Codex 调 /api/sandbox/reviews/weekly-context
  → context 含 viewpoints(含 invalidationSignals/confidence/expectedReviewDate)
                                            [代码层:补字段透出]
  → Codex 对 open/pending 观点:
      - 调 get_quote/get_kline 拉行情
      - 根据 validation / invalidationSignals 判定
      - 报告"日复盘观点回测"表格输出
  → syncViewpointResolutions 解析报告写回 status  [解析器:加新标题]
```

**Why 不堆代码**:用户方法论强调"少用固化代码,多调整 skills,信任顶级 agent"。复杂任务(Codex 判定)交给 skills,可固化部分(数据接口、解析器)做成工具。如果回测逻辑写死在代码里,后续调整(如新增"部分命中"判定、跨周复盘)都要改 TS 重新部署;放 skill 里改 markdown 即可。

**下一步**:WP5.3 月复盘归因(基于本月 validated/invalidated 比例输出 method_change 候选)。

#### WP5.3:月复盘归因(2026-06-22 完成)

**核心方法论**:延续 WP5.2 的"代码极薄 + skills 主导"。归因/偏差识别是 Codex 的活,代码只做"数据准备"。比 WP5.2 更进一步——**不需要新解析器**,因为方法候选有现成 API,Codex 直接调 `/api/sandbox/method-changes/propose`。

**变更范围**:

代码层(几行):
- `src/handlers/review.ts:buildMonthlyReviewContext` 加 `methodChangeProposals`(本月全量 proposed/confirmed/rejected 候选,让 Codex 看到已有提议避免重复)
- `src/handlers/review.ts` import `methodChangeBackend`

skills 层(主要工作):
- `.codex/skills/invest-agent-monthly-review/SKILL.md`:
  - workflow 加第 8 步"系统性偏差归因"
  - 新增"偏差识别规则"小节:命中率分析 / 重复出错模式 / 待回测堆积 / 对照 methodChangeProposals
  - 报告模板加"六、系统性偏差归因"段(具体偏差描述),原"六、策略与方法论改进"重写为"每条改进对应一个 API 调用"
  - Quality Rules 加"改进必须 cite 证据 + 落地为 propose 调用"
- `.codex/skills/invest-agent-service-tools/SKILL.md`:补 Method Changes API 段(propose + decide 完整字段说明 + List 通过 monthly-context)

烟测:
- `scripts/wp53-monthly-context-smoke.mjs`:验证 `buildMonthlyReviewContext` 返回 `methodChangeProposals` 字段透出正确

**为什么不需要新解析器**:
- viewpoint(观点状态)写在报告里给读者看,需要解析回填
- method_change(方法候选)是后端结构化数据,通过 API 直接写入,不需要"先写报告再解析"的中间步骤
- 这是更原生的 API-first 设计,符合用户方法论

**闭环怎么工作**:
```
用户发"月复盘"
  → generateMonthlyReview → safeAi(prompt)    [已有]
  → Codex 读 monthly-review skill             [skills 更新]
  → Codex 调 /api/sandbox/reviews/monthly-context
  → context 含 viewpointSummary + methodChangeProposals
                                              [代码层:补字段透出]
  → Codex 做偏差归因:
      - 算命中率、找重复出错模式
      - 对照 methodChangeProposals 看已提议过什么
      - 对每个新偏差调 /api/sandbox/method-changes/propose
                                              [已有 API,WP4.9]
      - 在报告里输出归因段 + 候选摘要(含 candidate_id)
  → 候选进入 proposed 状态,等用户确认(WP5.5)
```

**下一步**:WP5.4 用户确认入口(微信 + Dashboard),让用户在微信里"确认采用" / "拒绝" 方法候选。

#### WP5.4:用户确认入口(2026-06-22 完成,路径 A)

**核心方法论**:扫描后发现基础设施 90% 已就绪——sandbox decide API + 二次确认机制 + Dashboard 工作台都已存在。**真正的缺口在 skills 层**:Codex 不知道在月复盘后主动告知用户、不知道收到"采用 N"消息时怎么处理。

**路径选择**:做路径 A(微信原生),不做路径 B(Dashboard 管理页按钮)。理由:
- 用户主入口是微信,Dashboard 是开发辅助
- 路径 A 零代码,符合"少加代码,信任 agent"方法论
- 路径 B 改前端代码量不小,价值有限——直接调 API 也能操作

**变更范围**:

代码层:0 行。

skills 层(主要工作):
- `.codex/skills/invest-agent-monthly-review/SKILL.md`:
  - workflow 加第 11 步"输出后行动指引"
  - 新增"输出后行动指引示例"小节:月复盘回复末尾必须包含"待用户确认清单 + 用法",candidate_id 必须真实
- `.codex/skills/invest-agent-service-tools/SKILL.md`:
  - Method Changes 段加"候选确认对话模式(WP5.4)"小节
  - 4 种对话模式:用户主动询问 / 采用单个 / 批量采用 / 用户取消
  - 详细说明 decide + 二次确认的 8 步流程
  - 强调"不要凭印象编造 candidate_id"、"用户表达模糊时反问"

**闭环怎么工作**(完整时序):
```
[月复盘] Codex propose 候选 → 服务端返回 candidate_id
[月复盘] Codex 在回复末尾列候选清单 + "回复'采用 N'即可"
[用户]   "采用 27"
[Codex]  解析 → 调 decide(不带 confirmationId)
[服务端] 返回 confirmation required
[Codex]  告诉用户"请回复确认"
[用户]   "确认"
[Codex]  调 /api/sandbox/confirmations/pending 取 confirmationId
[Codex]  带 confirmationId 重发 decide → 服务端落盘
[Codex]  告诉用户"已采用"
```

**Why 不做 Dashboard 按钮**:用户主入口是微信;Dashboard 工作台已有候选 tile + 列表展示,只读足够;如某天需要批量操作,加 admin API + 前端按钮很简单,留作未来需求。

**下一步**:WP5.6 行为纠偏输出(周/月复盘读 `memory/behavior_events.jsonl` 统计追高/频繁短线/规则外请求)。WP5.5 实际即 WP5.4(原计划写重复了)。

#### WP5.6:行为纠偏输出(2026-06-22 完成)

**方法论延续 WP5.2/5.3**:代码层只透字段,模式识别全权交 Codex。

**代码层改动**(`src/handlers/review.ts`):
- 加 `collectBehaviorStats(userId, instanceId, startDate, endDate)` 辅助函数
- 读 workspace 下 `memory/behavior_events.jsonl`,按时间范围 + instance_id 过滤,按 event_type 聚合:
  - `actionConfirmedCount`:已确认交易动作(`action_confirmed`)计数
  - `conversationTurnCount`:微信对话轮次(`wechat_conversation_turn`)计数
  - `outOfScopeCount`:规则外请求(`out_of_scope_query`)计数
  - `recentActions`:最近 30 条 action_confirmed 详情(`occurred_at` / `code` / `action` / `price` / `quantity`)
- sqlite 模式无 behavior_events 返回 `available=false`,Codex 在报告里说明"数据缺失"
- 异常时降级 `available=false` 并 warn(不阻塞复盘流程)
- `buildWeeklyReviewContext` / `buildMonthlyReviewContext` 都接入

**Skill 改动**:
- `invest-agent-weekly-review/SKILL.md`:Inputs 加 `behaviorStats`,Report Structure 加"六、行为纠偏(WP5.6)"段
- `invest-agent-monthly-review/SKILL.md`:Inputs 加 `behaviorStats`,Report Structure 加"七、行为纠偏(WP5.6)"段

**Codex 识别维度**(代码不做模式识别,信任 agent):
- 追高:连续买入同一标的且价格递增(action 序列中 buy 价格单调上升)
- 频繁短线:open→close 间隔过短(buy 后短时间内 sell)
- 规则外请求:`outOfScopeCount` 异常多
- 复盘节奏:`conversationTurnCount` 与 `dailyReviewCount` 不匹配(对话 vs 复盘不平衡)
- 月度趋势:与上月对比(若可推断)

**Why 不做代码模式识别**:
- 行为模式识别本质是"读 detail 后定性判断",代码做反而限制 Codex 的发现能力
- 模式定义不稳定(下次可能加"集中在某板块加仓"或"反复在同一价位提问"),写死代码会限制演化
- 与 WP5.2/5.3 方法论一致:数据接口只读 + skill 指引 + Codex 自由发挥

**验证**:`scripts/wp56-behavior-stats-smoke.mjs` 模拟 6 条 behavior events(2 action_confirmed + 3 wechat_conversation_turn + 1 out_of_scope_query + 1 其他 instance 的事件应被过滤),验证 weekly/monthly context 都透出正确计数 + recentActions 字段 shape。

**WP5 工作包至此全部完成**(5.1/5.2/5.3/5.4/5.6 已完成;5.5 与 5.4 同一事项)。下一阶段:WP6 文档收敛。



---

### 工作包 6:文档收敛(2026-06-22 完成)

**目标**:把 docs/ 根目录收敛到 5-7 份核心文档,新人能直接上手。

**收敛前现状**:docs/ 根目录 10 份 .md(README + ideal-refactor-plan + table-ownership + 02 + 04 + 11 + 23 + 38 + 39 + 40),其中 38/39/40 是 ideal-refactor-plan.md 出台前的过渡文档,已被主计划覆盖或替代。

**收敛动作**(方案 B,保留 23 沙箱安全模型):

| 任务 | 动作 |
| :--- | :--- |
| 归档 38 | `38-runtime-skill-evolution-strategy.md` → `docs/archive/`。Codex ACP 主路径决策已在 ideal-refactor-plan.md 第一段复述 |
| 归档 39 | `39-invest-agent-ui-workbench-strategy.md` → `docs/archive/`。UI 愿景未启动实施,保留作未来 UI 重写参考 |
| 归档 40 | `40-engineering-convergence-plan.md` → `docs/archive/`。pre-refactor 5 步收敛计划已被 7 工作包替代 |
| 保留 23 | `23-multi-user-sandbox-design.md` 留根目录,因为沙箱安全模型(token 验证/强制隔离/审计)独立于 table-ownership.md,归档会丢失安全决策依据 |
| 更新 README.md | 移除 38/39/40 引用,在"Archived Material"段加 2026-06-22 收敛说明 |
| 更新 AGENTS.md | "Use these files first" 段同步收敛,移除 38/39/40 引用 |
| 更新 scan 脚本 | `scripts/convergence-responsibility-scan.mjs` 的扫描目标列表同步收敛(指向当前 root docs) |
| 修正历史引用 | ideal-refactor-plan.md WP2 表格里的"docs/38-runtime-skill-evolution-strategy.md"补注"已归档至 archive/" |

**收敛后**:docs/ 根目录 **7 份**:
- `README.md`(导航)
- `ideal-refactor-plan.md`(主计划)
- `table-ownership.md`(表归属)
- `23-multi-user-sandbox-design.md`(沙箱安全模型)
- `02-investment-methodology.md`(用户方法论)
- `04-core-workflows.md`(业务闭环)
- `11-server-deployment.md`(部署运维)

**目标 5-6 份的实际偏差**:保留 7 份是因为 23 沙箱安全模型独立,若强行归档需把 token 验证/审计模型迁到 table-ownership.md 或新文档,违反"低熵原则"(table-ownership 已经只讲一件事,不应再塞安全模型)。维持 7 份更内聚。

**未做的子任务**(原计划清单里的,本轮判断不需要):
- ❌ `docs/mvp-architecture.md` 新写——ideal-refactor-plan.md 已是架构入口,不必再写一份
- ❌ `docs/onboarding.md`——AGENTS.md + CLAUDE.md + docs/README.md 已经是新人的 30 分钟入口,不必重复
- ❌ `docs/workspace-model.md`——workspace 与服务层职责边界已在 table-ownership.md + ideal-refactor-plan.md 工作包 0/4 详述

**验收**:
- ✅ docs/ 根目录从 10 份降到 7 份,达成收敛目标(目标 5-6 份,7 份因 23 沙箱安全模型独立保留)
- ✅ 无 dangling 引用(grep 检查通过,仅剩 README.md 自身的归档说明)
- ✅ `npm run build` 通过
- ✅ `scripts/convergence-responsibility-scan.mjs` 扫描目标列表已更新

**回滚**:archive 不删除原文件,只移动,可随时找回。

---

## 六、阶段计划与里程碑

```
M0(启动)
  │
  ▼
M1:工作包 2 — Hermes 清退            (0.5d)
  │  主链路零 Hermes 依赖
  ▼
M2:工作包 0 — 工作空间机制 + 数据迁移  (3d)
  │  模板就绪 + primary 工作空间就绪 + SQLite 冻结
  ▼
M3:工作包 1 — 分流层上线              (2-3d)
  │  DeepSeek 接回主链路 + 多 provider 互备
  ▼
M4:工作包 3 — 协议层 yaml 落地        (2d)
  │  规则配置化 + 14 信号 P0/P1/P2 映射
  ▼
M5:工作包 4 — SQLite 写入冻结 + jsonl  (2-3d)
  │  用户私有产物全部 jsonl
  ▼
M6:工作包 5 — 闭环自进化              (3-4d)
  │  周/月复盘能给出命中率与方法候选
  ▼
M7:工作包 6 — 文档收敛                (1d)
   docs 从 40+ 降到 5-6 份核心
```

| 里程碑 | 完成标志 | 累计工期 |
| :--- | :--- | :--- |
| M0 → M1 | 主链路零 Hermes 依赖 | 0.5 天 |
| M1 → M2 | 模板 + primary 工作空间就绪 | 3.5 天 |
| M2 → M3 | "你好"2s 内回复,DeepSeek 接回主链路 | 6 天 |
| M3 → M4 | 核心规则全部 YAML 化 | 8 天 |
| M4 → M5 | 一次日复盘产生符合 schema 的 jsonl 记录 | 11 天 |
| M5 → M6 | 周复盘能给出本周观点命中率 | 15 天 |
| M6 → M7 | docs/ 从 40+ 降到 5-6 份核心 | 16 天 |

**总工期**:约 16 个工作日(3 周左右)。

---

## 七、风险与回滚

### 7.1 主要风险

| 风险 | 等级 | 缓解措施 |
| :--- | :--- | :--- |
| 工作空间数据迁移丢数据 | 高 | 迁移脚本幂等可重跑;迁移前后 diff 报告人工确认;SQLite 表冻结不删除 |
| DeepSeek 分类准确率不够,错误路由 | 高 | confidence < 0.6 自动降级 CodeX;持续监控 trace 中 route 分布 |
| 国产模型 API 单点不稳定 | 中 | 多 provider 互备(DeepSeek → 豆包 → StepFun),任一故障自动切换 |
| YAML 配置改完后行为不一致 | 中 | 工作包 3 引入 `USE_YAML_CONFIG` 开关,可瞬时回滚到硬编码 |
| JSONL 文件无限增长 | 低 | 按月归档,保留近 3 个月热数据 |
| 闭环回测引入错误归因,误导用户 | 中 | 方法候选必须用户确认才落盘,系统不静默修改知识库 |
| 文档收敛误删有用内容 | 低 | 全部 archive 不删除,保留恢复能力 |
| CodeX 工作目录切换影响现有 session | 中 | 工作包 0 联调时验证 codex-stdio-agent 的 CWD 切换;保留旧路径作 fallback |

### 7.2 整体回滚策略

- 每个工作包独立 commit,可单独 revert
- 关键开关:
  - `TRIAGE_ENABLED`(工作包 1)
  - `WORKSPACE_MIGRATION_ENABLED`(工作包 0)
  - `USE_YAML_CONFIG`(工作包 3)
  - `JSONL_WRITE_ENABLED`(工作包 4)
- 任一阶段卡住,可保留已完成工作包,跳过后续,不影响现有功能

---

## 八、决策记录

| 日期 | 决策 | 理由 |
| :--- | :--- | :--- |
| 2026-06-21 | CodeX 一律兜底,Hermes 退出主链路 | Hermes 反应不佳,CodeX 已稳定 |
| 2026-06-21 | 分流策略选 B(DeepSeek 分类) | 规则匹配僵化、漏召回高;第一层必须让 AI 处理 |
| 2026-06-21 | 协议层用 jr-backend 原版 YAML | 保留理想型的协议完备性,不做格式转换 |
| 2026-06-21 | 工作包顺序 2 → 0 → 1 → 3 → 4 → 5 → 6 | 先清退 Hermes 让主链路干净,再建工作空间基石,然后上分流见效,最后做协议/闭环/文档 |
| 2026-06-21 | **工作空间 = 模板拷贝,每用户一份** | 对齐 jr-backend 设计;CodeX/DeepSeek 都基于工作空间读写;SQLite 只保留服务层职责 |
| 2026-06-21 | DeepSeek 主 + 豆包/StepFun 备,多 provider 互备 | 国产模型单点不稳定,互备确保分流层可用性 |
| 2026-06-21 | 工作空间位置 `data/workspaces/<userId>/`,模板源 `templates/workspace/` | 与现有 `data/invest-agent.db` 同级,统一在 `data/` 下管理 |
| 2026-06-21 | 14 个信号 P0/P1/P2 按草案映射,联调期微调 | 草案见 5.3.1,以信号语义为依据 |
| 2026-06-21 | SQLite 表归属三类划分(保留 / 迁工作空间 / 丢弃) | 见工作包 0c 详细划分 |
| 2026-06-21 | 投资无关问题由 DeepSeek light 在 triage 层判断并友好拒绝 | 不让用户随意问非投资问题;不让 CodeX 兜底浪费成本;边界模糊宁可放进投资相关 |

---

## 九、已确认事项 ✅

| 事项 | 状态 |
| :--- | :--- |
| 分流策略 B(DeepSeek 分类) | ✅ 已确认 |
| 工作包顺序 2 → 0 → 1 → 3 → 4 → 5 → 6 | ✅ 已确认 |
| 协议层用 jr-backend 原版 YAML | ✅ 已确认 |
| CodeX 一律兜底,Hermes 退出主链路 | ✅ 已确认 |
| 工作空间模型(每用户一份模板拷贝) | ✅ 已确认 |
| SQLite 表归属三类划分方向 | ✅ 已确认 |
| 14 信号 P0/P1/P2 按草案映射 | ✅ 已确认 |
| 国产模型多 provider 互备(DeepSeek + 豆包 + StepFun) | ✅ 已确认 |
| 工作空间位置 `data/workspaces/<userId>/` | ✅ 自决(按最佳实践) |
| 模板源 `templates/workspace/` | ✅ 自决(按最佳实践) |
| 现有数据迁移策略:primary 一次性迁移 | ✅ 自决(按最佳实践) |
| 写入路径统一(通过 handler 工具,不直接写文件) | ✅ 自决(按最佳实践) |
| archive 沿用 `docs/archive/` | ✅ 自决(按最佳实践) |
| 可视化看板:工作包 3 之后再补 | ✅ 自决(按最佳实践) |
| 分流延迟:5s 超时切豆包,全失败降级 CodeX | ✅ 自决(按最佳实践) |
| 投资无关问题:triage 层判断 + LLM 生成友好拒绝 + 引导回投资 | ✅ 已确认 |
| 边界模糊时宁可放进投资相关让 CodeX 兜底,不误杀 | ✅ 自决(按最佳实践) |
| out_of_scope confidence ≥ 0.7 才拒绝,低于则自然处理 | ✅ 自决(按最佳实践) |
| 拒绝话术由 LLM 生成(非固定模板),保留个性化引导 | ✅ 自决(按最佳实践) |
| 边界文档并入 AGENTS.md(不独立文件) | ✅ 自决(按最佳实践) |
| 反作弊(连续 N 次升级提醒)本期不做,数据先攒 | ✅ 自决(按最佳实践) |

---

## 十、执行期再确认事项(联调阶段)

这些不在计划阶段定死,在对应工作包落地时联调确认:

1. **分流 prompt 措辞**(工作包 1):DeepSeek 分类效果可能需要 2-3 轮 prompt 优化,以 trace 中 route 分布与人工抽检为准。
2. **三级路由边界用例**(工作包 1):某些意图(如"帮我看看观察池")到底算 deterministic 还是 complex,以 10-20 个真实样例分类结果为准。
3. **14 信号 P0/P1/P2 阈值**(工作包 3):草案等级已定,具体阈值(如 price_change 多少百分比算 P0)以复盘报告合理性为准。
4. **方法候选确认 UX**(工作包 5):用户在微信里如何"确认采用",需要在工作包 5 设计时定具体交互。
