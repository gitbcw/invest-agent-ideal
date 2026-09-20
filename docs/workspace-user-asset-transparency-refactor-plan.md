# Workspace 用户资产透明化与确认流收敛：小重构方案

状态：执行契约 v1；可交给执行 Agent。任何超出冻结范围的变更必须先回到决策项。

日期：2026-09-16

## 1. 背景与问题定义

当前系统把三种不同性质的东西混在了一起：

1. 用户拥有的投资方法、Workspace 规则、记忆和报告；
2. Agent 的草稿、候选变更、运行上下文和工具编排状态；
3. 服务层的 scope、确认、审计、版本和并发控制。

旧 Workspace 模板和历史流程容易让用户看到工程文件或确认手续，却看不到“自己的内容到底是什么、改了什么、会影响什么”。这导致可逆的内容编辑也进入重型确认流；`method_changes` 候选、Workspace 文件、用户 artifact 还可能形成多份表征。

本次小重构的目标不是重建 Workspace，也不是一次性迁移所有业务数据，而是建立一个清晰的用户资产投影和分层确认模型，为后续 service-owned 收敛提供稳定产品语义。

## 2. 设计结论

### 2.1 两层模型

**用户资产层**：用户能理解、查看、编辑、比较和回滚的事实资产。

- 我的投资方法；
- 我的 Workspace 内容与配置；
- 我的规则与偏好；
- 我的记忆；
- 我的报告、附件和历史版本。

用户资产层以 service-owned asset/version 为产品权威；Portal 将现有“我的文件”入口改名为“工作空间”，并按用户语义展示实际存在的方法、规则、记忆和文件。用户不需要知道文件路径、数据库表或候选记录 ID。

**Agent 运行层**：服务内部的草案、工具调用、候选变更、任务运行、租约、审计和确认状态。它可以继续严格校验，但不应把内部状态机原样暴露给用户。

### 2.2 两种控制机制

- 可逆、无外部副作用的内容变化：`view → diff → discuss/edit → accept → new version → rollback`。
- 不可逆或有外部副作用的动作：`explain impact → explicit authorization → execute → audit`。

“确认”不再是所有持久化写入的统一门槛。确认对象必须是用户能理解的内容变化或外部影响，而不是内部状态转换或模型生成的口令。

### 2.3 单一事实来源

同一个用户资产必须有一个稳定的逻辑 `assetId` 和不可变版本链。方法、Workspace 配置和报告可有不同类型，但不能同时由 Workspace 文件、artifact 和 method-change candidate 各自承担“当前版本”的语义。

建议关系如下：

```text
用户资产(assetId)
  └─ 当前版本(head versionId)
       ├─ 内容/结构
       ├─ 来源与变更说明
       ├─ 影响范围
       └─ 历史版本 + diff + rollback

Agent 草案/运行记录 ──引用──> 资产版本或拟议版本
```

## 3. 面向用户的资产分类

### 3.1 方法资产

包含投资方法、指标公式、信号解释、减仓和退出条件等内容。方法资产必须支持 Markdown/结构化字段混合表达：公式正文可读，关键参数和影响范围可被服务识别。

方法的更新默认是可逆内容变更。只要用户意图明确且没有外部副作用，Agent 直接保存为新版本，并在对话中提供“查看文件”和“查看 Diff”；只有存在歧义、多个目标或外部影响时才追问或确认。

### 3.2 Workspace 内容与配置资产

Workspace 不是一个单一文件，而是用户方法、规则、记忆、计划和产物的集合。产品层应按用户语义组织这些内容；服务层仍可按域拆分存储，但必须能回到统一的资产、版本、来源和回滚模型。模板 Skill 负责工作流说明，不能把工程目录结构当作用户心智模型，也不能让自然语言覆盖已保存事实。

### 3.3 规则/偏好资产

可影响运行行为的风险阈值、观察条件、推送偏好等，仍应显示在用户资产层，但一旦启用会改变自动化或外部行为，就进入高影响确认，而不是普通文档接受。

### 3.4 记忆资产

区分“用户明确保存的事实”“Agent 推断的偏好”和“临时上下文”。只有前者默认进入长期用户资产；推断必须标记为推断并允许编辑/删除；临时上下文不自动升级为长期记忆。

## 4. Workspace 模板如何调整

### 4.1 新模板的职责

当前 `templates/workspace` 已是 legacy compatibility marker，不应恢复成 Agent 运行根。模板调整应集中在 `templates/skills`、资产 schema、Portal 语义入口和播种规则：

