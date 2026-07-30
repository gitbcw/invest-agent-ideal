# 开发 Agent 上下文治理落地计划

> 归档说明（2026-07-28）：本计划已执行完成，仅保留为上下文治理过程记录；当前项目红线与文档索引分别以根 `AGENTS.md` 和 `docs/README.md` 为准。

## 背景

本项目的开发任务随着项目演进而变慢，主要不是单个文档过长，而是启动时缺少稳定的上下文分流与权威来源机制。当前根 `AGENTS.md` 要求先阅读 `CLAUDE.md`、`docs/README.md` 和 `docs/system-overview.md`；四份入口材料重复描述运行时、ACP、发布与 Portal 等事实。开发 Agent 必须先判断资料是否相关、是否一致、是否仍然有效，才可进入代码与验证。

`CLAUDE.md` 同时承载了 Claude Code 项目指令、命令速查、架构概览、API/数据库说明和运维细节。它既不适合作为 Codex 的根约定，也不适合继续作为任何 Agent 的默认上下文。

本计划只治理**本仓库开发 Agent**的上下文。它不改动 Workspace 模板、真实用户 Workspace、产品 ACP 会话策略、投资工作流或服务运行时语义。

## 目标

1. 移除活跃仓库中的根 `CLAUDE.md`，不以另一个百科式根文件替代。
2. 将根 `AGENTS.md` 收敛为开发 Agent 的短启动层：全局红线与任务分流入口。
3. 将 `docs/README.md` 升级为可执行的任务上下文地图：每类任务明确权威材料、条件材料和最小验证面。
4. 让当前架构事实、领域契约、操作流程和历史证据各有唯一责任边界，减少重复和交叉核对。
5. 保持现有安全约束、发布/Workspace 资产保护与验证能力不退化。

## 非目标

- 不重写或自动替换 `templates/workspace/`、真实 Workspace 的 `AGENTS.md` 或 Skills。
- 不改变普通微信消息直通 ACP 的产品运行时语义。
- 不删除仍是当前权威的领域契约，不把协议细节移入根 Agent 指令。
- 不在本次工作中整理 `docs/archive/` 的历史材料，除非它们阻断 `CLAUDE.md` 的引用迁移。
- 不以“减少行数”为唯一目标；任何全局安全红线不得因收缩而丢失。

## 设计原则

### 上下文的四种身份

| 身份 | 读取时机 | 权威位置 |
| --- | --- | --- |
| 全局红线 | 每个开发任务 | 根 `AGENTS.md` |
| 当前架构事实 | 任务涉及相应架构面时 | `docs/system-overview.md` 或明确领域文档 |
| 任务局部契约与操作流程 | 由任务类型触发 | 项目 `.codex/skills/` 与领域契约 |
| 历史证据与考古 | 当前权威资料明确要求时 | `docs/archive/` |

### 读取规则

- 开发 Agent 默认只读取根 `AGENTS.md` 的短启动层，再根据任务地图进入一条任务通道。
- “重要”不等于“默认读取”。命令、端口、工具清单、表结构和部署步骤只在对应任务中展开。
- 每个当前事实只指定一个权威来源；摘要仅保留边界和链接，不复制完整结论。
- Skill 的 `Read First` 必须区分必读与条件读取，不得再要求所有任务重复读取根架构材料。

## 目标信息架构

### 根 `AGENTS.md`

保留：

- 项目一句话定位；
- 不可绕过的安全与资产红线：不得未经明确授权替换生产运行时数据或用户 Workspace 资产；安全性约束必须由服务层/MCP 强制；不从历史材料推翻当前权威契约；
- 任务启动规则：先在 `docs/README.md` 选择任务通道，不默认阅读全量资料；
- 指向 `docs/README.md` 的单一链接。

移出：产品能力清单、详细架构、模型档位、命令、领域 API、评测方法、Portal 细节、复盘/选股方向、投资输出和策略预案规则。后两类属于 Workspace 产品行为，在本计划中只从开发启动层移除，不迁移或改写 Workspace 资产。

### `docs/README.md`

保留其导航职责，但将“Read These First”改为短入口说明，并新增或重构任务表。每行必须包含：

| 字段 | 说明 |
| --- | --- |
| 任务通道 | 可由请求稳定识别的开发任务类型 |
| 触发条件 | 何时使用该通道 |
| 必读 | 当前任务必须读取的最小权威材料 |
| 条件读取 | 只有满足具体条件才读取的材料 |
| 验证面 | 最小构建、测试、smoke 或真实交互证据 |

