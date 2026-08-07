# 我的文件配额、映射与预览执行计划

> 状态：已执行并验收（未发布生产）
>
> 日期：2026-08-06
>
> 范围：Portal `/assets`、对话附件与交付物、报告映射、自动化产物，以及 Runtime 资产存储与配额边界。

## 1. 背景与目标

“我的文件”应是用户长期资产的统一产品视图，而不是 Workspace 的物理目录浏览器。用户需要理解自己拥有哪些上传文件、保存的 AI 产物、报告与自动化输出；它们可以来自不同业务面，但打开、预览、下载和容量统计应一致。

本计划落实以下目标：

1. 用户可在“我的文件”看到长期资产及报告的零复制映射入口，并看到 `已使用 / 200MB` 存储量。
2. 用户上传单文件最大 10MB，单次上传请求原始文件总量最大 20MB；所有长期文件总量最大 200MB。
3. 聊天附件默认短期保存，只有用户点击“保存到我的文件”才成为长期资产并消耗用户配额。
4. 图片仅在原始文件大于 1MB 时压缩；不超过 1MB 的图片原样保存。压缩后优先保证投资图表、截图中的文字和数字可读，最终仍不得超过单文件 10MB。
5. 从报告、对话或自动化点击文件时，统一在右侧文件预览区打开。该预览区与既有文件工作区互斥，不出现两个竞争的右侧面板。

## 2. 已确认产品决策

| 决策 | 规则 |
| --- | --- |
| 长期资产 | 用户主动上传、用户在对话中明确保存的交付物、自动化声明为保存的输出；它们都由用户资产与版本模型管理。 |
| 临时聊天附件 | 保留当前短期附件语义，不自动进入“我的文件”，不占 200MB 长期配额。 |
| 报告 | 日/周/月报告在“我的文件 > 报告”以零复制映射条目显示；点击使用统一右侧预览。报告字节只计一次实际占用，不因映射重复计费。 |
| 单文件上限 | 原始上传文件或自动化最终输出均不得大于 10MB。 |
| 单请求上限 | 同一次用户上传的原始文件合计不得大于 20MB；服务端以解码后的实际字节校验，不能信任前端声明。 |
| 用户配额 | 一个 `(userId, instanceId, projectId)` scope 的长期可见文件与报告映射底层字节总量不得超过 200MB。 |
| 版本与归档 | 每个保留的长期资产版本均计入配额；归档不释放空间。预览缓存、缩略图和临时 staging 不计入。 |
| 图片 | 图片 `<= 1MB` 原样保留；图片 `> 1MB 且 <= 10MB` 压缩后提交。SVG 不作为位图压缩，继续走 sanitizer。 |
| 右侧预览 | 右侧区域状态为 `none | asset-preview | workspace`，任一时刻只能有一种。 |

## 3. 明确不在范围内的事项

- 不把“我的文件”实现为 Workspace 全目录、文件夹树或任意路径读写入口。
- 不增加外部云盘同步、共享链接、多用户协作、无限保留或批量迁移真实用户 Workspace。
- 不在本期增加物理删除。归档与版本继续保留，配额释放规则在后续“彻底删除与留存期”专项中定义。
- 不把旧 `conversation_artifacts`、旧 `automation_task_assets` 的物理目录直接改写成新资产目录。
- 不对 PDF、CSV、XLSX 等非图片类型进行内容压缩或格式转换。

## 4. 当前实现与差距

| 当前面 | 已有能力 | 本计划需补齐 |
| --- | --- | --- |
| Runtime 资产 | `src/services/user-assets.ts` 已有 scope、版本、checksum、归档和格式校验 | 当前按格式允许 1-25MB，无单请求/用户总配额，也没有图片压缩。 |
| 对话交付物 | `conversation_artifacts` 已可关联 asset/version | 聊天附件与“保存到我的文件”的显式转换、容量预检和 UI 状态需统一。 |
| 报告 | `artifact.library.list` / `report.asset.get` 提供旧报告只读能力 | 报告尚不是“我的文件”的映射条目，也没有统一预览/配额统计。 |
| 自动化 | 通用自动化可创建或更新用户资产版本 | 自动化提交前未按每用户 200MB 进行原子预检。 |
| Portal 文件页 | `/assets` 已有列表、上传、重命名、归档、下载和居中预览弹窗 | 需展示配额、来源映射、统一右侧预览、20MB 请求级校验与图片处理反馈。 |