- Skill 只描述用户可理解的领域工作流、读取优先级和工具使用边界；
- 不把工程路径、数据库表、候选 ID或内部确认话术写给用户；
- 内部可保留候选状态，但用户界面只展示当前内容、变更历史、来源和必要影响说明；
- 方法和 Workspace 内容变更必须要求展示内容差异，而不是只输出登记结论；
- Agent 不能要求用户照抄固定确认句；自然语言意图由服务层绑定到当前可见变更摘要，并在歧义时追问具体决策点；
- Skill 不把用户消息本身当作安全授权，所有写入和外部动作仍走 service/MCP 合同。

### 4.2 Workspace 内容变更 Skill 的最小协议

Workspace 相关 Skill 应采用以下流程：

1. 读取当前用户资产和当前版本；
2. 判断请求是查询、讨论、修改、保存还是启用运行行为；
3. 对修改先生成拟议版本，并同时展示人类可读 diff；
4. 对缺失信息、口径冲突或语义不确定的部分标记为待定，不能默默补全；
5. 内容修改完成后只创建新版本；启用或自动运行另走影响确认；
6. 运行结果引用实际使用的 `versionId`，不能只写“使用最新版本”。

## 5. Portal / 对话交互设计

### 5.1 用户入口

Portal 将现有“我的文件”一级入口改名为“工作空间”。工作空间主界面按用户语义展示实际存在的内容：

- 我的方法；
- 我的规则；
- 我的记忆；
- 我的文件（报告、表格、附件和其他用户产物）。

工程路径可在高级详情中作为来源信息出现，但不能作为主导航。

### 5.2 对话内变更卡片与 Diff 侧栏

每次 Agent 已完成明确的可逆内容修改后，消息卡片至少包含：

- 当前版本和拟议版本；
- 内容 diff 或公式对照；
- 修改理由和来源；
- 受影响的自动化/任务；
- 未解决的问题；
- `查看文件`、`查看 Diff`、`打开工作空间`。

明确的可逆修改不进入 Workspace 审批队列，也不要求固定确认语句。若用户原话存在歧义，Agent 在对话中询问；否则直接完成版本提交。

### 5.3 高影响动作

启用 Workspace 中会改变运行行为的规则、改变调度、发送推送、修改交易相关规则或执行资金动作必须在卡片中明确说明影响，继续沿用服务层确认、scope、审计和幂等约束。这里的确认文案应由服务提供结构化决策项，Agent 负责解释，不由模型临时发明口令。

## 6. 现有用户 Workspace 处理

不得批量覆盖真实用户 Workspace，也不要求一次性完成全量迁移。采用“只读盘点 → 资产映射 → 用户可见导入/接受 → 双读观察 → 停止旧读路径”的分阶段方式。

### 阶段 A：只读盘点

对每个现有用户生成 manifest，不改动源文件：

- 方法文件、公式和规则；
- Workspace 内容及其来源；
- 报告、附件、automation source；
- Workspace 文件与 service asset 的重复关系；
- 无法分类、冲突或缺少版本信息的内容。

盘点结果必须能区分“已映射”“待用户判断”“仅兼容历史”“不迁移”。

### 阶段 B：建立只读资产投影

将可识别内容导入或映射为服务资产的只读视图，保留源路径、checksum、来源和导入批次。此阶段不覆盖 Workspace，不改变 Agent 读取优先级。

### 阶段 C：逐用户、逐资产接受

对方法和其他 Workspace 内容生成用户可读的导入卡片：显示源文件、解析后的结构、版本缺口、冲突和影响。用户可以接受为新资产、修改后接受、跳过或保留兼容读取。接受动作需留下审计和源版本引用。

### 阶段 D：双读校验

对明确接受的资产，运行时同时读取旧兼容源和新 service-owned 资产，比较规范化语义而非字节。冲突时 fail-closed 或标记 degraded，禁止静默选择一边覆盖另一边。

### 阶段 E：按域切换

先切方法和核心 Workspace 内容的读取，再切调度绑定和自动化输入，最后停用对应旧 Workspace 读取。每个域都需要独立快照、回滚点和自然业务验证；不能以模板发布代替用户迁移。

## 7. 服务与数据契约改造边界

本次小重构建议只冻结产品语义和最小接口，不立即重写全部存储：

