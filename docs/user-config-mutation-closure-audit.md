# 用户配置变更闭环审计

状态：2026-08-04，随 `user-config-mutation-closure-implementation-brief.md` 执行更新。

本审计只判断普通 Workspace ACP/Portal 对话能否通过当前正式能力完成“读取/形成草案/确认/写入/回读/审计/文件交付”。内部 `WorkspaceStore` 方法、兼容 sandbox HTTP 路由和 Platform 管理接口单独列出，不能把它们当成普通对话能力。

## 结论摘要

- `config/strategy.yaml` 的方法候选采用闭环已补齐：`method_changes.propose` 只产生候选，`method_changes.apply` 在第二次确认后正式写入并返回策略文件 artifact。
- `config/schedules.yaml` 和 `config/notification.yaml` 的 onboarding 后修改闭环已补齐：使用语义化 `preferences.apply`，支持复盘时间、盘中简报窗口和通知模式，并返回实际修改的配置文件。
- 持仓、观察仓新增、预案和规则创建已有正式 MCP 闭环；删除观察仓/预案、修改/删除已存在盯盘规则仍按当前产品契约明确不支持，不能通过隐藏 HTTP 路由绕过。
- `config/trading_strategies.yaml` 目前有 WorkspaceStore 和 sandbox HTTP CRUD，但没有普通对话 MCP 工具。交易策略是当前产品文档中的用户私有资产，却无法从普通对话走正式写入闭环，列为独立 P1 后续任务。
- `config/investment_models.yaml` 只有设计文档和 WorkspaceStore，没有当前服务消费、MCP 或普通对话契约证据；列为设计阶段，不在本次默认为已支持。

## 判定标准

| 结论 | 含义 |
| --- | --- |
| 完整 | 普通会话有正式读取/确认/写入能力，写入后有验证、审计和 artifact 或明确不需要文件交付 |
| 明确不支持 | 当前文档明确关闭该动作，服务不会伪造成功，Agent 应如实告知用户 |
| P1 后续 | 当前文档或用户心智已承诺，但普通会话缺少正式工具/闭环 |
| 设计阶段 | 只有设计或底层存储证据，尚未成为当前产品能力 |
| 用户资产直维护 | 不属于服务消费的用户文件，按精确草案和确认直接维护，并按实际修改结果发布文件 |

## 闭环矩阵

