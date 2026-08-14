# Mastra 重构长工作包

状态：WP0-WP7 技术候选已完成；H1 本地体验验收仍 pending
工作分支：`feat/mastra-migration`
工作树：`/Users/combo/MyFile/projects/invest-agent-ideal-mastra`

## 1. 最终目标

本工作包把当前“Mastra 内核已经可运行的迁移分支”推进为“本地可完整验收的正式候选版本”。候选版本必须满足：

- Mastra 是唯一 Agent 内核；不存在 ACP、Codex CLI、Hermes 或 Claude CLI 执行回退。
- runtime 与正式 Portal 位于同一个 Git 项目，但保持独立进程、独立端口和独立状态边界。
- 普通对话、scheduler、automation 不依赖用户 Workspace 中的 `AGENTS.md`、Skills、`.codex`、模型配置或 session。
- portfolio、watchlist、plans、preferences、methods、reviews、memory、schedules 和用户文件都有明确的 service/asset ownership。
- 生产备份只作为只读源；所有迁移和写入验证发生在临时 target 副本。
- 本地完整功能、数据迁移、Portal、微信 fixture、scheduler、automation、模型切换和审计追踪均有自动化证据。
- 在独立本地端口启动后，用户只需进行一次最终体验验收。

本工作包不包含部署包、新服务器、生产端口切换、真实微信重新扫码、生产数据写入或客户灰度。

## 2. 当前已经完成

- Mastra Agent 已成为迁移分支唯一运行内核，ACP stdio 执行器和依赖已删除。
- Portal、微信、scheduler、automation 已接入中性 runtime API。
- 会话取消、重启恢复、模型按回合选择、工具调用和 trace correlation 已验证。
- `23655` 可独立运行；`22655` 和生产状态未受影响。
- 生产灾备快照复制、冷启动、target 写入和源 checksum 不变已验证。
- Portal 页面人工验收已通过，并修复了审计模板 JavaScript 语法错误。
- Mastra prompt 不再向 Workspace 写 `.sandbox-token`，定时 prompt 不再读取 `AGENTS.md` 或 Workspace Skills。
- 最近完整自动化基线为 runtime `460` tests passed、正式 Portal `43` tests passed（2026-08-15，含画像退役/开销捕获/G22 卡片管线）。
- 2026-08-14 H1 前置实测发现 G22/G23；两项均已于 2026-08-15 修复（G22 终态为官方 artifact 卡片管线；G23 为 Mastra payload 形状解包，用户回合 trace 已实证 tool_calls 落库）。H1 验收进行中：文件/资产库/自动化列表/审计已过，余表格附件卡片重测。

因此，剩余工作不是“再换一次内核”，而是完成 H1 体验复核：复杂多工具回合的性能、Portal 中由 Agent 实际调用 `spreadsheet.create` 生成 XLSX、文件展示/下载，以及最后的全量回归。生产部署、真实微信、push、真实数据切换和分支合并均不属于当前工作包。

## 3. 工作包总览

前置设计门：WP1-WP3 必须遵循 [mastra-workspace-exit-mapping.md](./mastra-workspace-exit-mapping.md)。在该承接矩阵获用户确认前，不实施 Workspace 数据重构；任何未分类文件均不得删除或遗漏。

| 阶段 | 工作 | 目的 | 主要负责人 | 用户是否必须参与 |
| --- | --- | --- | --- | --- |
| WP0 | 当前成果固化与基线重建 | 防止长工作过程中丢失已验证成果 | Codex | 否 |
| WP1 | Workspace 运行环境彻底退出 | 确保 Mastra 不依赖旧 Agent 工作目录 | Codex | 否 |
| WP2 | 业务数据 service ownership | 让核心业务状态脱离 Workspace 文件运行 | Codex | 仅冲突无法自动裁决时 |
| WP3 | 用户资产与 Portal 文件契约收敛 | 用 asset library 替代 Workspace 文件树 | Codex | 否 |
| WP4 | 正式 Portal 同仓 | 达成 runtime + portal 一个项目的目标形态 | Codex | 否 |
| WP5 | 备份快照全域迁移验证 | 证明真实备份可安全进入新结构 | Codex | 仅数据冲突时 |
| WP6 | 历史兼容与命名清理 | 确保候选版本没有旧内核包袱 | Codex | 否 |
| WP7 | 完整自动化与本地候选启动 | 形成最终可验收版本 | Codex | 否 |
| Gate H1 | 本地最终体验验收 | 判断业务功能是否达到可替代水平 | 用户 | 是 |
| Future | 新服务器端口与内测切换 | 真正进入发布 | 用户授权 + Codex | 是，且不属于本工作包 |

