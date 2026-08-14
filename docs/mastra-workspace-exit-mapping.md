# Mastra Workspace 角色收敛与用户数据承接设计

状态：设计已确认；原型验证、分域隔离导入、运行时 ownership 收敛、默认 Mastra backend 切换与独立候选冷启动已完成；用户 Gate H1、真实微信/push、完整组合 target 写入验收及最终兼容命名清理仍待推进
适用分支：`feat/mastra-migration`
事实样本：只读 Workspace 快照 `2026-08-10T235031+0800`
验证证据：[mastra-workspace-prototype-validation.md](./mastra-workspace-prototype-validation.md)

> 本文是 Workspace 保留、退出旧运行时和后续数据承接的工作包。它确认目标架构，不表示真实 Workspace、生产 SQLite、微信状态或 `22655` 已被接入或迁移。当前验证仅使用自动清理的临时目录。

## 1. 结论

不再把“移除旧 Workspace 运行时依赖”理解为“删除用户 Workspace”。两者应明确分开：

1. **旧运行时退出**：Mastra 不依赖 ACP、Codex/Hermes/Claude CLI、`.codex` session、用户目录中的模型配置或旧 runtime 状态。
2. **受控用户项目空间保留**：每位用户仍有持久 Workspace，供 Agent 和用户共同演化报告、研究、方法、模板、Skills、表格和其他自定义产物。

目标不是把一切拆进数据库，而是让每类内容只承担适合它的职责：服务管理确定性业务事实和安全边界；用户 Workspace 保留项目自由度；不可信代码只在一次性 staging 中执行。

原型已验证 `@mastra/core@1.57.0` 可以按请求的用户 scope 动态绑定独立 Workspace，提供文件读写、搜索和 Skills；`LocalFilesystem` 的 `contained: true` 会阻断路径穿越。原型同时验证了命令工具的 cwd 绑定能力，但这不是生产执行授权。`LocalSandbox` 即使启用 macOS Seatbelt，仍可读到同级目录和项目目录，因此**不得**把它作为多用户或不可信代码执行的最终安全边界。

## 2. 目标架构

| 层 | 权威职责 | Agent 能力 | 不承担的职责 |
| --- | --- | --- | --- |
| 服务核心 | 用户/实例 scope、持仓、自选、计划、规则、调度、确认、审计、对话、权限 | 仅通过受控 service tools 读写 | 用户研究文件和任意脚本 |
| 受控用户 Workspace | 报告、研究资料、用户方法、模板、Skills、用户代码、可视化和交付物 | 按当前 scope 读写、搜索、版本化和发布 | 模型密钥、系统权限、调度真相、服务运行状态 |
| 临时 staging / sandbox | 某回合或某自动化任务的输入副本、运行输出、中间文件 | 可执行受限命令和代码 | 持久用户项目、其他用户目录、服务主机目录 |
| 资产索引与版本库 | Portal 文件列表、预览、下载、版本、来源、保留和引用关系 | 发布/引用当前 Workspace 文件或运行产物 | 取代用户项目的自然目录结构 |
| 系统策略 | 安全、scope、确认、审计、工具授权、产品流程 | 由服务强制 | 被 Workspace 的 `AGENTS.md` 或 Skill 覆盖 |

```text
Portal / WeChat / scheduler
            |
            v
Mastra Agent + request scope
   |                 |
   |                 +--> service tools --> service-owned facts and audit
   |
   +--> scoped Workspace --> reports / methods / templates / user files
   |
   +--> execution request --> staging copy --> isolated sandbox --> explicit publish
```

用户 Workspace 是 Agent 的项目空间，不是 Agent 内核、数据库或宿主机文件系统的代名词。

## 3. 已验证能力与边界

| 事项 | 结论 | 设计含义 |
| --- | --- | --- |
| 每用户目录绑定 | 已验证：`RequestContext.userId` 可驱动 Agent 动态 Workspace | 目录解析必须在服务端完成，不能相信模型或浏览器传来的路径 |
| 文件读写和搜索 | 已验证：Mastra Workspace 自动提供文件工具 | 普通对话可在用户项目根内创建和修改文件 |
| 路径越权 | 已验证：`LocalFilesystem({ contained: true })` 拒绝 `../` 跨根读取 | 禁止 `allowedPaths` 和 `contained: false`；不向模型暴露主机绝对路径 |
| 用户 Skills | 已验证：不同用户可得到不同同名 Skill 内容 | Skill resolver 无 scope 时必须返回空集或固定系统 Skill，不能猜目录 |
| 工具控制 | 已验证：读写/删除/命令可逐工具启停并要求确认 | 删除、移动、覆盖、发布和执行要有明确策略与审计 |
| 命令工作目录 | 已验证：命令从绑定 Workspace 目录启动 | 这只说明 cwd 正确，不等于可安全执行不可信代码 |
| LocalSandbox 隔离 | 已验证不足：Seatbelt 配置仍可读同级和项目目录 | LocalSandbox 仅用于可信本地开发；生产不能直接执行用户 Workspace 中代码 |

验证脚本：`npm run mastra:workspace-check`。它只创建并清理临时目录，不读取真实 Workspace。

2026-08-13 的复核结果为 7 项 `pass`：动态用户绑定、文件读写、路径穿越拦截、用户 Skill 隔离、删除工具禁用、命令 cwd 绑定、缺失 scope fail-closed；另有 1 项安全 `observed`：本机 Seatbelt 下的 `LocalSandbox` 可访问同级用户目录。该观察项是禁止生产执行路径使用 LocalSandbox 的依据，而非可接受的隔离保证。

## 4. Workspace 的目录契约

每用户有一个由服务注册和持有的项目根。推荐保留语义目录，而不是让所有文件退化为无上下文 blob：

| 项目区域 | 允许内容 | 默认 Agent 权限 | 备注 |
| --- | --- | --- | --- |
| `reports/` | 日/周/月复盘、公司/行业/专题研究、网页报告 | 创建、读取、修改；发布时生成版本 | 保持报告语义和原目录可读性 |
| `methods/` 或 `knowledge/methods/` | 用户投资方法、研究框架、判断原则 | 读取、提议修改；影响业务方法时确认 | 可对应 service methodology profile，但原文仍保留 |
| `templates/` | 报告、表格、分析模板 | 读取、创建、修改 | 自动化引用已发布版本，不直接依赖活动文件 |
| `skills/` | 用户方法型、展示型、研究型 Skills | 读取、版本化；不能扩大权限 | 系统 Skills 不放入用户根 |
| `files/` / `deliveries/` | 用户文件、表格、图片、HTML、ZIP、交付物 | 读取、保存、版本化 | Portal 的“我的文件”按资产索引展示 |
| `tools/` / `src/` / `schemas/` | 用户脚本、代码、schema、可复用计算定义 | 保存和编辑；默认不可执行 | 执行只进入 staging/sandbox |
| `data/` / `financials/` / `indicators/` | 用户上传或保留的原始数据、指标结果 | 读取、生成衍生物 | 不作为行情/持仓等服务事实的权威源 |
| `.agent-project/` | 项目 manifest、发布索引、版本与迁移元数据 | 仅服务写入 | 不等同于 `.codex`、`.agents` 或旧 `.state` |

禁止进入用户项目根的内容：服务 `.env`、API key、微信 token、数据库文件、服务锁、Agent session、模型配置、全局工具配置、其他用户文件和生产运行状态。

## 5. 数据承接矩阵

### 5.1 必须移为服务权威源的内容

| 当前 Workspace 来源 | 新的权威位置 | Workspace 中的保留方式 | 原因 |
| --- | --- | --- | --- |
| `config/portfolio.yaml` | portfolio / watchlist service 表 | 可导出为项目快照或用户说明 | 持仓必须有 scope、revision、确认和一致性 |
| `plans/`、可执行的交易预案 | stock plans / daily plans service 表 | 可生成可读报告或导出 | 需要确认、锁、规则和审计 |
| `config/schedules.yaml`、`watch.yaml` 中的调度/规则 | scheduler settings、automation、alert rules | 项目中可保存说明和模板 | 定时任务不应由目录存在与否决定 |
| `config/notification.yaml`、onboarding state | 服务设置和引导状态 | 可展示的设置导出 | 需要稳定、可审计、可恢复 |
| `memory/change_log.jsonl`、确认和运行事件 | domain audit / task runs / traces | 可在项目生成阅读摘要 | 运行审计不能由用户可改文件充当真相 |
| `memory/decisions.jsonl`、`review_viewpoints.jsonl` 的当前有效对象 | decision / viewpoint service 事件表 | 复盘报告中引用或导出 | 需要业务键、状态和关联查询 |

迁移后这些 Workspace 文件不必立即删除。它们是可读导出、历史快照或迁移输入，但服务表才是读写权威源。

### 5.2 应保留在用户 Workspace 的内容

| 当前 Workspace 来源 | 承接位置 | 是否进入“我的文件” | 说明 |
| --- | --- | --- | --- |
| `reports/daily|weekly|monthly/` | `reports/` + report/asset index | 是 | 自动化定义与历史报告分离；同一文件可有复盘页和文件页入口 |
| `reports/company/`、行业、策略、专题和指标报告 | `reports/` 或 `files/` + asset index | 是 | 保留用户可理解的目录、文件名、MIME 和来源 |
| `financials/companies/`、用户参考资料 | `data/` / `financials/` + asset index | 是 | 原始数据与分析报告分别标注 |
| `deliveries/` 的 XLSX、HTML、图片、PY、TXT、ZIP | `files/` 或 `tools/` + immutable version record | 是 | 代码默认只是资产，不能自动执行 |
| `assets/<id>/versions/` | Workspace 文件 + asset version mapping | 是 | 保留版本顺序、checksum 和来源引用 |
| `templates/`、`schemas/`、用户 `src/`、`tests/` | 原语义目录 + asset index | 是 | 不因不是数据库字段就丢失用户自定义能力 |
| `knowledge/methods/` 和用户编写的方法 | `methods/` / `knowledge/` | 可选 | 与 service profile 双向引用，不强迫全文结构化 |
| 用户 Skill | `skills/`，经分类后按 scope 加载 | 可选 | 用于方法、格式和研究流程；不能直接成为安全策略 |

资产索引是对 Workspace 文件的受控发现、版本和 Portal 展示层，不要求先把每个用户文件迁出为无目录 blob。重要发布、自动化输入和对话交付物可保存不可变版本；活动项目目录仍保留自然编辑体验。

### 5.3 不保留为新运行时输入的内容

| 来源 | 处理 |
| --- | --- |
| `.codex/`、`.agents/` 的 session、goals、memory/state SQLite、installation ID | archive/discard manifest，不作为 Mastra runtime 输入 |
| ACP/Codex/Hermes/Claude CLI 的认证、模型设置和执行状态 | 不迁移；凭据绝不进入用户 Workspace |
| `.state/`、`.invest-agent/workspace-compatibility.json`、template adoption | 仅迁移期归档/诊断，不进入新运行 |
| 嵌套 `.git/` 元数据 | 仅记录来源 commit/remote provenance，不作为运行目录复制 |
| `.trash/`、过期且无引用附件、可重建缓存 | 写入 manifest；除非仍被有效记录引用，否则不恢复 |

任何源路径都必须进入 `workspace manifest`，状态只能是 `service_migration`、`project_file`、`automation_template`、`asset_version`、`archive`、`discard` 或 `conflict`。`unclassified=0` 是硬验收条件。

## 6. 自动化、复盘与项目文件

日、周、月复盘仍要拆开处理，但不再要求把历史报告迁离用户项目：

| 对象 | 权威位置 | Workspace 作用 |
| --- | --- | --- |
| 日/周/月的时间、启用、通知偏好 | 系统托管 review automation | 用户可查看说明，不直接靠文件触发 |
| 复盘输出 policy | versioned product policy / automation template | 用户自定义模板作为已发布版本被选择性引用 |
| 历史复盘报告 | Workspace `reports/` + report/asset index | 用户和 Agent 可继续读取、迭代、预览与下载 |
| 日计划、观点、决策状态 | service state/event 表 | Workspace 生成报告、说明或导出 |
| 自动化输入/工作文件 | 临时 staging + asset version | 不直接给任务整个用户项目根 |

财报/公司分析默认是按需工作流。只有存在明确周期、范围和触发条件的用户要求，才创建 automation；既有历史财报永远不会自动变成任务。

## 7. Skills、`AGENTS.md` 与提示词

| 内容类别 | 新系统承接 | 能否改变权限 |
| --- | --- | --- |
| 系统安全、scope、确认、审计、工具规则 | 服务代码与 tool schema | 不可由用户文件覆盖 |
| 产品核心 workflow | Mastra instructions、workflow、service tool、automation template | 不可由用户文件覆盖 |
| 用户投资方法与风格 | Workspace `methods/` / `skills/` + profile/methodology reference | 只能影响方法和表达 |
| 用户研究/格式 Skill | Workspace `skills/`，动态按 scope 加载 | 不能声明新服务权限或可执行命令 |
| 用户 prompt 片段 | versioned project instruction fragment | 低于系统策略和工具授权 |
| 旧 ACP/Codex/Hermes 路径、模型、session 指令 | archive/discard | 否 |

`AGENTS.md` 不再是最高优先级的运行时契约。若保留，必须改名或迁移为受控的项目说明，例如 `.agent-project/instructions.md`：它可以说明用户偏好、目录约定和研究方法，但不能声明服务工具、扩大 scope、关闭审计、修改模型/密钥或绕过确认。

系统模板和用户修改版本必须分别记录。用户修改的核心方法不能在模板升级时被静默覆盖。

## 8. 文件操作、发布和执行安全

### 8.1 普通文件操作

1. 服务根据已认证的 `userId + instanceId` 从 Workspace registry 解析唯一项目根。
2. Mastra 以该根创建 Workspace，filesystem 必须 `contained: true` 且无额外 `allowedPaths`。
3. 模型只能使用项目相对路径；Portal 与 trace 不返回主机绝对路径。
4. 写入、重命名、覆盖、删除、归档和发布都记录 audit；删除、覆盖关键模板和移动目录需要明确确认。
5. 每次写入通过 mtime/version 或 asset version 检查并发冲突；重要发布创建不可变版本与 checksum。

### 8.2 代码和命令执行

用户脚本、模型生成代码和可执行 Skill 不能直接在持久用户 Workspace 中运行。正确流程为：

1. 服务根据已确认的执行请求创建一次性 staging root。
2. 只复制本次所需的已发布输入、模板和数据副本；不挂载持久项目根为可写目录。
3. 在容器、微虚机或远程 sandbox 中限制网络、凭据、资源、超时和允许的解释器。
4. 运行输出先落 staging，经过类型/大小/恶意内容检查后，由明确的 publish 操作写回 Workspace/资产版本。
5. 记录输入版本、命令、环境模板、输出 checksum、执行人/自动化和 trace；staging 在保留窗口后清理。

