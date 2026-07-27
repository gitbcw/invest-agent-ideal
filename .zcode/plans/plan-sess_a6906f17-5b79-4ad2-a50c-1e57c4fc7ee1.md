# Portal 文件生命周期 — 前端实现计划

## 背景

后端（`invest-agent-ideal`）已交付 Phase A+B：`conversation_attachments` 权威表、artifact retention 分类、`attachment.get` / `artifact.delete.prepare` / `artifact.delete.confirm` connector 命令、capability 广播、9 个新错误码、扩展的 `ArtifactLibraryItem`（含 `category/downloadable/openRoute`）、14 例后端测试、协议文档、`retention:*` CLI。

**关键发现**：先决工作包 `portal-multi-file-workspace-library-work-package.md` 声称 Portal 前端在提交 `0244db3` 已交付"多标签文档工作区 + 精选文件树"，但核查 `/Users/combo/MyFile/projects/invest-agent-portal` 后确认：该提交不存在于任何分支/reflog/packed-refs，`codex` 分支为空，`main` (440484c) 工作树中**完全没有** library/tree/tab/openRoute 相关代码。因此文件树、多标签工作区、Lightbox、删除弹窗、附件过期状态全部是 **greenfield** 实现。

工作目录：`/Users/combo/MyFile/projects/invest-agent-portal`（Next.js 14 + React 18 + TS + Tailwind）。

## 布局决策（默认选择，可被用户纠正）

采用**先决工作包设计的"右侧文档工作区"模型**：文件树作为可折叠子面板嵌在右侧栏内、文档标签页在文件树右侧。理由：(1) 与既有先决设计一致；(2) 工作包 §13 说"右侧文件树"；(3) 不引入第三列，1440px 下不会过窄。默认实现完整 §13（11 项验收）。生产 Phase B/C 默认**只准备 + dry-run 报告，不做 --apply，不启用 FILE_RETENTION_CLEANUP_ENABLED**，把破坏性动作留给用户显式确认。

## 实现步骤

### 1. 协议类型层（`src/lib/protocol/`）
- `types.ts`：`ConnectorCapability` 加 `attachment.get`、`artifact.library.list`、`artifact.delete.prepare`、`artifact.delete.confirm`；新增 `ArtifactLibraryCategory`、`ArtifactLibraryItem`（含 `category/downloadable/openRoute/previewMode` 全集）、`ArtifactLibraryListRequest/Result`、`AttachmentGetRequest` + `AttachmentGetActiveResult` + `AttachmentGetStatusResult`、`ArtifactDeletePrepareRequest/Result`、`ArtifactDeleteConfirmRequest/Result`、`ArtifactDeleteImpactNotes`。扩展 `ArtifactPreviewMode` 加 `html`。
- `envelope.ts`：`PortalErrorCode` 加 9 个新码（`ATTACHMENT_*`、`ARTIFACT_EXPIRED/DELETED/NOT_DELETABLE/DELETE_*`）；`PORTAL_TYPES` 加 `ATTACHMENT_GET`、`ARTIFACT_LIBRARY_LIST`、`ARTIFACT_DELETE_PREPARE`、`ARTIFACT_DELETE_CONFIRM`。
- 协议版本保持 `2026-07-04`（纯加性，不破坏既有 connector）。

### 2. 后端 API 路由（`src/app/api/`，复用 `sendConnectorRequest` + `ARTIFACT_ERROR_STATUS` 模式）
- `artifacts/library/route.ts`（GET，cursor/limit）→ `artifact.library.list`
- `attachments/[attachmentId]/route.ts`（GET）→ `attachment.get`；返回 active 带字节、expired/deleted 只带状态
- `artifacts/[artifactId]/delete/prepare/route.ts`（POST）→ `artifact.delete.prepare`
- `artifacts/[artifactId]/delete/confirm/route.ts`（POST，body 带 tokenId）→ `artifact.delete.confirm`
- 现有 `artifacts/[artifactId]/route.ts` 的 `ARTIFACT_ERROR_STATUS` 扩展新码（`ARTIFACT_EXPIRED→410`、`ARTIFACT_DELETED→410`、`ARTIFACT_NOT_DELETABLE→405`、`DELETE_CONFIRMATION_*→409/400`、`ATTACHMENT_*→404/410`）。抽到共享 `src/lib/protocol/error-status.ts` 避免重复。