## 4. 详细执行内容

### WP0：固化当前成果

工作：

1. 审阅当前未提交改动，确认均属于本轮 Mastra 重构。
2. 运行构建、完整测试、快照 smoke 和 diff 检查。
3. 将备份隔离、Portal 修复、Workspace token 清理和相关文档形成一个明确 checkpoint。
4. 更新 `main -> migration` 和正式 Portal 的最新差异基线。

完成标准：工作树有可追溯 checkpoint；后续每个阶段可单独回滚和审阅。

### WP1：Workspace 运行环境彻底退出

工作：

1. 普通对话不再把用户 Workspace 作为 Agent `cwd`，改用 runtime 私有临时目录。
2. scheduler 不再因为 `AGENTS.md` 是否存在而判断用户是否可运行。
3. 模型、工具、权限、确认和 prompt instructions 全部来自服务层。
4. automation 只获得 task staging；普通对话不获得用户根文件树。
5. 增加源码扫描和行为测试，禁止 `.codex`、Skills、旧 session 重新进入 runtime。
6. 先生成完整 Workspace inventory/manifest，将每个文件标记为 structured state、event memory、automation、asset、product policy、archive、discard 或 conflict，要求 `unclassified=0`。

目的：证明“无 Workspace Agent runtime”是真的运行边界，而不只是改名。

完成标准：删除测试 Workspace 中的 `AGENTS.md/.codex` 后，Portal 对话、微信 fixture、scheduler 和 automation 代表性流程仍通过。

### WP2：业务数据 service ownership

前置输入：已确认的 Workspace 退出承接矩阵和完整 migration manifest。不得用“daily/review/memory”一个笼统类别覆盖语义不同的数据。

按域推进，禁止一次性大爆炸迁移：

1. scheduler preferences：`schedules.yaml`、`watch.yaml`、notification 配置进入 service-owned schema。
2. portfolio/watchlist/plans：服务表成为权威读写源，Workspace YAML 仅作为迁移输入或用户导出。
3. profile/methods：投资画像、方法和版本历史进入 service 表/版本资产。
4. review automation：日、周、月复盘的 schedule 和执行 policy 进入系统托管自动化；历史报告不转成任务。
5. daily/review/memory：当前计划与偏好进入结构化 service 表，决策/反馈/方法变化进入 append-only event 表，运行日志进入审计。
6. Skills/`AGENTS.md`/提示词：安全规则固化到服务层，产品流程进入版本化系统策略，用户方法与风格进入 profile/methodology；旧执行器和路径规则舍弃。
7. 所有写路径保留 scope、确认、审计、锁和幂等语义。

每个域必须依次完成：schema → 快照 dry-run → 幂等导入 → 双读对照 → 切换默认读写 → 旧路径只读 → 自动化验收。

目的：Workspace 可以退出运行架构，同时不丢失用户真正的投资数据。

完成标准：核心功能在空 Workspace 或无 Workspace 的情况下仍可读写；备份中的同域数据可导入 target 且重复执行不产生重复记录。

用户参与规则：

- 字段可依据现有代码、文档和真实使用路径确定时，由 Codex 决策并记录。
- 若同一用户的 SQLite 与 Workspace 对同一业务对象存在冲突，且时间戳/版本/当前运行路径都无法判定权威源，则暂停该域并给用户一份最小冲突清单。
- 不因为备份里有 4 个技术用户就要求用户现在选择正式迁移名单；本地验证可覆盖全部快照，正式发布时再选择两位内测用户。

### WP3：资产与 Portal 文件契约

工作：

