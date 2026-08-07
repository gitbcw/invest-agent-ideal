# 用户产物库与通用自动化任务文档

> 上游设计：[用户产物库与通用自动化设计](./user-asset-library-and-general-automation-design.md)
>
> 交付目标：实现可管理、可版本化的用户产物库，并将自动化从“定时维护 CSV/XLSX”扩展为“定时执行已有能力，可选读写产物、可选推送”的通用模型。

## 执行约束

- 此任务不授权修改生产数据库、真实 Workspace、真实 `reviews/`、`.state/`、微信状态或生产环境。所有开发和验收使用隔离数据。
- `main` 是最终发布基线；任何数据库演进使用 additive migration，禁止破坏性重建或批量重写。
- Portal 不得直接读写本地 Workspace；所有资产操作必须经 connector 的注册 scope。
- 不以 Skill、提示词或用户输入作为 scope、版本提交、投递或服务写入的安全边界。
- 旧自动化任务、对话 artifact、Workspace 浏览器和复盘契约必须保持兼容，除非本任务明确给出替代与迁移步骤。

## 产物链与依赖

```text
WP0 契约冻结
  ├─ WP1 资产 schema 与安全存储
  │    ├─ WP2 资产服务与 MCP 提交
  │    │    ├─ WP3 connector / Portal API
  │    │    │    └─ WP4 Portal 产物库
  │    │    └─ WP5 通用自动化任务模型
  │    │         └─ WP6 调度、投递、运行与资产版本提交
  └─ WP7 旧表格任务兼容与逐任务迁移
WP4 + WP6 + WP7 → WP8 端到端验收与发布准备
```

每个工作包完成后必须写入对应的移交笔记；下游 Agent 只依赖移交笔记与明确产物，不重新解释原始对话。

## 工作流状态机

| 状态 | 进入条件 | 必需产物 | 退出条件 | 禁止事项 |
| --- | --- | --- | --- | --- |
| S0 契约冻结 | 接收本任务文档 | 格式矩阵、协议草案、兼容矩阵 | 架构 reviewer 确认 scope | 先写 schema/UI |
| S1 资产基础层 | WP0 通过 | migration、存储服务、安全测试 | 资产版本可安全读写 | 迁移真实用户资产 |
| S2 调用面 | S1 通过 | MCP/connector/HTTP contracts | Portal 可按 scope 调用 | 浏览器直连 Workspace |
| S3 产品面 | S2 通过 | 资产库 UI、通用任务 UI | 人工可完成核心流程 | 用 Workspace 浏览器代替资产库 |
| S4 运行面 | S1/S2 通过 | scheduler/runner/投递实现 | run 与版本原子闭环 | 失败仍提交资产版本 |
| S5 兼容迁移 | S3/S4 通过 | 旧任务适配、逐任务迁移与回退 | 老任务不回归 | 批量迁移真实数据 |
| S6 验收 | 所有前置包通过 | 自动证据、浏览器验收、发布清单 | reviewer 通过 | 以单元测试替代交互验收 |

## 工作包

### WP0：冻结资产与自动化契约

任务名称：资产格式、版本和协议契约

目的：把上游设计中会影响 DB、MCP、connector、Portal 的公共语义一次冻结，避免多仓库各自猜测。

输入：上游设计、`docs/user-portal-protocol.md`、`docs/user-portal.md`、当前 `conversation-artifacts` 与 `automation-tasks` 实现。

输出：

- `docs/user-asset-library-contract.md`，包含 asset/version/task/run descriptor、状态机、错误码、格式/MIME/大小矩阵。
- Runtime 与 Portal 共享的 protocol type 变更清单。
- 旧对象兼容矩阵：`conversation_artifacts`、`automation_task_assets`、Workspace 文件协议、旧 Portal artifact 路由。

边界：不建表、不改 connector、不改 UI。

步骤：

1. 列出现有 artifact 与自动化协议字段及其调用者。
2. 固化 `user_asset`、`user_asset_version`、绑定、输出/投递策略和错误码。
3. 为每种首期格式定义 upload、preview、download、create、update 的允许性与字节上限。
4. 定义 version 提交、恢复、归档、idempotency、lease 失效和跨 scope 的行为。
5. 请架构 reviewer 对契约和兼容矩阵作一次书面判定。

验收标准：每个新字段有 owner、scope、来源和兼容策略；CSV/XLSX/Markdown 的更新语义明确；仅推送任务无资产绑定时 schema 合法；不存在裸 Workspace 路径作为浏览器请求参数。

失败处理：若某格式无法安全预览或结构校验，降为“仅下载”或排出首期，不以宽松 MIME 接受替代。

