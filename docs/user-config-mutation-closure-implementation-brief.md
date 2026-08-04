# 用户配置变更闭环补全实施任务书

## 1. 任务目标

补全用户在普通对话中修改自身确定性配置的完整闭环，并系统排查是否还存在“用户提出修改，但系统只能生成草案、只能读取、只能通过隐藏 HTTP 接口修改，或写入后无法确认结果”的同类问题。

本任务由执行 Agent 完成。执行 Agent 应以当前工作树为起点，先验证已有未提交改动，再继续实现；不要重做、覆盖或回退已有改动。

完成后的标准闭环为：

```text
读取当前状态和 revision
  -> 形成精确结构化草案
  -> 服务登记确认单
  -> 用户在后续消息明确确认
  -> 服务执行确定性写入
  -> 回读并验证持久化结果
  -> 写审计和变更日志
  -> 返回本轮实际修改文件的 artifact descriptor
  -> Agent 向用户明确说明已生效并附文件卡片
```

## 2. 背景与已确认问题

生产用户 `111` 的最新策略变更对话已经定位到以下事实：

- 会话：`web_TXtt2-vhCvXhsftp`
- 方法变更候选：`088d789b-4535-4c29-ad4f-31cab9eb328f`
- 审计中只有 `confirmations.request` 和 `method_changes.propose`
- 候选状态停留在 `proposed`
- `config/strategy.yaml` 没有变化
- 当时 MCP 只暴露 `method_changes.propose`
- 已有 `/api/sandbox/method-changes/decide` 只改变候选状态，不写入正式策略

根因不是用户没有确认，而是系统缺少从候选草案到正式策略落盘的服务闭环。用户无法仅通过正常对话完成策略变更。

## 3. 当前工作树接手状态

当前工作树已存在一版未完成、未验证的实现草稿。执行 Agent 必须先阅读 `git diff`，在此基础上修正，不得假设其正确或已完成。

已有改动涉及：

- `src/mcp/service-tools-core.ts`
- `src/mcp/invest-agent-service-tools.ts`
- `src/mcp/service-tool-classification.ts`
- `src/services/mutation-resource-keys.ts`
- `src/lib/workspace-store.ts`
- `tests/service-tool-grant.test.ts`
- `docs/service-tools-mcp.md`
- `templates/workspace/AGENTS.md`

草稿已经开始引入 `method_changes.apply`，目标语义是：

1. `method_changes.propose` 只创建候选，不修改正式策略。
2. Agent 展示将写入 `config/strategy.yaml` 的精确结构化 patch，并登记第二次确认。
3. 用户在后续消息确认后调用 `method_changes.apply`。
4. 服务校验候选仍为 `proposed`、策略 revision 未过期、确认单与 payload 完全绑定。
5. 服务合并 patch、写入并回读 `config/strategy.yaml`。
6. 服务将候选标记为 `confirmed`，记录确认元数据、审计和 change log。
7. 服务返回 `config/strategy.yaml` 的 artifact descriptor。

当前已知遗漏：`src/mcp/invest-agent-service-tools.ts` 中 `confirmations.request.operation` 的 Zod enum 尚未加入 `method_changes.apply`。此外，当前草稿尚未通过类型检查、测试或构建，事务失败补偿与确认消费顺序也必须审查。

## 4. 范围

### 4.1 必须完成：方法变更采用闭环

完成并验证 `method_changes.apply`，至少覆盖：

