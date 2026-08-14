# Mastra 下一阶段：可观测性、无 Workspace 运行时与 Portal 同仓计划

## 1. 背景与当前判断

`feat/mastra-migration` 已在隔离端口 `23655` 运行，执行内核为 Mastra，默认模型为 `gpt-5.6-terra`。类型检查、构建、397 项自动化测试和真实 Mastra 回合已通过。

本阶段将人工验收记为：**外观与基础链路初步通过，尚未做系统化人工回归；不视为正式发布验收。** 后续优先通过完整追踪、契约测试、隔离运行和自动化对照减少人工操作，只把难以自动判定的用户体验问题留给人工抽查。

用户确认的长期产品形态是：

- Mastra 版本不保留 ACP、Codex ACP、Hermes 或 Workspace Agent runtime。
- 产品运行结构收敛为一个项目中的 `runtime + portal`。
- Portal 用户功能与当前正式 Portal 保持业务等价，同时允许采用 Mastra runtime 的原生能力。
- 真实业务数据将来单独迁移；当前阶段不进入正式发布、生产数据迁移或端口切换。

## 2. 关键术语与边界

“不保留 Workspace”必须拆成两个不同目标：

1. **移除 Workspace 作为 Agent 运行环境**：不再依赖用户目录中的 `AGENTS.md`、`.codex/`、Skills、模型配置、工作目录提示或 Codex session 状态。这是本阶段目标。
2. **迁移 Workspace 中的业务数据**：portfolio、watchlist、plans、methods、reviews、用户文件等当前仍有大量读写落在 Workspace。它们必须迁移到明确的服务存储或资产存储后才能删除旧目录。这是独立数据重构，不得通过删目录完成。

当前扫描显示源码中约有 196 处 `WORKSPACE_BACKEND`、`ensureWorkspace`、`WorkspaceStore` 或 `resolveWorkspacePath` 引用，因此“无 Workspace”是数据 ownership 重构，而不是简单清理命名。

## 3. 本阶段目标

1. 完善覆盖 Portal、微信、scheduler/automation、模型和工具调用的 Mastra-native 追踪。
2. 建立 `main` 与迁移分支的业务功能/接口/行为差异矩阵，并形成持续同步检查。
3. 在完全隔离的本地状态中验证微信适配、scheduler、automation 和 push 生成链路；默认不向真实用户发送消息。
4. 验证模型可在新回合切换、失败可审计、切换不依赖 Workspace 或 Claude/Codex CLI。
5. 盘点 Workspace 数据 ownership，设计 SQLite/资产存储迁移顺序，先解除 Agent runtime 依赖。
6. 评估并设计将正式 Portal 源码纳入迁移项目的目录、构建、测试和部署结构。

## 4. 非目标

- 不做正式发布、生产端口替换、生产数据迁移、灰度或回滚演练。
- 不改动 `main`、22655、生产 `.env`、真实 Workspace 或微信生产状态。
- 不直接复制 Portal 仓库后宣称完成；必须先冻结接口与行为基线。
- 不因为目标是无 Workspace 就删除仍承载业务数据的目录或兼容读取。
- 不要求用户完成全面人工回归；人工只用于最终体验抽查和无法自动断言的展示问题。

## 5. 工作流 A：追踪先行

### A1. 追踪契约

为每个外部请求建立稳定关联链：

`channel request -> conversation turn -> agent trace -> model attempt -> tool call -> artifact/write -> automation/scheduler run -> delivery`

追踪至少记录：

- `traceId`、`requestId`、`conversationId`、`runId` 和 `taskId` 的可关联关系。
- channel、mode、runtime=`mastra`、模型 provider/model、开始/结束时间和耗时。
- success、timeout、cancelled、busy、provider error、tool error 的中性错误分类。
- token usage、usage source、工具名、调用次数、耗时、结果大小和成功状态。
- Portal/微信入口、自动化运行、scheduler publication 和 push delivery 的终态。
- 模型切换前后的配置版本或 model selection source，但不记录 API key、Authorization、原始密钥文件内容。

### A2. 存储与展示

- `agent_traces` 保持 Agent 回合的权威执行记录。
- automation、push、conversation 和 artifact 表保留各自业务 ownership，通过明确 ID 关联，不以时间邻近作为长期主关联方式。
- Platform 审计页将历史“进入 Codex”等显示改为 Mastra/runtime 中性文案。
- 新增追踪覆盖率检查：对已完成请求统计缺 trace、缺模型、缺工具终态、缺 delivery 关联的数量。

### A3. 验收

- Portal、微信 fixture、scheduler 和 automation 各执行成功、失败、取消样例后，可从一个 traceId 找到完整链路。
- 日志和数据库抽查不含 gateway key、MCP token 或 Authorization。
- 追踪写入失败不阻断用户请求，但产生独立告警和覆盖率缺口。