移交笔记：记录冻结协议版本、已排除格式、待确认的 UI 文案和任何现有命令冲突。

### WP1：实现资产 schema 与受控版本存储

任务名称：资产领域持久化与安全文件提交

目的：建立用户资产和不可变版本的服务权威，替代“直接把用户文件当 Workspace 文件”的做法。

输入：WP0 契约；`src/db/schema.ts`、`src/db/index.ts`、`src/services/conversation-artifacts.ts`、`src/lib/workspace.ts`。

输出：additive migration、`user_assets` / `user_asset_versions`（及必要绑定表）、`src/services/user-assets.ts`、隔离测试。

边界：不迁移真实资产；不修改 Portal UI；不删除或重定义 `conversation_artifacts`。

步骤：

1. 以三元 scope 为所有表和查询的必要条件，并添加索引和外键/逻辑完整性检查。
2. 实现安全命名、MIME/大小/内容校验、Workspace 内 staging、原子版本提交、checksum 回读和 head 更新。
3. 实现读取当前版本、列出版本、恢复为新版本、重命名、归档的服务接口。
4. 对 CSV/XLSX 复用结构校验；Markdown 完整替换必须使用 UTF-8 与大小限制；其他格式依 WP0 矩阵处理。
5. 为路径逃逸、符号链接、scope 混淆、checksum/MIME 不一致、并发提交和失败回滚添加测试。

验收标准：同一 `assetId` 在任何时刻只有一个可验证 current version；失败提交不留下 head 或孤立可见版本；跨用户/项目/实例访问均失败；恢复历史版本生成新 version ID。

失败处理：任何无法保证 DB 和文件一致性的提交必须保留失败审计、清理 staging，并返回可分类错误，不得悄悄回退到任意 Workspace 路径。

移交笔记：列出 migration key、表/索引、存储路径布局、暴露的服务函数和安全测试覆盖。

### WP2：实现 Agent 资产读写与对话交付桥接

任务名称：资产 MCP 与 conversation artifact 关联

目的：让普通对话和后台任务通过服务受控地读取/提交资产版本，并让对话交付物可保存为长期资产。

输入：WP0/WP1 产物；`src/mcp/service-tools-core.ts`、`src/mcp/invest-agent-service-tools.ts`、`src/services/conversation-turns.ts`、`src/services/conversation-artifacts.ts`。

输出：资产读取/提交/保存 MCP 合同、conversation artifact 到 user asset/version 的关联、审计和测试。

边界：不允许 ACP 传绝对路径；不改变既有 `artifacts.publish` 的 reports/config 兼容行为；普通对话的长期保存不绕过明确用户确认。

步骤：

1. 以 WP0 名称实现最小 MCP：读取已授权资产版本、将受控 staging 输出提交为新版本、把当前 turn 生成物保存到资产库。
2. 将提交动作绑定当前 conversation turn 或 automation run，写入 audit/provenance。
3. 让现有对话 artifact descriptor 可选携带 `assetId` 和 `versionId`，保留旧客户端兼容。
4. 写入确认规则：普通对话保存需用户意图/Portal 确认；启用任务仅能按声明输出策略提交。

验收标准：Agent 无法读取未绑定或跨 scope 资产；保存动作可从资产和对话双向追溯；MCP 失败不在消息中声称文件已保存。

失败处理：无法绑定当前 turn/run 时拒绝提交；禁止降级成向 Workspace 任意目录写文件。

移交笔记：列出 MCP 名称、授权规则、descriptor 兼容字段和覆盖测试。

### WP3：扩展 connector 与 Portal API 合同

任务名称：资产库的受 scope 保护调用面

目的：为 Portal 提供资产库操作，不让浏览器越过 relay 或拼装本地路径。

输入：WP0/WP1/WP2 产物；Runtime `src/portal/connector.ts`、Portal protocol/types/API route 模式。

输出：`asset.*` connector 命令、Portal `/api/assets/*` 路由和跨仓库 contract tests。

边界：不复活废弃的 `artifact.library.list` 作为新资产库主接口；不让 payload 提供 scope；不提供任意文件删除。

步骤：

1. 实现并注册 `asset.list/get/version.get/versions.list/upload/rename/archive/restore_version/references.list`。
2. 校验请求 schema，限制 pagination/filter 参数和上传格式。
3. 对每条命令强制 connector 注册 scope，并覆盖 connector-project scope 一致性。
4. 在 Portal 建立对应的 authenticated API routes 和错误码映射。

验收标准：未认证访问为 401；跨 scope 为 403/域错误；未知资产为 404；超出格式或大小限制有稳定错误；Portal 不能从浏览器声明 `userId`、`projectId`、`instanceId`。