- 候选必须存在且状态为 `proposed`。
- 只允许 Workspace 策略后端时，应在 schema、描述或错误中清晰表达。
- `strategyPatch` 必须非空，拒绝未知字段和非法类型。
- patch 只改变用户确认过的字段，未涉及字段保持原值。
- `expectedLastConfirmedAt` 存在时必须做乐观并发校验。
- 确认单绑定 `candidateId`、`strategyPatch` 和 revision；`summary`、`decisionNote` 可作为非语义元数据处理，但不能改变实际写入。
- 必须要求确认单创建之后出现一条新的、明确的用户确认消息。
- 写入后必须回读并核对 revision、confirmation id、candidate id 和实际 patch 内容。
- 同一候选不能重复采用，同一确认单不能重复消费。
- 失败时不得出现“候选已确认但策略未写入”或“策略已写入但候选仍 proposed”的静默半完成状态。
- 成功后追加 `memory/change_log.jsonl`，写成功审计，并发布 `config/strategy.yaml`。
- 失败路径写失败审计应沿用现有 `callServiceTool` 统一机制，不重复造审计通道。

需要重点审查当前草稿的操作顺序。跨 YAML、候选存储、确认单、审计和 artifact 发布无法形成单一数据库事务时，必须明确主状态与补偿策略，并用测试证明可恢复性。不能只回滚 YAML 而忽略已经写入的 change log、已消费确认单或已变更候选状态。

### 4.2 必须完成：同类配置闭环审计

建立“用户可配置资源闭环矩阵”，逐项检查正常 Portal/微信对话实际可获得的 MCP 工具，而不是只看内部类、WorkspaceStore 方法或 sandbox HTTP 路由。

矩阵至少包含以下列：

| 字段 | 含义 |
| --- | --- |
| 用户意图示例 | 用户会怎样表达修改需求 |
| 权威资源 | YAML、SQLite 或服务实体 |
| 当前读取入口 | 普通会话中真实可见的 MCP read tool |
| 当前草案入口 | 是否能形成精确、可验证草案 |
| 当前确认入口 | 是否由服务绑定 operation + payload |
| 当前写入入口 | 普通会话中真实可见的确定性 write tool |
| revision/并发 | 是否拒绝陈旧草案 |
| 回读验证 | 是否验证真实持久化结果 |
| 审计/change log | 是否可追溯 |
| artifact | 是否返回本轮修改文件 |
| 结论 | 完整、产品明确不支持、或闭环缺口 |

必须检查的资源：

- 持仓、现金比例、观察仓：`config/portfolio.yaml`
- 个股预案与预案观察条件
- 用户投资风格、仓位结构、买卖/风控规则：`config/strategy.yaml`
- 方法变更候选及其正式采用/拒绝
- 交易策略实体：`config/trading_strategies.yaml`
- 投资模型：`config/investment_models.yaml`
- 明确盯盘规则：规则服务/SQLite
- 复盘与盘中简报时间：`config/schedules.yaml`
- 盘中简报偏好：`config/watch.yaml`
- 通知偏好：`config/notification.yaml`
- 用户自定义风格包：`config/style_packs.yaml`
- 观察池：`config/observation_pool.yaml`
- onboarding 完成后的“重新配置”路径

同时搜索以下危险信号：

- 有 `WorkspaceStore.write*` 或 sandbox `set/remove/decide` 路由，但普通会话没有对应 MCP 工具。
- 有 `propose/draft/validate`，但没有 `apply/commit/update/delete/disable`。
- 写工具存在，但没有注册到 `invest-agent-service-tools`、没有加入分类、grant、确认枚举或资源锁。
- 工具只修改状态标志，不修改权威配置。
- 写入成功后不回读、不写审计、不追加 change log 或不发布实际修改文件。
- 模板 `AGENTS.md` 宣称用户可以修改，但服务层没有执行能力。
- 文档宣称“当前未开放”，但产品主流程又依赖该能力。
- Portal 可用而微信不可用，或仅隐藏 HTTP 能用，导致渠道能力不一致。

执行期间若发现 onboarding 完成后复盘时间、盘中简报窗口或通知偏好无法通过普通对话单独修改，应优先补一个固定语义的 `preferences.apply`；它可以修改这些已定义的配置域，但不得演变为任意 YAML 编辑器。

### 4.3 缺口处理规则

不要看到每个 YAML 就机械新增 CRUD。对矩阵中的每个缺口先分类：