### 3. 浏览器 API 客户端（`src/components/chat/api.ts`）
新增 `fetchArtifactLibrary({cursor,limit})`、`fetchAttachment(attachmentId)`、`prepareArtifactDelete(artifactId)`、`confirmArtifactDelete(artifactId, tokenId)`，沿用既有 `{ok:true}|{ok:false,code,message,status}` 判别联合模式。

### 4. 右侧文档工作区（替换单 panel `ArtifactViewer` 的外层）
- 新增 `src/components/chat/DocumentWorkspace.tsx`：多标签状态（`tabs: WorkspaceTab[]`、`activeTabId`），每标签独立保留滚动位置；从对话卡片/文件树/legacy 链接打开文档时新增或激活标签；关闭单标签、关闭全部、重复打开去重。复用现有 `ArtifactViewer` 作为单标签内容渲染器（它已按 previewMode 路由 markdown/image/pdf/text/table）。
- 删除成功后自动关闭匹配标签并刷新文件树（工作包 §8.2）。
- 标签栏 ARIA + 键盘（Esc 关闭当前标签，沿用现有 ArtifactViewer 的 Escape 监听模式）。

### 5. 文件树（`src/components/chat/LibraryTree.tsx`）
- 嵌在 DocumentWorkspace 左侧可折叠子面板；按 `category`（daily/weekly/monthly/company/metrics/memory/other）分组，目录节点可展开/收起。
- 消费 `fetchArtifactLibrary` + cursor 分页"加载更多"。
- 点击项按 `openRoute` 路由：`document`→新增标签；`image`→打开 ImageLightbox；`download`→直接下载（不进标签）。
- 每项右侧删除图标（仅 `openRoute=document` 且 capability 支持 delete 时显示）→ 触发删除弹窗。
- 不显示 absolute path / retention 内部字段 / DB id（工作包 §8.1）。
- capability 不支持 `artifact.library.list` 时显示"文件目录暂时不可用"降级，不影响聊天。

### 6. ImageLightbox（`src/components/chat/ImageLightbox.tsx`）
- 全屏覆盖层，展示 durable image artifact；Esc/点击遮罩/✕ 关闭；复用现有 `fetchArtifact` + object URL + checksum 校验。
- 复用 `ArtifactViewer` 已有的 image 渲染逻辑（blob object URL，SVG 走 blob image 防脚本注入）。
- deleted/expired 状态复用现有 `NoticePanel`。

### 7. 删除确认弹窗（`src/components/chat/DeleteArtifactModal.tsx`）
- 两步：prepare 返回 `tokenId + impactNotes + displayPath + sizeBytes + category + expiresAt(令牌)`；弹窗必须展示全部 `impactNotes`（含"可能影响后续复盘""30 天恢复窗口"）。
- confirm 携带 tokenId；token 过期/重放/篡改 → `ARTIFACT_DELETE_CONFIRMATION_EXPIRED`，弹窗显示错误并允许重新 prepare。
- 取消无副作用（工作包 §13 第 8 项）。

### 8. 附件卡片状态（`src/components/chat/MessageBubble.tsx` + `types.ts`）
- `AttachmentView` 加 `expiresAt?`、`status?: active|expired|deleted`。
- `normalizeAttachments` 解析 `metadata.attachments` 中的 `attachmentId/expiresAt`。
- `AttachmentCard` 点击调用 `fetchAttachment`：active→图片用 Lightbox / 文档下载；expired/deleted→显示"附件已过期"灰态，移除查看/下载动作（工作包 §5.2、§13 第 1/2 项）。
- 卡片显示保留截止时间（`expiresAt` 友好格式）。