| 用户意图 | 权威资源 | 普通会话读取/草案 | 普通会话确认/写入 | 回读、审计、artifact | 结论 |
| --- | --- | --- | --- | --- | --- |
| 修改持仓、现金比例、观察仓迁移 | `config/portfolio.yaml` | `portfolio.read`；服务校验完整组合草案和 revision | `confirmations.request` -> `portfolio.apply_changes` | 回读、change log、audit、自动发布 `config/portfolio.yaml` | 完整 |
| 新增观察仓 | `config/portfolio.yaml` | `watchlist.read` | `confirmations.request` -> `watchlist.add` | scope backend、audit、Workspace 下发布 `config/portfolio.yaml` | 完整 |
| 删除观察仓 | `config/portfolio.yaml` | `watchlist.read` | 只有 sandbox HTTP 兼容路由，没有 MCP 删除工具 | HTTP 路由有 audit，但普通 ACP 不可调用 | 明确不支持；按服务工具文档保持 fail-closed |
| 新增/修改个股预案 | `config/portfolio.yaml` 的 `stock_plans` | `plans.read` | `confirmations.request` -> `plans.set` | backend 写入、audit、Workspace 下发布 `config/portfolio.yaml` | 完整 |
| 修改预案观察条件 | `config/portfolio.yaml` 的 `stock_plans` | `plans.read` | `confirmations.request` -> `plans.watch_conditions` | backend 写入、audit、Workspace 下发布 `config/portfolio.yaml` | 完整 |
| 删除个股预案 | `config/portfolio.yaml` 的 `stock_plans` | `plans.read` | 只有 sandbox HTTP 兼容路由，没有 MCP 删除工具 | 普通 ACP 无法完成 | 明确不支持；不通过 HTTP 绕过 |
| 提出方法/策略变更 | `memory/method_changes.jsonl` | 同轮形成候选草案；候选后端有 scope 读写 | `confirmations.request` -> `method_changes.propose` | 候选确认单消费、audit；返回当前 strategy revision | 完整 |
| 正式采用方法变更 | `config/strategy.yaml` | `method_changes.apply` 的 confirmation preview 读取候选和策略 revision | 第二次 `confirmations.request` -> `method_changes.apply` | 回读字段和元数据、候选 confirmed、change log、audit、发布 `config/strategy.yaml` | 完整 |
| 修改复盘时间 | `config/schedules.yaml` | `preferences.apply` 预校验当前 revision 和语义 patch | `confirmations.request` -> `preferences.apply` | 回读、change log、audit、发布 `config/schedules.yaml` | 完整 |
| 修改盘中简报窗口/频率 | `config/schedules.yaml` / `config/watch.yaml` 的协议边界 | `preferences.apply` 校验 `HH:MM` 窗口和频率；机器规则不写入 watch.yaml | `confirmations.request` -> `preferences.apply` | 回读、change log、audit、发布 `config/schedules.yaml` | 完整；明确规则另走 watch-rule |
| 修改通知模式 | `config/notification.yaml` + schedules policy | `preferences.apply` 支持三种产品模式 | `confirmations.request` -> `preferences.apply` | 回读通知和市场简报策略、change log、audit、发布两个实际修改文件 | 完整 |
| 修改默认/自定义投资风格包 | `config/style_packs.yaml` | 当前没有独立 `style_packs.read` 或结构化草案 MCP 工具；策略只读取已选风格标识 | 当前没有普通会话写入 MCP 工具 | 无当前服务层写入、回读、审计和 artifact 闭环证据 | 设计/产品边界待确认；当前不宣称支持 |
| 修改可跟踪观察池 | `config/observation_pool.yaml` | 当前没有 `observation_pool.read` 或草案 MCP 工具 | 当前没有普通会话写入 MCP 工具；`watchlist` 是不同资源 | 无当前服务消费或 artifact 闭环证据 | 设计/产品边界待确认；当前不宣称支持 |
| 新增价格盯盘规则 | SQLite `alert_rules` | `watch_rules.catalog/list/validate` | `confirmations.request` -> `watch_rules.create` | 创建成功、audit；规则通过 list/dry-run 回读 | 完整 |
| 修改/删除已存在盯盘规则 | SQLite `alert_rules` | `watch_rules.list` 可读 | 当前 MCP 没有 update/delete | Platform/HTTP 管理接口存在，但普通 ACP 不可调用 | 明确不支持；单独产品任务 |
| 新增/修改交易策略实体 | `config/trading_strategies.yaml` | Agent 可读 Workspace 文件；HTTP 有 `/api/sandbox/strategies` | 当前只有 HTTP `strategies.set/remove`，没有 ACP MCP 写工具 | HTTP 有 audit，但不属于普通会话能力；没有自动 artifact 契约 | P1 后续：需产品确认后增加命名 MCP |
| 删除交易策略实体 | `config/trading_strategies.yaml` | WorkspaceStore 可读 | HTTP 有 `strategies.remove`；普通 ACP 无 MCP | 删除不级联预案引用，现有文档要求暴露孤儿引用 | P1 后续：需定义引用阻断/确认和 artifact |
| 修改投资模型 | `config/investment_models.yaml` | 只有 WorkspaceStore 读取方法和设计文档 | 无 MCP、无当前 HTTP 领域路由、无服务消费证据 | 无普通会话闭环 | 设计阶段；不宣称已支持 |
| 修改方法说明、Skill、知识、普通报告、研究脚本 | Workspace 用户文件 | Agent 直接读取并形成文件级草案 | 后续用户确认后直接维护用户资产；不需要为每个文件新增 MCP | 修改后对每个实际变更文件调用 `artifacts.publish`，成功才提供链接 | 用户资产直维护 |
| onboarding 完成后的重新配置 | 多个 `config/*.yaml` | `onboarding.draft.*` 可创建新草稿；草稿确认后统一提交 | draft step confirmations -> frozen commit | worker 写入并验证，完成通知和配置 artifacts | 完整但粒度较粗；普通单项修改优先用 `preferences.apply`/领域工具 |