`LocalSandbox` 只可用于可信本机开发或受控测试，不能成为未来用户代码执行功能的生产安全承诺。

## 9. 初始化模板与生命周期

新用户初始化不再复制旧 ACP Workspace 模板，而是由服务创建最小项目骨架：目录、项目 manifest、系统只读模板引用、可选的用户方法/报告模板。用户项目只继承产品允许的内容，不继承认证、模型配置、系统 Skills 或历史 session。

模板分三层：

| 层 | 管理方式 | 用户能否改写 |
| --- | --- | --- |
| 系统策略与安全模板 | 服务发布、版本化、不可写 | 否 |
| 产品报告/自动化模板 | 系统版本，可选择/复制 | 副本可改，原版不可改 |
| 用户项目模板与方法 | Workspace 内版本化 | 是，重要改动需确认 |

迁移已有用户时，优先建立与旧目录语义相近的受控项目根，再分域导入服务事实并创建 asset/version 索引。不能因服务迁移成功就删除用户报告、方法或自定义文件。

## 10. 导入、冲突与幂等

1. 每一个快照路径必须进入 manifest，`unclassified=0`。
2. service migration 记录保留原相对路径、source hash、批次、原时间戳和目标业务键。
3. project file/asset version 保留原目录、文件名、MIME、checksum、来源和版本顺序。
4. 同一业务对象同时存在 SQLite 与 Workspace 时，按当前生产权威读写路径、revision、业务时间和审计链判断，不按文件时间静默覆盖。
5. 可以确认等价时幂等合并；可确认新旧版本时保留历史；无法裁决且影响当前服务状态时进入最小冲突清单。
6. 重复导入两次不得增加 service 记录、项目文件副本或资产版本。
7. 原 Workspace 只读归档保留到用户验收和回滚窗口结束；`archive` 不代表立即物理删除。

## 11. 用户参与门

Codex 可独立完成目录 inventory、manifest、结构化迁移、资产版本索引、权限测试、双读和临时 target 冷启动。用户只在以下情况参与：

- 当前持仓、计划或方法有两个都可能有效的版本，证据不足以决定权威源；
- 一个自定义 Skill 混合产品行为和独特用户方法，自动拆分会改变语义；
- 自然语言规则无法判断应成为自动化、确定性提醒还是仅作为项目方法；
- 准备永久舍弃一个无法识别价值的文件；
- 希望把某项用户代码从“可保存资产”升级为“允许执行的工具”。

不要求用户逐文件人工验收；每次只提交最小冲突清单、影响与推荐处理。

## 12. 实施门与验收标准

设计已经确认。下一步先实施“受控 Workspace 原型接入”，再进行分域数据迁移。不得以“无 Workspace 冷启动”作为验收目标；正确目标是“没有旧 runtime 依赖，但有受 scope 控制的用户项目空间”。

第一阶段完成条件：

- 动态 Workspace registry 只能由服务按认证 scope 解析，缺 scope fail-closed；
- Agent 可以在测试用户项目中读、写、搜索和动态读取用户 Skill；
- `contained: true`、无绝对路径泄露、跨用户 filesystem 越权和无 scope 访问均有测试；
- 删除/覆盖/发布/执行有独立确认、审计和版本规则；
- 持久 Workspace 不含密钥、服务数据库、Agent session、模型配置或旧 ACP runtime；
- 用户代码执行仍被禁用，或只通过 staging + 非 LocalSandbox 的隔离方案执行。

第一阶段的执行顺序与边界：

1. 建立仅由认证 `userId + instanceId` 查询的 Workspace registry；根目录必须来自服务配置或隔离测试输入，缺 scope、未知 scope、符号链接逃逸和越过 dedicated project root 均 fail-closed。
2. 将可选的动态 Workspace 绑定接入 Mastra Agent factory，普通互动仅开放相对路径的读取、列举、搜索、创建和编辑；默认关闭删除、移动、命令和用户代码执行。
3. 为项目文件写入、覆盖、发布和版本创建审计事件；发布才创建可被 Portal/自动化引用的不可变资产版本。
4. 在临时双用户项目中验证 scope、路径 containment、Skill 隔离、工具白名单、审计和缺 scope 拒绝；不接入真实 Workspace，也不把旧 `ensureWorkspace` 或 `resolveWorkspacePath` 作为新 registry。
5. 第一阶段验收通过后，再逐域处理 service-owned 事实和资产索引。每一域仍须经过 manifest、快照 dry-run、幂等导入、双读对照和 target 冷启动，且只使用备份快照副本。

### 12.1 第一阶段执行记录（2026-08-13）

已交付以下实现，且它们默认不接入真实用户 Workspace：

- `src/mastra/workspace-registry.ts` 提供显式的 `userId + projectId + instanceId -> projectRoot` 注册表。未注册 scope 不创建 Workspace；缺失/非法 scope、根目录逃逸、根目录变更及符号链接均 fail-closed。
- 项目 bootstrap 只在专用 `MASTRA_PROJECTS_ROOT` 下创建最小目录与 `.agent-project/manifest.json`，不复制旧 Workspace、`.codex`、模型配置、session、密钥或服务状态。
- `src/mastra/agent-factory.ts` 可接收已经由服务解析的 Workspace；互动 runtime 仅在 registry 已注册时绑定它，并向 Mastra 传入服务侧 `RequestContext`。来自消息上下文的 `workspacePath` 不再决定 Agent cwd 或文件权限。
- Workspace 只使用 `LocalFilesystem({ contained: true, allowedPaths: [] })`，动态加载项目内 `skills/`；不创建 `LocalSandbox`。默认只开放读取、列举、搜索、创建、编辑和建目录；删除、命令、后台进程、LSP、索引和 AST 编辑全部关闭。写入要求 approval + read-before-write。
- Workspace 工具调用以 scope、工具名和相对路径写入 file lifecycle audit；不记录文件内容和主机绝对路径。
- 调度回合不再创建旧 Workspace 或将其作为 cwd；它保持 service tools + task staging 的最小权限模型。

当前验证证据：

```bash
node --import tsx --test tests/mastra-scoped-workspace.test.ts tests/mastra-facade.test.ts tests/mastra-workspace-runtime-boundary.test.ts
npm run typecheck
npm run build
npm run mastra:workspace-check
npm test
```

聚焦测试覆盖双 scope 隔离、未注册拒绝、根目录/符号链接逃逸拒绝、最小项目 manifest、工具白名单、真实 RequestContext 注入和 Agent factory 绑定。`LocalSandbox` 的安全观察项仍然有效，故用户代码执行未启用。

### 12.2 快照 Workspace manifest dry-run（2026-08-13）

新增 `npm run mastra:workspace-manifest -- --workspace-snapshot <snapshot> --workspace-id <id> --out <outside-snapshot.json>`。该工具只枚举、哈希和分类文件；输出路径必须在整个快照根以外，测试覆盖 macOS `/var` 与 `/private/var` 别名，避免借由路径别名写入快照源。

对只读快照 `2026-08-10T235031+0800` 的 `mg` 执行结果：`fileCount=459`、`unclassified=0`、源内容摘要 `e484e5d5b10187658cede8f51ff71cb076126a540c1c979bba45be6c30a6c730`。分类为：

| disposition | 数量 | 后续处理 |
| --- | ---: | --- |
| `discard` | 273 | `.codex`、`.state` 等旧 runtime 状态，不作为 Mastra 输入 |
| `archive` | 3 | 旧项目说明与 compatibility 元数据，仅保留来源证据 |
| `service_migration` | 25 | portfolio、调度、通知、plans、memory，按域导入前双读 |
| `asset_version` | 16 | attachment、assets、deliveries，先校验字节再登记资产版本 |
| `project_file` | 141 | reports、knowledge、模板、用户代码、Skills 等保留在受控项目目录 |
| `conflict` | 1 | `config/strategy.yaml`，需自动拆分 profile 的服务字段与用户方法/项目文件后再判定 |

此结果尚未导入任何数据；manifest 输出位于一次性 `/tmp`，不在快照源或真实 Workspace 中。下一步是只读解析 `config/strategy.yaml` 的字段归属并生成该域的 mapping/dry-run，不进行写入。

### 12.3 `config/strategy.yaml` 分域验证（2026-08-13）

`mg/config/strategy.yaml` 是 manifest 中唯一的 `conflict` 文件。实际原因不是无法识别，而是同一个文件同时承载结构化投资画像和用户可读的方法规则；因此不能整体导入旧 `investment_profiles`，也不能直接作为 Mastra 运行时配置加载。

已新增只读 dry-run：

```bash
npm run mastra:strategy-mapping-dry-run -- \
  --workspace-snapshot <snapshot> --workspace-id mg \
  --user-id mg --instance-id invest-agent-mg --out <outside-snapshot.json>
```

真实快照的结果写在一次性 `/tmp/mastra-mg-strategy-mapping-20260813.json`，源 `config/strategy.yaml` 的 SHA-256 为 `0a4eac23fcf1ac9ef9a0453b208a32fbcd7e7aff28a55d1d876708fe642ce826`。所有顶层字段均得到归属，`unmappedTopLevelFields=[]`：

| 源字段 | 目标 | 当前状态 |
| --- | --- | --- |
| `profile`、`allocation`、`position_roles` | service-owned `mastra_project_profiles.profile_json` | 已在临时目标 SQLite 验证导入 |
| `buy_rules`、`sell_rules`、`rebalance_rules`、`risk_rules`、`do_not_do_rules`、`decision_boundaries`、`notes` | 受控项目的 `methods/strategy-rules.md` | 待实现项目文件与双读导入 |
| `last_confirmed_at` | profile 与方法记录的 source revision | 已纳入 dry-run；不作为自动覆盖依据 |
| `last_confirmed_by`、`last_confirmation_id`、`last_method_change_candidate_id` | 来源 provenance | 已保留在 mapping report，待随资产/迁移记录保存 |
| 原始 `config/strategy.yaml` 字节 | immutable user asset version | 待实现；用于审计、回滚与用户可读历史 |

`mastra_project_profiles` 是新内核的**加性 service-owned 画像投影**，实际主键为 `(user_id, project_id, instance_id)`。它保留来源路径、checksum、revision、迁移批次和时间戳；它不取代 `methods/` 或用户项目文件，也不重新依赖旧 `investment_profiles` 双轨表。应用的 `initDb()` 现在会创建该表及 `idx_mastra_project_profiles_source`，因此新表能以兼容方式进入现有 SQLite 初始化路径。

临时 target import 仅接受 dry-run report，目标数据库必须在完整 snapshot 根目录之外。同一 scope + 相同来源 checksum + 相同 profile JSON 的重复导入返回 `replayed` 且记录数保持为 1；同 scope 的任何不同内容立即以 `MASTRA_PROFILE_IMPORT_CONFLICT` 失败，不按 mtime 或来源文件静默覆盖。对真实 `mg` 快照的临时验证得到：

```text
action=inserted
action=replayed
count=1
scope=mg / invest-agent / invest-agent-mg
batchId=mastra-strategy-mg-20260813
```

快照保持只读；临时 target 和 `/tmp` 输出均不是生产 SQLite、真实 Workspace 或部署输入。灾备 SQLite 中不存在 `investment_profiles` 或 `methodology_profiles` 记录，因而本域没有 Workspace-vs-SQLite 的权威冲突，也不需要用户裁决。快照 `ai_instances` 使用 `id` 而非旧分析假定的 `instance_id`，此 schema 差异已记录，未写入目标。

本域聚焦验证如下，均已通过：

```bash
node --import tsx --test \
  tests/mastra-project-profile-schema.test.ts \
  tests/mastra-strategy-target-import.test.ts \
  tests/mastra-strategy-mapping-dry-run.test.ts \
  tests/mastra-workspace-manifest.test.ts
npm run typecheck
npm run build
git diff --check
```

### 12.4 Strategy 规则文件与版本资产隔离导入（2026-08-13）

策略域的第二条承接已完成于临时 target：`npm run mastra:strategy-project-import` 只接受已经完成的 strategy dry-run report，并将 project-method 字段渲染为 `methods/strategy-rules.md`；原 `config/strategy.yaml` 的原始字节同时保存为项目内 immutable asset version，并在 `user_assets` / `user_asset_versions` 登记 scope、checksum、版本路径与幂等键。

该工具在实际写入前重新计算来源 YAML checksum，若快照在 dry-run 后发生变化则以 `MASTRA_STRATEGY_SOURCE_CHANGED` 拒绝；target project root 和 target SQLite 均必须完整位于 snapshot 根目录外。相同 scope、同一 methods 内容和同一 source asset 重跑返回 `replayed`；同 scope 的 Markdown、资产字节或目标登记任一不一致，均以 `MASTRA_STRATEGY_PROJECT_IMPORT_CONFLICT` 拒绝，绝不自动覆盖。

对 `mg` 快照的同一临时 target 完成 profile import、project import 后再次运行两者，结果均为 `replayed`。双读验证结论：

| 对照 | 结果 |
| --- | --- |
| `mastra_project_profiles.profile_json` 与 dry-run service mapping | 完全一致 |
| `methods/strategy-rules.md` 与全部 buy/sell/rebalance/risk/do-not-do 规则、decision boundaries 和 notes | 全部保留 |
| `user_asset_versions.checksum`、项目内 immutable YAML 字节与源 `config/strategy.yaml` | 三者一致，SHA-256 为 `0a4eac23fcf1ac9ef9a0453b208a32fbcd7e7aff28a55d1d876708fe642ce826` |

此次 target 中 methods 文件 checksum 为 `96f63f48eaa73bc098618d6e48ab5f16dee5685e36f3a392c20c3bb9ead0b135`，资产路径为 `assets/asset_strategy_9347bdd9796436d1934aa6fa/versions/version_strategy_0a4eac23fcf1ac9ef9a0453b/strategy.yaml`。这些值只是 `/tmp` 中一次性验证 target 的证据，不是生产资产 ID 或部署输入。

对应测试覆盖正常导入、重跑、源篡改、同 scope 内容冲突和 snapshot 内 target 拒绝：

```bash
node --import tsx --test \
  tests/mastra-strategy-project-import.test.ts \
  tests/mastra-strategy-target-import.test.ts \
  tests/mastra-strategy-mapping-dry-run.test.ts
```

策略域已完成 manifest → field mapping → profile/project/asset target import → 幂等 → 双读。它尚未连接任何真实用户、生产 SQLite、Portal 或服务端口。下一数据域为 `config/portfolio.yaml`：先重新核对当前服务表 ownership 和实际 YAML 字段，再生成只读 mapping/dry-run；不得直接复制或导入。

随后每个数据域继续按：schema/ownership → snapshot dry-run → 幂等导入 → 双读对照 → target 冷启动 → 迁移报告。整个过程仅使用备份快照副本，不修改生产源、真实 Workspace 或生产微信状态。

### 12.5 `config/portfolio.yaml` ownership 与 dry-run（2026-08-13）

