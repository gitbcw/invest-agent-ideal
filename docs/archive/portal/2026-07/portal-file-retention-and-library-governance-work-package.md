# Portal 文件生命周期、永久文档库与用户删除工作包

> **边界更新（2026-07-25）**：Portal 文件目录已改为 workspace 工程文件只读浏览。网页端不再允许删除、编辑、移动或重命名；`artifact.delete.*` connector 能力和 Portal 删除入口已退役。本文中的删除/精选库内容只保留为历史生命周期实现记录，不再是当前 Portal 产品契约。用户要求文件变更时必须通过 AI 对话；AI 文件级写白名单仍需从当前 `workspace-write` 运行时迁移到服务层受控写能力，迁移完成前不得把提示词纪律描述成硬隔离。

> 状态：Runtime/协议/测试已实现（Phase A+B + 自动化测试）；生产 Phase C/D 首次真实清理待运维显式确认
> 日期：2026-07-25
> 面向角色：目标模式执行 Agent、独立验收 Agent
> 依赖：`docs/portal-multi-file-workspace-library-work-package.md`（已完成并部署）
> 重要：本工作包扩展此前“文件树只显示 Markdown/HTML 正式 artifact”的选择规则；冲突处以本文为准。

## 实现落点（已实现）

Runtime 侧已落地的代码：

- `src/db/schema.ts` + `src/db/index.ts`：新增 `conversation_attachments` 表与 `conversation_artifacts` 的 additive retention 列 + 索引；migration 幂等。
- `src/lib/attachment-store.ts`：上传时计算 checksum，`ATTACHMENT_RETENTION_DAYS=7`。
- `src/services/conversation-log.ts` + `src/channels/weixin-message-bridge.ts`：上传后写入权威 attachment 行，并在消息 metadata 暴露 `expiresAt`。
- `src/services/conversation-artifacts.ts`：发布时按确定性规则计算 `origin/retention_class/visibility/expires_at`；1 MiB durable 边界；library list 过滤 deleted/expired、支持 image/pdf/text/table 与 `category/downloadable/openRoute`。
- `src/services/file-retention.ts`：权威 attachment 索引、7d 过期读取（`ATTACHMENT_EXPIRED/DELETED`）、幂等带锁清理、空目录 prune。
- `src/services/artifact-deletion.ts`：prepare/confirm 一次性 scope-bound token、隐藏回收区 30d、同路径 tombstone、purge job。
- `src/services/file-retention-backfill.ts`：artifact retention 分类、精选目录扫描注册、附件索引回填（全幂等）。
- `src/portal/connector.ts`：`attachment.get` / `artifact.delete.prepare` / `artifact.delete.confirm` 命令 + capability。
- `src/scheduler/file-retention.ts` + `src/services/attachment-retention.ts` + `src/index.ts`：日清理与回收区 purge job，受 `FILE_RETENTION_CLEANUP_ENABLED` 与 `scheduled_task_runs` 锁保护。
- `src/scripts/file-retention-backfill.ts` + `src/lib/sqlite-ops.ts`：`retention:report/backup/backfill/cleanup/trash` CLI（dry-run/apply 双闸门）。
- 测试：`tests/file-retention.test.ts`（14 例）覆盖 D1-D3、D8-D13；`tests/attachment-retention.test.ts` 更新为 shim 行为；`tests/conversation-artifacts.test.ts` 更新为新的库准入/路由契约。

未在本仓库实现的（属 Portal 前端仓库，仅通过协议/capability/错误码契约交付）：附件过期卡片、删除确认弹窗、文件树 image Lightbox/download 路由的实际渲染。

## 1. 目标模式任务定义

### Objective

建立明确、可审计、可执行的用户文件生命周期，并把用户 Workspace 中已有的重要投资产物有选择地开放到 Portal：

1. 用户通过 Portal 或微信发给 AI 的图片/文件，内容保留 `7` 天；到期后删除文件字节，但保留对话消息和安全元数据，Portal 显示“附件已过期”。
2. AI 正式生成并发布、体积不超过 `1 MiB` 的重要文件/图片，作为永久 artifact 保存在用户 Workspace，直到用户主动删除。
3. AI 生成但不满足永久条件的临时产物，保留 `7` 天，不自动进入永久文档库。
4. 把现有日复盘、周复盘、月复盘、公司/财务分析、决策指标和经过整理的用户记忆摘要纳入精选文档库。
5. 不直接开放完整 Workspace、原始 memory 事件流、Skills、配置、财务原始资料或运行状态。
6. 用户可以在右侧文件树中下载或删除永久 artifact；删除具备明确确认、审计和短期恢复能力。
7. 采用分阶段迁移和启用策略：先加字段/索引与 dry-run，再经备份和明确确认启用第一次真实清理。