1. 将 Portal `workspace.file.list/get` 的用户体验迁移到 `asset.list/get/version`。
2. 报告、附件、自动化 source/working 和用户保存文件使用独立受控字节根，不使用用户 Workspace 根。
3. `conversation_artifacts`、`user_assets`、`automation_task_assets` 成为权威索引。
4. 保留 Markdown、HTML、图片、XLSX 的预览、下载、版本和 retention 行为。
5. 正式 Portal 与 runtime connector 的 capability/错误码同步更新。
6. 将历史日/周/月复盘作为带业务语义的报告资产导入；复盘页面和“我的文件”引用同一资产版本。
7. 将公司财报、专题研究、用户表格/代码/模板/schema 等有价值内容导入“我的文件”；代码资产默认不可执行。
8. 附件保持 TTL 和消息关联，只有用户已明确保存的内容才提升为长期资产。

目的：Portal 不再因为 Workspace 文件树存在才能工作，同时保持现在用户看到的文件能力。

完成标准：Portal 文件列表、预览、下载、保存、版本和自动化产物测试全部使用 asset contract；`workspace.file.*` 不再是当前 UI 必需能力；快照文件迁移 manifest 的 `unclassified=0`，资产 checksum 与版本关系完整。

### WP4：正式 Portal 同仓

工作：

1. 仅从正式仓库 `/Users/combo/MyFile/projects/invest-agent-portal` 导入，不使用 `test-projects/`。
2. 建立 `apps/runtime`、`apps/portal`、`packages/protocol`/`contracts` 或等价清晰结构。
3. 保留 Portal 历史来源记录；原 Portal 仓库在本地候选验收前仍是旧服务事实源。
4. 根目录提供分别启动、分别测试和联合开发命令。
5. runtime 与 portal 不共享 SQLite 文件，不把 Portal relay 与 Agent runtime 合并为一个进程。
6. 协议 schema 只保留一个权威定义，消除 connector/Portal 手工漂移。

目的：达到用户明确要求的“runtime + portal 一个项目，方便测试和 Git 管理”，而不是把两个服务粗暴塞进一个进程。

完成标准：在同一仓库中可分别 build/test runtime 与 portal，并可用一个开发命令同时启动；正式 Portal 43 项及新增合同测试通过。

### WP5：备份快照全域迁移验证

工作：

1. 使用完整灾备快照和 Workspace 快照的复制副本。
2. 对 WP2/WP3 的每个域输出 source/target count、checksum、missing、conflict、skipped。
3. 执行两次导入，证明幂等。
4. 从 target 冷启动 runtime + portal，执行关键读取和受控写入。
5. 测试结束删除临时 target；验证快照源摘要未变化。

目的：在不接触生产的情况下，证明新数据结构能承接真实形状的数据。

完成标准：所有纳入迁移的域 `missing=0`、`conflict=0`，或冲突均有明确处置记录；源快照未变化。

### WP6：历史兼容清理

工作：

1. 删除/归档仍导入已删除 ACP 模块的 smoke 和 probe。
2. 清理 runtime 源码、环境变量、UI、函数和类型中的 ACP/Codex/Hermes 历史命名。
3. 保留的历史名仅允许存在于一次性迁移代码、archive 文档和旧字段兼容读取中。
4. 删除 Workspace compatibility runtime 路径；备份/迁移工具可以保留但必须明确只读源边界。
5. 加入 convergence scan，防止旧依赖重新出现。

目的：迁移分支成为真正的重构版本，不背负双内核和旧执行器兼容包袱。

完成标准：源码扫描无旧内核运行引用；package 依赖无旧 SDK/CLI；所有当前测试使用中性命名或 Mastra 命名。

### WP7：本地正式候选验收准备

工作：

1. typecheck、build、runtime 全套测试、Portal 全套测试、协议合同测试全部通过。
2. 用全新空状态冷启动，验证新用户完整流程。
3. 用备份迁移 target 冷启动，验证历史用户读取和一次受控写入。
4. 独立启动 runtime 与同仓 Portal；保持生产端口和生产状态不动。
5. 检查 health、登录、对话、取消、附件、文件、自动化、审计、模型切换和 trace coverage。
6. 输出最终验收报告、已知限制和明确的发布前遗留项。