失败处理：协议版本或字段未对齐时停止发布，在两仓库补充兼容适配和 contract test 后再继续。

移交笔记：列出命令、HTTP 路由、请求/响应类型、错误码和兼容承诺。

### WP4：实现 Portal 产物库

任务名称：用户资产管理界面

目的：让用户以“产物”而非“Workspace 文件”心智模型完成查看、下载、整理与版本恢复。

输入：WP3 API 合同；Portal 的 chat 文档预览组件、导航和自动化页面。

输出：一级“产物库”入口、列表、详情、版本时间线、上传、重命名、归档、恢复界面，以及聊天/自动化跳转。

边界：不展示内部 `assets/` 文件路径、工程文件、调试日志或 Workspace 文件夹树；不做文件夹移动、彻底删除和批量操作。

步骤：

1. 增加导航、资产列表、筛选/搜索和空状态。
2. 复用现有预览/下载安全管道，不为新资产创建绕过 checksum 的下载路径。
3. 构建资产详情：当前版本、来源、引用任务、版本历史、恢复确认和归档操作。
4. 增加支持格式的上传，并在对话 artifact 卡片及自动化详情中跳转到资产。
5. 使用浏览器做桌面与移动验收，尤其验证长文件名、无预览格式、归档状态和错误状态。

验收标准：用户能在不打开 Workspace 的前提下上传、查看、下载、重命名、归档和恢复一个资产版本；历史版本不能被误当作当前版本；所有按钮错误有可理解反馈。

失败处理：预览失败时提供安全下载和错误状态；不因预览错误隐藏资产元数据或版本历史。

移交笔记：列出页面/组件、关键交互、已验证视口、遗留格式限制。

### WP5：将自动化任务抽象为通用任务定义

任务名称：通用自动化任务 schema 与资产绑定

目的：使自动化可以纯推送、创建产物或更新已有产物，而非强制 `source/working` 表格。

输入：WP0/WP1/WP2；`src/services/automation-tasks.ts`、`src/services/automation-runner.ts`、Portal `AutomationShell`。

输出：版本化通用任务 schema、资产绑定表/服务、兼容读模型和新编辑器 request contract。

边界：不移除旧 `automation_task_assets`；不修改现有日周月复盘调度；不允许通用任务通过描述文本获得任意服务写权限。

步骤：

1. 扩展 task revision：instruction、输入绑定、output policy、delivery policy；文件输入改为可选。
2. 实现 `none/create/update` 输出策略的服务验证，并限制 update 格式矩阵。
3. 将 Portal 编辑器改为四段模型，固定北京时间，并允许创建无资产的推送任务。
4. 为旧表格任务保留兼容视图与执行器，新增任务默认走资产绑定。
5. 测试无资产推送、创建 Markdown 产物、更新 CSV/XLSX、版本冲突和非法绑定。

验收标准：没有文件的任务可创建、手动运行和启用；更新目标必须是同 scope、受支持、active 的资产；编辑任务继续产生 immutable revision 并需重新启用。

失败处理：不支持的旧任务/格式继续走旧兼容路径或明确提示迁移，不能在读取时静默丢失绑定。

移交笔记：记录新旧 schema 映射、默认行为、不可兼容输入及 migration 条件。

### WP6：实现通用运行、推送与版本提交闭环

任务名称：自动化 runner 的资产输出与投递

目的：保证后台运行真正完成“触发 → ACP → 校验/提交资产版本 → 可选推送 → 审计”，并在故障时不制造假成功。

输入：WP2/WP5；runner、scheduler、push 队列和现有 run lease 机制。

输出：结构化运行结果协议、版本提交/投递顺序、运行详情中的资产引用、故障恢复测试。

边界：不让模型自由决定物理目标路径；不把 ACP 普通文本误作成功资产更新；不生成重复版本或重复推送。

步骤：

1. 定义 runner 与 ACP 的结构化结果：摘要、是否推送、staged output descriptor、输出 MIME/文件名和可选条件原因。
2. 先校验并提交资产版本，再标记 run succeeded；投递使用独立幂等键并记录结果。
3. 对 `none` 输出只记录摘要；对 `create/update` 保存产物版本 ID；失败时保持 head 不变。
4. 维持并扩展任务级锁、run lease、重试和过期回收，保证重试不会重复推进版本。
5. 手动运行建会话；计划运行只写历史；继续对话只带引用，不自动再次执行。

验收标准：每天新闻推送任务无需资产即可成功；表格更新成功产生一个新版本且只有一次；ACP/结构校验/租约/投递失败都不会错误推进版本或重复推送。