### Completion Definition

只有以下条件全部满足时，目标才可标记完成：

- 新上传附件获得服务端权威 `expiresAt = storedAt + 7 days`，过期清理不依赖文件夹名称猜测。
- 过期附件的消息仍在，文件字节不可读取，Portal 明确显示已过期且不永久 loading。
- 新的正式 AI artifact 在 `<= 1 MiB` 且符合准入规则时标记为永久、无 `expiresAt`，重启和长期清理后仍可读/下载。
- `> 1 MiB`、legacy、临时和未正式发布的 AI 产物不会被误判为永久。
- 现有用户的精选历史产物完成幂等 backfill，文件树可见日/周/月复盘、公司/财务分析、指标和整理后的记忆摘要。
- 原始 `memory/*.jsonl`、`financials/companies/**`、配置、Skills、审计和任务运行文件不可见。
- 侧栏删除只作用于当前 user/instance 的永久库文件，确认后立即从 UI 消失，30 天内可由运维恢复，之后才物理清除。
- 跨用户、跨实例、路径逃逸、symlink、删除其他用户和重复清理均被拒绝或安全幂等。
- Runtime/Portal 测试、类型检查、构建、迁移升级测试和桌面浏览器验收通过。
- 火山云生产 Portal 必须在固定公网 IP + HTTP（非 secure context）下完整支持图片预览、文档打开、下载与 checksum 校验；不得把 HTTPS 或 `crypto.subtle` 作为功能前提，异步失败不得永久停留在 loading。
- 火山云代码和 additive schema 发布后，生产数据先备份并完成 dry-run；未经单独确认不执行首次批量物理删除。

## 2. 当前实现审计结论

### 2.1 当前没有完整的“3 天清理闭环”

代码现状：

- 用户附件写入 `attachments/YYYY-MM-DD/`，文件名含随机 attachment ID。
- `conversation_messages.metadata.attachments` 保存安全相对路径等元数据。
- 没有权威 `conversation_attachments` 表、`expiresAt`、`deletedAt` 或幂等清理记录。
- 未发现按 3 天真正执行的附件清理调度器。
- Workspace 模板 `config/privacy.yaml` 当前写的是 `reports: user_controlled`、`memory: user_controlled`，也不是 3 天策略。

因此本任务不是把常量从 `3` 改成 `7`，而是补齐“保存时分类 -> 权威到期时间 -> 定时清理 -> Portal 过期状态 -> 审计”的完整链路。

### 2.2 当前永久文件已经存在，但很多没有进入 Portal 索引

- 日复盘会同步到 `reports/daily/`，正式 `reviews.save` 会发布 artifact。
- 周/月复盘 Skill 输出到 `reports/weekly/`、`reports/monthly/`。
- 公司财务分析输出到 `reports/company/`。
- 指标、流程图等位于 `reports/metrics/`。
- 当前文件树只列 `conversation_artifacts` 中来源为 `artifacts.publish` / `reviews.save` 的 Markdown/HTML，因此旧文件或只落盘未发布的文件不可见。
- `memory/*.jsonl` 是 Agent 内部结构化记录，不应原样暴露，但可以生成用户可读摘要后放入 `reports/memory/`。

### 2.3 当前缺少用户删除契约

artifact 现有能力覆盖 list/get/event，没有经过确认的 delete、tombstone、回收站和物理清理流程。删除不能只在 Portal 隐藏，也不能由浏览器提交任意相对路径。

## 3. 权威生命周期策略

### 3.1 策略矩阵

| 数据类别 | 例子 | 保留级别 | 内容期限 | Portal 可见性 | 到期/删除行为 |
| --- | --- | --- | --- | --- | --- |
| 用户上传附件 | Portal/微信图片、PDF、DOCX 等 | `transient_upload` | 7 天 | 原对话内可查看/下载；到期后只显示元数据 | 到期清除字节，消息保留 |
| AI 永久 artifact | 正式复盘、公司分析、指标、重要图表 | `durable_library` | 永久，直到用户删除 | 文件树 + 对话 artifact | 用户删除后进隐藏回收区 30 天 |
| AI 临时 artifact | >1 MiB、明确 transient、非精选输出 | `transient_generated` | 7 天 | 原对话内可查看/下载，不进入永久树 | 到期清除字节，descriptor 标记 expired |
| legacy 路径映射 | 用户点击旧 `/home/.../reports/...` 链接产生 | `reference_only` | 不改变底层文件生命周期 | 仅兼容当前点击，不进入永久树 | 不凭 legacy 记录删除文件 |
| 内部 Workspace 状态 | config、Skills、raw memory、audit/task logs | `workspace_internal` | 由 Workspace/服务规则管理 | 不对 Portal 开放 | 本任务不清理 |
| 回收站 artifact | 用户从文件树删除的永久文件 | `trashed` | 30 天 | 不在普通文件树/对话预览中可读 | 30 天后物理清除 |