## 6. 工作流 B：main 功能差异与 Portal 一致性

### B1. main 同步矩阵

以 `main` 为业务上游，按提交维护四类状态：

- `direct-port`：纯业务/API 变更，可逐提交移植。
- `mastra-rewrite`：行为必须保留，但 ACP 实现需在 Mastra/runtime 重写。
- `not-applicable`：仅服务旧 ACP/Codex/Hermes 的实现。
- `pending-decision`：涉及产品或数据 ownership，需要明确决策。

当前 `4b20aef..main` 的业务变化均已处理：`d2b493f`、`74184c9` 已移植，`8702952` 已 Mastra-native 重写，`21d43a9` 仅为本地草稿 ignore。

### B2. Portal 契约矩阵

正式 Portal 的事实源仍是 `/Users/combo/MyFile/projects/invest-agent-portal`。在移动代码前，自动提取并对照：

- 协议版本、envelope、capabilities 和错误码。
- 登录/session、conversation list/detail/chat/cancel。
- 附件上传、文件库、预览、下载和保留期状态。
- automation create/list/run/detail/continue 与运行审计。
- 长任务、并发限制、断线重连、幂等和跨 scope 拒绝。
- Markdown、SVG、XLSX 等展示契约。

判断标准不是目录或组件逐文件相同，而是公开协议、状态转换、安全边界和用户可见结果等价。

### B3. Portal 同仓设计

推荐目标目录：

```text
apps/runtime/        Mastra runtime、HTTP/API、scheduler、微信适配
apps/portal/         Next.js Portal 与 relay
packages/protocol/   Portal envelope、schema、错误码、capability
packages/contracts/  共享业务 DTO；不放数据库实现
```

在当前项目完成模块边界和构建方案验证后，再分阶段导入 Portal 历史。保留原 Portal Git 提交来源记录；迁移验收前，原 Portal 仓库仍是正式发布源。不得从 `test-projects/` 导入。

### B4. 验收

- 契约测试可对同一组 fixtures 分别运行正式 Portal connector 和迁移 runtime。
- 所有不一致都有 `expected`、`bug` 或 `pending` 分类。
- 同仓方案能独立启动 runtime 和 portal，也能通过一个根命令启动两者；二者仍可分别构建和测试。

## 7. 工作流 C：微信、scheduler 与 automation 隔离验证

### C1. 微信

- 使用独立测试用户、独立数据库和微信状态目录。
- 默认用 fixture/fake sender 验证 inbound、文本回复、图片附件、长任务和幂等。
- 真实微信只做一次明确目标测试；不复用生产 listener 状态，不向非测试用户发送。
- 每次消息必须进入 `agent_traces` 并关联 conversation message。

### C2. Scheduler/automation

- 在隔离状态根开启 scheduler，但使用可控时钟或直接触发 due task，避免等待真实时间。
- 覆盖 daily/weekly/monthly review、market watch `NO_PUSH`、rule alert、通用 automation、XLSX 产物和失败重试。
- push 默认落 fake delivery/测试队列；验证生成与交付终态，不发送给生产用户。
- 自动化文件只能访问任务 staging 与资产存储，不获得整个用户 Workspace。

### C3. 验收

- 代表性任务产生正确 artifact/publication、run 状态、trace 和 delivery 状态。
- 失败、超时、取消、重试不会重复写文件或重复推送。
- 运行后隔离数据可全部清理，生产 DB、Workspace 和微信状态无变化。

## 8. 工作流 D：模型切换验证

### D1. 目标行为

- 模型选择由 runtime 服务配置或受控 Platform API 管理，不读取 Workspace 模型配置。
- 已开始的回合固定其模型；配置变更只影响随后开始的新回合。
- 切换无需重启时优先热更新；若 Mastra/provider 客户端缓存导致必须重建 Agent，只重建后续回合使用的 Agent factory。
- 不调用 `claude -p`、Codex CLI 或 Hermes；只使用 OpenAI-compatible gateway 与 Mastra provider。

### D2. 安全设计

- API key 仍只来自进程环境或受控 secret provider。
- Platform 可见 provider、模型名、配置版本和健康状态，不返回 key。
- 模型 allowlist、并发限制和错误回退由服务端控制；用户消息不能注入模型名。
- 第一阶段不做静默模型 fallback，失败应记录实际尝试模型并返回明确中性错误。

### D3. 自动化验证

依次执行 `gpt-5.6-terra -> 第二个网关可用模型 -> gpt-5.6-terra` 三个新回合，断言：