1. **当前产品已承诺且用户合理预期可修改**：在本任务内补齐最窄的服务闭环。
2. **当前文档明确为未实现或不支持**：保留 fail-closed 行为，修正文档/提示，使 Agent 明确告知用户能力边界；不要伪造写入。
3. **工程模板、服务配置或不应由普通用户修改的内部配置**：排除出用户变更面，并记录理由。
4. **产品决策不足**：列为开放问题，不自行扩展 schema 或业务语义。

首轮审计应重点确认两个高风险疑点：

- `trading_strategies.yaml` 当前文档提到 sandbox list/set/remove，但普通会话是否有同语义 MCP 闭环。
- `investment_models.yaml` 当前设计称其为用户投资模型主对象，但普通会话是否能读取、起草、确认和正式写入。

若它们属于当前承诺，应复用现有后端和确认基础设施增加领域工具；若尚未承诺，应让当前权威文档和 Agent 行为一致，不能留下“看似能改、实际只能口头答复”的状态。

## 5. 非目标

- 不在本任务中部署生产。
- 不修改生产用户 `111` 或任何真实 Workspace 数据。
- 不用模板覆盖真实用户的 `AGENTS.md`、Skills 或 `config/**`。
- 不通过 shell、localhost HTTP 或隐藏 sandbox 路由绕过 MCP 服务契约。
- 不把所有配置统一成通用文件 CRUD 工具。
- 不新增与缺口无关的投资业务模型、策略推荐或自动交易能力。
- 不修改 Portal UI；本任务关注服务闭环和 artifact 返回协议。若发现 Portal 未展示已返回的 artifact，只记录为独立缺口。
- 不自动采用历史候选；生产历史修复必须另行获得用户授权。

## 6. 实施步骤

### WP0：冻结基线并验证接手状态

1. 记录 `git status --short` 和现有 diff。
2. 确认改动全部属于本任务，保留用户已有改动。
3. 运行 `npm run typecheck`，先修复现有草稿的编译问题。
4. 补上 `confirmations.request` schema、注册清单、分类和资源锁中的遗漏。

### WP1：完成 `method_changes.apply`

1. 明确候选、策略、确认单三者的状态转换和失败补偿。
2. 完善输入规范化、revision 校验和 confirmation payload 绑定。
3. 实现写入、回读、候选决定、change log、审计、确认消费和 artifact 发布。
4. 更新工具描述与 Workspace Agent 规则，明确 `propose` 不生效、`apply` 才正式采用。
5. 更新 `docs/service-tools-mcp.md`，记录完整行为而非只增加工具名。

### WP2：建立用户配置闭环矩阵

1. 从 `templates/workspace/AGENTS.md` 的用户配置清单出发列资源。
2. 交叉检查 MCP 注册、dispatch、确认操作集合、工具分类、grant、资源锁、后端、sandbox 路由和文档。
3. 对每项运行静态证据检查，必要时用测试会话验证实际工具可见性。
4. 将矩阵写入新的当前文档，建议路径：`docs/user-config-mutation-closure-audit.md`。
5. 每个缺口按“补齐、明确不支持、内部配置、待决策”分类。

### WP3：修复已承诺的同类缺口

1. 只处理 WP2 证明属于当前产品承诺的缺口。
2. 每个新增写能力都必须复用确认、scope、锁、审计和 artifact 基础设施。
3. 优先使用领域 operation，不暴露任意 YAML path/field 写入。
4. 新增或删除能力必须定义引用完整性、幂等性和并发语义。
5. 若缺口数量超过两个独立领域，先把矩阵和分批建议交给用户，不在单次改动中无边界扩张。

当前审计的处理边界：

- `preferences.apply` 属于当前 onboarding 后配置承诺，纳入本次实现。
- 交易策略实体普通对话写入、盯盘规则 update/delete、投资模型运行时写入分别列为后续任务；当前文档明确不支持或尚未成为运行时契约的动作保持 fail-closed。