失败处理：任何提交前失败将 run 标为 failed 并保留可诊断摘要；提交成功但推送失败可单独重试投递，不能重新执行或重新生成资产版本。

移交笔记：列出状态转换、幂等键、重试边界、run/asset/provenance 字段与关键 smoke 证据。

### WP7：旧表格自动化兼容与逐任务迁移

任务名称：历史任务适配、迁移与回退

目的：让已创建的 CSV/XLSX 自动化任务不中断，同时提供可控路径将其转为资产绑定任务。

输入：WP1/WP5/WP6；现有 `automation_task_assets`、`automation_task_revisions` 与 Workspace `automations/` 目录。

输出：旧任务兼容适配、逐任务迁移命令/界面、备份和回退说明、迁移测试。

边界：不自动批量迁移真实用户；不删除旧 source/working 文件；不改变已有任务的时区、调度、状态或下一次运行。

步骤：

1. 让旧任务详情继续读取并下载现有 source/working 资产。
2. 设计“迁移到产物库”显式动作：先备份，创建源/工作资产与版本，写新 revision，保持 paused 等待用户确认启用。
3. 支持失败回退到旧 revision；记录 migration audit。
4. 对隔离 fixture 验证迁移前后输出内容、checksum、scope 和运行历史可追溯。

验收标准：未迁移任务行为不变；迁移后任务引用 user asset 且历史版本可见；任何迁移失败不损坏原任务文件或激活任务。

失败处理：备份或校验无法完成时中止迁移并保留旧任务；不尝试“尽力猜测”文件格式或内容。

移交笔记：记录迁移 eligibility、备份位置、回退步骤、已迁移/跳过状态。

### WP8：独立验收、发布准备与观察

任务名称：跨仓库端到端验收

目的：以用户可见行为和服务安全边界验证全部交付，而不是只依赖实现方自测。

输入：WP0-WP7 的移交笔记、隔离运行时与 Portal 环境、设计验收标准。

输出：验收记录、缺陷清单或通过结论、发布/回退清单。

边界：验收 Agent 不重构产品设计；不对真实用户数据做迁移或创建永久测试资产。

步骤：

1. 跑 Runtime/Portal 类型检查、单元/合同测试、构建和最小 connector smoke。
2. 在隔离用户下验证：上传资产、对话保存、纯推送自动化、新建 Markdown、更新 CSV/XLSX、版本恢复、任务继续对话。
3. 用第二用户重复读取/下载/更新/恢复尝试，证明 scope 隔离。
4. 注入 ACP 失败、版本校验失败、重复 run、lease 丢失、推送失败，验证无假成功和无重复版本。
5. 用浏览器验证 Portal 产物库与自动化编辑器在桌面和移动视口的核心流程。
6. 产出发布前检查与回退路径：代码回退、additive migration 兼容、未迁移旧任务继续运行。

验收标准：上游设计中的全部验收标准都有自动或浏览器证据；未通过项按严重度路由回具体 WP；不得以“测试未覆盖”标记通过。

失败处理：若发现数据安全、跨 scope、重复版本或错误推送问题，标为阻断，不进入发布准备。

移交笔记：包含环境、命令、结果、浏览器证据、已知风险和明确的 go/no-go 结论。

## Agent 执行规则

- 一个 Agent 一次只领取一个工作包；必须先阅读该 WP 的输入和上游移交笔记。
- 任何 WP 修改 protocol/schema 时，需在同一变更窗口同步 Runtime、Portal 与合同测试；不允许只改一端。
- 执行 Agent 不得自行把“产物库”退化为 Workspace 文件树，也不得将“自动化”重新限制为文件维护。
- 独立 reviewer 按 WP 验收标准审核，优先报告数据越界、兼容回归、假成功、幂等与版本问题。

## 可直接交给执行 Agent 的提示词

```text
执行 docs/user-asset-library-and-general-automation-tasks.md 中的 <WP 编号>。

先阅读上游设计、该 WP 的输入和上游移交笔记。严格遵守任务的边界、输出、验收和失败处理；不要扩展到未依赖的工作包。保留用户已有改动，不操作真实 Workspace、生产 SQLite 或生产环境。完成后提供：修改文件清单、执行命令与结果、逐条验收证据、移交笔记，以及任何阻塞项。
```

## 可直接交给验收 Agent 的提示词

```text
独立验收 docs/user-asset-library-and-general-automation-tasks.md 中的 <WP 编号> 或 WP8。

以该 WP 的验收标准为唯一依据。优先检查 scope 隔离、版本不可变性、失败不提交、兼容性和 Portal 实际交互。先列出问题及其证据；没有问题时明确说明仍未覆盖的风险。不要替执行 Agent 重做设计或以实现方自述作为通过证据。
```