最低覆盖的通道：

1. 局部 TypeScript / 测试问题；
2. 服务 API、MCP、Platform 或 Portal 变更；
3. SQLite schema、迁移、回填与数据归属；
4. Scheduler、规则巡检与推送排障；
5. 生产发布、回滚和运行时迁移；
6. Portal 协议或本地 connector 变更；
7. 文档与当前权威契约维护；
8. 真实交互评测与问题归因。

### 领域事实与操作流程

- `docs/system-overview.md`：唯一的当前运行时与职责边界概览；不再将 `CLAUDE.md` 列为下一步阅读材料。
- `docs/service-tools-mcp.md`：MCP 工具契约与验证；不把其内容复制到入口文件。
- `docs/table-ownership.md`：表归属与迁移判断；不把表清单复制到入口文件。
- `docs/user-portal.md` / `docs/user-portal-protocol.md`：Portal 当前契约；任务地图与 service API Skill 指向精确章节或条件，而非默认加载全协议。
- 项目 `.codex/skills/`：可重复执行的流程、条件读取和验证命令。它们是任务层入口，不是根文档的附录。
- `package.json`：可执行命令的唯一事实来源；文档只能选择和说明命令，不维护第二份完整命令表。

## 执行计划

### 1. 建立迁移清单与权威归属表

在修改前，对 `CLAUDE.md` 的每个章节建立逐段清单，标记为：保留到根红线、迁入已有权威文档、迁入 Skill/reference、已重复可删、历史记录应归档。对每项记录目标来源与验证方式。

重点检查以下现有章节：项目概述、常用命令、版本与生产基线、环境配置、消息主链路、关键文件、服务能力、HTTP/Portal、数据源、复合指标、数据库、文档入口。

禁止直接复制内容到新位置；先确认目标文档是否已经是等价的当前权威来源。

### 2. 收缩根 `AGENTS.md`

将根文件改为短启动层，并删除“先读四份文件”的强制加载规则。保留的全局红线用可操作的禁止/要求描述，避免写入领域实现细节。

对拟移出的投资行为规则，仅在确认它们不再作为开发 Agent 默认上下文所需时移出；本计划不修改或覆盖 Workspace 资产。对于发现的根目录独有产品约束，记录为后续独立的 Workspace 治理前置项，而不是在本次范围内偷偷迁移。

### 3. 重建 `docs/README.md` 的任务地图

将现有文档目录改造成上述八类任务通道。每个通道先指向一个 Skill 或一个当前权威文档，再列出明确条件下才需要展开的材料。

新增“停止规则”：完成必读集、能够定位受影响代码和验证面后，不应继续通读同领域的其他资料；只有出现权限、生产数据、跨边界行为或当前资料冲突时，才展开条件材料。

### 4. 调整项目 Skills 的读取契约

审查 `service-api-change`、`db-migration`、`scheduler-push-debug`、`volcano-ops` 及评测类 Skills。

- 移除对已删除 `CLAUDE.md` 的依赖；
- 将笼统的根文档读取替换为任务必需的具体来源；
- 将 Portal、sandbox、生产迁移等写成条件读取；
- 让每个 Skill 的验证段与任务地图保持一致；
- 不改变任何运行时操作流程、权限或安全门槛。

### 5. 迁移引用并删除 `CLAUDE.md`

在所有现行引用更新后删除根 `CLAUDE.md`。本次已确认的迁移面至少包括：

- `README.md`；
- 根 `AGENTS.md`；
- `docs/README.md` 与 `docs/system-overview.md`；
- 当前 watch、策略、指标、onboarding、Portal 等设计文档中的现行引用；
- `docs/project-intent-pack/` 的 evidence/source 列表；
- `scripts/check-agent-context.mjs` 的扫描与契约文件清单。

历史文件若仅记录“曾更新 CLAUDE.md”，应优先归档或保留为历史陈述，不为删除文件而伪造当前引用。

### 6. 更新自动检查与验证

修改 `scripts/check-agent-context.mjs`，使其不再把 `CLAUDE.md` 视为扫描/契约前提，并增加以下轻量检查：