### WP4：测试与验收

先运行聚焦测试，再运行完整验证。至少执行：

```bash
npm run typecheck
node --import tsx --test --test-concurrency=1 tests/method-change-apply.test.ts
npm test
npm run check:agent-context
npm run build
npm run test:boundary
git diff --check
```

若实际新增了其他领域工具，为每个领域增加对应集成测试，并运行相关 smoke。测试失败时只修复本任务引入的问题；既有无关失败必须保留证据并报告。

## 7. `method_changes.apply` 测试要求

新增 `tests/method-change-apply.test.ts` 或等价聚焦测试，至少覆盖：

1. 创建临时 Workspace 和初始 `config/strategy.yaml`。
2. 创建一个 `proposed` 候选。
3. 为 `method_changes.apply` 请求确认单。
4. 插入发生在确认单之后的用户明确确认消息。
5. 执行 apply 并验证 patch 合并、未涉及字段保留。
6. 验证 `last_confirmed_at`、`last_confirmed_by`、`last_confirmation_id`、`last_method_change_candidate_id`。
7. 验证候选变为 `confirmed`，decision note 已保存。
8. 验证 change log 和成功审计。
9. 验证返回 `config/strategy.yaml` artifact，且 payload checksum 与 Workspace 文件一致。
10. 验证确认单不能复用，候选不能重复采用。
11. 验证陈旧 revision 在任何持久化副作用发生前被拒绝，确认单仍可用于重新评估或按现有契约保持 pending。
12. 验证 candidate id、patch 或 revision 被篡改时确认绑定失败。
13. 验证非法/空 patch 被拒绝且不创建确认单。
14. 注入候选决定失败、回读失败或 artifact 发布失败，验证系统不会静默报告成功，并记录可恢复状态。

测试模式参考：

- `tests/portfolio-apply-changes.test.ts`
- `tests/mcp-confirmation.test.ts`
- `tests/onboarding-watch-setup-completion.test.ts`

## 8. 文档与 Agent 行为要求

`templates/workspace/AGENTS.md` 必须明确：

- `method_changes.propose` 只保存候选草案，不能回复“策略已修改”。
- 创建候选后，应向用户展示正式策略 patch，并询问是否采用。
- 正式采用必须再次通过 `confirmations.request(method_changes.apply)` 登记精确 payload。
- 用户下一轮明确确认后调用 `method_changes.apply`。
- 只有工具返回成功且回读通过后，才能回复“已生效”。
- 必须使用返回的 `config/strategy.yaml` artifact descriptor，不能伪造文件链接。

`docs/service-tools-mcp.md` 必须记录：

- 两阶段候选与正式采用的区别。
- 两次确认分别保护什么操作。
- revision、幂等、审计、回读和 artifact 契约。
- 当前后端限制和失败行为。

闭环审计文档必须是当前事实文档，不得写入 `docs/archive/`。

## 9. 验收标准

### 策略采用闭环

- 用户可以从普通对话完成“提出策略变更 -> 候选 -> 正式采用 -> 文件可见”的全过程。
- 采用前 `config/strategy.yaml` 不变；采用成功后只包含用户确认的变更。
- 服务拒绝陈旧、篡改、重复或未经后续用户确认的请求。
- 成功响应包含真实 `config/strategy.yaml` artifact。
- 测试证明没有仅改变候选状态却未改变正式策略的路径。

### 横向闭环审计

- 所有列出的用户配置资源都有证据化矩阵结论。
- 每项都能区分“真实 MCP 能力”和“仅内部代码/HTTP 能力”。
- 当前已承诺的缺口得到修复，或在缺口超过本任务合理范围时形成明确的后续工作包。
- 明确不支持的能力在工具描述、当前文档和 Agent 行为中一致，用户不会被误导为已经修改。
- 没有新增任意文件 CRUD 或绕过服务安全边界的实现。

