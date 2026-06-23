# 19 — Skill 闭环加固执行计划

> 创建于 2026-06-03。本文档用于落实本轮 Skill 闭环审查后的四项明确工作：可审计日志、路线图同步、客户输出边界、复盘 Skill 迁移方案。

## 背景

当前项目已经切到“本机 Codex + ACP + invest-agent 确定性服务/API + `.codex/skills`”的主架构。服务继续负责微信连接、Dashboard、SQLite、行情、巡检、提醒、落库和推送；Codex 与 Skills 负责复盘、选股问答和投资判断流程。

本轮审查发现 Skills 已经形成方法论闭环雏形，但仍有几个工程和文档边界需要加固：

- Codex ACP 主链路缺少新的可审计响应日志，无法完整追踪异常回复。
- `docs/15-next-phase-roadmap.md` 状态滞后，没有反映提醒状态去重、选股 Skill 拆分、客户话术边界等最新变化。
- 客户回复仍可能泄露内部路径、localhost、端口、curl、接口名、服务状态或工程组件名。
- 复盘 Skills 需要参照 `jr-backend` 的复盘提示词和输出纪律，但不能照搬它“每只股票一个目录”的文件组织；当前项目应继续以数据库和服务上下文管理复盘数据。

## 目标

1. 完善当前 Codex ACP 主链路的可审计日志，让异常回复可回溯。
2. 更新路线图，把当前已完成和明确暂缓的事项同步到项目事实源。
3. 加固客户输出边界，禁止内部工程细节出现在微信客户话术中。
4. 明确复盘 Skill 的迁移计划：参考 `jr-backend` 的复盘质量，不继承其目录结构。

## 非目标

- 本轮不新增财务、新闻、公告、技术指标等确定性数据 API。
- 本轮不扩展选股问答的数据源能力；第三点“确定性数据支撑”继续观察，后续再做。
- 本轮不恢复旧自研 Runtime，不做关键词路由回退。
- 本轮不把 `jr-backend` 的 `review/<股票>.md` 或每股目录结构迁入当前项目。
- 本轮不改变持仓/自选池的核心数据模型。

## 当前决策

### 确定性数据暂缓

选股问答的确定性数据能力现在暂不纳入本轮。当前阶段优先搭闭环：用户提问、Codex 按 Skill 判断、必要时加入自选池、设置预案和提醒、进入巡检与复盘。行情、资金流、财务、公告、新闻、候选股批量技术位置等高频 API 后续再按真实使用频率补。

### 复盘数据管理方式

复盘方法参考 `jr-backend`，但复盘数据管理采用当前项目方式：

- 数据来源：SQLite + 服务生成的结构化上下文。
- 报告保存：继续由服务保存到 `daily_plans` 和 `reviews/` artifact，后续可扩展 `review_reports` / `review_viewpoints` 等表。
- 不采用 `jr-backend` 的每只股票一个目录方式。
- 日复盘、周复盘、月复盘都应围绕数据库记录、提醒事件、预案、持仓/自选池状态和历史报告形成连续审计链。

## 工作项

### W1：Codex ACP 可审计日志

**问题**

旧 `agent_traces` 表属于旧 Runtime 阶段历史追踪。当前 Codex ACP 主链路只有运行日志和部分状态日志，缺少可用于排查客户异常回复的结构化记录。

**建议实现**

在当前主链路新增或复用一套 ACP trace 写入逻辑。优先方案是新增轻量表，例如 `codex_acp_traces`：

| 字段 | 说明 |
| --- | --- |
| `id` | 自增主键 |
| `conversation_id` | 微信会话或 ACP conversation id |
| `message_id` | 本轮消息 id |
| `channel` | `weixin-mobile` / `dashboard` / `acp-http` 等 |
| `user_text` | 用户原始文本，必要时截断 |
| `prompt_text` | 发给 Codex 的最终 prompt，建议截断或摘要 |
| `reply_text_raw` | Codex 原始回复，建议截断 |
| `reply_text_sanitized` | 经过客户话术清洗后的最终回复 |
| `mode` | `chat` / `daily-review` / `screening` / `watchlist-mutation` 等 |
| `review_context_summary` | 如果是复盘，记录日期、股票数、提醒数等摘要，不存完整大 JSON |
| `status` | `success` / `timeout` / `error` |
| `error_message` | 异常信息，截断 |
| `elapsed_ms` | Codex 调用耗时 |
| `created_at` | 创建时间 |

**落点**