### 9. Capability 门禁（`src/components/chat/ChatShell.tsx`）
- `status.capabilities` 已端到端打通但未被使用。新增辅助 `hasCapability(status, cap)`，分别门禁：文件树（`artifact.library.list`）、附件点击查看（`attachment.get`）、删除按钮（`artifact.delete.prepare` + `artifact.delete.confirm`）。
- connector 离线时删除禁用或明确失败，UI 不永久 loading（§13 第 10 项）。

### 10. Mock connector + fixtures（`src/lib/mock/`）
- `connector.ts`：REGISTER capabilities 加 4 个新 cap；`handleInbound` 加 `ATTACHMENT_GET`、`ARTIFACT_LIBRARY_LIST`、`ARTIFACT_DELETE_PREPARE/CONFIRM` 分支；实现内存版 token store + trash。
- `fixtures.ts`：加 `FIXTURE_LIBRARY`（各 category 的 markdown/html/image/pdf/csv 样本）、`FIXTURE_ATTACHMENTS`（含一个 active + 一个 expired）、`FIXTURE_DELETE_TOKENS`。让 §13 验收可纯 mock 跑通，无需真实后端。

### 11. §13 浏览器验收（隔离 fixture，桌面 1440x900 + 1920x1080）
- 用 `dev:mock`（PORTAL_MOCK_SCENARIO=online）启动 Portal，逐项手动/脚本核验 11 个场景：
  1. 上传图片/文档→显示保留截止时间可读；2. mock 时钟跨 7 天→卡片"已过期"对话仍在；3. 文件树出现 backfill 的日/周/月/company/metrics/memory；4. 文件树不出现 raw memory/financials/config/Skills/alerts/用户附件；5. 打开 md/html 多标签切换、图片进 Lightbox、下载其他 durable；6. 1 MiB 边界样本分别进永久/临时；7. 删除非关键报告→确认弹窗、树/标签移除、卡片 deleted；8. 取消删除无副作用；9. 删除周/月复盘→显示"可能影响后续复盘"提示；10. connector 离线→删除禁用/明确失败、UI 不永久 loading；11. 恢复 connector→树刷新、跨 user/instance 看不到/删不了其他文件。
- 由于该仓库无测试框架，验收以 `MANUAL_TESTING.md` 增补章节 + 截图/记录形式留档（与该仓库既有做法一致）。

### 12. 生产 Phase B/C（保守默认）
- 仅运行只读 `retention:report` 和 `retention:backfill --dry-run`，向用户出示逐用户统计（候选数、字节数、无法归属/孤儿文件）。
- **不**运行 `--apply`、**不**设置 `FILE_RETENTION_CLEANUP_ENABLED`。Phase B apply / Phase C 首次清理留给用户在看到 dry-run 报告后显式确认。

## 不在本计划范围
- 移动端适配（工作包明确非目标）。
- 用户侧回收站/自助恢复 UI（首版非目标）。
- 在线编辑/重命名/移动/共享（非目标）。
- Office 预览器（非目标）。
- 真实生产数据写入（保守默认）。

## 风险与缓解
- **协议版本不升级**：纯加性 union 成员 + 新命令字符串，旧 connector/客户端继续工作；capability 门禁让旧 runtime 安全降级。
- **多标签状态膨胀**：标签上限（如 8 个）+ LRU 关闭；会话切换时保留各标签滚动位置（沿用现有 ArtifactViewer 的 scroll preservation 模式）。
- **删除竞态**：token 绑定 scope+path+checksum；prepare 与 confirm 间文件变更→`ARTIFACT_DELETE_CONFLICT`；scheduler 读取冲突由后端已处理的 tombstone 顺序保证。
- **mock 与真实协议漂移**：mock 严格按 `user-portal-protocol.md` 的新章节实现，types 从 `src/lib/protocol` 导入，避免手写 shape。