portfolio 域不能直接复用旧 `portfolio`、`watchlist`、`stock_plans` 三张双轨表：它们只能表达少量标准列，无法完整承接 YAML 中的 `cash`、账户、持仓数量/市值/权重、扩展属性、嵌套 `watch_conditions` 以及来源确认元数据。迁移分支新增加性的 service-owned `mastra_portfolio_states`，以 `(user_id, project_id, instance_id)` 为主键，用 `portfolio_json` 保留完整结构化投影，并记录 source path、checksum、revision 和 migration batch；原 YAML 仍作为 immutable asset version 保存，避免把用户可读来源变成不可追溯的 blob。

已新增只读 dry-run：

```bash
npm run mastra:portfolio-mapping-dry-run -- \
  --workspace-snapshot <snapshot> --workspace-id mg \
  --user-id mg --instance-id invest-agent-mg --out <outside-snapshot.json>
```

对真实 `mg` 快照的结果位于 `/tmp/mastra-mg-portfolio-mapping-20260813.json`：源 `config/portfolio.yaml` SHA-256 为 `ddb07e251f56180b5accba206850914331e9c43cf0e3648e645a37bb54df64bc`，计数为 holdings `10`、watchlist `6`、stock plans `3`、accounts `0`；`unmappedTopLevelFields=[]`、`duplicateCodes=[]`、`conflict=false`。映射会拒绝缺少 `name/code` 的记录以及同一域重复 code，避免生成含糊的业务主键。

灾备 SQLite `20260802T100039Z` 中 `mg` 相关的旧 `portfolio`、`watchlist`、`stock_plans` 三表均为 `0` 行，因此本域没有 YAML 与 SQLite 的同对象冲突，也没有触发用户裁决。该 SQLite 只读查询未被迁移脚本作为写入目标。

### 12.6 Portfolio 临时 target 导入与双读（2026-08-13）

`npm run mastra:portfolio-target-import` 将 dry-run 的完整 service projection 写入临时 `mastra_portfolio_states`，同时先复制并校验原始 YAML，再登记 `user_assets/user_asset_versions`。target SQLite 与 project root 必须位于完整 snapshot 根目录之外；source checksum 在写入前重新计算，源被篡改时以 `MASTRA_PORTFOLIO_SOURCE_CHANGED` 停止。已有同 scope state、资产登记或资产字节任一不一致时以 `MASTRA_PORTFOLIO_IMPORT_CONFLICT` 停止；完全相同的重复运行返回 `replayed`，不增加 state 或 asset version。

对同一个临时 `mg` target 执行两次的结果：

```text
action=inserted
action=replayed
scope=mg / invest-agent / invest-agent-mg
stateChecksum=512c85fb5f670b8ca81a2a648f83026fe2c9d60fefe2590e7906f475ee79a5e6
sourceChecksum=ddb07e251f56180b5accba206850914331e9c43cf0e3648e645a37bb54df64bc
counts=holdings:10, watchlist:6, stockPlans:3, accounts:0
```

双读验证通过：`mastra_portfolio_states.portfolio_json` 与 dry-run projection 完全一致；目标资产字节 hash 与 `user_asset_versions.checksum` 一致；资产 checksum 与源 YAML 一致。临时资产路径为 `assets/asset_portfolio_641ad098cf72175f7f5e02f9/versions/version_portfolio_ddb07e251f56180b5accba20/portfolio.yaml`，仅用于 `/tmp` 证据，不是生产资产 ID。

portfolio 聚焦验证均已通过：

```bash
node --import tsx --test \
  tests/mastra-portfolio-mapping-dry-run.test.ts \
  tests/mastra-portfolio-target-import.test.ts \
  tests/mastra-project-profile-schema.test.ts
npm run typecheck
npm run build
git diff --check
```

策略和 portfolio 两个域现在都完成 manifest → dry-run → target import → 幂等 → 双读；仍未连接真实用户、生产 SQLite、Portal 或服务端口。下一候选域是 `config/schedules.yaml` / `config/watch.yaml` / `config/notification.yaml`，先做字段 ownership 和调度暂停状态分析，再决定 service schema；不得在 dry-run 前恢复调度或推送。

### 12.7 调度、观察与通知配置 dry-run（2026-08-13）

四个配置文件的运行时 ownership 已确认：

| 源文件 | service-owned 内容 | 迁移期间处理 |
| --- | --- | --- |
| `config/schedules.yaml` | 时区、日/周/月复盘时间、财报触发边界、盘中窗口和运行 policy | 进入 runtime preferences projection；target 保持 scheduler disabled |
| `config/watch.yaml` | 观察边界、例外/非例外规则、动态阈值说明、去重和优先级 | 作为同一 preferences projection 的完整嵌套字段；不直接创建新的 alert rule |
| `config/notification.yaml` | 通知模式、P0/P1/P2 policy、工作时段、免打扰和周末偏好 | 作为 preferences projection；不在导入时发送消息 |
| `config/onboarding_state.yaml` | 用户确认步骤和完成时间 | 作为 onboarding provenance；不驱动 target 是否创建 Workspace |

已新增 `npm run mastra:runtime-preferences-mapping-dry-run`，只读加载四个 YAML，记录各自 checksum/字节数和合并后的 `sourceRevision`，并将 `schedulerActivation` 固定标为 `disabled_until_target_cold_start_and_explicit_enable`。对真实 `mg` 快照，四个文件齐全、`unmappedSourceFiles=[]`、`conflict=false`；源摘要如下：

```text
config/schedules.yaml        484bcbc8d1614a7dda88cd9285ac8b59c8759e233c1b6ccebc4296e797953005
config/watch.yaml            5f64ec16bb4f9dbbb25e4f58de434a5291031c5f963f351a73453a9cfab8fdd8
config/notification.yaml     401ace2d4c336c43539a106ba7cd166ca4d7cee21fe825b63d67e07ac9489a2d
config/onboarding_state.yaml 8457538ea05fb58603b678d5409545575d78a150a80bb5bc886a348f89be51d4
sourceRevision=2026-07-19T03:04:29.527Z
```

`mastra_runtime_preferences` 是加性的 service-owned 表，以 `(user_id, project_id, instance_id)` 为主键，保存完整 `preferences_json`、来源 checksum JSON、revision 和迁移批次。`npm run mastra:runtime-preferences-target-import` 在写入前重新校验四个源 checksum；任一源变化会以 `MASTRA_RUNTIME_PREFERENCES_SOURCE_CHANGED` 停止。同 scope 的 projection、任一来源资产登记或资产字节不一致会以 `MASTRA_RUNTIME_PREFERENCES_IMPORT_CONFLICT` 停止；四者完全相同的再次导入返回 `replayed`。

对同一个临时 `mg` target 执行两次结果为 `inserted`、`replayed`，并登记 1 条 preferences projection 和 4 个 immutable YAML assets。双读验证通过：projection 与 dry-run mapping 一致，4 个目标资产的字节 hash 与 `user_asset_versions.checksum` 一致且分别匹配源文件；target activation 仍为 `disabled_until_target_cold_start_and_explicit_enable`。所有输出和 target 都在 `/tmp`，调度、推送、生产 SQLite、真实 Workspace 均未被写入或启动。

本域聚焦验证均已通过：

```bash
node --import tsx --test \
  tests/mastra-runtime-preferences-mapping-dry-run.test.ts \
  tests/mastra-runtime-preferences-target-import.test.ts \
  tests/mastra-project-profile-schema.test.ts
npm run typecheck
npm run build
git diff --check
```

策略、portfolio 和 runtime preferences 三个域现在都完成 manifest/dry-run → 隔离 target import → 幂等 → 双读。下一候选域为 `plans/`、`memory/` 和历史 `reports/` 的 daily/review/method-change 数据；先按文件清单和现有 service 表逐类分析，不能把历史报告自动转换成 scheduler task，也不能在未确认 event schema 前写入生产表。

### 12.8 Daily / review / memory 域 dry-run 与隔离导入（2026-08-13）

该域按语义拆成四类，避免把文件名相近的数据误合并：

| 来源 | 目标记录类型 | 处理原则 |
| --- | --- | --- |
| `plans/daily/<date>.yaml` | `daily_plan` service state | 按 `plan_date` upsert；文件日期与内容 `plan_date` 必须一致 |
| `memory/behavior_events.jsonl`、`decisions.jsonl`、`change_log.jsonl`、`source_events.jsonl` | `service_event` | 按源文件、行号和内容 hash 保留为 immutable event，不 read-modify-write |
| `memory/method_changes.jsonl` | `method_change_service_migration` | 保留候选版本，后续由现有 method-change 语义按 candidate/version 读取 |
| `memory/review_viewpoints.jsonl` | `review_viewpoint_service_state` | 作为状态来源；本快照为空，不凭空创建 viewpoint |
| `memory/audit_events.jsonl`、`feedback.jsonl`、`task_runs.jsonl` | `archive_*_source` | 只保留来源证据，不成为新 runtime 的权限、调度或任务真相 |

已新增 `npm run mastra:review-memory-mapping-dry-run`。它验证 daily 文件日期、JSONL 语法、source line key 唯一性和所有已知文件分类；报告硬标记 `historyDoesNotCreateAutomationTasks=true`。真实 `mg` 快照结果：`dailyPlanCount=11`、`memoryFileCount=9`、`memoryLineCount=264`、`parseErrors=0`、`conflict=false`、`unclassified=0`。其中 184 行 behavior events、23 行 decisions、25 行 change log、25 行 source events、4 行 method changes，review viewpoints 为 0 行；所有 11 个 daily 文件均包含 `plan_date/generated_at/summary/content/data`。

`mastra_review_memory_records` 是临时 target ledger，记录 scope、record type、business key、payload、原始路径/行号/checksum 和 batch；同 scope 的任何 payload/source checksum 差异以 `MASTRA_REVIEW_MEMORY_IMPORT_CONFLICT` 停止。原始 daily/YAML 和 JSONL 文件另登记为 20 个 immutable assets。导入前重新校验每个源文件 checksum，源发生变化以 `MASTRA_REVIEW_MEMORY_SOURCE_CHANGED` 停止；重复执行只有在 275 条记录和 20 个资产全部一致时返回 `replayed`。

真实 `mg` target 双跑结果：

```text
action=inserted
action=replayed
recordCount=275 (daily=11 + JSONL=264)
assetCount=20
historyDoesNotCreateAutomationTasks=true
```

双读通过：target ledger 按类型计数为 `daily_plan=11`、`service_event=257`、`method_change_service_migration=4`、三个 archive 类型各 1；20 个 target asset 的字节 hash 均与登记 checksum 一致。所有 target 在 `/tmp`，没有修改快照源、生产数据库、真实 Workspace、scheduler、push 或 automation。

本域聚焦验证已通过：

```bash
node --import tsx --test \
  tests/mastra-review-memory-mapping-dry-run.test.ts \
  tests/mastra-project-profile-schema.test.ts
npm run typecheck
npm run build
git diff --check
```

至此 strategy、portfolio、runtime preferences、daily/review/memory 四个数据域均完成 source manifest/dry-run → 隔离 target 导入 → 幂等 → 双读。剩余的高价值用户内容主要是 `reports/`、`financials/`、`knowledge/`、`templates/`、`deliveries/`、`attachments/` 和 `assets/`，下一步按 asset ownership 做分类与字节校验；仍不把代码资产升级为可执行工具，也不恢复 scheduler/push。

### 12.9 用户项目资产 dry-run 与隔离登记（2026-08-13）

剩余项目文件不应为适配现有 Portal 上传格式而被强行扁平化或重新解释。当前 Portal 的 `user_assets` 合约不接受 Python、ZIP、任意 YAML 等全部 Workspace 格式；因此本阶段新增 `mastra_workspace_asset_records` 作为**通用迁移台账**，保存 source path、处置分类、保留级别、MIME、字节数、checksum、目标相对路径、scope 和 migration batch。它不把这些文件伪装成正式 Portal library 上传资产，也不改变未来 Portal 的格式契约。

已新增 `npm run mastra:asset-mapping-dry-run`。它只接收 manifest 中 disposition 为 `asset_version` 或 `project_file` 的普通文件，逐文件计算 checksum 和 MIME，并按用途标记为 `durable_library_candidate`、`reference_only`、`project_file_non_executable` 或 `project_file`；`discard`、`archive`、`service_migration` 和 `conflict` 由各自域处理，绝不复制进通用资产台账。符号链接只记录为不可复制的来源，不作为 target 文件。真实 `mg` 快照结果为：普通资产文件 `157` 个、另有 `discard/archive/service_migration/conflict` 文件由 manifest 归属处理、`unclassified=0`、`conflict=false`；其中 durable library candidate `35` 个、reference only `9` 个、project file non-executable `10` 个、project file `103` 个。所有用户代码、Skill、Python、ZIP 和其他可执行格式都维持为数据资产，`codeExecutionEnabled=false`。

`npm run mastra:asset-target-import` 只接受上述 dry-run report。写入前它重新计算每个源文件 checksum；任一源变化以 `MASTRA_ASSET_SOURCE_CHANGED` 停止。target SQLite 与 target project root 都必须完整位于 snapshot 根目录外，避免把验证输出写回备份源。文件只复制到 `assets/migrated/<source-path>`，权限固定为 `0600`，并以 `executable=0` 登记；同 scope 的来源 checksum、分类、保留级别、目标路径或目标字节任一不一致时以 `MASTRA_ASSET_IMPORT_CONFLICT` 停止，不做静默覆盖。

真实 `mg` 临时 target 双跑结果：

```text
action=inserted
action=replayed
recordCount=157
executableRows=0
codeExecutionEnabled=false
```

双读确认 `157` 条通用资产台账与 dry-run 的 source path/checksum/分类一一对应，所有 target 文件字节 hash 与台账 checksum 一致，且没有 target 文件带 executable bit。此前一次早期验证曾错误地把 discard/service migration 文件也复制进通用台账，已由筛选规则修正，不作为有效迁移结果。该验证不创建正式 Portal library 项、不恢复附件到期策略，也不改变附件 TTL；后续若要在 Portal 展示、预览或提升某个资产，必须按 Portal 的正式 asset contract、保留规则和用户确认另行处理。所有 output 和 target 均在 `/tmp`，未写入快照源、生产 SQLite、真实 Workspace、scheduler、push 或服务端口。

### 12.10 组合 target 冷启动验证（2026-08-13）

四个已完成的数据域已组合到同一个一次性 target，验证导入顺序、跨域共存和冷启动前置条件：

```text
/tmp/mastra-composed-target-fixed-mmIkw0
```

组合导入结果：strategy profile、strategy project/method asset、portfolio、runtime preferences、review/memory 和 generic assets 均为 `inserted`。target 内容摘要如下：

| 投影/台账 | 结果 |
| --- | ---: |
| strategy profile | 1 |
| portfolio | holdings 10、watchlist 6、stock plans 3、accounts 0 |
| review/memory records | 275 |
| 通用项目资产 | 157 |
| 可执行资产 | 0 |

只读 verifier：