- `src/db/index.ts`：建表和索引。
- `src/db/schema.ts`：Drizzle schema。
- `src/acp/agent.ts`：在 `handleMessage` 成功、超时、异常时写 trace。
- `src/channels/weixin-mobile.ts`：后台日复盘异步流程也要写同一类 trace，至少记录 job key、ack、最终推送结果或失败原因。
- 可选：Dashboard 增加只读最近 trace 查询接口，但本轮不是必须。

**注意**

- trace 是内部排障数据，不进入客户回复。
- 对 prompt 和 reply 做长度上限，避免 SQLite 无限膨胀。
- 不记录 token、cookie、微信 token、环境变量、完整内部路径。
- 错误 trace 也要写入，否则最需要排查的场景反而没有记录。

### W2：路线图更新

**问题**

`docs/15-next-phase-roadmap.md` 仍显示部分事项待做或描述不完整。

**更新范围**

- D4-4 提醒降噪：补充“状态型提醒去重已完成”，例如止损/破位/支撑附近不应每 5 分钟重复推送。
- D4-5 日复盘 Skill 驱动：改为“进行中”，说明已有服务注入上下文 + Codex/Skill 生成 + 服务保存/推送，但 Skill 文档仍需对齐服务职责。
- D4-6 选股问答 Skill 驱动：改为“进行中”，说明已拆分主 Skill 和行业、公司价值、护城河、技术位置、风险等子 Skill；确定性数据 API 暂缓。
- D4-7 高频确定性 API 清单：明确“暂缓”，后续根据真实高频需求补，不作为当前闭环搭建前置条件。
- 新增 D4-8 可审计日志：Codex ACP trace。
- 新增 D4-9 客户输出边界加固：禁止内部工程细节泄露。
- 新增 D4-10 复盘 Skill 质量迁移：参考 `jr-backend` 提示词和复盘纪律，但使用当前数据库/服务上下文。

### W3：客户输出边界加固

**问题**

客户回复可能出现内部路径、localhost、端口、curl、接口名、Codex/ACP、服务状态、日志目录、调试描述等内容。测试时可接受，但面向客户显得不专业。

**建议实现**

1. 加强 Skill 文档规则：
   - `.codex/skills/invest-agent-service-tools/SKILL.md`
   - `.codex/skills/invest-agent-stock-screening-qa/SKILL.md`
   - `.codex/skills/invest-agent-daily-review/SKILL.md`
   - `.codex/skills/invest-agent-weekly-review/SKILL.md`
   - `.codex/skills/invest-agent-monthly-review/SKILL.md`

2. 统一加一条硬规则：
   - 最终客户回复不得出现 `localhost`、端口、curl、API 路径、文件路径、日志路径、Codex、ACP、Skill 名称、内部服务名、执行栈或“服务重启/服务未响应”等未经证明的运维判断。

3. 加强 `src/lib/customer-output.ts`：
   - 补充 `/api/...`、`curl ...`、端口号、常见内部组件名、`src/...`、`docs/...`、`.codex/...` 等模式。
   - 对“服务没有响应”“我重启了服务”等表述谨慎处理：没有服务端事实时不要保留为客户结论。

4. 在 `src/acp/codex-stdio-agent.ts` 的移动端 system prompt 中继续保留边界，但不要只依赖 prompt；最终回复仍要经过 sanitizer。

**验收标准**

- 模拟 Codex 返回包含路径、localhost、curl、API、Skill 名称的文本，最终客户文本应被清洗。
- 微信普通问答、选股问答、日复盘三类回复都不应暴露内部细节。
- 如果真实发生超时或失败，客户话术只说“这次分析生成超时了，请稍后再试”，不推断服务状态。

### W4：复盘 Skill 迁移方案

**问题**

当前日复盘 Skill 已经有结构，但周/月复盘仍更像方法草案；同时日复盘 Skill 里对微信场景仍保留直接 curl 和 save 的流程，和当前服务托管异步流程有职责冲突。

**参考源**

- `/Users/combo/MyFile/projects/jr-backend/AGENTS.md`
- `/Users/combo/MyFile/projects/jr-backend/review/2026年05月29日复盘总结.md`
- `/Users/combo/MyFile/projects/jr-backend/review/weekly/2026年第22周.md`

**迁移原则**