1. 为 `method`、Workspace 内容域增加资产类型和版本元数据；
2. 为拟议版本增加结构化 diff、sourceRef、影响范围和状态；
3. 将 `method_changes.propose/apply` 重新定义为内部兼容 API，Portal/Agent 面向用户只暴露“创建拟议版本/接受版本”；
4. 让运行记录绑定实际输入 `versionId`；
5. 保留旧 Workspace file list/get 作为兼容读取，不再扩展其产品能力；
6. 所有写入继续由 service/MCP 强制 scope、权限、审计、并发和路径安全。

## 8. 分阶段执行计划

### WP0：冻结语义与盘点

交付：资产类型表、状态机、确认分类表、现有用户 manifest 方案、Workspace 内容映射草案。

验收：任何一次变更都能明确归类为内容版本变化或高影响动作；没有“所有写入都必须确认”的模糊规则。

### WP1：模板与 Skill 规则

交付：方法、Workspace 内容、记忆相关 Skill 的新规则；删除模型自编确认口令的提示；定义草案、拟议、生效、拒绝语义。

验收：隔离测试 Workspace 中，方法和其他 Workspace 内容修改展示 diff；缺少信息时标记待定；不要求照抄口令；启用/推送仍触发服务确认。

### WP2：用户资产投影与 Portal 最小界面

交付：资产列表/详情/版本/diff/接受/拒绝/回滚的最小 API 和 Portal 入口；保留旧 Workspace 浏览器。

验收：用户不看工程路径也能找到自己的 Workspace 内容；能看到当前版本、变更内容、来源、影响和历史版本。

### WP3：现有用户迁移试点

交付：只读 manifest、mg 隔离副本导入、双读比较、回滚演练和证据记录。

验收：不修改真实 Workspace；mg 副本能完成 Workspace 内容查看、diff、接受新版本和恢复；冲突会显式标记，不静默覆盖。

### WP4：按域切换与观察

交付：先方法和核心 Workspace 内容，再自动化绑定的切换计划；自然运行观察窗口；旧路径退役清单。

验收：实际运行记录引用版本 ID；失败时可回退到旧资产或兼容读路径；确认流只保留高影响动作。

## 9. 非目标

- 本期不恢复旧 ACP Workspace 运行模式；
- 不批量改写真实用户的 `AGENTS.md`、Skills、方法文件或 SQLite；
- 不一次性迁移所有业务域和历史资产；
- 不通过 Portal 暴露任意文件系统写入；
- 不把模型输出后处理成“看似已生效”的状态；
- 不删除 `method_changes` 或兼容 API，直到新资产路径有真实运行证据。

## 10. 风险与应对

| 风险 | 应对 |
|---|---|
| 新资产与旧 Workspace 内容冲突 | 保留 checksum、来源和双读比较；冲突时 degraded/fail-closed |
| Workspace 内容映射丢失公式或规则语义 | 结构化字段与原文并存；保留原始版本；用代表性用户资产验证 |
| 用户看见太多内部细节 | 只展示语义状态、diff、影响和来源摘要；路径与内部 ID 放高级详情 |
| 降低确认后误启用自动化 | 内容接受和启用分离；启用继续走服务层确认 |
| 模板更新影响现有用户 | 新模板只影响新项目；现有用户逐资产采用、备份和可回退 |
| 迁移后版本引用漂移 | 运行记录固定实际 `versionId`；禁止仅保存 `latest` |

## 11. 待裁决问题

以下问题会改变第一期范围，其他细节可按本方案默认值推进：

1. 第一阶段是否把“方法”和其他核心 Workspace 内容都纳入试点，还是先只做方法？建议先以方法为主、保留其他内容的映射接口，避免首期范围过大。
2. 用户资产是否允许 Portal 直接编辑正文？建议第一期保留 Agent 对话编辑 + Portal diff/接受/回滚，第二期再增加结构化直接编辑。
3. 方法资产是否需要拆成“说明文档”和“可执行规则”两个关联资产？建议先使用一个逻辑方法资产加结构化 metadata，避免再次制造双事实来源。

## 12. 执行者交接提示

请按本方案先完成 WP0 和 WP1 的隔离实现与验证，不要直接修改真实用户 Workspace、生产数据库或推送状态。实现前先核对当前 `docs/table-ownership.md`、`docs/context-and-prompt-architecture.md`、用户资产契约和现有 Portal asset/version API；任何与既有契约冲突的字段或状态先记录为决策项。完成后提供模板 diff、服务契约 diff、隔离用户交互证据和未覆盖项。

## 13. 验收者交接提示