```bash
node scripts/mastra-target-cold-start-verify.mjs \
  --target-db /tmp/mastra-composed-target-fixed-mmIkw0/target.db \
  --target-project-root /tmp/mastra-composed-target-fixed-mmIkw0/project \
  --user-id mg --instance-id invest-agent-mg
```

验证通过：所有必需投影存在；275 条历史记录和 157 条资产可见；所有 target 文件 checksum 匹配；所有 target 文件均无 executable bit；scheduler activation 保持 `disabled_until_target_cold_start_and_explicit_enable`。verifier 只读，不会修改 target 或源快照。

### 12.11 HTTP 离线冷启动与 Portal 契约复核（2026-08-13）

使用上述组合 target 在临时端口 `23657` 启动迁移分支，配置为 offline 模式，并关闭 scheduler、push、微信恢复和 Portal connector。未启动、重启或写入生产端口 `23655`。

结果：

```text
GET /health                         -> 200
GET /api/portal/health (no token)   -> 401
GET /api/portal/health (temp token) -> 200
```

健康检查返回的对话和文件能力可用，说明 target 可以完成 Mastra runtime 的 HTTP 冷启动。当前仍发现一个契约收敛项：正式 Portal 已支持 `asset.list/get/version.get/versions.list` 等 asset contract，但迁移分支 `/api/portal/health` 仍将 `workspace.file.list`、`workspace.file.get` 作为主要声明。后续必须把 asset capabilities 设为主能力，并将 workspace file 仅保留为明确的兼容能力，同时增加契约测试；这不影响本次离线冷启动结论。

### 12.12 当前实现边界与下一阶段顺序（2026-08-13）

本工作包已证明“备份快照 -> 隔离 target -> Mastra HTTP 冷启动”链路可行，但尚未完成运行时 ownership 收敛。当前默认 backend 仍为旧 Workspace backend，部分 service/MCP、daily plan、用户资产和 scheduler 代码仍直接读取 Workspace；旧 ACP/Codex/Hermes 命名和兼容路径也尚未清理。不得把本阶段 target 导入结果当作生产切换或最终平替验收。

下一阶段按以下顺序推进：

1. 将 Portal health/capability 声明切换为 asset contract 主能力，并补充 runtime/Portal 契约测试。
2. 实现 scope-bound、service-owned 的 portfolio/watchlist/stock-plan 只读 adapter，从 `mastra_portfolio_states` 提供现有 backend 接口所需数据；无投影时 fail-closed，不静默回退到 Workspace。
3. 为 daily/review/memory 增加 service-owned read adapter，并用组合 target 做 scope isolation、缺失投影和读写行为测试。
4. 在双读对照和回滚策略具备后，再将 Mastra/service backend 设为迁移分支默认 backend；旧 Workspace backend 仅保留迁移/回滚用途。
5. 最后进行 ACP/Codex/Hermes/旧 Workspace runtime 命名收敛扫描，完成独立本地候选启动和用户 Gate H1；在 Gate H1 前不部署、不接生产数据、不恢复真实 scheduler/push。

当前 Gate 状态：数据域导入与组合 target 冷启动为 `pass`；Portal asset capability 收敛、service-owned runtime read wiring、旧命名清理和最终候选启动仍为 `pending`。用户不需要逐文件验收，只有出现无法由来源 checksum、revision 或审计链裁决的业务冲突时才进入用户参与门。

### 12.13 Service-owned 只读读取接入（2026-08-13）

在不改变当前默认运行路径的前提下，迁移分支新增 `WORKSPACE_BACKEND=mastra` 选择值，接入组合 target 的 service-owned 读取投影：

| 读取接口 | Mastra 来源 | 写入行为 |
| --- | --- | --- |
| portfolio / watchlist / stock plans | `mastra_portfolio_states.portfolio_json` | 明确返回 `MASTRA_BACKEND_READ_ONLY` |
| daily plans | `mastra_review_memory_records` 中的 `record_type=daily_plan` | 明确返回 `MASTRA_BACKEND_READ_ONLY` |
| method changes | `record_type=method_change_service_migration`，按 candidate id 取最新版本 | 明确返回 `MASTRA_BACKEND_READ_ONLY` |
| review viewpoints | `record_type=review_viewpoint_service_state` | 明确返回 `MASTRA_BACKEND_READ_ONLY`；空投影返回空集 |

所有 adapter 都使用 `user_id + project_id + instance_id` 查询；缺失投影返回 `MASTRA_PROJECTION_NOT_FOUND` 或空状态，不会静默回退到 Workspace。旧 backend 仍保留用于当前兼容路径，只有显式设置 `WORKSPACE_BACKEND=mastra` 才启用这些读取 adapter；因此本轮没有改变 `23655` 或默认服务行为。

Portal 本地 health capability 也已调整：`asset.list/get/version.get/versions.list` 等正式 asset contract 现在排在主能力区，`workspace.file.list/get` 仅保留为旧 Portal 客户端的明确兼容能力。

新增回归覆盖：双 scope 读取隔离、无投影 fail-closed、daily 历史排序、方法候选读取、空观点投影以及所有 service-owned 写入拒绝。验证命令：

```bash
npm run typecheck
npm run build
node --import tsx --test \
  tests/mastra-service-owned-read-adapter.test.ts \
  tests/mastra-target-cold-start-verify.test.ts \
  tests/mastra-portfolio-target-import.test.ts \
  tests/mastra-review-memory-target-import.test.ts \
  tests/mastra-runtime-preferences-target-import.test.ts \
  tests/mastra-asset-target-import.test.ts
git diff --check
```

结果：`12/12` 通过。下一阶段仍需在双读和写事务契约具备后，才可把 Mastra backend 设为迁移分支默认值；在此之前不删除旧 Workspace backend，也不进行生产切换。

### 12.14 Service-owned 写事务接入（2026-08-13）

在组合 target 上继续完成了 Mastra backend 的第一批写事务，且仍只在显式 `WORKSPACE_BACKEND=mastra` 时启用：

| 写域 | 实际写入 | 幂等/冲突边界 |
| --- | --- | --- |
| portfolio / watchlist / stock plans | 同 scope 的 `mastra_portfolio_states.portfolio_json`，单 SQLite transaction | 缺失 projection fail-closed；不写 legacy 行表或 Workspace |
| trade action | `mastra_review_memory_records` 的 `service_event` ledger | scope + event key 绑定，保留审计事件 |
| daily plan | `mastra_review_memory_records` 的 `daily_plan` 记录 | `(scope, plan_date)` 原地 upsert，避免重复记录 |
| method change | `method_change_service_migration` ledger | propose 新候选；decide 更新同候选 ledger，不触发唯一键重复 |
| review viewpoint | `review_viewpoint_service_state` ledger | 按 source date 替换，resolve 在原 scope 记录上更新 |

写路径保持服务层 scope，不接受 Workspace 路径或客户端 scope 覆盖；旧 Workspace backend 仍可通过原配置使用，生产默认和 `23655` 均未切换。

本轮验证新增写后读取、跨 scope 缺失投影、ledger 唯一键更新和 Portal capability 回归。已通过：

```bash
npm run typecheck
npm run build
node --import tsx --test tests/mastra-service-owned-read-adapter.test.ts
```

下一步是用完整组合 target 做双读对照：同一 scope 的 service projection 与旧快照读取结果逐字段比较，并为写事务增加 revision/optimistic-concurrency 检查；完成后才评估把迁移分支默认 backend 切换为 `mastra`。

### 12.15 组合 target 逐字段双读与 revision 保护（2026-08-13）

新增 `npm run mastra:dual-read-verify`，只读比较备份 Workspace 快照与 service-owned target，不写源快照或 target。对真实 `mg` 快照和组合 target 执行：

```bash
npm run mastra:dual-read-verify -- \
  --workspace-snapshot /Users/combo/MyFile/my-data/backups/invest-agent/workspaces/snapshots/2026-08-10T235031+0800 \
  --workspace-id mg \
  --target-db /tmp/mastra-composed-target-fixed-mmIkw0/target.db \
  --user-id mg --instance-id invest-agent-mg
```

结果：

```text
ok=true
portfolio.match=true
portfolio.sourceCount=19
portfolio.targetCount=19
dailyPlans.match=true
dailyPlans.sourceCount=11
dailyPlans.targetCount=11
sourceWriteAttempted=false
targetWriteAttempted=false
```

portfolio canonical projection 的 source/target SHA-256 均为 `9922284155d81e78690828c89eb8d3b6807bba17a1605d211a89c9419adf3862`。这证明组合 target 的 portfolio、watchlist、stock plans 和 daily plans 与备份源逐字段一致；它不等价于所有历史 memory/event 的业务语义已经完成转换。

service-owned portfolio 写入现在支持可选 `expectedRevision`：revision 不匹配时返回 `MASTRA_REVISION_CONFLICT`，匹配时在同一 SQLite transaction 内更新投影；watchlist/plan 删除和修改也共享该边界。回归已覆盖 stale revision 拒绝与正确 revision 成功写入。

本轮验证通过：`npm run typecheck`、`npm run build`、双读命令、8 个迁移/adapter 聚焦测试和 `git diff --check`。当前仍不能切换默认 backend：method/review/daily 的写事务虽已可用，仍需将所有 runtime/MCP 调用路径逐一核对其 revision 传递和错误映射，再进行迁移分支默认切换与独立候选启动。

### 12.16 全量回归与 MCP 主路径收敛记录（2026-08-13）

本轮对迁移分支执行完整测试套件，结果为 `438/438` 通过（`0` fail、`0` cancelled、`0` skipped）。验证覆盖 Mastra runtime、Workspace scope/containment、Portal asset capability、组合 target 导入与重放、service-owned 读取/写入、portfolio 双读、daily plan、review/memory、revision 冲突保护以及现有兼容路径回归。

同时完成 MCP 主路径的第一轮收敛：

- `portfolio.read` 在 Mastra backend 下只读取 service-owned projection，不再从 Workspace 回退；缺失 projection 明确失败。
- `portfolio.apply_changes` 在 Mastra backend 下通过 projection transaction 写入，不再发布旧 `config/portfolio.yaml` Workspace artifact。
- `watchlist.add`、`plans.set` 及组合相关修改路径传递当前 Mastra revision；过期 revision 统一返回 `MASTRA_REVISION_CONFLICT`，匹配 revision 才允许写入。
- 所有 service-owned 读写继续以 `userId + projectId + instanceId` 作为 scope，客户端不能覆盖 scope。

本轮没有切换迁移分支默认 `WORKSPACE_BACKEND`，没有修改生产数据库、真实 Workspace、微信状态或 `23655`。剩余切换前置工作是：逐一审查 runtime、sandbox HTTP 和 scheduler 的直接 Workspace 读取/写入路径，补齐稳定 API/MCP 错误映射；完成后才可在独立端口启动候选服务并执行最终用户 Gate H1。

当前 Gate 状态：

| Gate | 状态 |
| --- | --- |
| 备份快照到隔离 target 的导入、重放、双读 | pass |
| Mastra runtime HTTP 冷启动与 Portal asset capability | pass |
| service-owned 组合读写与 revision 保护 | pass |
| 全量回归（440 tests） | pass |
| runtime preferences service-owned 读写与 scope 隔离 | pass |
| Mastra strategy profile 读取、sandbox 写入与 method-change apply | pass |
| Mastra review 保存、periodic review 与决策/来源事件 ledger | pass |
| 迁移分支默认 backend 切换 | pending |
| sandbox onboarding 读取/写入路径收敛 | pass |
| reviews 等直接 Workspace 路径审查、错误映射、独立候选启动 | pending |

### 12.17 Runtime preferences 主路径接入（2026-08-13）

继续审查默认 backend 切换前的直接 Workspace 路径后，已将用户偏好配置的计划/写入接口抽象为 `UserPreferenceStore`。Mastra 模式现在使用 `mastra_runtime_preferences` 的 scope-bound projection，读取和写入均限定 `userId + projectId + instanceId`，不会创建或读取 Workspace 文件；Workspace 模式保持原有 YAML 行为。市场简报的推送模式读取也在 Mastra 模式下改为从该 projection 读取。

新增回归覆盖：Mastra 偏好写后读取、跨 instance 隔离、无 Workspace 访问，以及既有 runtime-preferences target import 回归。验证通过：

```bash
npm run typecheck
node --import tsx --test \
  tests/mastra-runtime-preferences-backend.test.ts \
  tests/mastra-runtime-preferences-target-import.test.ts \
  tests/mastra-service-owned-read-adapter.test.ts
git diff --check
```

仍未切换默认 backend。当前直接 Workspace 路径主要剩余 onboarding 确认/状态、`reviews.save` 的历史决策/事件追加，以及 sandbox HTTP 中的其它兼容配置读取；这些路径需要分别确认其 service-owned 权威模型和错误映射后再改造，不能用偏好 projection 代替。生产数据、真实 Workspace、微信状态和 `23655` 均未触碰。

### 12.18 Strategy profile service-owned 主路径接入（2026-08-13）

基于已有 `mastra_project_profiles` 投影，迁移分支现在在 Mastra backend 下：

- sandbox `profiles.investment` 读请求按 `userId + projectId + instanceId` 读取 strategy profile projection；不存在投影返回空状态，非法 JSON 返回 `MASTRA_PROJECTION_INVALID`。
- sandbox `profiles.investment.set` 在 Mastra 模式下只更新同 scope 的 profile projection，不创建或修改 `config/strategy.yaml`。
- MCP `method_changes.propose` 返回 Mastra profile revision；`method_changes.apply` 在 Mastra 模式下将经过确认的 patch 写回 profile projection，并更新 service-owned method-change ledger。
- Mastra 模式不自动发布旧 Workspace strategy artifact；Workspace 模式的原有发布行为保持不变。

本轮验证通过：`npm run typecheck`、method-change 与 strategy profile 聚焦测试、`git diff --check`。为避免默认切换后产生半迁移写入，Mastra 模式下尚未完成 service-owned 多域事务的 onboarding 写入口现在明确返回 `MASTRA_ONBOARDING_WRITE_NOT_READY`，不会回退写入 Workspace。onboarding 状态已经纳入 runtime preferences projection 的读写模型；完整的 portfolio/strategy/preferences/watch 原子提交仍需下一阶段实现。`reviews.save` 的决策事件追加和 sandbox 的其它 Workspace 兼容配置读取也需要继续审查。

### 12.19 Review service-owned 主路径接入（2026-08-13）

Mastra backend 下的 `reviews.save` 已完成以下收敛：daily review 继续写入 service-owned `dailyPlanBackend`，但不再镜像到 Workspace；weekly/monthly review 由 `periodicReviewBackend` 写入 `mastra_review_memory_records` 的 `periodic_review` 记录；`decisionRecords` 和 `sourceEvents` 写入相同 scope 的 `service_event` ledger，不再追加 `memory/decisions.jsonl` 或 `memory/source_events.jsonl`。报告内容仍由服务侧 review storage 管理，用户项目的报告文件只在显式 asset/project 发布路径中产生，不作为隐式副作用。