所有期限按 UTC 时间计算：

- 用户上传和临时 AI 产物：`expiresAt = storedAt + 7 * 24h`。
- 查看、下载、切换标签或重新登录不会延长 TTL。
- 永久 artifact 的 `expiresAt = null`。
- 回收站 `purgeAt = deletedAt + 30 * 24h`。

### 3.2 “重要 AI 产物”的确定性定义

禁止让模型用自然语言主观判断“这个文件重要”。永久准入由服务层规则决定。

文件必须同时满足：

1. 来源是 `reviews.save`、正式 `artifacts.publish`、受控系统报告发布，或经本工作包 backfill 登记。
2. 文件位于用户 Workspace 的 `reports/**`，realpath 仍在 reports 根目录内。
3. 文件大小 `<= 1,048,576` bytes；按实际读取大小判定，不信任调用方声明。
4. MIME/扩展名/内容检查通过现有 artifact 安全规则。
5. 不属于隐藏、临时、备份、告警噪声或内部状态路径。
6. 未标记 `visibility=conversation_only` 或 `retention=transient`。

自动永久来源：

- `reviews.save` 产生的正式日复盘。
- 正式发布到第 4 节精选目录的周/月复盘、公司/财务分析、指标报告、记忆摘要。
- Agent 在当前 turn 中通过 `artifacts.publish` 明确交付给用户、且满足大小/格式/路径条件的文件或图片。

不会自动永久：

- `source=legacy_path`。
- `reports/alerts/**` 高频告警明细。
- 文件名为隐藏/临时/备份模式。
- 未经过 artifact 发布、也不属于允许 backfill 目录的任意 Workspace 文件。
- 超过 1 MiB 的文件；首版作为 7 天临时产物。未来出现稳定的大文件长期需求时再引入对象存储，不在本任务绕过阈值。

## 4. 精选开放目录与内容分类

### 4.1 首批永久文档库

| Workspace 来源 | Portal 分类 | 自动 backfill | 打开方式 |
| --- | --- | --- | --- |
| `reports/daily/**` | 日复盘 | 是 | Markdown/HTML 标签 |
| `reports/weekly/**` | 周复盘 | 是 | Markdown/HTML 标签 |
| `reports/monthly/**` | 月复盘 | 是 | Markdown/HTML 标签 |
| `reports/company/**` | 公司与财务分析 | 是 | Markdown/HTML 标签；安全图片走 Lightbox |
| `reports/metrics/**` | 决策指标与图表 | 是 | 文档标签或图片 Lightbox |
| `reports/memory/**` | 投资记忆摘要 | 仅受控生成文件 | Markdown/HTML 标签 |
| 其他正式 `artifacts.publish` 文件 | 其他产物 | 不做目录扫描；发布时登记 | 按 MIME 路由 |

支持进入永久库的 MIME 首版沿用现有安全 artifact 集合，但大小必须 `<=1 MiB`：

- `text/markdown`
- 严格 sandbox 的 `text/html`
- `image/svg+xml`、`image/png`、`image/jpeg`、`image/webp`
- `application/pdf`、`text/plain`、`application/json`、`text/csv` 可以进入库并下载；不因此扩展侧栏渲染范围。

打开路由保持既有产品决定：

- Markdown/HTML：右侧多标签文档工作区。
- SVG/PNG/JPEG/WebP：独立 Lightbox，不进入文档标签。
- PDF/TXT/JSON/CSV：在文件树显示文件信息与下载操作；首版不新增预览器。

### 4.2 明确不开放