完成标准：形成一个可由用户直接访问的本地候选版本；自动化无失败；没有未分类的功能差异或数据 ownership。

## 5. 用户必须参与的节点

### 当前 Gate P0：确认工作包范围

用户只需确认以下理解是否符合预期：

- 目标是完整重构候选，不是现在部署。
- runtime + Portal 必须同仓，但仍是独立进程。
- Workspace 退出 Agent runtime；业务数据迁到 service/asset 层后才移除旧路径。
- 备份快照用于本地迁移验证，生产源绝不写入。
- Codex 连续执行 WP0-WP7，直到本地最终验收门。

### 条件 Gate D1：无法自动裁决的数据冲突

通常不需要用户参与。只有 WP2/WP5 发现真实冲突且没有可靠权威源时，才提交最小冲突清单，用户只决定保留哪一版数据。

### 必须 Gate H1：本地最终体验验收

Codex 提供本地访问地址和验收账号，用户验证：

- Portal 的主要功能和现有服务业务等价。
- 对话、文件、自动化、审计和模型体验符合预期。
- 产品上没有明显的旧 Workspace/旧内核痕迹。

用户不需要逐条手工测试所有后端状态；自动化证据由 Codex 提供。

### 未来 Gate R1：是否进入发布阶段

H1 通过后再单独讨论。届时用户确认新服务器端口、两位内测用户、Portal 地址和重新微信扫码安排。未经该确认不制作部署包、不连接服务器、不切换端口。

## 6. Codex 可独立完成的工作

- 代码和数据 ownership 盘点。
- schema、migration、backfill 和幂等工具实现。
- 快照复制、checksum、dry-run、双读和回滚演练。
- runtime/Portal 重构、同仓和协议统一。
- 自动化测试、fixture、独立服务启动和日志/trace 审计。
- 旧兼容代码、命名、脚本和依赖清理。
- 文档、执行记录、验收报告和冲突清单。
- 测试用户创建与清理。

上述工作均不得修改生产源、真实 Workspace、生产微信状态或发布目标。

## 7. 风险与控制

| 风险 | 控制 |
| --- | --- |
| Workspace 同时承载运行环境和业务数据 | 按 WP1/WP2 分离，禁止直接删目录 |
| SQLite 与 YAML/JSONL 数据冲突 | 双读报告；无法裁决才触发 D1 |
| Portal 同仓造成协议漂移或历史丢失 | 正式仓库唯一来源，先合同测试再移动 |
| 长工作包改动过大 | 每个 WP 独立 checkpoint、测试和报告 |
| 误操作生产 | 只使用快照副本；路径拒绝、前后 hash、独立端口和状态根 |
| 为了通过测试保留旧兼容回退 | WP6 convergence scan 明确禁止运行时回退 |
| 过早进入部署 | Phase 4/Future 明确排除，必须经过 H1 和 R1 |

## 8. 本工作包完成定义

WP0-WP7 全部完成且证据齐全时，本工作包停在 Gate H1。此时不代表已经发布，只代表：

1. Mastra 重构在本地达到正式候选质量。
2. runtime + Portal 已同仓且功能完整。
3. 备份数据可以安全、可重复地迁移到临时 target。
4. 生产源、旧服务和真实微信状态没有被修改。
5. 用户可以用最少人工操作判断是否值得进入未来发布阶段。

## Executor Prompt

在 `feat/mastra-migration` 工作树连续执行 WP0-WP7。按阶段建立 checkpoint、运行验证并更新执行记录；除非遇到 Gate D1 的不可裁决数据冲突，不要在中间要求用户做人工验收。不得准备部署包、连接服务器、修改生产源、切换端口或操作真实微信状态。完成后启动本地候选并停在 Gate H1。

## Reviewer Prompt

独立检查 WP0-WP7 的代码、schema、数据 ownership、Portal 同仓来源、快照隔离、幂等、自动化证据和旧内核收敛。不得以测试总数代替逐项验收；不得批准部署或生产切换。若所有标准满足，将结果路由到用户 Gate H1。