- 迁移复盘质量，不迁移目录结构。
- 保留 `jr-backend` 的强项：
  - 核心结论先行。
  - 区分核心仓、非核心仓、观察标的。
  - 明确操作纪律：持有、等待、减仓、分批、验证点。
  - 观点追踪表。
  - 日复盘进入周复盘，周复盘回测日复盘观点。
  - 明确数据来源和数据限制。
- 调整为当前项目模型：
  - `持仓池`、`自选池`、`stock_plans`、`alert_events`、`daily_plans`。
  - 不使用 `jr-backend` 的“每只股票一个 Markdown 目录”。
  - 由服务注入上下文、保存报告、更新数据库；Skill 只负责分析结构和输出纪律。

**日复盘 Skill 修正方向**

重写 Service Context Workflow 的优先级：

1. 如果 prompt 已包含服务提供的复盘上下文 JSON：直接生成客户可读复盘，不调用 API，不保存，不提工具。
2. 如果 Codex 独立运行且没有上下文：可调用 `invest-agent-service-tools` 获取 `/api/reviews/context`。
3. 保存和推送默认由服务负责；只有独立手工运行时才调用保存接口。

**周复盘/月复盘方向**

短期先明确为“半自动/文件+数据库混合”：

- 周复盘应读取本周 `daily_plans` / `reviews/`、`alert_events`、`stock_plans` 和当前持仓/自选状态。
- 月复盘应读取周复盘、日复盘、提醒事件、计划变化、筛选到自选的记录。
- 在专门 API 未完成前，Skill 需要明确说明数据缺口，不假装已经有完整上下文。

中期再补服务上下文接口：

- `/api/reviews/weekly-context`
- `/api/reviews/monthly-context`

但这不是本轮必须实施内容。

## 执行顺序

1. 实施 W1：先补 Codex ACP trace，因为它能帮助后续所有异常排查。
2. 实施 W3：再加固客户输出边界，避免继续出现内部话术泄露。
3. 实施 W2：同步路线图，把当前完成、进行中、暂缓事项写清楚。
4. 实施 W4：调整复盘 Skills，先解决日复盘职责冲突，再增强周/月复盘说明。

## 验收标准

- 任意一轮微信客户消息，成功或失败后都能在内部 trace 中看到：用户文本、最终回复、状态、耗时和异常摘要。
- 日复盘异步任务也有 trace，可排查“收到请求、生成中、最终推送/失败”。
- 客户最终回复不暴露路径、接口、端口、curl、Codex/ACP/Skill 等内部词。
- `docs/15-next-phase-roadmap.md` 准确反映当前阶段：
  - 提醒去重已完成。
  - 日复盘和选股问答 Skill 驱动进行中。
  - 确定性数据 API 暂缓。
  - ACP trace、客户话术边界、复盘 Skill 迁移列入近期工作。
- 日复盘 Skill 与当前服务托管流程一致，不再鼓励微信场景重复调用 API 和保存接口。
- 周/月复盘 Skill 明确当前数据来源和缺口，不假装已有完整自动化上下文。

## 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| trace 记录过多导致数据库膨胀 | 对 prompt/reply/error 做长度上限，后续加清理策略 |
| trace 写入异常影响客户回复 | trace 写入失败只记日志，不阻断主流程 |
| sanitizer 误删正常投资表达 | 添加有代表性的测试样例，先覆盖内部工程词，不做过度语义改写 |
| Skill 文档过度规定导致回复僵硬 | 只硬约束边界和证据纪律，不固定所有话术 |
| 周/月复盘被误认为已全自动 | 文档明确“短期半自动，完整 context API 后续再补” |

## 执行交接提示

Executor prompt:

```text
请按 docs/archive/19-skill-loop-hardening-plan.md 执行本轮加固。范围只包括 W1 可审计日志、W2 路线图更新、W3 客户输出边界、W4 复盘 Skill 职责对齐。不要新增选股问答确定性数据 API，不恢复旧 Runtime，不迁移 jr-backend 的目录结构。完成后运行类型检查/构建和相关 smoke 测试，并说明 trace、sanitizer、文档更新的验证结果。
```

Reviewer prompt:

```text
请审查执行结果是否符合 docs/archive/19-skill-loop-hardening-plan.md。重点检查：Codex ACP 成功/异常是否都有 trace；客户最终文本是否不会泄露内部路径/API/端口/Skill/ACP；路线图是否准确反映进行中和暂缓事项；复盘 Skills 是否遵守服务负责上下文与保存、Skill 负责判断结构的边界。不要要求新增确定性数据 API，除非执行者误把它纳入本轮。
```