- `financials/companies/**` 中的原始财报、授权数据和来源文件：它们可能较大、具许可限制，也不是 AI 生成的用户报告。
- 原始 `memory/audit_events.jsonl`、`behavior_events.jsonl`、`source_events.jsonl`、`task_runs.jsonl`、`change_log.jsonl`。
- `config/**`、`knowledge/**`、`.codex/**`、`skills/**`、schemas、代码、日志、数据库和运行状态。
- `reports/alerts/**` 高频告警详情，首版不进入永久用户库。
- 附件目录 `attachments/**`；用户上传只能从原对话访问 7 天。

### 4.3 用户可读“记忆”

不直接展示 raw JSONL。新增确定性的用户可读摘要产物：

- `reports/memory/decision-journal.md`：从 `memory/decisions.jsonl` 汇总已记录观点、动作、验证状态和来源日期。
- `reports/memory/method-evolution.md`：从 `memory/method_changes.jsonl` 汇总候选、已确认和已拒绝的方法变化。

要求：

- 摘要明确生成时间和数据截止时间。
- 不把内部 trace、工具名、系统 prompt、审计 token、原始行为事件或未经用户确认的方法候选伪装成已采用规则。
- 摘要是可删除的派生文档；删除摘要不删除底层 memory 记录。
- 首版不开放 feedback/source/audit/task/behavior 原始记录。
- 生成/刷新摘要使用确定性服务或受控 Skill，产物仍走 `artifacts.publish` 并受 1 MiB 阈值约束。

## 5. 用户上传附件：7 天保留

### 5.1 权威 attachment 索引

新增服务层表 `conversation_attachments`，而不是从消息 JSON 或目录日期推算清理：

```text
attachment_id       primary key
user_id             required
instance_id         required
conversation_id     required
message_id          nullable until message persisted
source              portal | weixin
kind                image | document
mime_type
file_name
relative_path       workspace-safe relative path
size_bytes
checksum
retention_class     transient_upload
stored_at
expires_at
deleted_at          nullable
delete_reason       nullable (expired | user_deleted | missing | cleanup_error)
updated_at
```

保存路径仍可使用 `attachments/YYYY-MM-DD/`，但日期目录只是组织方式，不是权威 TTL。

### 5.2 读取与 Portal 状态

新增受 session scope 保护的 attachment read 能力，按 `attachmentId` 读取，不接受 raw path：

- 7 天内：用户可在原对话中查看图片或下载文件。
- 到期/已删除：返回稳定错误 `ATTACHMENT_EXPIRED` / `ATTACHMENT_DELETED`，不返回路径。
- Portal 对话消息保留文件名、MIME、大小、发送时间和 `expiresAt`。
- 到期后附件卡片显示“附件已过期”，移除查看/下载动作；消息正文和对话仍保留。
- 图片预览使用现有安全 Blob/Lightbox 方式；文档只下载，不为本任务新增 Office 预览。

### 5.3 清理任务

服务层每日执行一次幂等清理，也提供运维 dry-run 命令：

1. 查询 `expires_at <= now AND deleted_at IS NULL`。
2. 对每条记录重新校验 user workspace、attachments 根目录和 realpath containment。
3. 只 unlink 精确文件，不递归删除用户目录。
4. 文件不存在视为幂等成功并记录 `missing`，不能让整个批次失败。
5. 更新 `deleted_at/delete_reason`，记录聚合审计、成功/失败计数和字节数。
6. 空日期目录可以在确认无索引文件后删除，但不是完成条件。

任务必须有锁/租约，避免多个进程重复清理；批次大小受限，单项失败不阻断后续项。

## 6. AI artifact 保留元数据

对 `conversation_artifacts` 做 additive migration，建议新增：

```text
origin              assistant | system | workspace_backfill | legacy
retention_class     durable_library | transient_generated | reference_only | trashed
visibility          library | conversation_only | hidden
expires_at          nullable
deleted_at          nullable
deleted_by          nullable
delete_reason       nullable
trash_relative_path nullable
purge_at            nullable
```

规则：

- 新 `reviews.save` 和合格 `artifacts.publish` 在写入时一次性计算 retention，不依赖 Portal 推断。
- transient artifact 到期后，artifact.get 返回 `ARTIFACT_EXPIRED`。
- durable artifact 无 expiresAt，除非用户删除。
- library list 只返回 `visibility=library AND retention_class=durable_library AND deleted_at IS NULL`。
- 同一路径多版本共享一个实际文件时，删除必须按 `userId + instanceId + normalized relativePath` tombstone 所有相关可见记录，避免旧版本 fallback 重新出现。
- checksum 不匹配、路径逃逸或文件缺失不能被 backfill 成 durable。

## 7. 历史文件与记录 backfill

### 7.1 AI artifact 记录回填