新增验证覆盖 Mastra periodic review 写后读取、跨 instance 隔离和 ledger 记录；既有日/周/月复盘契约、snapshot memory 导入和受控保存回归也已通过。验证命令包括 `npm run typecheck`、相关聚焦测试和 `git diff --check`。onboarding 的多域原子提交及其 sandbox 入口仍为下一阶段，默认 backend 仍未切换。

### 12.20 Onboarding draft 多域原子提交（2026-08-13）

完成 onboarding draft 的 Mastra service-owned 提交路径：冻结草稿经过统一校验后，portfolio、strategy profile、runtime preferences（含 schedules、notification、watch、onboarding state）在同一个 SQLite transaction 中更新；scheduler activation 继续保持 `disabled_until_target_cold_start_and_explicit_enable`。草稿规则会在配置写入前全部执行现有 `validateWatchRule` 校验，已校验规则通过事务级插入 helper 写入 `alert_rules`，并以 draft commit key 保持幂等。

Mastra draft worker 不创建 Workspace，也不调用旧 `WorkspaceStore`；Workspace backend 的原有 draft commit 行为保持不变。非法 projection 或缺失 imported projection 会 fail-closed，不会静默创建默认数据。新增回归覆盖三类 projection 的写后读取、onboarding completed 状态、规则写入和无 Workspace 依赖；全量回归现为 `440/440` 通过。

当前仍未切换默认 backend。下一阶段需要补齐 sandbox onboarding 读取/写入 API 的 Mastra 路由（旧逐步确认入口应继续 fail-closed 或调用同一 draft transaction），并完成独立候选服务启动前的直接 Workspace 路径扫描与错误映射。

### 12.21 Sandbox onboarding 路径收敛（2026-08-13）

`/api/sandbox/onboarding/state` 在 Mastra backend 下改为读取 `mastra_runtime_preferences` 中的 scope-bound `onboardingState`，不再从 Workspace 读取。旧的逐步写入接口 `confirm-portfolio` 和 `confirm-step` 在 Mastra 模式下明确返回 `MASTRA_ONBOARDING_WRITE_NOT_READY`，避免绕过已完成的 draft 多域原子提交；Workspace 模式行为保持不变。正式 Mastra onboarding 写入应通过冻结 draft -> service-owned transaction 流程完成。

本轮类型检查和 onboarding/runtime preferences 聚焦测试通过；完整回归仍需在本轮路由变更后重新执行。生产数据、真实 Workspace、微信状态和 `23655` 未触碰。

### 12.22 最终编译、回归与 Workspace 路径复核（2026-08-13）

本轮修复了 `MastraUserPreferenceStore.write()` 对 `WatchYaml` 的类型声明，随后完成迁移分支的验证：

```text
npm run typecheck                                      -> pass
聚焦 onboarding/preferences/periodic-review 测试       -> 3/3 pass
npm test                                               -> 440/440 pass
git diff --check                                       -> pass
```

全量回归使用 `data/test.db`、`data/test-workspaces` 和 `data/test-runtime`，未使用生产数据库或真实 Workspace。测试结束后没有启动、重启或修改 `23655`。

最终直接 Workspace 路径扫描的结论如下：

| 路径类别 | 当前结论 |
| --- | --- |
| portfolio、watchlist、stock plans、daily plans、method changes、review viewpoints、periodic reviews、runtime preferences、onboarding state | Mastra 模式已走 scope-bound service projection/ledger；缺失或非法投影 fail-closed，不回退 Workspace |
| MCP `portfolio.read/apply_changes`、watchlist/plans revision 传递、reviews.save | Mastra 主路径已收敛；旧 Workspace 分支仅在显式 Workspace backend 下保留 |
| sandbox onboarding 旧逐步写入接口 | Mastra 模式稳定返回 `MASTRA_ONBOARDING_WRITE_NOT_READY`，避免绕过多域事务 |
| 用户报告、资产、附件、Portal 文件浏览、对话归档、automation staging | 仍属于合法的用户项目文件/资产生命周期，不能误删；需要后续统一核对 Mastra scope 与 asset contract |
| scheduler 的兼容读取、旧 Workspace Store、旧 automation/对话兼容路径 | 仍存在显式兼容调用；不能在本轮默认切换前删除或隐藏 |

因此当前判断是：迁移分支已经具备隔离 target 冷启动、service-owned 核心事实读写和完整回归证据，但还没有达到“所有运行时路径均以 Mastra 为默认、旧兼容路径仅作回滚”的切换条件。当前不切换 `WORKSPACE_BACKEND` 默认值，不部署候选端口，也不恢复真实 scheduler/push。

下一阶段按以下顺序执行：

1. 为用户资产、Portal 文件、对话归档和 automation staging 补齐统一的 scope/asset contract 复核，确认它们只读写受控项目文件，不把 Workspace 文件重新当作业务事实源。
2. 对 scheduler、runtime、sandbox、MCP 及 automation 的剩余兼容调用做逐项清单，给每条路径标注 `service_fact`、`project_asset` 或 `migration_compatibility`，并补齐稳定错误映射。
3. 在清单无未解释的 service-fact Workspace 读取、且 Mastra 写事务具备回滚策略后，才将迁移分支默认 backend 切换为 `mastra`；切换必须只在隔离数据库和独立端口进行。
4. 默认切换后的独立候选服务启动、HTTP/Portal/微信模拟验证和用户 Gate H1 仍是最后一步；Gate H1 前不接生产数据、不改 `23655`、不恢复真实推送。

当前 Gate 状态：

| Gate | 状态 |
| --- | --- |
| 备份快照 -> 隔离 target 导入、重放、双读 | pass |
| Mastra Workspace scope/containment 与 HTTP 冷启动 | pass |
| service-owned 核心事实读写、revision 与 onboarding 事务 | pass |
| runtime preferences、periodic review、MCP 主路径 | pass |
| 全量回归（440 tests） | pass |
| 用户资产/对话/automation 文件路径最终归类 | pending |
| 默认 `WORKSPACE_BACKEND=mastra` 切换 | pending |
| 独立候选启动与用户 Gate H1 | pending |

### 12.23 项目文件、资产与 automation staging 的 scope 收敛（2026-08-13）

继续处理 12.22 的第一项 pending Gate，完成了四个运行时边界修正：

- Portal 旧 `workspace.file.list/get` 兼容接口现在接受完整 `userId + projectId + instanceId`。`WORKSPACE_BACKEND=mastra` 时只读取 `MastraWorkspaceRegistry` 已注册的项目根；缺少 scope、未知实例或未注册项目返回稳定的 `WORKSPACE_FILE_SCOPE_UNAVAILABLE`，不再回退到旧 per-user Workspace。Workspace backend 的兼容行为保持不变。
- `user_assets` 的物理存储根在 Mastra 模式下改为 registry 项目根，与数据库三元 scope 一致。上传、版本读取和 staging commit 在未注册项目时以 `MASTRA_PROJECT_SCOPE_UNAVAILABLE` fail-closed。
- Mastra 用户/会话初始化改为 registry bootstrap，创建最小 `.agent-project` 项目骨架，不再因初始化副作用创建 legacy Workspace。返回给 runtime 的 `workspacePath` 也来自注册项目根。
- generic automation 和 legacy automation 的临时 staging 在 Mastra 模式下从注册项目根创建；只复制任务绑定文件，执行结束清理 staging，未启用持久项目代码执行。

新增测试：

```bash
node --import tsx --test \
  tests/mastra-workspace-file-compat.test.ts \
  tests/mastra-user-assets-project-root.test.ts \
  tests/mastra-scoped-workspace.test.ts
```

验证结果：类型检查通过，新增/相关聚焦测试通过；本轮全量回归为 `442/442`（`0` fail、`0` cancelled、`0` skipped），`git diff --check` 通过。测试只使用临时 DB、临时 Workspace 和 `/tmp` 项目根，没有触碰生产数据或 `23655`。

本轮仍未完成的直接路径包括：

| 路径 | 处理状态 |
| --- | --- |
| `conversation-artifacts` 的 legacy report/path 发布与读取 | 仍是显式项目文件兼容路径；需要按完整 scope 接入 registry，或在 Mastra 默认模式改为只允许 `user_assets` 版本读取 |
| `file-retention`、`artifact-deletion`、`workspace-report-assets` | 仍按旧 Workspace 根执行物理清理/报告预览，需完成同一 registry resolver 后才能默认切换 |
| `conversation-log` 的普通对话附件与历史记录路径 | service-owned conversation rows 已有 scope，但附件落盘和 legacy workspacePath 字段仍需拆分为 project asset / transient staging |
| `automation-tasks` 创建和迁移兼容路径 | 仍保留旧 task asset 文件结构和 Workspace 兼容 helper；Mastra 创建路径需改为 user asset 或明确的项目 staging contract |

因此默认 `WORKSPACE_BACKEND=mastra` 仍保持 pending。下一步优先完成 artifact/retention/deletion 的 registry resolver 和 scope 错误映射，再审查 conversation attachments；这些是实现层工作，不需要用户裁决。只有遇到无法由 scope、checksum、revision 或审计链决定的业务冲突，才进入用户参与门。

### 12.24 Artifact、报告预览与删除清理的项目根收敛（2026-08-13）

本轮新增 `src/services/project-storage-root.ts` 作为文件型服务的统一根解析器：

- Mastra 模式必须提供完整 `userId + projectId + instanceId`，并命中 `MastraWorkspaceRegistry` 已注册项目根；缺少或未知 scope 分别返回 `PROJECT_STORAGE_SCOPE_REQUIRED` / `PROJECT_STORAGE_SCOPE_UNAVAILABLE`。
- Workspace 模式仍使用旧 `resolveWorkspacePath`，保证迁移期间兼容测试和回滚路径不变。
- conversation artifact 发布、读取和 curated library 列表现在使用该 resolver；Portal 的 report asset 与 report mapping 读取也传递完整 scope。
- artifact deletion 的 trash move、purge 使用 artifact 自身的 `project_id` 加调用者 instance scope 解析项目根，避免清理任务按 userId 误删另一实例的文件。

验证：

```bash
npm run typecheck
node --import tsx --test \
  tests/conversation-artifacts.test.ts \
  tests/file-retention.test.ts \
  tests/workspace-report-assets.test.ts \
  tests/user-assets-portal-contract.test.ts
```

结果为相关测试 `73/73` 通过，`git diff --check` 通过。此前新增的 Mastra scope/asset/staging 测试仍通过；生产数据库、真实 Workspace、微信状态和 `23655` 未触碰。

剩余待收敛路径：

| 路径 | 当前状态 |
| --- | --- |
| conversation attachments 的临时落盘、TTL 清理和历史 `workspacePath` 字段 | 仍需拆分为 transient staging 与受控 project asset；当前保留兼容行为，未作为 Mastra 默认切换证据 |
| `automation-tasks` legacy source/working 文件创建、迁移 helper | 仍有旧结构兼容调用；generic runner 的执行 staging 已改为 registry 项目根，但 task 创建/回放尚未完全迁移到 `user_assets` |
| `file-retention-backfill`、旧 Workspace report backfill | 仅迁移/回填工具，不能作为 Mastra 运行时事实源；默认切换前需标记为 migration-only 并补 fail-closed 测试 |

当前默认 backend 仍不可切换。下一步先处理 conversation attachment 的 storage scope 和 automation task 创建/回放边界；完成后重新运行全量 `npm test`，再决定是否具备独立候选端口启动条件。

### 12.25 Conversation attachment scope 与 TTL 清理收敛（2026-08-13）

附件是 transient upload，不属于持久项目资产，但它仍必须绑定到正确的项目根。依据 `db-migration` 规范，本轮做了加性、可回滚的 schema 与路径收敛：

- `conversation_attachments` 新增 `project_id TEXT NOT NULL DEFAULT 'invest-agent'`；旧数据库通过 `ensureColumn` 自动补列，现有行保持可读，初始化重复执行安全。
- `registerAttachment`、`findAttachmentRecord`、`readAttachmentBytes` 和 TTL cleanup 查询/删除都保留完整 `userId + projectId + instanceId`。
- Mastra 模式的附件读写和清理使用统一 `resolveProjectStorageRoot`，只访问 registry 已注册的项目根；Workspace 模式保留旧兼容路径。
- 普通 Portal 对话把附件写到该项目根，并将相同 project scope 写入服务表；Mastra runtime 的 `workspacePath` 只返回项目根或受控 automation staging，不再回退旧 per-user Workspace。

验证已通过：

```bash
npm run typecheck
node --import tsx --test \
  tests/file-retention.test.ts \
  tests/portal-conversation-log.test.ts \
  tests/conversation-log.test.ts
git diff --check
```

本轮没有执行生产迁移；仅验证本地临时数据库的 fresh/upgrade/idempotency 行为。仍待处理的是 `automation_tasks` legacy source/working 文件创建与迁移 helper，以及最后一次全量回归；在这些完成前不切换默认 backend、不启动候选服务。

### 12.26 Automation task 文件根与全量回归（2026-08-13）

最后一批 legacy 文件访问也已完成 scope 收敛：`automation-tasks.ts` 的 `workspacePathForScope()` 在 Mastra 模式下只返回 registry 已注册的项目根；未注册 scope 统一返回 `AUTOMATION_INVALID_SCOPE`。因此 task source/working 文件的创建、读取、替换、checksum 校验和删除不会再按 userId 猜测旧 Workspace。generic/legacy runner 的 transient staging 也已在前一轮改为同一项目根。

相关 automation 测试通过 `34/34`。随后执行完整回归：

```text
npm run typecheck -> pass
npm test         -> 442/442 pass
git diff --check -> pass
```

全量回归只使用测试数据库、测试 Workspace 和临时项目根，未启动或修改生产端口 `23655`，未读取或写入生产 SQLite、真实 Workspace 或微信状态。

当前实现已满足“项目文件/资产/临时 staging 不跨 scope、不把旧 per-user Workspace 当 Mastra 默认根”的代码级条件。但这还不是默认切换完成的证据：

1. 迁移分支的 `WORKSPACE_BACKEND` 默认值仍是 `workspace`，这是有意保留的回滚安全阀。
2. 必须在隔离数据库和独立端口上显式设置 `WORKSPACE_BACKEND=mastra`，导入组合 target 并做一次真实 HTTP/Portal cold start，确认注册项目、user assets、attachments、artifact library、automation 和 onboarding 在同一进程内都能工作。
3. 该候选启动通过后，再做旧 Workspace/ACP/Codex/Hermes 兼容命名的最终清理扫描；这些残留目前仍是迁移/回滚边界，不能在证据不足时删除。

下一 Gate 已明确为“Mastra backend 显式隔离启动与端到端契约验证”，不需要用户提供数据或参与业务裁决；仍不部署、不恢复真实 scheduler/push、不触碰 `23655`。

### 12.27 Mastra backend 独立候选端口冷启动（2026-08-13）