## 5. 目标交互与信息架构

### 5.1 我的文件是虚拟分类，不是物理目录

列表使用来源筛选/虚拟入口，而不是让用户管理 Workspace 文件夹：

```text
我的文件
  全部文件
  我的上传
  AI 生成
  自动化产物
  报告（映射）
  已归档
```

一个条目可同时具有“AI 生成”和“报告”等来源标签，但物理字节和配额只能计算一次。Portal 不显示内部相对路径、Workspace 路径、staging 路径、技能或日志。

### 5.2 报告映射

- 新生成的日/周/月报告由报告服务登记一个 scope 内的 `report` 映射条目；映射不复制字节。
- 映射条目显示标题、生成时间、格式、大小、来源“报告”，并打开既有受控报告读取能力。
- 报告映射的底层字节被纳入同一用户存储统计，但不会因为同时出现在报告页和“我的文件”重复计数。
- 旧报告只做只读、按需映射，不批量迁移或修改真实 Workspace。未能完成安全读取或大小审计的旧条目不显示，并写审计原因。

### 5.3 统一右侧预览

在 Portal 应用层创建单一 `FilePanelProvider` / `FilePanel`：

- `asset-preview`：显示名称、来源、版本、大小、预览、下载、保存/归档等与条目类型相符的操作。
- `workspace`：保留既有文件工作区能力。
- 打开其中一个面板必须关闭另一个；链接点击不跳转到 `/assets`，在当前上下文直接打开预览。
- `/assets` 可仍以页面列表承载浏览和筛选，但详情改用同一右侧预览组件，移除当前居中详情弹窗，避免两套交互。
- 键盘 Esc、关闭按钮、焦点恢复、窄屏下全屏抽屉都必须可用。

## 6. 存储、配额与图片处理设计

### 6.1 配额服务

新增服务层唯一入口，例如 `user-storage-quota.ts`，而不是让 Portal 自行累计：

- `getStorageUsage(scope)` 返回 `usedBytes`、`reservedBytes`、`limitBytes = 200 * 1024 * 1024`、`availableBytes`，供 `asset.list` 及独立轻量读取返回。
- 为每个三元 scope 建立一行配额/预留记录；在 SQLite 事务与资源 mutation lock 内做“预留 -> 写入/映射提交 -> 结算”或“失败 -> 释放”。
- 普通资产版本、报告映射的实际底层字节、自动化输出和从对话保存的交付物均通过同一计费函数。
- 同一物理 backing 被多个映射引用时，按稳定 backing ID 去重；资产版本的每个独立物理版本按实际大小计一次。
- 所有写入路径在落 staging 前做快速预检，在提交事务内再次强制检查，返回稳定的 `USER_STORAGE_QUOTA_EXCEEDED`，携带安全的 `limitBytes`、`usedBytes`、`requestedBytes`。

### 6.2 上传限制

- Portal 文件选择器和聊天附件选择器在客户端显示单文件 10MB、当次 20MB 的即时错误；这是体验层，不是安全边界。
- Connector、HTTP route、attachment store、asset upload、conversation save、automation commit 均对原始字节执行同一 10MB 单文件与 20MB 请求上限规则。旧内部系统文件、模板和受控 backfill 不经用户上传入口，但写入长期用户资产时仍经过 200MB 配额检查。
- base64 HTTP payload 允许必要的编码开销，限额始终按解码后的原始文件字节计算。

### 6.3 图片压缩

- 图片 `<= 1MB`：保留原始内容、原始格式及 checksum，不转换。
- 图片 `> 1MB`：客户端可先生成压缩候选减少网络负担；服务端必须独立识别图片、去除 EXIF 并进行受控转码/缩放，不能信任客户端处理结果。
- JPEG/WebP 采用逐级质量与最长边限制的压缩策略；PNG 以无损优化为先，只有明确无透明度且体积无法控制时才按策略转为 WebP。保留用户可见的原文件名并返回最终 canonical MIME/大小。
- 压缩以文字和图表可读为优先，不设“必须压到 1MB”的目标；最终输出仍必须 `<= 10MB`，否则拒绝并给出可操作的错误。
- 新增或确认服务端图像编码依赖在本地、CI 和生产运行时可用；不能仅依赖浏览器 Canvas。