对现有 `conversation_artifacts` 幂等分类：

- `reviews.save` / `artifacts.publish` + 文件有效 + <=1 MiB + 非排除路径：`durable_library`。
- 正式来源但 >1 MiB：`transient_generated`；第一轮只计算 expiresAt 和报告，不立即删除。
- `legacy_path`：`reference_only`。
- 无法验证的记录：保持不可见，写入迁移报告，不猜测。

### 7.2 既有 Workspace 报告发现

只扫描第 4.1 节固定目录，不扫描整个 Workspace：

- 每个 production user/instance 独立解析 workspace。
- 文件有效、支持 MIME、<=1 MiB 时注册新 artifact，`origin=workspace_backfill`、`source=workspace_backfill`、`retention_class=durable_library`。
- artifactId 由服务生成；不绑定历史对话，不伪造 assistant message。
- 以 `userId + instanceId + relativePath + checksum` 保证幂等。
- 不移动、不改写原文件。
- 大文件、隐藏/临时/备份、symlink、未知 MIME 和 reports/alerts 只出现在 dry-run 排除报告。

如外部 canonical `reviews/` 中有文件但对应 Workspace reports 镜像缺失，只在 scope 映射完全确定时使用现有 review 同步逻辑补齐；不得直接把共享 reviews 根目录暴露或批量复制进错误用户 Workspace。

### 7.3 用户附件索引回填

- 从 `conversation_messages.metadata.attachments` 与安全相对路径回填 `conversation_attachments`。
- 以 metadata 的消息时间/文件 stat 时间中更可靠者确定 `storedAt`，无法确定时进入人工报告，不猜测过期时间。
- 已超过 7 天的历史附件先标为 `cleanup_candidate`，首次部署不立即 unlink。
- 生成逐用户 dry-run：候选文件数、总字节、最早/最晚时间、无法归属、孤儿文件、路径异常。

## 8. 侧栏下载与删除

### 8.1 文件树展示扩展

在已完成的精选文件树上增加：

- 永久 Markdown/HTML 文档。
- 永久 AI 图片，点击后走 Lightbox。
- 永久 PDF/TXT/JSON/CSV 文件，显示下载动作，不放入文档标签。
- 每项可显示类型、大小和生成/更新时间；不显示 absolute path、retention 内部字段或数据库 ID。
- 用户上传附件不进入文件树。

### 8.2 删除交互

每个永久库文件提供熟悉的删除图标按钮和 tooltip。删除必须是两步确认：

1. `artifact.delete.prepare`：服务按 session scope 返回一次性 confirmation token、标题、展示路径、大小和影响说明。
2. Portal 显示确认对话框。
3. `artifact.delete.confirm`：携带 token 执行；token 绑定 user/instance/artifact/path/checksum，短时有效且只能消费一次。

确认文案至少说明：

- 文件将立即从文档库和已打开标签中移除。
- 日/周/月复盘等文件删除后可能影响后续复盘的历史输入。
- 系统保留 30 天恢复窗口，之后永久清除。

删除成功后：

- 文件从原位置移动到用户 Workspace 内隐藏回收区，例如 `.trash/artifacts/<opaque-id>/...`，禁止使用用户输入构造目标路径。
- 当前路径的相关 artifact 记录全部 tombstone，library list 不再返回。
- 相关标签关闭；历史对话卡片显示“文件已删除”，不再下载。
- 写入包含 user/instance/artifact、大小、原安全相对路径摘要和 purgeAt 的审计；不记录绝对路径。

首版不提供用户侧“回收站/恢复”UI。30 天内只允许受审计的运维恢复；后续有真实需求再增加用户恢复界面。

### 8.3 删除权限与竞态

- 浏览器不能提交 userId、instanceId、relativePath 或 trash path。
- 只允许删除 `durable_library` 且 `visibility=library` 的 artifact。
- raw memory、config、Skills、financials 来源文件和 user uploads 不通过 artifact delete API 删除。
- delete 与 artifact.get/list 使用事务/tombstone 顺序，确认后不能在竞态窗口继续读到文件。
- 重复 confirm 返回幂等结果，不重复移动文件。
- scheduler 正在读取复盘文件时，删除要么等待 scope 锁，要么返回可重试冲突，不在读取中途移动。

## 9. API 与错误契约

### Runtime/connector 新增或扩展

- `attachment.get`
- `artifact.delete.prepare`
- `artifact.delete.confirm`
- `artifact.library.list` 扩展 category、downloadable 和媒体路由安全字段
- 内部 retention dry-run / cleanup 命令（不暴露给普通 Portal 浏览器）