独立检查：用户能否在不理解工程路径的情况下看到自己的 Workspace 内容、当前版本和 diff；可逆内容编辑是否不再要求固定口令；高影响动作是否仍由服务层确认；运行是否绑定实际版本；现有 Workspace 是否只读盘点、逐资产迁移、可回滚；冲突和缺失是否显式标记。不得仅以单元测试、Agent 自述或模板文件存在判定完成。

## 14. 执行契约（冻结）

### 14.1 本次必须交付

本次只交付“方法/Workspace 内容透明化最小闭环”，不实施全量 Workspace 迁移：

1. `method` 用户资产的查看、直接保存新版本、diff、历史和回滚语义；
2. 现有 `method_changes.propose/apply` 的兼容适配，使其成为内部候选机制，不再作为用户界面语义；
3. 对话输出中的变更卡片数据契约；
4. Portal 最小资产详情/版本/diff/接受/拒绝/回滚入口；
5. 仅对隔离 fixture 和明确的 `mgreplay` 副本执行 Workspace manifest 与导入演练；
6. 模板 Skill 的规则调整：展示内容差异、允许自然语言接受、禁止模型自编固定口令；
7. 方法变更运行/审计记录引用具体资产版本或明确标记为 legacy candidate。

### 14.2 明确不做

- 不修改真实 `mg`、`111`、`dyk` Workspace；
- 不批量修改 `AGENTS.md`、Skills、方法文件或生产 `.env`/SQLite；
- 不删除 `method_change_candidates`、`method_changes` 工具或旧 Workspace 浏览器；
- 不把所有 Workspace 域一次性迁入资产库；
- 不开放任意文件编辑、路径写入或用户直接提交服务层 scope；
- 不改变交易、推送、调度和资金动作的现有确认边界。

### 14.3 代码责任边界

执行 Agent 必须先检查并在实现报告中列出实际路径；以下是默认责任范围：

| 责任 | 默认路径 | 允许改动 |
|---|---|---|
| 资产版本服务 | `src/services/user-assets.ts`, `src/db/schema.ts`, `src/db/index.ts` | 增加方法资产类型/来源/版本引用所需的最小字段或 adapter；优先复用现有 user asset API |
| 方法候选兼容 | `src/lib/method-change-backend.ts`, `src/mcp/service-tools-core.ts` | 保留旧请求/响应；增加 candidate→asset version 的明确映射和幂等校验 |
| 对话/工具输出 | `src/mcp/`, `src/mastra/`, 相关 artifact descriptor | 增加变更卡片所需的 current/proposed/diff/impact 字段；不得在服务层改写 Agent 最终自然语言 |
| Portal | `apps/portal/src/` 对应 asset/Workspace 页面、connector schema | 增加方法资产入口、版本时间线、diff、接受/拒绝/回滚；保留旧 Workspace 浏览器 |
| 模板 Skill | `templates/skills/`, 当前 Mastra skill seeding 相关文件 | 只改用户可见工作流规则；不写内部表名、路径或服务密钥 |
| 迁移工具 | 新增 `scripts/workspace-method-manifest.mjs` 或等价脚本 | 只读 manifest、隔离导入、checksum、冲突报告；默认拒绝生产路径 |

若实现需要修改其他模块，必须说明原因、影响和回滚方式，不得顺手重构无关域。

### 14.4 最小数据契约

方法资产和变更卡片至少支持以下字段；字段名称可适配现有 schema，但语义不可删减：

```ts
type MethodChangeView = {
  assetId?: string;
  currentVersionId?: string;
  proposedVersionId?: string;
  candidateId?: string;             // legacy candidate 可选
  affectedResource: string;
  currentSummary: string;
  proposedSummary: string;
  diff: string;
  reason: string;
  impact: "content_only" | "runtime_behavior" | "external_effect";
  unresolvedQuestions: string[];
  status: "discussing" | "proposed" | "accepted" | "rejected" | "superseded";
  sourceRef?: { conversationId?: string; turnId?: string; workspacePath?: string };
};
```

规则：

- `content_only` 接受后只创建新版本，不自动启用任务或推送；
- `runtime_behavior`、`external_effect` 必须继续走对应服务确认；
- `proposedVersionId` 未形成前，不得向用户声称已保存或已生效；
- legacy candidate 只能表示候选，不得伪装成当前方法版本；
- 所有接受/拒绝必须绑定当前可见候选或版本，不能只按自由文本猜测历史对象。

### 14.5 执行顺序与停止条件

#### WP0：基线与隔离 fixture

执行：

