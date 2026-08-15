# 上下文与提示词架构（Mastra 候选分支）

状态：已实施（2026-08-15）；适用于 `feat/mastra-migration`
前置：[mastra-architecture-baseline.md](./mastra-architecture-baseline.md)、[mastra-workspace-exit-mapping.md](./mastra-workspace-exit-mapping.md) 第 7 节

本文定义 Mastra 运行时的上下文组装分层、多轮历史、系统指令与方法论 Skills 的归属。它是旧 Workspace `AGENTS.md` + `.codex/skills` 提示词体系在新内核下的正式承接。

## 1. 分层总则

| 层 | 内容 | 载体 | 变更方式 |
| --- | --- | --- | --- |
| L1 常驻系统指令 | 身份、能力边界、投资纪律、事实标准、工具学说、方法论引导、通道呈现政策 | `src/runtime/agent-instructions.ts`（版本化代码），经 `createMastraAgent({ instructions })` 注入 | 走代码评审与发布 |
| L2 状态类上下文 | 初始化提示、复盘上下文 JSON、附件框架、待确认事项 | 服务端按需组装进当轮用户消息 | 服务代码 + 运行时状态 |
| L3 多轮历史 | 当前会话的历史消息 | `conversation_messages` 权威表 → `loadConversationHistory` → `runMastraTurn({ history })` | 用户对话自然产生 |
| L4 用户方法论 | 用户投资方法、风格、策略规则 | workspace `skills/`（SKILL.md）与 `methods/` | 用户主导演化：草案 → 确认 → 落盘 |

红线不变：安全、scope、确认、审计由服务层强制；用户文件（L4）不能覆盖 L1 系统指令或扩大权限。

## 2. 多轮历史（L3）

- 每轮从权威表 `conversation_messages` 按当前 `conversationId` 读取最近消息（默认 24 条、单条 2400 字符、总预算 24000 字符；预算从旧往新丢弃，至少保留最新一轮）。
- 排除当前轮：web 路径按 `request_id`（Portal requestId 已透传到 agent context）；微信路径按"最新一条 user 消息与当前文本完全一致"兜底。两条通道都在调用 agent 前落库当前用户消息，必须显式排除避免重复。
- 不引入 Mastra Memory：其自带存储会与 `conversation_messages` 形成双事实源（DB merge 后的单一事实源原则）。
- 历史读取失败降级为空数组，绝不阻塞交互回合。
- 自动化一次性会话（`automation-run:<runId>`）自然没有历史，无需特判。

## 3. 系统指令（L1）

`buildAgentInstructions({ channel })` 组装：基础段（身份/边界/纪律/工具学说/方法论引导/输出要求）+ 通道段（web 的表格、invest-svg、artifact 交付政策；微信的简洁 Markdown 要求）。

迁移记录：web 通道政策原先每轮前缀在用户消息里（`buildChannelForwardPrompt`），2026-08-15 迁入系统指令；用户消息只保留附件框架。`buildChannelContextInstruction` 仍从 `agent.ts` 导出（通道段的内容源，测试依赖）。

调度任务（日/周/月复盘等）同样注入基础系统指令；任务专属指令（如"必须调用 reviews.save"）仍在任务提示词里，具体指令优先于基础学说。

## 4. 方法论 Skills（L4）

定位：**系统播种初始版本，之后是用户的可进化资产**。用户不会手改 SKILL.md 没关系——正常演化路径是用户在对话中表达方法调整，Agent 整理草案、经确认后更新文件并留痕。

- 模板：`templates/skills/`（fundamental-analysis / technical-analysis / macro-analysis / risk-control），内容承接旧 `knowledge/methods/` 默认框架并适配新内核（引用服务工具与 `methods/strategy-rules.md`，不再引用旧 config yaml）。
- 播种：`MastraWorkspaceRegistry.bootstrap()` 调用 `seedSystemSkills()`——只复制不存在的文件，永不覆盖用户演化后的版本；模板根缺失不报错（老部署可没有 templates/）。可用 `SYSTEM_SKILLS_TEMPLATE_ROOT` 覆写。
- 存量项目：`node scripts/seed-mastra-skills.mjs [--dry-run] [--root <projects-root>]`，同样幂等、不覆盖。服务器布局默认读 `data/projects`。
- Mastra Workspace 以 `skills: ["skills"]` 挂载，SKILL.md 自动进入 agent 的 skills 清单并渐进式披露（search/load）。
- 旧 `.codex/skills` 的产品流程型 skill（daily-review、market-watch、onboarding 等）**不迁移**：其职责已由 typed automation tasks、调度提示词组装和服务代码接管，迁回等于用文档当安全边界。
- workspace 写工具策略（approval + read-before-write + 审计）约束 skill 文件的修改路径。

## 5. 遗留问题（已留坑）

- **"越用越好用"**：跨会话个性化记忆、方法演化的自动建议（复盘时主动提出 skill 修订建议）、用户偏好沉淀。当前只做了 L3 会话内历史 + L4 手动/半自动演化；跨会话记忆层暂不设计，待产品验证后立项。
- 旧生产 Workspace 中用户实例的 `AGENTS.md` / `.codex/skills` 属于用户资产，按红线只能报告差异，不能自动迁移或删除。

## 6. 部署注意

- 播种读取运行目录下的 `templates/skills`；发布必须同步模板目录（普通代码发布本来就包含模板）。
- 服务器存量三个 beta 用户项目执行一次 `scripts/seed-mastra-skills.mjs`（先 `--dry-run` 核对）。
- 历史注入会增加每轮 token 消耗（约等于最近 24 条消息的文本量），计价与 trace 已覆盖该成本。