建议错误：

- `ATTACHMENT_EXPIRED`
- `ATTACHMENT_DELETED`
- `ARTIFACT_EXPIRED`
- `ARTIFACT_DELETED`
- `ARTIFACT_NOT_DELETABLE`
- `ARTIFACT_DELETE_CONFIRMATION_REQUIRED`
- `ARTIFACT_DELETE_CONFIRMATION_EXPIRED`
- `ARTIFACT_DELETE_CONFLICT`

所有 API：

- scope 来自 authenticated Portal session + connector registration。
- 不接受 absolute/raw path。
- 复用现有 artifact/attachment MIME、size、realpath 和 symlink 边界。
- 旧 connector capability 缺失时 Portal 降级，不影响聊天。

## 10. 迁移与生产启用顺序

### Phase A：Additive schema 与兼容读写

1. 备份生产 SQLite 并执行 `quick_check`。
2. 新增 `conversation_attachments` 和 artifact nullable columns/indexes。
3. 旧记录在字段为空时继续按旧行为可读；不能因 migration 立即过期。
4. 部署新写入路径、Portal 过期/删除状态和 capability，但 retention cleanup 保持 disabled。
5. 验证新上传附件和新 artifact 的 retention 字段正确。

### Phase B：Backfill 与 dry-run

1. 回填 attachment 索引和 artifact retention 分类。
2. 扫描固定报告目录，注册历史精选文件。
3. 生成逐用户报告和 SHA/数量/字节统计。
4. 验证 mg、111、dyk 的库内容与排除内容。
5. 只报告拟删除/拟入库项，不 unlink、不移动。

### Phase C：明确确认后启用真实清理

第一次真实清理属于 material destructive action，必须在 Agent 展示以下内容后取得明确确认：

- 备份路径与校验结果。
- 每个 user/instance 的到期附件数量和总字节。
- 无法归属、路径异常和孤儿文件数量。
- 本次不涉及的永久报告、raw memory 和 Workspace 配置清单摘要。

确认后先小批量执行，再验证 Portal expired 状态、SQLite、文件数和日志，最后启用每日 job。普通后续到期清理由已启用策略自动运行，不需逐项确认。

### Phase D：回收站清理

- 用户主动删除进入回收站后，独立 job 清理 `purgeAt <= now` 项。
- 首次启用同样先 dry-run；只清理由服务记录创建的精确 trash path。
- Runtime 回滚不能使 tombstone 文件重新出现在库中。

## 11. 代码落点

### Runtime

- `src/lib/attachment-store.ts`
  - 保存 checksum/TTL 元数据，禁止仅按日期目录决定生命周期。
- `src/services/conversation-log.ts`
  - attachment 记录与 messageId 绑定。
- `src/services/conversation-artifacts.ts`
  - retention 分类、library 扩展、expired/deleted 读取、backfill helper。
- `src/portal/connector.ts`
  - attachment get、artifact delete prepare/confirm、capability。
- `src/db/schema.ts` 与 `src/db/index.ts`
  - additive schema 和升级幂等性。
- 新增服务建议：
  - `src/services/file-retention.ts`
  - `src/services/artifact-deletion.ts`
- scheduler/运维脚本：
  - retention dry-run
  - attachment expiry cleanup
  - trash purge
  - curated workspace backfill
- `src/mcp/invest-agent-service-tools.ts`
  - 明确 publish 后的永久/临时结果和 1 MiB 规则；不让模型绕过服务判定。
- Workspace 模板只更新说明/起始 Skill；普通发布不得覆盖真实用户 Workspace。

### Portal

- 对话附件卡片：7 天内查看/下载，到期/删除状态。
- 文件树：新增 durable 图片和下载型文件，删除动作与确认对话框。
- DocumentWorkspace：收到 delete 成功后关闭匹配标签并刷新树。
- ImageLightbox：durable image 的下载与 deleted/expired 状态复用现有安全管线。
- Portal protocol/types/API routes：新增 capability 和错误映射。

### 文档

- `docs/user-portal-protocol.md`
- `docs/table-ownership.md`
- `docs/system-overview.md`
- `CLAUDE.md` 运维命令与生命周期说明
- `templates/workspace/config/privacy.yaml` 仅更新新建 Workspace 初始说明，不覆盖真实 Workspace。

## 12. 自动化测试要求

### Attachment retention