- 不存在面向当前操作的 `CLAUDE.md` 引用或死链接；
- 根 `AGENTS.md` 不再要求全量入口预读；
- `docs/README.md` 存在上述任务通道及每条的验证面；
- Skill 引用的路径和 `npm run` 命令仍有效。

不要把文档长度作为机械失败条件；以身份边界、链接完整性和任务通道可用性作为验收依据。

### 7. 分层验证与评审

1. 运行 `npm run check:agent-context`，修复所有当前文档链接、仓库路径和命令引用。
2. 运行 `npm run verify`，确认文档检查变更没有影响 TypeScript、单测或隔离 smoke。
3. 选择至少四个代表任务进行桌面回放：局部测试失败、MCP/API 变更、数据库迁移、生产发布。对每项记录必读材料、条件材料是否触发、验证面是否可在不读全仓文档的情况下确定。
4. 由独立 reviewer 对照本计划验收：确认没有安全红线丢失、没有把 Workspace 治理混入本范围、没有保留第二本 `CLAUDE.md` 式百科入口。

## 受影响文件

预期会修改：

- `AGENTS.md`
- `README.md`
- `docs/README.md`
- `docs/system-overview.md`
- `docs/project-intent-pack/00-summary.md`
- `docs/project-intent-pack/01-system-intent.md`
- `docs/project-intent-pack/03-feature-specs.md`
- 当前仍将 `CLAUDE.md` 作为操作前提的设计文档
- `.codex/skills/*/SKILL.md`
- `scripts/check-agent-context.mjs`

预期会删除：

- `CLAUDE.md`

执行前必须重新检查工作树。当前 `CLAUDE.md`、`docs/README.md` 和其他文档已有未提交改动；执行者必须理解并保留这些改动，不得用重置、覆盖或批量重写清除它们。

## 验收标准

- 根目录不存在活跃 `CLAUDE.md`，且所有当前链接、脚本和任务入口均不再依赖它。
- 根 `AGENTS.md` 能在短时间内说明全局红线与如何选择任务通道，但不再充当架构手册、命令表或投资行为手册。
- 开发 Agent 可从 `docs/README.md` 为八类任务选择一条明确路径，得到必读集、条件读取集和最小验证面。
- 当前架构事实在一个权威位置维护；入口页或 Skill 不复制其长篇内容。
- 所有项目 Skill 在不读取 `CLAUDE.md` 的前提下仍能找到所需事实与验证命令。
- `npm run check:agent-context` 与 `npm run verify` 均通过。
- 四个代表任务的桌面回放表明，Agent 不需要在任务开始时读取原先四份入口材料才能找到受影响代码和验证路径。
- 没有修改真实 Workspace、模板 Workspace 或产品运行时行为。

## 风险与控制

| 风险 | 控制 |
| --- | --- |
| 删除总手册后遗漏必要红线 | 先做逐段归属表；独立 reviewer 检查根红线与安全 Skill |
| 把服务/产品运行时分流误解为开发任务分类 | 在任务地图中明确二者不同；不触碰普通微信消息路径 |
| 将 Workspace 行为规则误删 | 本计划不编辑 Workspace；独有规则仅记录为后续事项 |
| 当前工作树改动被覆盖 | 修改前读 diff；只做小块补丁；不执行 reset/checkout |
| Skill 失去关键来源 | 每个 Skill 改动后执行其最小路径检查与 `check:agent-context` |
| 文档变短但任务仍找不到验证面 | 用四类代表任务回放作为强制验收 |

## 执行交接

### Executor prompt

按本计划实施开发 Agent 上下文治理。范围仅限根 `AGENTS.md`、`CLAUDE.md`、项目文档、项目级 `.codex/skills` 与文档检查脚本。先建立 `CLAUDE.md` 的逐段归属表，再修改入口与引用，最后删除 `CLAUDE.md`。保留所有既有未提交改动；不得修改 Workspace 模板、真实 Workspace、产品 ACP 运行时或服务行为。每次缩减默认上下文时，说明对应的权威来源和最小验证面。

### Reviewer prompt

按本计划验收实现结果。重点检查：`CLAUDE.md` 是否已完全退出当前依赖链；根 `AGENTS.md` 是否只保留开发任务全局红线和分流入口；任务地图是否为每个通道提供必读、条件读取和验证面；Skills 是否仍可独立定位资料；所有安全与资产保护约束是否仍有权威承接。不要把 Workspace 或产品 ACP 上下文治理纳入本次验收范围。