在构建通过后，使用一次性 `/tmp` 状态根显式启动迁移分支：

```text
WORKSPACE_BACKEND=mastra
INVEST_AGENT_OFFLINE_MODE=true
PORT=23657
DB_PATH=/tmp/.../target.db
MASTRA_PROJECTS_ROOT=/tmp/.../projects
```

同时关闭 Portal connector、微信恢复、scheduler 和 push worker。实际 HTTP 结果：

```text
GET /health                                  -> 200
GET /api/portal/health (无 token)             -> 401
GET /api/portal/health (临时 service token)   -> 200
GET /api/portal/workspace/files (未注册 scope) -> 409 WORKSPACE_FILE_SCOPE_UNAVAILABLE
```

Portal health 返回 asset contract 为主能力，workspace file 仅作为兼容能力。服务正常启动后已停止并清理全部临时状态；没有启动、重启或写入 `23655`，没有使用生产 SQLite、真实 Workspace 或微信状态。

这证明 Mastra backend 已具备独立 HTTP 冷启动和基本 Portal 授权/错误契约，但还不等价于最终平替验收：组合备份 target 尚未注入本次服务，且用户交互、真实资产读写和 scheduler/push 仍保持关闭。下一步是把隔离组合 target 接入 `23657`，做一次只读的 Portal/asset/conversation smoke；通过后再进行旧 ACP/Codex/Hermes 命名清理和最终候选 Gate H1。

### 12.28 重启恢复与 runtime project scope 修正（2026-08-13）

准备把组合 target 接入候选服务时发现两个不能忽略的问题，均已修复后再继续：

1. `MastraWorkspaceRegistry` 原本仅在进程内保存注册项，服务重启会丢失已有项目根。现在 registry 会且只会从 `MASTRA_PROJECTS_ROOT/<scope-digest>/.agent-project/manifest.json` 恢复；manifest 的 schema、userId、projectId、instanceId 和 digest 必须全部匹配。它不扫描用户目录、不按 userId 猜路径，非法或篡改 manifest fail-closed。
2. `AiProjectRuntimeContext.projectId` 曾错误返回 `ai_instances.id`，而已导入的 Mastra projection 使用业务 project id `invest-agent`。这会使运行时 scope 与 target 投影不匹配。现在 `projectId` 固定返回 `ai_instances.project_id`，`instanceId` 保持实例 id；Mastra 初始化同步 bootstrap 同一完整 scope，且不再调用 legacy `ensureWorkspace`。

对应验证：scope/restart/adapter/instance-delete 聚焦测试 `13/13` 通过；随后 `npm test` 为 `443/443` 通过（`0` fail、`0` cancelled、`0` skipped），`npm run typecheck` 和 `git diff --check` 均通过。

这个修正是组合 target 候选服务 smoke 的前置条件。下一步仍是将**临时**组合 target 以正确 project registry scope 接入独立端口，确认投影可见；尚未改变默认 backend 或生产状态。

### 12.29 组合 target 的只读 Portal 文件 smoke（2026-08-13）

在 12.28 的 restart hydration 与 runtime scope 修正后，已将组合备份 target 的**副本**接入独立候选服务进行只读 smoke。源 target 为 `/tmp/mastra-composed-target-fixed-mmIkw0`；启动前复制到新的临时目录，验证过程不修改源 target、生产 SQLite、真实 Workspace、微信状态或 `23655`。

候选服务仍使用显式 Mastra backend、离线模式和 `23657`，并关闭 Portal connector、微信恢复、scheduler 与 push worker。服务重启后由受校验 manifest 恢复项目 registry；以完整 scope `mg / invest-agent / invest-agent-mg` 请求 Portal workspace-file compatibility 接口，得到：

```text
文件列表                       -> 120 项
methods/strategy-rules.md      -> 可读取
文件大小                       -> 6467 bytes
checksum                       -> 64 个十六进制字符
```

这验证了组合 target 的注册项目根可以跨进程恢复，Portal 文件兼容读取只命中该 scope 的项目根，并未回退到按用户推断的 legacy Workspace。验证完成后候选服务已停止，临时 target 副本与项目根均已清理。

本 Gate 的结论是 **pass（只读 project-file / registry restore smoke）**。它不覆盖用户资产写入、附件上传、artifact 发布、automation 执行、真实微信交互或 scheduler/push；更不代表默认 `WORKSPACE_BACKEND` 已切换、真实数据已经迁移或可以部署。下一步进入剩余旧 runtime/Workspace 路径的分类与收敛，只有不存在未解释的 `service_fact` Workspace 依赖后，才可在新的隔离 target 和端口上评估默认 backend 切换。

### 12.30 Mastra 运行时入口与调度路径收敛（2026-08-13）

本轮针对静态扫描发现的运行时残留，完成了不改变生产状态的边界修正：

- `/api/chat` 在 Mastra 模式下忽略请求体中的 `workspacePath`，先通过 `ensureDefaultProjectForUser()` 获取服务侧 `userId + projectId + instanceId`，由 registry bootstrap/恢复项目根；旧 Workspace backend 才保留 legacy `ensureWorkspace` 分支。
- Platform 的 Workspace ensure/reset 管理入口在 Mastra 模式下只 bootstrap 已认证 scope 的 registry 项目，返回中性注册状态；不会创建旧 per-user Workspace。
- 实例创建失败回滚和实例删除在 Mastra 模式下只删除 registry 能从完整 manifest 解析、且已通过 containment 校验的项目根；解析失败时 fail-closed，不猜测或删除其他路径。Workspace backend 的旧目录清理保持不变。
- review scheduler 在 Mastra 模式下从 `MastraUserPreferenceStore` 读取 schedules，预生成交接文件写入 `.agent-project/staging/scheduled-reviews/`；不再读取 `config/schedules.yaml` 或写入旧 `.state`。
- market-watch scheduler、alert policy 在 Mastra 模式下从 service-owned preferences 读取 watch 配置；风险优先级使用服务内固定策略，不初始化或读取旧 Workspace `risk_taxonomy.yaml`。
- Mastra 模式强制关闭 `SCHEDULED_REVIEW_LEGACY_ORCH` 的旧文件编排，即使环境变量显式设置为 `true` 也不会绕过 service publication contract；旧 backend 仍可显式使用兼容路径。

验证：

```text
npm run typecheck -> pass
npm test -> 443/443 pass
git diff --check -> pass
```

测试使用临时数据库、项目根和状态目录，未触碰生产 SQLite、真实 Workspace、微信状态或 `23655`。本 Gate 只证明 Mastra 模式下这些入口不会重新引入旧 Workspace 事实源；仍未完成默认 backend 切换，也未恢复真实 scheduler/push。下一步继续对 conversation、automation、Platform 资产统计等剩余路径做 Mastra/legacy 分类，并在全量回归后重新评估候选切换 Gate。

### 12.31 Automation follow-up 与 Platform 管理面残留分类（2026-08-13）

12.30 后的全量路径复核又处理了两个会在候选服务中实际触发的旧目录副作用：

- `createAutomationTask()` 在 Mastra 模式下改为 bootstrap 完整 registry scope，才创建 task source/working assets；不再无条件 `ensureWorkspace`。Workspace backend 的初始化路径保持原样。
- automation task 的 Portal follow-up conversation 在 Mastra 模式下通过 `resolveProjectStorageRoot()` 创建短期 staging；不会因互动回合重新创建 legacy Workspace。staging 仍只包含该 task 绑定的 source/working 文件。

同时复核了 Platform 管理面：实例摘要不再向 Portal/Platform payload 暴露 Mastra 项目根绝对路径；Mastra investment-state 不再把 legacy `workspaceExists()` 当作数据就绪前提。仍保留的 `portfolioConfigured`、`strategyConfigured`、notification/onboarding 指示灯目前依赖旧 YAML 文件契约，不能把“投影为空”擅自等价为“用户未配置”。因此它们被归类为 **管理面展示契约 pending**，不是 Mastra service-fact 读写依赖，也不能作为默认切换验收证据。

本轮聚焦验证：

```text
npm run typecheck -> pass
automation/conversation/registry/Portal 聚焦测试 -> 41/41 pass
git diff --check -> pass
```

没有启动生产服务或真实推送，没有修改生产数据。下一步应继续清理仍未分类的执行路径与旧 ACP/Codex/Hermes 命名；Platform onboarding 指示灯需要单独以 service projection 定义语义，不能在没有产品规则时猜测迁移结果。

### 12.32 未接线用户指标执行入口 fail-closed（2026-08-13）

对所有 `ensureWorkspace()` 调用点做分类后确认：portfolio、plan、review viewpoint、method change 的调用都属于显式 Workspace backend 实现；Mastra backend 已有独立 service projection。L3A（YAML 复合指标）和 L3B（用户脚本指标）则是没有当前调用点、但会在未来 scheduler 接入时产生危险副作用的遗留入口：前者会初始化旧 Workspace 并读取 `composite_indicators.yaml`，后者会读取并执行持久 Workspace 下的用户脚本。

Mastra 模式现在对二者均 fail-closed：

- L3A 返回空配置，不读取或创建 legacy Workspace；未来需要先定义受 scope 约束的 published asset / service rule contract。
- L3B 返回空 registry，不读取或执行持久用户脚本；未来只能从已发布资产复制到非 LocalSandbox 的隔离 staging 后执行。

Workspace backend 的显式兼容实现未改变。验证结果：

```text
npm run typecheck -> pass
npm test -> 443/443 pass
git diff --check -> pass
```

至此，扫描出的 Mastra 主运行路径中没有仍会自动创建 legacy Workspace 的未分类 service-fact 调用。仍不能把这等同于默认 backend 切换完成：Platform 管理面 onboarding 指示灯尚未有 service projection 语义，真实 scheduler/push 仍关闭，且旧 ACP/Codex/Hermes 仅完成运行路径隔离、未完成迁移分支的最终删除/命名收敛。下一 Gate 是对候选启动所加载模块做 import/runtime 验证，并形成遗留命名的删除、替换或保留分类清单。

### 12.33 独立候选服务模块加载与 HTTP smoke（2026-08-13）

完成候选启动前的静态 import 复核：`server.ts`、runtime、Portal、Platform、scheduler、service 和 Mastra 主路径没有直接 import ACP/Codex/Hermes 模块。遗留命名仅出现在显式兼容 backend、迁移/回滚工具、审计字段或历史注释中；不能据此删除整个兼容模块。

同时修正 `scripts/run-mastra-local.sh` 的实验默认值：端口改为独立的 `23656`（可通过 `MAS_TRA_PORT` 覆盖），并显式设置 `WORKSPACE_BACKEND=mastra`。脚本仍只读取此前已授权的本地 OpenAI-compatible gateway 配置，不把 gateway 配置视作 ACP runtime。

构建后用临时状态根启动候选服务：

```text
WORKSPACE_BACKEND=mastra
INVEST_AGENT_OFFLINE_MODE=true
PORT=23657
DB_PATH=/tmp/.../target.db
MASTRA_PROJECTS_ROOT=/tmp/.../projects
```

HTTP smoke 结果：

```text
GET /health                                      -> 200
GET /api/portal/health (无 token)                 -> 401
GET /api/portal/health (临时 service token)       -> 200
GET /api/portal/workspace/files (未注册 scope)    -> 409 WORKSPACE_FILE_SCOPE_UNAVAILABLE
```

候选进程已通过 SIGINT 停止，临时状态移动到专用清理目录；没有触碰 `23655`。验证期间检测到 `23655` 仍由原有本地服务监听，未对其执行重启或写入。

本 Gate 结论为 **pass（Mastra module-load / HTTP cold-start contract）**。它仍不覆盖组合 target 的完整只读资产 smoke 之外的写入、真实微信、scheduler/push、Platform onboarding 展示契约，也不代表默认 backend 或生产部署已切换。下一步应形成最终遗留命名分类表，并评估是否具备在独立端口开启真实 scheduler 的候选 Gate；在此之前不改默认值。

### 12.34 Mastra context packet 的路径泄露收敛（2026-08-13）

复核 context/prompt 构建链路时发现，通用 `ContextPacket.workspace.path` 在 Mastra 模式仍可能通过 `resolveWorkspacePath(userId)` 产生宿主机绝对路径。虽然当前 Mastra Agent 主路径关闭了 context packet，这仍不是足够的服务边界。

现在 Mastra 模式的 context packet 明确不填充 `workspace.path`；Workspace backend 的兼容 packet 仍保留原行为。Mastra Workspace 继续通过服务端解析出的 Workspace object 和内部 staging context 使用，绝对路径不进入模型 prompt、Portal payload 或客户输出。

验证：

```text
npm run typecheck -> pass
Mastra facade/runtime-boundary/Portal scope 聚焦测试 -> 14/14 pass
git diff --check -> pass
```

本 Gate 不改变用户项目文件、生产数据或端口。默认 backend、真实 scheduler/push、Platform onboarding service projection 和用户 Gate H1 仍 pending。

### 12.35 Platform onboarding 展示改用 Mastra service projections（2026-08-13）

补齐 12.31 标记的管理面展示契约：Mastra 模式下客户摘要不再通过 legacy `config/*.yaml` 判断“是否已配置”。它现在按完整 `userId + projectId + instanceId` 查询：

- `mastra_portfolio_states` 是否存在 -> `portfolioConfigured`；
- `mastra_project_profiles` 是否存在 -> `strategyConfigured`；
- `mastra_runtime_preferences` 是否存在 -> review schedule / notification projection 已建立；
- preferences 内 `onboardingState.status` -> `onboardingStatus`；
- preferences 内 notification mode -> `notificationPreference`。

Mastra investment-state 继续以 service backends 返回的事实为准；Workspace backend 的旧 YAML 展示不变。该映射只读，不修改投影，不创建 Workspace。

验证：`npm run typecheck` 通过；Mastra onboarding/preferences 聚焦测试通过；随后执行完整回归确认跨模块兼容。

### 12.36 Mastra scheduler 独立候选启动（2026-08-13）

在全新临时 DB、`MASTRA_PROJECTS_ROOT` 和 legacy `WORKSPACE_ROOT` 下启动真实 scheduler 候选进程：

```text
WORKSPACE_BACKEND=mastra
INVEST_AGENT_OFFLINE_MODE=false
PORT=23658
PORTAL_CONNECTOR_AUTO_START=false
WEIXIN_AUTO_START=false
PLATFORM_WEIXIN_AUTO_START=false
```

结果：HTTP `/health` 持续返回 `200`；scheduler、review、data-quality、file-retention worker 均能启动；没有用户 scope 时，临时 `legacy-workspaces` 和 `projects` 根均未被创建，说明启动扫描不会初始化 legacy Workspace 或凭猜测创建 Mastra 项目。日志也已改为 backend-aware，不再把 Mastra 调度描述为扫描 `workspace schedules.yaml`。

候选进程已停止，临时状态移动到专用清理目录；未启动、重启或写入 `23655`，未接入真实微信或推送。