## 代码证据

### 正式 MCP 工具与服务入口

- 注册入口：`src/mcp/invest-agent-service-tools.ts`
- dispatch、确认绑定、失败审计和 artifact：`src/mcp/service-tools-core.ts`
- 工具风险分类：`src/mcp/service-tool-classification.ts`
- 跨进程资源锁：`src/services/mutation-resource-keys.ts`、`src/services/resource-mutation-lock.ts`
- 确认消费和最近用户消息校验：`src/lib/sandbox-confirmation.ts`、`src/mcp/service-tools-core.ts`

本次新增的确定性入口：

- `method_changes.apply`：候选采用到 `config/strategy.yaml`。
- `preferences.apply`：复盘时间、盘中简报窗口/频率、通知模式。

### 兼容 HTTP 与普通 ACP 的边界

- `src/routes/sandbox.ts` 仍保留 `watchlist/remove`、`plans/remove`、`/api/sandbox/strategies/*` 等兼容或管理入口。
- `docs/service-tools-mcp.md` 明确普通 Workspace Agent 不得调用隐藏 HTTP、token、端口或本地文件作为 MCP 缺口的 fallback。
- 因此“HTTP 有接口”不等于“用户在普通 Portal 对话中已经可以完成修改”。

### 当前文档契约

- `templates/workspace/AGENTS.md` 要求持仓、方法变更、偏好和规则修改先有精确草案和二次确认。
- `docs/trading-strategy-design.md` 明确交易策略实体的 WorkspaceStore 和 sandbox CRUD，但没有把它列为当前 ACP MCP 工具。
- `docs/investment-model-design.md` 把投资模型标为第一版设计，并列出渐进路线，当前没有运行时领域契约。
- `docs/system-overview.md` 将服务工具保留给服务消费的确定性状态，并允许用户自有方法、Skill、知识和普通报告按文件草案维护。

## 已处理问题

### 策略候选只停留在 proposed

已通过 `method_changes.apply` 修复。服务现在区分“提出候选”和“正式采用”，并在正式采用时：

- 校验 candidate scope、状态和 expected strategy revision；
- 绑定第二次确认的候选、patch 和 revision；
- 合并 patch，保留未涉及字段；
- 回读策略元数据；
- 更新候选状态、change log 和 audit；
- 消费 confirmation；
- 发布 `config/strategy.yaml`。

### onboarding 完成后无法单独改复盘/盯盘/通知配置

已通过 `preferences.apply` 修复。服务只接受语义化字段，不接受任意 YAML path 或字段名；同一确认单同时修改多个偏好时，通知策略不会覆盖用户刚提交的盘中窗口。

## 后续任务

### P1：交易策略实体普通会话闭环

新增前需要确认产品是否希望用户在 Portal/微信自然对话中维护 `trading_strategies.yaml`。若确认，执行 Agent 应：

1. 增加命名的 `trading_strategies.read`、`trading_strategies.apply`（或明确拆分 create/update/remove）MCP 工具。
2. 用 key 绑定确认 payload，定义删除时的 `stock_plans.strategy_key` 孤儿引用处理。
3. 增加 revision、scope、资源锁、回读、audit、change log 和每个实际变更文件 artifact。
4. 补充普通 ACP 集成测试和 MCP smoke。

### P1：盯盘规则 update/delete

若产品决定开放，不能把现有 Platform/HTTP update/delete 直接暴露给 Agent；应定义 MCP schema、确认 payload、规则 revision、回读/dry-run 和删除影响，再单独实现。

### P2：投资模型运行时闭环

先明确 `investment_models.yaml` 是否正式进入当前用户产品。如果进入，再定义主对象、默认模型切换、策略引用完整性、确认和 artifact；在此之前保持设计阶段状态。

## 验收建议

本矩阵的“完整”结论必须由以下证据支持：

```bash
npm run typecheck
node --import tsx --test --test-concurrency=1 tests/method-change-apply.test.ts tests/preferences-apply.test.ts
npm test
npm run build
npm run test:boundary
git diff --check
```

如果后续任务开放交易策略或规则删除，必须把对应行从“P1 后续/明确不支持”改为有真实代码和测试证据的“完整”，不能只更新工具清单或文档。