- Portal/微信附件均写入 7 天 expiresAt。
- 到期前 get 成功；到期后 get 返回 expired 且不返回 bytes/path。
- 查看/下载不续期。
- cleanup 幂等、并发锁有效、缺失文件不阻断批次。
- 路径逃逸、symlink、错误 user/instance 和伪造 attachmentId 被拒绝。
- 消息 metadata 在清理后仍可解析，Portal 显示 expired。

### Durable artifact

- 正式发布 1 MiB 边界：`1,048,576` bytes durable，`1,048,577` bytes transient。
- reviews.save、artifacts.publish、workspace_backfill 的分类正确。
- legacy、alerts、隐藏/临时、未知 MIME 和不安全文件不永久化。
- durable artifact 无 expiresAt；transient 7 天后 expired。
- library list 过滤 deleted/expired，按格式返回正确打开路由。

### Backfill

- 日/周/月/company/metrics 固定目录入库。
- raw memory、financials、config、Skills、alerts、attachments 不入库。
- 同 path+checksum 重跑不重复。
- 同路径新 checksum 创建新版本并只展示最新有效版本。
- dry-run 不修改文件，不写 destructive 状态。

### Delete/trash

- prepare/confirm token 绑定 scope、path、checksum，过期/重放/篡改失败。
- 删除其他 user/instance、raw internal、transient upload 被拒绝。
- 删除 tombstone 同路径版本并移入精确 trash path。
- library、tabs、历史卡片状态一致。
- 30 天边界和 purge 幂等正确。
- scheduler 读取竞态返回冲突或安全串行。

### Migration

- fresh DB、旧 DB 升级、重复启动迁移均通过。
- nullable compatibility 期间旧 Runtime/Portal 不崩溃。
- production-like fixture 的 backfill 数量与 dry-run 可复现。

## 13. 浏览器验收

仅桌面：`1440 x 900`、`1920 x 1080`。

至少验证：

1. 上传图片和文档，Portal 显示保留截止时间并可读取。
2. 使用测试时钟跨过 7 天，附件卡片显示“已过期”，对话仍在。
3. 文件树出现 backfill 的日/周/月、company、metrics 和 memory summary。
4. 文件树不出现 raw memory、financials、config、Skills、alerts 或用户附件。
5. 打开 Markdown/HTML、多标签切换；打开 AI 图片进入 Lightbox；下载其他 durable 文件。
6. 1 MiB 边界样本分别进入永久/临时路径。
7. 删除一份非关键测试报告：确认弹窗、树/标签移除、历史卡片 deleted 状态。
8. 取消删除时没有任何状态变化。
9. 删除周/月复盘类测试文件时显示“可能影响后续复盘”提示。
10. connector 离线时删除禁用或明确失败，现有 UI 不永久 loading。
11. 恢复 connector 后树刷新；跨 user/instance 看不到/删不了其他文件。

生产只读验收不得上传真实敏感文件或发送微信消息。需要时间边界/删除的测试在隔离 fixture 完成；生产只验证已有库、capability、dry-run 和健康状态。

## 14. 验收清单

| 编号 | 必验结果 | 判定标准 |
| --- | --- | --- |
| D1 | 上传 7 天 | Portal/微信上传均由权威索引计算 7 天，读取不续期 |
| D2 | 到期状态 | 到期只删 bytes，消息与安全元数据保留并显示“附件已过期” |
| D3 | 永久阈值 | 合格 AI artifact `<=1 MiB` 永久，超出 1 byte 即不自动永久 |
| D4 | 精选历史 | 日/周/月/company/metrics 与受控 memory summary 可在文件树查看/下载 |
| D5 | 内部隔离 | raw memory、financials、config、Skills、audit/task/alerts/attachments 不可见 |
| D6 | 图片路由 | 永久 AI 图片进入库但点击走 Lightbox，不进入文档标签 |
| D7 | 其他文件 | PDF/TXT/JSON/CSV 永久项可下载，但不扩展右栏预览范围 |
| D8 | 删除确认 | 侧栏删除使用 scope 绑定的一次性确认，取消无副作用 |
| D9 | 删除结果 | 确认后树/标签/卡片一致变为 deleted，文件进入 30 天隐藏回收区 |
| D10 | 删除安全 | 跨 scope、token 重放、路径篡改、内部文件和读取竞态安全处理 |
| D11 | 清理幂等 | 附件 expiry 与 trash purge 可重复运行，单项失败不阻断批次 |
| D12 | Backfill 幂等 | 重跑不重复 artifact、不改写 Workspace 文件、不误纳排除目录 |
| D13 | 迁移兼容 | fresh/upgrade/restart 通过，旧空字段在 rollout 窗口不导致服务故障 |
| D14 | 审计 | publish 分类、backfill、expiry、delete、purge 均有无绝对路径的审计证据 |
| D15 | 首次清理门禁 | 生产第一次真实删除前存在备份、dry-run 报告和明确用户确认 |
| D16 | 生产健康 | Portal `/login` 200，Runtime/Portal/111/dyk/mg online，无新错误 |
| D17 | 数据保护 | 普通部署不替换 `.env`、SQLite、Workspace、reviews、`.state` 或微信状态 |