本 Gate 结论为 **pass（scheduler process cold start / no implicit Workspace creation）**。这仍不等于恢复真实 scheduler/push 或完成用户 Gate H1：需要已导入且明确启用的测试 scope、推送模拟、失败重试和审计验证；默认 `WORKSPACE_BACKEND` 依然保持 pending。

### 12.37 默认 Mastra backend 切换与独立冷启动复核（2026-08-13）

完成迁移分支运行时默认值切换：`src/lib/data-backend.ts` 现在仅在显式配置 `sqlite` 或 `workspace` 时选择对应兼容 backend；未设置或设置为 `mastra` 时默认使用 Mastra。`src/platform/project-registry.ts` 的实例回滚/删除也改用解析后的 `ACTIVE_BACKEND` 判断，避免默认未设置环境变量时遗漏 Mastra 项目根回收。

现有 legacy Workspace 单元测试在 `package.json` 的 `npm test` 脚本中显式设置 `WORKSPACE_BACKEND=workspace`，这是测试兼容配置，不代表服务默认仍以 Workspace 运行；Mastra 专项测试继续显式设置 Mastra backend。

默认未设置 `WORKSPACE_BACKEND` 的独立候选进程使用临时 DB、临时项目根、离线模式和端口 `23659` 完成 HTTP 复核：

```text
GET /health                                      -> 200
GET /api/portal/health (无 token)                 -> 401
GET /api/portal/workspace/files (未注册 scope)    -> 409 WORKSPACE_FILE_SCOPE_UNAVAILABLE
ACTIVE_BACKEND                                   -> mastra
legacy Workspace 根                               -> 未创建、为空
```

同一变更集验证结果：`npm run typecheck`、`npm test`（443/443）、`npm run build`、`git diff --check` 均通过。候选进程已停止，临时状态已清理；没有启动、重启或写入 `23655`，没有使用生产 SQLite、真实 Workspace 或微信状态。

本 Gate 结论为 **pass（默认 Mastra backend / isolated HTTP cold-start）**。它证明迁移分支在未设置 backend 环境变量时以 Mastra 为核心启动，但不宣称最终业务平替、真实数据迁移或生产部署完成。剩余工作包括：用户 Gate H1 手动验收 Portal/微信交互；在隔离测试 scope 上完成完整组合 target 的写入、资产发布、conversation、scheduler/push 模拟与审计验证；以及在保留迁移/回滚/审计证据的前提下，分类并清理不再需要的 ACP/Codex/Hermes 历史兼容命名。

### 12.38 Attachment 完整项目 scope 读取边界（2026-08-13）

复核隔离组合 target 后确认，附件表已保存 `userId + projectId + instanceId`，但附件读取入口此前只比对 user 与 instance。对于同一用户、同一实例下存在多个项目的 Mastra registry，这会让附件的项目级隔离只停留在存储路径而不是读取授权边界。

现已将 `findAttachmentRecord()` 与 `readAttachmentBytes()` 的读取契约扩展为完整 scope；Portal connector 和 Mastra service tools 均传入认证/运行时的 `projectId`。未提供 projectId 的 legacy 调用仍按默认业务项目 `invest-agent` 兼容，Mastra 请求不再能以同 user/instance 跨 project 读取附件元数据或字节。

新增默认 Mastra 环境测试：为同 user/instance 的 `project-a` 与 `project-b` 各自 bootstrap registry 项目，在 `project-a` 上传并登记附件后，`project-a` 可读回同 checksum 字节，`project-b` 同时无法读取元数据且 `readAttachmentBytes()` 返回 `ATTACHMENT_NOT_FOUND`。该验证使用临时 DB、临时 projects root 和临时 legacy root；未使用备份源、生产 SQLite、真实 Workspace、微信状态或 `23655`。

相关兼容回归 `file-retention`、Portal conversation log、Portal asset contract 共 `27/27` 通过；Mastra scope/asset/file 相关测试与类型检查、`git diff --check` 均通过。随后完整 `npm test` 为 `444/444`（`0` fail、`0` cancelled、`0` skipped）。该收敛补足了完整组合 target 的附件读取授权边界，但不等于真实微信/推送恢复或用户 Gate H1。

### 12.39 旧 ACP/Codex/Hermes 引用分类（2026-08-13）

对迁移分支的 `src/`、运行脚本和 package scripts 做静态扫描：Mastra 主运行时没有 `src/acp` 目录，也没有从 ACP/Codex/Hermes 实现模块直接 import；`server`、Portal、Platform、Mastra runtime、service tools 和 scheduler 主路径均以 Mastra/backend-neutral 实现为入口。

剩余引用按以下类别处理，当前不直接删除：

| 类别 | 现状 | 处理决定 |
| --- | --- | --- |
| 数据库 `codex_acp_traces`、旧 `backend` 默认值和一次性 normalize migration | 历史真实数据、审计和升级兼容所需 | 保留 schema/migration；Mastra 新 trace 使用 agent-neutral 表/字段，后续只在确认历史保留周期后再归档 |
| `workspace-rollback`、备份、release snapshot 和兼容 acceptance 脚本 | 回滚、灾备和发布边界，不是运行时入口 | 保留；这些脚本不得被 Mastra 默认服务自动调用 |
| `mcp-acp-*`、旧 Codex smoke/probe | 旧 backend 专项证据 | 保留为显式 legacy probe，不能作为 Mastra 验收证据；后续可在兼容窗口结束后独立移入 archive |
| 旧注释、日志标签和 `backend=codex` 业务历史值 | 观测/迁移兼容命名 | 不在本 Gate 擅自改写，避免破坏查询、回放和审计关联；新增 Mastra 路径不应继续产生这些值 |

该扫描的结论是 **Mastra 主路径依赖分类 pass，历史兼容命名清理 pending**。后续只有在完成用户 Gate H1、真实 push 恢复策略和回滚保留周期确认后，才评估删除或归档旧 probe、历史表及对应命名；本轮未删除任何兼容模块，也未触碰生产数据或 `23655`。

### 12.40 完整组合 target 写入与自动化 staging smoke（2026-08-13）

使用备份快照 `/Users/combo/MyFile/my-data/backups/invest-agent/disaster-recovery/full/2026-08-13T010005+0800` 和 Workspace 快照 `/Users/combo/MyFile/my-data/backups/invest-agent/workspaces/snapshots/2026-08-10T235031+0800`，在 `/tmp/mastra-composed-write-target-06qGlO` 重建隔离 target。所有 mapping/dry-run 输出、target SQLite 和项目根均位于快照根之外；源快照只读。

导入结果：

```text
strategy projection       -> inserted
portfolio projection      -> inserted
runtime preferences       -> inserted（4 个来源资产）
review/memory ledger       -> inserted（275 条记录、20 个资产）
generic asset ledger      -> inserted（157 条资产，全部 executable=0）
target cold-start verify  -> pass
```

随后通过 `npm run mastra:target-write-smoke`（源码 smoke 使用 `node --import tsx`）注册完整 `userId=mg + projectId=invest-agent + instanceId=invest-agent-mg` scope，执行无模型调用的 Portal 写入：

- 伪造请求体中的 user/project/instance scope 被稳定拒绝为 `INVALID_REQUEST`；
- `asset.upload` 成功，字节写入已注册项目根并可通过目标 SQLite 版本记录校验；
- `automation.create` 成功，生成 paused 任务及同 scope 的 source/working 文件；未启动任务、scheduler、push 或模型调用。

最终 smoke 输出为 `ok=true`，并报告 `forgedScopeOverride=rejected`。这是隔离 target 的写入和 staging 契约证据，不是生产数据迁移、真实微信/push 恢复或用户 Gate H1。临时 target 后续可直接删除，不影响任何备份源或 `23655`。

### 12.41 Mastra scheduler activation fail-closed（2026-08-13）

复核 12.40 的导入 target 时发现，`mastra_runtime_preferences` 虽然保存了 `schedulerActivation=disabled_until_target_cold_start_and_explicit_enable`，但 scheduler scope 枚举此前仍会把 active instance 纳入自动扫描；这会使“禁用”只停留在数据记录而没有运行时强制。

现在 Mastra `getSchedulableScopes()` 在返回 scope 前读取同一完整 scope 的 runtime preferences：只有 `schedulerActivation === "enabled"` 才进入自动调度；缺失或任意其它值均 fail-closed，并记录 backend-aware 日志。Workspace backend 的既有调度行为不变。手动 `triggerScheduled*Now` 入口仍保留为后置人工/隔离验收入口，不会因自动枚举门禁而隐式恢复。

新增临时 DB 测试覆盖：同一 active Mastra instance 在 `disabled_until_target_cold_start_and_explicit_enable` 下不进入 schedulable scopes，改为显式 `enabled` 后才进入。该测试没有启动 scheduler interval、push worker、微信或任何真实服务。

验证结果：Mastra scheduler activation 聚焦测试通过；随后完整回归、typecheck、build 和 `git diff --check` 继续执行。该 Gate 使导入 target 的 scheduler/push 默认保持关闭，但不等于真实推送恢复或用户 Gate H1 完成。

### 12.42 Automation scheduler activation 收敛（2026-08-13）

继续审查 12.41 的 scheduler 旁路后确认，automation scheduler 原本直接调用 `listDueAutomationTasks()`，不经过主 scheduler 的 Mastra scope 枚举，因此可能绕过 `schedulerActivation`。现已在 `runAutomationSchedulerTick()` 的 dispatch 前读取同一 `userId + projectId + instanceId` 的 `mastra_runtime_preferences`：Mastra 下只有显式 `schedulerActivation=enabled` 才调用 `runAutomationTaskNow()`；缺失、非法或 `disabled_until_target_cold_start_and_explicit_enable` 均记录并跳过。

data-quality 是平台级定时汇总，不读取用户 Workspace 或发送用户 push；file-retention 仍由既有 `FILE_RETENTION_CLEANUP_ENABLED=true` 环境门控制，未被 Mastra activation 绕过。本轮未改变这两个独立安全门。

验证：Mastra scheduler activation 与 automation activation 聚焦测试通过；legacy automation reliability 测试显式设置 `WORKSPACE_BACKEND=workspace` 后 `5/5` 通过。Mastra disabled target 的 automation tick 返回 `due=1, started=0`，切换到显式 `enabled` 后才 dispatch。完整回归、typecheck、build 和 `git diff --check` 在本 Gate 后复跑；未启动 scheduler interval、push worker、微信或 `23655`。

### 12.43 Sandbox strategy library 旁路 fail-closed（2026-08-13）

最后一轮 `ensureWorkspace()` / `WorkspaceStore` 静态审查发现，`/api/sandbox/strategies`、`strategies/set` 和 `strategies/remove` 没有 Mastra service-owned projection 分支，会在 Mastra 默认模式直接读取或写入旧 `WorkspaceStore`。这与“Mastra 默认不依赖旧 Workspace 事实源”的边界冲突。

现已将三个路由在 Mastra 下统一收敛为 `MASTRA_STRATEGY_LIBRARY_NOT_READY`：GET 返回明确未接线状态，写入/删除返回 HTTP 409；Workspace backend 的原有交易策略 YAML 行为保持不变。该域后续若要恢复，需要先定义 project asset/service projection contract，不能静默回退旧目录。

审查后的其它 `ensureWorkspace()` 调用均属于显式 Workspace backend、迁移/回滚工具或已在 Mastra 分支 fail-closed 的 L3A/L3B/旧 onboarding 入口。验证：typecheck、build、完整回归和 `git diff --check` 在本 Gate 后执行；没有修改生产数据、真实 Workspace、微信状态或 `23655`。

### 12.44 Mastra 默认路径静态审查收口（2026-08-13）

对当前 `src/` 的全部 `ensureWorkspace()`、`resolveWorkspacePath()` 和 `WorkspaceStore` 调用点完成逐点分类：

- 运行时、Portal、Platform、service tools、review publication、daily/periodic review backend 在 Mastra 分支均使用 service projection 或 registry project root；
- L3A/L3B、旧 onboarding step、Workspace strategy library 等没有 Mastra-native contract 的入口现在 fail-closed；
- rollback、snapshot、backup、backfill 和显式 Workspace backend 保留旧路径，但不被默认 Mastra 自动调用；
- `SCHEDULED_REVIEW_LEGACY_ORCH=true` 在 Mastra 下仍被 `isLegacyReviewOrch()` 拒绝，不能重新打开旧文件编排。

因此本轮静态审查未发现新的“默认 Mastra 会自动创建/读取 legacy Workspace”旁路。该结论只代表代码路径分类收口，不替代用户 Gate H1、真实微信/push 和生产部署验收。

### 12.45 目录型 Workspace 能力验证与候选服务 Gate H1 预检（2026-08-13）

本轮针对“Mastra 是否仍能承接用户目录型项目空间”完成验证。`@mastra/core@1.57.0` 的动态 Workspace factory 可以依据服务端认证 scope 绑定注册项目根，并提供项目内文件读写、搜索和用户 Skill 加载；项目 manifest 可跨进程恢复，`LocalFilesystem({ contained: true })` 会拒绝路径穿越。用户目录仍可保留自然文件结构，服务事实、权限、审计、调度和发布边界继续由 service/MCP 层控制。用户代码没有在持久项目根或 LocalSandbox 中执行，LocalSandbox 的同级目录可见性仍被列为不可接受的多租户隔离能力。

隔离验证证据包括：

- `npm test`：`446/446`，0 fail、0 cancelled、0 skipped；
- `npm run typecheck`、`npm run build`、`git diff --check`：通过；
- 完整组合备份副本 target：strategy、portfolio、runtime preferences、review/memory 和通用资产导入成功；target cold-start、Portal asset upload、automation staging 和伪造 scope 拒绝均通过；
- Mastra scheduler 与 automation scheduler：未显式 `schedulerActivation=enabled` 时均 fail-closed；
- `/api/sandbox/strategies` 在 Mastra 下不再回退旧 `WorkspaceStore`，未接线能力明确返回 `MASTRA_STRATEGY_LIBRARY_NOT_READY`；
- 全量 `ensureWorkspace()`、`resolveWorkspacePath()` 和 `WorkspaceStore` 调用点已分类，未发现默认 Mastra 主路径会隐式创建或读取 legacy Workspace 的新旁路。

候选服务已在独立端口 `23656` 启动，使用临时状态根、`gpt-5.6-terra` 和 offline 模式；`23655` 仍由主分支服务监听且未被重启、写入或读取。已确认 `GET /health -> 200`，未授权 Portal health 返回 `401`。该候选服务不启用真实微信、推送、scheduler 或生产数据。

本 Gate 结论为 **technical preflight pass；用户 Gate H1 pending**。用户需要在 `http://127.0.0.1:23656/platform` 手动确认 Portal 页面、登录/session、dashboard/instances/audit、基础对话和加载状态。H1 通过后仍需单独决定真实微信绑定与 push 恢复、最终 ACP/Codex/Hermes 历史命名的归档/删除窗口，以及部署端口和真实数据迁移；本轮不执行这些动作。