## 7. 分阶段执行计划

### Phase 0：冻结契约与影响面

1. 更新 `docs/user-asset-library-contract.md` 的大小矩阵、会话语义和兼容矩阵，明确 10MB / 20MB / 200MB、报告映射和图片规则。
2. 更新 `docs/user-portal-protocol.md` 的 `asset.list` / 上传返回模型，增加 storage usage；只在版本协商后加入新字段或采用向后兼容的可选字段。
3. 盘点所有长期写入入口：资产上传、版本上传、对话保存、自动化输出、报告发布/映射、恢复版本；盘点所有临时附件入口，防止绕过限制。
4. 产出迁移说明：只 additive migration，禁止删除或移动真实 Workspace、旧报告、旧任务资产。

### Phase 1：Runtime 配额与统一限制

1. 添加配额表、Drizzle schema 与 additive migration；三元 scope 建唯一约束。
2. 实现原子预留/结算和 backing 去重逻辑，接入 `createUserAsset`、`uploadUserAssetVersion`、`restoreUserAssetVersion` 及通用自动化输出提交。
3. 将 `MAX_BYTES` 替换为统一单文件 10MB 边界，同时保留格式/MIME/结构校验。
4. 在 attachment store 和 Portal connector 处落实每文件 10MB、每请求 20MB；保持“临时附件不占长期配额”。
5. 在资产列表响应中返回用量；对于现有资产/报告，提供只读可重复的 usage reconciliation/backfill 脚本与审计报告，不自动修改用户字节。

### Phase 2：报告映射与来源模型

1. 新增通用映射记录或等价的受控 catalog 读取层，支持 `asset` 与 `report` 两种 backing；所有查询强制三元 scope。
2. 将报告生成成功路径登记为 report 映射，并写入审计和配额结算；失败不得留下可见映射或错误计费。
3. 让 `asset.list` 返回统一条目和来源标签，避免将旧 `artifact.library.list` 改名或破坏其兼容语义。
4. 为旧报告实现按需、只读映射适配；拒绝路径逃逸、未知 MIME、无有效大小或超过用户配额的条目。

### Phase 3：图片压缩服务

1. 选定并安装可在生产运行时稳定使用的服务端图片处理库，封装为单一 image normalization service。
2. 将大图片压缩接到资产上传和“保存到我的文件”路径；保留 <=1MB 图片原样写入。
3. Portal 在本地压缩发生时显示“正在优化图片”和压缩后的大小；服务端最终返回才作为成功依据。
4. 覆盖 JPEG、WebP、透明 PNG、不可解码图片、伪造 MIME、EXIF、压缩后仍超限和不应压缩的 <=1MB 图片。

### Phase 4：Portal 资产页与右侧预览

1. 扩展 `/assets`：来源分类、搜索、归档切换、容量条与文字 `已使用 X / 200MB`，并显示剩余容量。
2. 上传 UI 支持多文件/总量校验，逐文件展示错误、图片优化状态及配额不足提示；不得在客户端提前声称保存成功。
3. 抽取现有 `AssetLibraryShell` 的预览逻辑为可复用右侧 `FilePanel`，用全局互斥状态替代居中详情弹窗。
4. 在对话交付卡、报告入口和自动化运行产物中接入同一 FilePanel；点击链接不触发第二个文件工作区。
5. 覆盖桌面和移动：桌面右抽屉固定宽度并保持聊天/报告主体可读；窄屏使用全屏抽屉。

### Phase 5：对话、自动化与兼容性收口

1. 聊天附件保持临时状态；对话文件卡提供明确“保存到我的文件”，操作后创建资产版本、来源 `conversation`、占用配额并更新卡片状态。
2. AI 生成的可下载文件在对话中先作为交付物；只有用户保存时进入长期资产。自动化声明 `create`/`update` 的产物可按任务授权直接入库，但受 10MB/200MB 强制约束。
3. 自动化和报告失败时显示运行/报告错误，不把“配额不足”降级为普通聊天成功，也不创建会话或半成品资产。
4. 复核旧 `conversation_artifacts`、旧报告库、旧表格自动化、Workspace 浏览器和生产数据的兼容行为。