- 三个回合都通过 Mastra 执行。
- trace 的 `agentModel` 与请求时配置一致。
- conversation、工具 scope 和业务数据连续，不依赖 Workspace session。
- 一个回合执行期间切换配置，不改变该回合模型，只影响下一回合。

若网关当前只允许一个模型，则使用本地 OpenAI-compatible fixture 验证切换语义，并把真实双模型验证记为外部条件未满足，而不是伪造成功。

## 9. 工作流 E：Workspace 去运行时化和数据 ownership

### E1. 先移除运行环境依赖

- prompt 不再读取 Workspace `AGENTS.md`、Skills 或 `.codex` 配置。
- Agent cwd 改为受控临时执行目录或任务 staging；普通对话不获得用户根目录。
- 模型、MCP、权限和方法配置由服务层/数据库提供。

### E2. 再迁业务数据

建立逐域清单并明确目标 ownership：

- portfolio/watchlist/plans/preferences/methodology：SQLite service tables。
- conversation/trace/confirmation/scheduler/automation：现有 service tables。
- 用户上传和 Agent 产物：受控 asset store + metadata tables。
- review/report：资产存储或专用表，不再依靠相对 Workspace 路径作为权威索引。

每个域必须具备：读取双轨期、一次性导入、校验、幂等、备份、回滚和删除旧读取前的覆盖率证据。此数据迁移属于后续独立执行阶段，本计划只完成 inventory、目标 schema 和顺序设计。

## 10. 推荐执行顺序

1. A：追踪契约、关联 ID、审计 UI 中性化和覆盖率测试。
2. B1/B2：自动生成 main 同步矩阵和 Portal 契约矩阵。
3. C：微信、scheduler、automation 隔离自动化验收。
4. D：模型切换的配置 ownership、并发语义和 fixture/live 验证。
5. E：Workspace 引用按运行环境、业务数据、文件产物、历史兼容分类。
6. B3：在上述边界稳定后确定 Portal 同仓目录与导入批次。

工作流之间的门槛：A 完成后才以 trace 作为 C/D 验收证据；E 的 ownership 未确认前不得删除 Workspace；B2 未完成前不得移动 Portal。

## 11. 本阶段交付物

- Mastra-native observability contract 与追踪覆盖率报告。
- `main -> migration` 按提交同步矩阵。
- runtime connector 与正式 Portal 的协议/行为差异矩阵。
- 微信、scheduler、automation 隔离验收报告。
- 模型切换验收报告。
- Workspace ownership inventory 与去运行时化设计。
- Portal 同仓架构决策记录和分阶段导入计划。

## 12. 阶段完成标准

- 自动化证据覆盖 Portal 核心 API、微信适配、scheduler/automation 和模型切换，不要求用户完成全面人工回归。
- `agent_traces` 能关联主要业务终态且审计文案、字段中不再把当前执行称为 Codex/ACP。
- Portal 一致性差异已分类，未分类项为零。
- 已证明 Agent 执行不需要 Workspace 中的模型、Skills 或 session；剩余 Workspace 依赖均被标注为业务数据或资产迁移项。
- 23655 持续独立运行，22655、`main` 和生产状态未受影响。

## 13. 暂停门

### 13.1 备份快照测试边界

迁移分支的真实数据兼容性测试只能使用生产灾备快照的复制副本。快照源必须保持只读，不得直接作为 `DB_PATH`、`WORKSPACE_ROOT`、`RUNTIME_DATA_ROOT` 或 `REVIEWS_ROOT`；测试前后必须校验源快照清单未变化。统一使用 `scripts/mastra-backup-snapshot-test.mjs`，详见 `docs/mastra-backup-snapshot-test-policy.md`。

完成上述工作后停止，不进入部署包准备、正式发布门槛、真实数据迁移、生产部署、端口替换或客户灰度；迁移分支重构和备份快照验证仍可继续，等待用户另行确认发布阶段。

## Executor Prompt

在 `/Users/combo/MyFile/projects/invest-agent-ideal-mastra` 的 `feat/mastra-migration` 上按本计划执行 A、B、C、D、E。先完善追踪，再用追踪作为隔离验收证据。不得修改 `main`、22655、生产数据、真实 Workspace 或生产微信状态；不得恢复 ACP/Codex/Hermes 或调用 Claude CLI。遇到 Workspace 引用时先分类 ownership，不得直接删除。Portal 正式事实源只能读取 `/Users/combo/MyFile/projects/invest-agent-portal`，先完成契约矩阵和同仓 ADR，再迁移源码。完成后停在第 13 节暂停门。

## Reviewer Prompt

独立对照本计划检查追踪完整性、Portal 契约差异、微信/调度隔离证据、模型切换语义、Workspace ownership 分类和生产隔离。不得以测试总数或执行方自评替代逐项证据；不得批准正式发布、数据迁移或端口切换。