### 12.46 工作包停点复核（2026-08-13）

对 12.45 之后的当前工作树再次执行完整回归：`npm test` 为 `446/446`，0 fail、0 cancelled、0 skipped；`npm run typecheck`、`npm run build` 和 `git diff --check` 均通过。测试使用显式 `WORKSPACE_BACKEND=workspace` 的 legacy fixtures，不改变服务默认值；Mastra 专项测试覆盖 draft onboarding commit、project scope、asset、scheduler activation、Workspace containment 和 service-owned projections。

本轮源码审计确认，Mastra onboarding 的正式写入路径是 `onboarding.draft.*` 冻结后统一提交到 portfolio/profile/runtime-preferences/watch projections，并在同一 SQLite transaction 中写入；旧的 `onboarding.confirm_portfolio`、`onboarding.confirm_step`、`onboarding.complete_watch_setup` 入口在 Mastra 下继续明确 fail-closed，不会回退到 Workspace。这是有意的安全边界，不是遗漏的静默兼容。

当前隔离候选服务仍保持在 `23656`：

```text
GET /health                         -> 200
GET /api/portal/health (无 token)    -> 401
23655                               -> 原主分支进程仍在监听
```

候选服务使用临时状态根、offline 模式、`gpt-5.6-terra`，不启用真实微信、push、scheduler，也不读取生产 SQLite、真实 Workspace 或 `23655`。工作包现阶段没有剩余可由代码单方面完成而又不改变产品决策的必做项；下一停点是用户 Gate H1。H1 通过后，再处理真实微信/push 恢复、历史兼容命名最终归档/删除和发布决策。

### 12.47 Portal 管理面自动化 UI 复核（2026-08-13）

通过候选服务 `http://127.0.0.1:23656/platform` 的实际浏览器会话复核了管理面。初始 `运营总览` 正常显示更新时间、统计和异常摘要；以下 hash 路由均完成渲染，DOM 中没有残留“正在读取”或“正在加载”状态：

```text
#customers       客户与助手
#quality         产品质量
#runtime         运行与触达
#cost            成本统计
#instances       用户助手
#audit           日志审计
#rule-alerts     规则巡检
#source-quality  MCP 工具状态
```

这证明隔离候选的 Platform 管理页面能够读取其专用状态并完成导航，未复现此前的空白加载问题。该检查未修改任何记录、未调用模型、未启用真实微信/push/scheduler，且 `23655` 保持不动。它属于 H1 前的自动化可用性证据；对话、文件和自动化是否达到用户的实际业务平替预期，仍由用户 Gate H1 决定。

### 12.48 正式 Portal 同仓候选联调与文件 scope 修复（2026-08-13）

将正式 Portal 唯一来源仓库 `/Users/combo/MyFile/projects/invest-agent-portal`（来源 commit `5c35f0ec6e70cd736b98f504e75d2e860956728e`）以 `apps/portal/` 导入迁移仓库，作为 Mastra 候选的同仓 Portal 工程。导入排除了 `.git`、依赖、构建缓存、数据、日志和 `.env*`；`apps/portal/PORT_SOURCE.md` 记录来源和边界。根仓库新增隔离启动和 Portal 校验脚本：`mastra:portal:local`、`portal:build`、`portal:test`、`portal:typecheck`。

候选同仓拓扑为独立进程和独立状态根：

```text
Mastra runtime  -> 23656
正式 Portal     -> 23657
Portal Relay    -> 23658
状态根          -> data/mastra-portal-local/
```

统一脚本先在 `MASTRA_PROJECTS_ROOT=data/mastra-portal-local/runtime/projects` bootstrap 服务拥有的 `primary / invest-agent / invest-agent-primary` project scope，再注册 loopback connector；候选使用临时 Portal DB、offline 模式、`gpt-5.6-terra`，未启用 scheduler、push 或微信。主分支 `23655` 仍由原进程监听，未被重启、写入或读取。

Portal 工程验证结果：`npm ci`、`npm run portal:typecheck`、Portal 测试 `43/43`、`npm run portal:build` 均通过。浏览器复核已确认登录后显示 `用户 · primary`、connector `在线`，`conversation.list`/会话页面可加载，自动化任务页面可加载，`我的文件`页面可加载且在空项目时显示 `0` 文件，不再报 `WORKSPACE_FILE_SCOPE_UNAVAILABLE`。

联调中发现并修复一个真实 scope 传递缺口：Portal connector 的 `workspace.file.list/get` 原先只传 `userId`，在 Mastra 文件服务的完整 scope 契约下会被拒绝。现已补齐注册 connector 的 `projectId + instanceId`，并增加 connector 回归测试；完整 scope 缺失仍 fail-closed。根仓库专项测试、`npm run typecheck`、`npm run build` 和 `git diff --check` 均通过。

通过 Portal 输入框提交了一条隔离测试消息，消息进入 Mastra runtime 后最终成功完成；隔离 target 的 `agent_traces` 记录为 `status=success`、`agent_backend=mastra`、`agent_model=gpt-5.6-terra`，回复耗时约 63 秒。该回合未触发真实微信或推送。响应时间较长仍需作为候选环境的体验限制记录，不能仅凭一次成功回合宣称完整业务平替；这不影响 Portal 登录、connector、会话列表、文件 scope 和自动化页面的本地链路证据。

本 Gate 结论为 **同仓 Portal/Relay/Runtime 技术联调通过；模型对话回合和用户 Gate H1 仍 pending**。后续仍需用户确认实际 Portal 交互是否满足平替预期，再决定真实微信/push 恢复、历史 ACP/Codex/Hermes 命名归档窗口以及最终部署和备份数据迁移；本轮不执行生产切换。

### 12.49 WP6 失效旧入口清理与收敛扫描修复（2026-08-13）

按 WP6 继续清理迁移分支当前仍暴露、但已引用不存在 ACP 实现的开发入口：从根 `package.json` 移除 ACP-only MCP probes、旧 Workspace/ACP acceptance smoke、旧 Codex mobile/publication 命令，并删除对应仅用于旧执行器的脚本文件。保留灾备、备份和回滚脚本作为历史运维/审计边界；它们不属于 Mastra runtime，也不会被默认候选自动调用。测试中的 `workspace-compatibility-acceptance` 失效入口断言同步移除。

同时修复 `scripts/convergence-responsibility-scan.mjs`：扫描目标现在先过滤当前工作树中实际存在的权威文件，历史文档路径缺失不再被误报为扫描错误。扫描结果：3 项责任检查全部通过；`npm test`（本轮 445 个测试均通过，0 fail、0 cancelled、0 skipped）、`npm run typecheck`、`npm run build`、`git diff --check` 均通过。

这一步只清理迁移分支的失效开发入口和扫描器，不删除数据库历史表、迁移字段或备份/回滚证据；旧历史命名的最终归档仍需保持可审计，并不构成生产发布。当前候选仍使用隔离状态，`23655` 未重启、未写入、未读取。

本 Gate 结论为 **WP6 可自动清理项通过；WP7 技术候选保持可运行；模型对话和用户 Gate H1 仍 pending**。下一步不再自动触碰真实微信、push、生产数据库或部署端口；需要用户确认候选 Portal 的实际业务体验后，才进入发布决策门。

### 12.50 WP7 自动化验收收口与 H1 停点（2026-08-13）

对工作包 WP7 和下一阶段计划的剩余自动化项做逐项审计：

- 模型选择已有 Mastra factory 的 per-turn snapshot 测试；同一进程中 `model-a -> model-b` 会创建不同的后续 Agent，且不读取 Workspace 模型配置。隔离候选真实回合最终以 `gpt-5.6-terra` 成功写入 `agent_traces`，记录 `agent_backend=mastra`、`agent_model=gpt-5.6-terra`。
- scheduler 与 automation activation 已有 Mastra 专项测试：缺失或非显式 `enabled` 均 fail-closed，显式 enabled 才 dispatch；generic automation 测试覆盖 fake push queue、产物版本、幂等交付和失败结果，不向真实微信发送。
- Portal connector、文件 scope、会话恢复/取消、附件、资产版本、自动化和 trace coverage 均有自动化合同测试；正式 Portal `43/43` 通过。
- `npm test` 本轮为 `445` 个测试全部通过，0 fail、0 cancelled、0 skipped；`npm run scan:convergence`、`npm run typecheck`、`npm run build`、`npm run portal:typecheck`、`npm run portal:build` 和 `git diff --check` 均通过。

运行状态复核：Mastra runtime `23656`、正式 Portal `23657`、Relay `23658` 均在线；主分支生产服务 `23655` 仍由原 PID 监听。候选使用 `data/mastra-portal-local/` 隔离状态、offline 模式、临时 Portal DB；没有触碰生产 SQLite、真实 Workspace、真实微信或 push。

当前剩余项已经是用户判断而非可安全自动替代的代码验收：需要用户打开 `http://127.0.0.1:23657/login`，确认 Portal 登录后对话响应速度、文件/自动化页面、审计观感以及是否达到业务平替预期。真实微信/push 恢复、历史兼容物理归档窗口、部署包和新服务器端口属于 H1/R1 之后，不在本工作包内执行。

本 Gate 结论为 **WP0-WP7 自动化证据收口通过，正式停在用户 Gate H1**。在用户明确体验通过前，不再自动推进生产数据迁移、微信绑定、push 恢复、部署或端口切换。

### 12.51 H1 复现：复杂工具请求空回复修复与真实结果（2026-08-13）

用户在 Portal 提交“碳酸锂数据周度去库数据跟踪表格，要求 SMM 和 Mysteel 双口径”后，前端显示已处理约 40 秒，随后提示“任务遇到暂时性故障，自动重试后仍未恢复”。隔离 runtime 的 `agent_traces` 直接记录了 4 次 `MASTRA_EMPTY_RESPONSE`，耗时约 28–64 秒；这些失败回合没有 `agent_model`、最终回复或完整工具终态。Portal 登录、Relay、conversation API 和文件 scope 均正常，因此故障不在前端或认证链路。

根因定位为 Mastra Agentic Loop 的服务端步数预算未显式设置。复杂请求需要多个模型/工具步骤；默认 loop 上限可能在工具调用后耗尽，`runMastraTurn()` 只收到空文本，随后把它正确包装成 `MASTRA_EMPTY_RESPONSE`，Portal 再显示暂时性故障。此前仅增加等待时间不能解决这个问题。

已修复：

- `createMastraAgent()` 接受服务端 `maxSteps`，写入 Mastra `defaultOptions`；非法值或超过 20 步会 fail-closed。
- `runMastraTurn()` 默认使用服务端 `DEFAULT_MASTRA_MAX_STEPS=12`，并把 `maxSteps` 同时传给 Agent factory 和每回合 `stream()`。
- 交互 runtime 明确传入 12 步；调用方不能通过用户消息或浏览器 scope 提高上限。
- 新增 facade 回归：工具步骤之后仍能返回最终文本；不安全步数被拒绝。

修复后重新启动隔离候选并用相同请求复现：最终 `agent_traces` 为 `status=success`、`agent_backend=mastra`、`agent_model=gpt-5.6-terra`，耗时约 162 秒；Portal 返回了 SMM 与 Mysteel 双口径首期基准表和口径差异说明。该结果证明空回复故障已修复，但 162 秒仍是明显的交互性能问题，可能由网关延迟、外部数据工具和多步工具链共同造成；不能把它视为 H1 体验通过。未触发真实微信/push，生产 `23655` 未操作。

本 Gate 结论为 **复杂工具请求的正确性从失败转为成功；性能仍需 H1 用户判断**。后续可独立继续做网关/工具耗时分段观测和体验优化，但在没有用户确认可接受响应速度前，不进入生产切换。

### 12.52 复杂回合阶段计时观测（2026-08-13）

针对 12.51 中成功但耗时约 162 秒的问题，Mastra facade 增加了受控、无原文的 timing 摘要。每个成功回合的 `budget.timing` 仅记录 `agentFactoryMs`、`streamInvokeMs`、`outputCollectMs`、`totalMs` 和工具事件计数；不保存 prompt、工具参数、工具结果、Authorization 或 API key。该摘要沿用现有 `reviewContextSummary` trace 字段，不增加数据库 schema 或迁移风险，旧 trace 行保持兼容。

随后复核发现，失败回合仍发生在交互入口固定的 12 步预算内；因此将隔离候选的服务端默认步数提高到硬上限 20 步。该值仍由服务端控制，浏览器和用户输入不能扩大；这是复杂多工具请求的候选验证配置，不代表生产配置已变更。

回归验证：Mastra 专项测试、`npm run typecheck`、`npm run build` 和 `git diff --check` 均通过。下一次隔离候选复杂请求后，应读取该摘要与现有 `external_mcp_tool_calls` 交叉比较，判断延迟主要来自模型网关、工具/MCP 还是最终输出消费。计时证据完成前，H1 仍不视为性能通过，也不推进生产切换。

### 12.53 Mastra 原生结构化 Excel 交付工具（2026-08-13）

Portal 实际请求“先把表格做出来”时，发现 Agent 只有“保存已有 base64 文件”和“发布已有 Workspace 文件”能力，没有可靠的结构化数据到 XLSX 的服务工具，因此模型错误地回复“当前会话未提供 Excel 二进制写入能力”。

已新增 Mastra service tool `spreadsheet.create`：Agent 传入文件名、列名和结构化数据行，由服务层使用已部署的 ExcelJS 生成真实 Office Open XML 工作簿，执行表头冻结、自动筛选、列宽设置、内容校验，并保存到当前 scope 的“我的文件”，返回 asset/version descriptor。工具受 scope guard 和 service audit 约束，不接受路径、不写生产 Workspace。网页通道提示已明确要求表格请求必须调用该工具。`npm run typecheck`、`npm run build` 和 `git diff --check` 通过。

本项尚需在隔离 Portal 中由用户再次提交同类请求，确认 Agent 实际调用工具、Portal 展示 artifact 并可下载；此前直接脚本生成的样本不作为验收证据。

## Executor Prompt

在 `feat/mastra-migration` 上首先实现受控用户 Workspace 接入：建立 scope 校验的 Workspace registry、动态 Agent Workspace factory、项目 manifest、文件/发布审计、`contained: true` 越权测试和用户 Skill 动态加载。不要接入真实 Workspace，不要迁移数据，不要启用用户代码执行。完成原型接入验收后，再按本设计分域迁移服务事实与资产索引；保留用户项目目录和自然文件结构。

## Reviewer Prompt

独立检查 Workspace 是否只由认证 scope 解析，目录 containment 是否有效，系统策略是否仍在服务层，用户 Skills/项目说明是否不能扩大权限，用户文件是否保留自然目录和版本关系，以及用户代码是否没有在 LocalSandbox 或持久项目根中执行。任何绝对路径泄露、跨 scope 读取、旧 runtime 配置重新成为依赖、未分类源文件，或把 LocalSandbox 当多用户安全边界的实现，均判定不通过。