## 8. 测试与验收

### Runtime 自动测试

- 10MB 以下文件可保存；`>10MB` 的上传、对话保存与自动化输出均被拒绝。
- 多文件原始总量 20MB 以内可提交，超过 20MB 被拒绝；base64 编码长度不影响判定。
- 同 scope 的资产版本、报告映射、归档版本累计到 200MB 后，下一次写入返回 `USER_STORAGE_QUOTA_EXCEEDED`；失败写入不泄漏 reservation。
- 并发两个写入不会使配额超过 200MB；重试、幂等回放、事务回滚和 lease 失败的计费正确。
- 其他用户/实例不能读到 usage、映射或绕过配额写入。
- <=1MB 图片字节与 checksum 原样保留；>1MB 图片经过服务端压缩；恶意图片、MIME 伪造、不可压缩超限均失败且无残留。
- 临时聊天附件不进入资产列表、不占长期配额；显式保存后可见且可追溯来源。
- 报告映射不复制字节，两个映射不重复计费，旧报告不被自动移动或改写。

### Portal 浏览器验收

- “我的文件”可见准确的 `已使用 / 200MB`；刷新、筛选、归档后不出现错误统计。
- 上传超过 10MB、批量超过 20MB、配额不足均在提交前给出清晰提示，服务端拒绝后界面不出现假成功。
- 小图片上传后 checksum/大小未变化；大图片显示优化进度并可打开、下载。
- 从报告、对话和自动化运行点击同一文件，都使用同一个右侧预览面板；打开预览会抑制文件工作区，关闭后可恢复。
- 在移动宽度下没有遮挡、无法关闭的抽屉或双滚动区域；Esc、关闭按钮和焦点恢复正确。

### 发布与回滚

- 数据库仅 additive migration；发布前按现有生产运维流程备份 SQLite，禁止重建资产表或批量迁移真实 Workspace。
- 先以隔离测试用户完成配额、图片、报告映射和对话保存端到端 smoke，再发布。
- 回滚只回滚代码与新增 UI；已提交资产版本、报告映射和配额审计保留，服务需容忍新表存在。

## 9. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 配额统计与并发写入竞争 | 服务端事务预留和 resource mutation lock；Portal 仅展示，不做权威判断。 |
| 图片压缩导致图表文字失真 | 仅 >1MB 执行；优先缩放与保守质量，保留最终预览；失败时拒绝而不是静默降质。 |
| 报告映射影响旧报告契约 | 用独立映射/适配层，不将 `artifact.library.list` alias 成 `asset.list`，不移动既有字节。 |
| 用户已超过 200MB | 先统计并显示；禁止新增长期写入但保留读取、下载和归档；不自动删除。 |
| 客户端绕过限制 | Runtime 对全部写入口按解码后字节、MIME、checksum、scope 与配额二次校验。 |
| 两个右侧面板状态冲突 | 全局互斥 FilePanel 状态；组件不得各自维护独立可见状态。 |

## 10. 交付物

1. 更新后的资产/协议契约与迁移说明。
2. 配额 schema、运行时服务、统一限制和图片 normalization service。
3. 报告映射 catalog 适配和审计/用量查询接口。
4. Portal 容量条、上传反馈、来源分类与统一右侧 FilePanel。
5. Runtime 合同测试、Portal 单元测试、隔离用户浏览器验收记录、发布/回滚记录。

## 11. 执行交接

Executor prompt:

> Implement `docs/user-file-library-quota-and-preview-execution-plan.md` in phases. Preserve the three-field scope boundary, existing report and legacy artifact protocols, task-asset compatibility, and real user Workspace contents. Use additive database migrations only. Treat 10MB per file, 20MB per upload request, 200MB per scope, explicit conversation save, and >1MB-only image compression as server-enforced contracts. Report blockers rather than broadening scope or silently changing product semantics.

Reviewer prompt:

> Independently review the implementation against `docs/user-file-library-quota-and-preview-execution-plan.md`. Lead with violations of quota atomicity, scope isolation, report no-copy mapping, transient attachment behavior, image threshold behavior, and the right-panel mutual-exclusion requirement. Verify with automated tests and an isolated-user browser flow; do not accept self-reported completion as evidence.