### 工程质量

- 聚焦测试、完整测试、typecheck、build、agent-context 和 boundary test 全部通过，或只存在有证据的既有无关失败。
- `git diff --check` 通过。
- 未修改生产数据、真实 Workspace 或生产环境文件。
- 最终报告列出修改文件、测试结果、审计矩阵结论和仍需产品决策的项。

## 10. 风险与处理

- **跨存储半完成**：先定义主状态和补偿顺序，通过失败注入测试验证；不要以“通常不会失败”为前提。
- **确认单误绑定**：confirmation target 必须包含领域资源 ID 和实际语义 payload，元数据剥离规则必须最小化。
- **陈旧覆盖**：所有正式配置修改应携带可比较 revision；没有 revision 的领域在矩阵中标为风险。
- **工具已注册但 Agent 看不到**：同时检查 MCP 注册、授权分类和会话 manifest，不只检查 dispatch。
- **把内部配置误当用户配置**：依据当前产品文档和用户心智分类，不以文件位于 `config/` 为唯一标准。
- **范围膨胀**：同类缺口超过两个领域时先分包，优先保证策略闭环完整和审计结论可靠。
- **真实 Workspace 风险**：所有验证使用临时测试 Workspace；生产历史候选只做只读核验。

## 11. 交付物

执行 Agent 最终至少交付：

1. 完成并验证的 `method_changes.apply` 实现。
2. `tests/method-change-apply.test.ts` 及必要的工具注册/授权测试。
3. 更新后的 `templates/workspace/AGENTS.md` 与 `docs/service-tools-mcp.md`。
4. `docs/user-config-mutation-closure-audit.md` 配置闭环矩阵。
5. `preferences.apply` 及其集成测试，覆盖 onboarding 后复盘/盯盘/通知配置修改。
6. 对确认属于当前承诺的其他缺口所做的最小修复，或拆分后的后续任务清单。
7. 验证命令和结果摘要。

## 12. 执行 Agent 提示词

```text
请执行 docs/user-config-mutation-closure-implementation-brief.md。

先读取根 AGENTS.md、docs/README.md、docs/service-tools-mcp.md、docs/trading-strategy-design.md、docs/investment-model-design.md，以及 service-api-change skill。当前工作树已有未提交的 method_changes.apply 草稿，必须先查看 git diff 并在其基础上修正，不得回退或覆盖已有改动。

先完整补齐并验证“方法变更候选 -> 第二次确认 -> 正式策略落盘 -> 回读 -> 审计/change log -> config/strategy.yaml artifact”闭环。然后按任务书建立所有用户可配置资源的闭环矩阵，区分真实普通会话 MCP 能力、仅内部 HTTP/Store 能力、明确不支持和实际缺口。只修复当前产品已经承诺的缺口，不新增通用 YAML CRUD，不部署生产，不修改用户 111 或任何真实 Workspace。

严格执行任务书的测试与验收标准。若同类缺口涉及超过两个独立领域，完成策略闭环和审计矩阵后拆分后续工作包，不无边界扩张。最终报告实现结果、测试证据、矩阵结论、风险和开放问题。
```

## 13. 验收 Agent 提示词

```text
请独立验收 docs/user-config-mutation-closure-implementation-brief.md 的执行结果。

不要只看代码中是否出现 method_changes.apply。用测试证据验证普通会话真实可见工具、确认单 payload 绑定、后续用户确认、revision 防陈旧、策略真实落盘、回读、候选状态、审计、change log、artifact 和失败补偿。重点检查是否存在半完成状态、确认复用、任意 YAML CRUD、隐藏 HTTP 绕过或生产 Workspace 修改。

再核对 docs/user-config-mutation-closure-audit.md 是否覆盖任务书列出的全部用户配置资源，且每个结论都有代码或运行证据，并区分“明确不支持”和“闭环缺口”。按严重程度列出问题；未满足任一验收标准时不得判定完成。
```