1. 阅读 `docs/table-ownership.md`、`docs/context-and-prompt-architecture.md`、本契约、现有 user asset tests 和 method-change tests；
2. 建立临时 fixture Workspace、隔离 DB 和隔离 Portal 配置；
3. 记录当前 `method_changes`、`user_assets`、`user_asset_versions` 的读写路径；
4. 先运行现有相关测试，保存基线。

完成条件：没有生产路径、真实 Workspace 或真实微信状态被访问；基线测试命令和结果已记录。

#### WP1：服务语义与兼容适配

执行：

1. 复用现有 user asset/version 服务；若方法资产缺少类型字段，使用 additive migration；
2. 将候选内容与 `assetId/versionId` 关联，保留旧 candidate ID；
3. 接受操作必须原子地推进资产 head 或明确返回冲突；
4. 拒绝、过期、重复接受和跨 scope candidate 必须返回确定性错误；
5. 运行/审计记录保存实际版本引用。

完成条件：服务单测覆盖成功、重复、并发冲突、scope 越权、过期 candidate、拒绝和回滚。

#### WP2：模板与 Agent 输出

执行：

1. 修改相关 `templates/skills`，要求 Agent 展示当前内容、变更内容、理由和未决问题；
2. 删除“请回复某固定确认句”的提示性要求；
3. 保留高影响动作的服务确认；
4. 变更卡片缺少 diff 或影响字段时，服务/Portal 标记为 degraded，不得渲染成已生效。

完成条件：隔离对话 fixture 中自然语言“可以/接受这个版本”可在唯一候选下完成接受；多候选或含糊意图会继续询问；不出现固定口令要求。

#### WP3：Portal 最小闭环

执行：

1. 在现有资产/Workspace 入口增加“方法”语义入口；
2. 展示当前版本、拟议变更、diff、来源、影响、历史版本；
3. 提供历史版本查看和恢复；
4. 对话消息提供“查看文件”“查看 Diff”“打开工作空间”，Diff 以侧栏呈现；
5. 对 `runtime_behavior`/`external_effect` 显示影响确认，不把工作空间变成审批页；
5. 保持旧 Workspace 浏览器只读兼容。

完成条件：浏览器 smoke 能完成方法查看→diff→接受→历史恢复；刷新后状态一致；跨 scope 返回 403/404；不能通过 UI 提交绝对路径。

#### WP4：隔离迁移演练

执行：

1. 对 fixture 和明确复制的 `mgreplay` 做只读 manifest；
2. 生成方法映射、checksum、版本缺口和冲突报告；
3. 导入到隔离资产库，不回写源 Workspace；
4. 执行双读语义比较和回滚演练；
5. 形成迁移报告，列出可自动导入、需用户判断和不迁移项。

完成条件：源文件 checksum 不变；导入可重复且不产生重复版本；冲突不静默覆盖；失败可删除整批隔离导入并保留证据。

### 14.6 强制验证命令

执行 Agent 必须按实际 package scripts 运行，至少包括：

```bash
npm run verify
npm test -- --runInBand
npm run typecheck
npm run build
```

如果某命令不存在，必须改用 `package.json` 中对应命令并记录；不得伪造通过。另需运行新增的定向测试：

```bash
npm test -- tests/user-assets.test.ts tests/method-change-apply.test.ts
npm test -- tests/<new-workspace-transparency-tests>.test.ts
```

Portal 必须增加至少一个真实浏览器 smoke；仅 jsdom、curl 或 connector 单测不能替代。

### 14.7 回滚与发布门

- WP0-WP2 只允许代码、模板和隔离 DB/Workspace 变更；可直接回退代码；
- WP3 发布前必须确认 Portal 与服务协议兼容；旧入口仍可用；
- WP4 不得连接真实生产 Workspace；
- 任何真实用户采用必须逐用户、逐文件/资产、先备份、可回滚，并由用户明确接受；
- 未通过浏览器 smoke、scope 隔离、版本幂等或源 checksum 校验，不得进入真实用户试点；
- 发现新旧事实无法判定时，停止切换并标记 `degraded/conflict`，不得自动选择覆盖。

### 14.8 执行 Agent 汇报格式

执行完成后必须报告：

1. 实际修改文件与每个文件的责任；
2. 数据迁移/兼容变化及回滚方式；
3. 测试命令、结果和未运行原因；
4. 浏览器 smoke 的用户可见证据；
5. 隔离 Workspace/DB/资产是否清理；
6. 未完成项、风险和是否触碰真实用户数据；
7. 不得用“已支持”替代具体操作证据。