## 15. 非目标

- 向用户展示完整 Workspace 文件系统。
- 直接展示或在线编辑 raw memory JSONL。
- 暴露原始财报许可文件或实现大型文件对象存储。
- 永久保存所有 AI 中间文件、缓存、告警明细和临时截图。
- 用户侧回收站与自助恢复 UI；首版仅保留运维恢复窗口。
- 在线编辑、重命名、移动、共享或跨用户文件协作。
- 移动端适配。
- 因模板策略变更覆盖真实用户的 AGENTS/Skills/config。
- 在未经确认的普通发布中立即删除历史附件。

## 16. 风险与缓解

- **把“重要”交给模型主观判断**：服务根据来源、目录、大小、格式和 visibility 确定 retention。
- **首次上线误删旧附件**：additive migration -> backfill -> dry-run -> 备份 -> 明确确认 -> 小批量清理。
- **暴露 raw memory**：只发布 `reports/memory` 派生摘要，原始 JSONL 永不进入 library API。
- **删除破坏复盘链**：显式影响提示、30 天隐藏回收区、调度读取冲突保护。
- **同路径多 artifact 复现已删文件**：按 normalized path tombstone 所有版本，list/get 检查 deleted state。
- **超过 1 MiB 的长期需求**：首版不绕过阈值；以真实需求决定对象存储方案。
- **附件元数据与磁盘漂移**：权威 attachment table + checksum + reconciliation dry-run，文件夹日期不作事实来源。
- **两项目协议错配**：capability gating，先 Runtime 后 Portal，旧版本安全降级。

## 17. 执行 Agent 交接提示词

```text
请进入目标模式，执行 docs/portal-file-retention-and-library-governance-work-package.md。

目标是建立真正可执行的文件生命周期：用户通过 Portal/微信上传的附件保留 7 天，到期只删除 bytes 并保留消息/元数据；AI 正式发布且 <=1 MiB 的重要 artifact 永久保存在用户 Workspace，直到用户删除；其他 AI 临时产物保留 7 天。把历史日/周/月复盘、company/财务分析、metrics 和受控 memory 摘要幂等 backfill 到文档库，绝不暴露 raw memory、financials、config、Skills、alerts 或完整 Workspace。

扩展已上线多文件树：Markdown/HTML 进标签，AI 图片进 Lightbox，其他安全小文件可下载。侧栏删除必须 prepare/confirm、scope 绑定、审计，并先移动到 30 天隐藏回收区；不得直接 raw-path unlink。新增 conversation_attachments 权威索引和 additive artifact retention 字段。

严格按 Phase A-D 执行。首次生产真实清理前必须提供 SQLite 备份、quick_check、逐用户 dry-run 和拟删除统计并取得明确确认；在此之前保持 cleanup disabled。不得 reset 共享工作树、覆盖真实 Workspace/Skills/config、替换生产数据或发送真实微信测试消息。完成 D1-D17 前不要标记目标完成。
```

## 18. 独立验收 Agent 交接提示词

```text
请独立验收 docs/portal-file-retention-and-library-governance-work-package.md，对 D1-D17 逐项给出 Pass/Partial/Fail 和证据。

重点检查：7 天是否由服务端 expiresAt 控制且访问不续期；1 MiB 边界；日/周/月/company/metrics/memory-summary backfill；raw memory/financials/config/Skills/alerts 隔离；图片 Lightbox 路由；删除 token 的 scope/过期/重放/竞态；30 天 trash；同路径版本 tombstone；cleanup/backfill 幂等；fresh/upgrade schema；以及生产首次删除是否真的经过备份、dry-run 和明确确认。

浏览器破坏性测试只在隔离 fixture 执行。生产仅做只读库、capability、dry-run、进程与日志验收，不上传敏感文件、不发送微信消息。不得以构建通过代替数据生命周期和负向权限证据。
```
