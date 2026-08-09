# 用户门户 Relay 当前协议

本文件是 Invest Agent 本地 runtime 与独立 Portal relay 的当前对接契约。历史草案、退役命令、mock 场景和交接提示见
[`archive/user-portal-protocol-pre-consolidation-2026-07-28.md`](./archive/user-portal-protocol-pre-consolidation-2026-07-28.md)。

## Transport 与版本

- Connector 主动连接 Portal relay 的 WebSocket 地址。
- token 只用于 connector 与 relay 握手，不能传给浏览器。
- 当前协议版本：`2026-07-04`。
- Connector 建连后先发送 `connector.register`，之后每 15 秒发送 `connector.heartbeat`。
- 45 秒没有收到 relay 消息或 acknowledgement 时，connector 主动重连；普通断线 5 秒后重试。
- 同一 assistant 默认最多并行处理 3 个 `conversation.chat`，可由 `PORTAL_MAX_CONCURRENT_TASKS_PER_ASSISTANT` 配置为 1-10。超限返回可重试的 `CONCURRENT_TASK_LIMIT`，不静默排队。

## Envelope

```ts
type PortalProtocolVersion = "2026-07-04";

interface PortalEnvelope<T = unknown> {
  protocolVersion: PortalProtocolVersion;
  requestId: string;
  type: string;
  sentAt: string; // ISO-8601
  payload: T;
}

interface PortalResponse<T = unknown> {
  protocolVersion: PortalProtocolVersion;
  requestId: string;
  type: string;
  ok: boolean;
  sentAt: string;
  data?: T;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}
```

响应必须复用请求的 `requestId` 和 `type`。未知 command 返回 `INVALID_REQUEST`。

## 注册 scope

```ts
interface ConnectorRegisterPayload {
  connectorId: string;
  assistantId: string;
  instanceId: string;
  userId: string;
  projectId: string;
  displayName: string;
  version: string;
  startedAt: string;
  capabilities: string[];
  mode: "real" | "mock";
}

interface ConnectorHeartbeatPayload {
  connectorId: string;
  assistantId: string;
  status: "online" | "busy" | "degraded";
  activeRequests: number;
  lastActivityAt: string;
}
```

Connector 注册后，本地 runtime 以注册 scope 为权威。command payload 中即使带有 `userId`、`assistantId`、`instanceId` 或 `projectId`，也不能覆盖注册值。每个读取与聊天操作都必须绑定当前 connector 的 user/instance。
对话消息持久化必须在同一会话内保持 project scope 不变。兼容历史会话时，只允许复用该 connector 当前业务 project 或当前 instance runtime project；user、instance、assistant 任一不匹配仍返回 `CONVERSATION_SCOPE_MISMATCH`。自动化与资产命令继续使用 connector 注册的业务 project scope。

## 当前 Commands

| `type` | 方向 | payload | 成功 `data` |
| --- | --- | --- | --- |
| `connector.register` | connector -> relay | `ConnectorRegisterPayload` | relay 的接受状态、心跳间隔与冲突策略 |
| `connector.heartbeat` | connector -> relay | `ConnectorHeartbeatPayload` | relay acknowledgement |
| `conversation.list` | relay -> connector | `{ channel?, cursor?, limit? }` | `{ items, nextCursor? }` |
| `conversation.get` | relay -> connector | `{ conversationId, cursor?, limit? }` | `{ conversationId, title, messages, nextCursor? }` |
| `conversation.chat` | relay -> connector | chat payload，见下文 | 用户消息、助手消息与 trace/usage |
| `report.asset.get` | relay -> connector | `{ relativePath }` | report 文件 payload |
| `artifact.get` | relay -> connector | `{ artifactId }` | artifact 描述与 base64 |
| `artifact.library.list` | relay -> connector | `{ cursor?, limit? }` | `{ items, nextCursor? }` |
| `artifact.publish.legacy` | relay -> connector | `{ relativePath, conversationId? }` | 注册后的 artifact 描述 |
| `artifact.event` | relay -> connector | `{ artifactId, event, status?, reason? }` | `{ accepted: true }` |
| `attachment.get` | relay -> connector | `{ attachmentId }` | attachment 元数据，active 时含 base64 |
| `workspace.file.list` | relay -> connector | `{}` | `{ items }` |
| `workspace.file.get` | relay -> connector | `{ relativePath }` | workspace 文件 payload |
| `automation.list` | relay -> connector | `{}` | `{ items }` |
| `automation.get` | relay -> connector | `{ taskId }` | task definition, current revision and assets |
| `automation.create` | relay -> connector | `{ name, description?, schedule, sourceAsset }` | paused task |
| `automation.update` | relay -> connector | `{ taskId, expectedRevision?, name?, description?, schedule?, sourceAsset? }` | new paused revision |
| `automation.activate` / `automation.pause` | relay -> connector | `{ taskId, expectedRevision? }` | updated task |
| `automation.run_now` | relay -> connector | `{ taskId, idempotencyKey? }` | run and result |
| `automation.runs.list` | relay -> connector | `{ taskId, limit? }` | `{ items }` |
| `automation.run.get` | relay -> connector | `{ runId }` | one scoped run |
| `automation.asset.get` | relay -> connector | `{ assetId }` | task asset descriptor and base64 |
| `automation.continue_in_chat` | relay -> connector | `{ runId }` | a new conversation bound to the run |
| `asset.folder.list` | relay -> connector | `{}` | `{ items: UserAssetFolderDescriptor[] }` |
| `asset.folder.create` | relay -> connector | `{ name, parentFolderId? }` | folder descriptor |
| `asset.folder.rename` | relay -> connector | `{ folderId, name }` | folder descriptor；同级名称按不区分大小写唯一 |
| `asset.folder.delete` | relay -> connector | `{ folderId }` | `{ folderId }`；仅允许删除空目录 |
| `asset.delete` | relay -> connector | `{ assetId }` | `{ assetId, deletedVersions }`；若文件仍被自动化任务引用则拒绝 |
| `asset.convert_to_xlsx` | relay -> connector | `{ assetId, expectedVersionId, confirmed: true, idempotencyKey }` | 同一 `assetId` 上新增格式化 XLSX 版本；保留 CSV 历史版本与自动化绑定 |

注册时的 capability label 还包含 `conversation.sync` 和 `conversation.attachments`，它们描述镜像/附件能力，不代表存在同名 command。对接方不得发送表中没有列出的 `conversation.sync` command。

## Conversation Contract

```ts
interface ConversationSummary {
  conversationId: string;
  title: string;
  channel: "web" | "weixin-mobile";
  lastMessagePreview?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ConversationMessage {
  messageId: string;
  conversationId: string;
  userId: string;
  assistantId: string;
  instanceId: string;
  channel: "web" | "weixin-mobile";
  role: "user" | "assistant" | "system";
  content: string;
  status: "pending" | "sent" | "failed";
  traceId?: string;
  requestId?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

interface PortalAttachmentInput {
  kind?: "image" | "document";
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  base64?: string;
  downloadUrl?: string;
}

interface ConversationChatRequest {
  conversationId: string;
  userMessageId?: string;
  text?: string;
  attachments?: PortalAttachmentInput[];
  idempotencyKey?: string;
  clientSentAt?: string;
  channel?: "web" | "weixin-mobile";
}

interface ConversationChatResult {
  conversationId: string;
  userMessage: ConversationMessage;
  assistantMessage: ConversationMessage;
  traceId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}
```

`text` 与 `attachments` 至少一个非空。Connector 先把用户消息写入本地权威 conversation log，再调用 workspace ACP，最后写入并返回完整助手消息。协议当前不要求流式 chunk；Portal 可以在收到完整内容后做展示动画。

附件限制由本地 attachment store 强制执行：单条消息最多 8 个；每个原始文件最多 `10 MiB`，同一请求解码后的原始字节合计最多 `20 MiB`，不区分图片与文档。优先传 `base64`，边界按实际解码字节而非客户端声明或 base64 长度计算。`downloadUrl` 默认拒绝，只有 HTTPS host 被 `PORTAL_ATTACHMENT_DOWNLOAD_HOSTS` 精确列入白名单才允许，下载后仍执行类型、大小和 magic-byte 校验。

消息 `metadata.attachments` 只能镜像安全描述字段，不能包含本地绝对路径。助手消息可以带经服务端清洗的 `metadata.inlineVisuals`：

```ts
interface InlineSvgVisual {
  version: 1;
  id: string;
  kind: "svg";
  title: string;
  alt: string;
  svg: string;
}
```

Portal 应将其作为静态图片数据呈现，不能把 SVG 当作同源 HTML/DOM 执行。

## Automation Task Contract

自动化 command 的 `userId`、`instanceId`、`projectId` 永远取自 connector 注册 scope，payload 中同名字段会被忽略。任务定义写入服务 SQLite，文件资产提升到用户 Workspace 的
`automations/<task-id>/source|working/`，不引用 7 天 TTL 的 `conversation_attachments`。首期上传只接受 CSV/XLSX；`source` 不可覆盖，`working` 由服务校验真实路径、符号链接和 checksum 后原子替换。

新建 Portal 自动化应使用通用 `instruction` 与 `inputs` 绑定“我的文件”中的资产；绑定引用资产 ID，不复制文件。附加资产同时是该任务的受控文件候选：`output.mode=agent` 允许 Agent 在每次运行中根据任务说明选择只读、更新某个 latest 输入的 Markdown/CSV/XLSX 版本，或创建一个关联资产；服务只接受任务输入中的更新目标，不允许 Agent 访问或修改未附加资产。通用输入支持当前用户资产格式（Markdown、HTML、CSV、XLSX、PDF、PNG、JPEG、WebP、SVG）。上述 CSV/XLSX 限制仍适用于兼容旧任务的 `sourceAsset` 上传路径。

`automation.create` 和 `automation.update` 返回的任务都处于 `paused`；update 会创建不可变 revision，必须再次调用 `automation.activate` 才会按声明的 timezone 和 daily/weekdays/weekly 规则调度。`automation.run_now` 是真实运行：每次使用新的 `runId`，只写入运行记录和结果，不创建 Portal conversation。计划运行同样只生成 `automation_task_runs` 历史；用户要继续讨论时必须显式调用 `automation.continue_in_chat`，该入口才创建新的普通 conversation，且不会恢复后台上下文或自动再次写文件。

运行和资产读取始终按注册 scope 强制隔离。运行错误、写入结果和 checksum 记录在自动化审计与运行历史中；旧 `scheduled_task_runs` 仍只服务现有复盘、盘中简报和规则巡检。

若同一任务已有未过期的运行，`automation.run_now` 返回可重试的 `AUTOMATION_TASK_BUSY`（HTTP `409`）；租约在提交结果前失效则返回可重试的 `AUTOMATION_RUN_LEASE_LOST`。结构不合法的 CSV/XLSX 返回 `AUTOMATION_ASSET_INVALID_CONTENT`（HTTP `422`）。这些错误不会把工作文件提交为成功结果。

## Artifact 与 Attachment

`artifact.get`、`artifact.event`、`artifact.library.list` 和 `attachment.get` 都以注册的 user/instance scope 查询。只知道 ID 不能跨用户读取或写 telemetry。

`artifact.event.event` 仅接受 `open`、`success`、`failure`、`download`。`artifact.library.list` payload 只接受 `cursor` 和 `limit`，多余字段返回 `INVALID_REQUEST`。`artifact.publish.legacy` 仅用于既有相对路径兼容；新产物应由服务/MCP 的正式发布流程登记。

`reviews.save` 以及在 `artifacts.publish` 中明确传入 `saveToMyFiles=true` 的正式交付物，如被判定为 `durable_library`，服务会同步登记到 `user_assets`。普通聊天发布写入 `deliveries/` 并保持临时状态，直到用户执行保存。首次自动入库创建文件，同一 Workspace 相对路径的后续正式发布追加版本；artifact descriptor 的 `assetId`、`versionId` 与 `savedToMyFiles=true` 与“我的文件”中的当前文件版本保持一致。该衔接由服务层执行，不依赖 Agent 再调用一次保存工具。

Artifact payload 的公共字段包括：

```ts
interface ArtifactPayload {
  artifactId: string;
  title: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  base64: string;
  checksum: string;
  sanitized: boolean;
  kind: string;
  previewMode: string;
  createdAt: string;
  workspacePath?: string;
}
```

`workspacePath` 只在 artifact 对应 Portal 可浏览的 Workspace 文件时出现，且必须是相对路径。expired/deleted attachment 仍可返回安全元数据供页面显示状态，但不得返回文件字节。

## Workspace 文件只读协议

`workspace.file.list` 不接受任何筛选字段。返回 item：

```ts
interface WorkspaceFileItem {
  fileId: string;
  relativePath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  updatedAt: string;
  previewMode: "markdown" | "html" | "image" | "text";
  downloadable: boolean;
}

interface WorkspaceFilePayload extends WorkspaceFileItem {
  base64: string;
  checksum: string;
}
```

`workspace.file.get` 只接受 `relativePath`。服务端拒绝：

- 绝对路径、空段、`.`、`..` 和路径穿越；
- 符号链接与逃逸当前用户 Workspace 的真实路径；
- 隐藏目录/文件、`.state`、`.trash`、`.git`、缓存、构建和运行目录；
- `.env`、credentials/auth 文件；
- 非 `markdown` / `html` / `image` 预览类型；YAML（`.yaml` / `.yml`）例外，作为转义的纯文本预览；
- 超过 15 MB 的文件。

列表最多 5,000 项。错误码包括 `WORKSPACE_FILE_INVALID_PATH`、`WORKSPACE_FILE_NOT_FOUND`、`WORKSPACE_FILE_FORBIDDEN`、`WORKSPACE_FILE_TOO_LARGE`、`WORKSPACE_FILE_LIMIT_EXCEEDED`。

`report.asset.get` 是旧报告专用读取面，只允许 `reports/` 下白名单文件；Workspace 浏览器新接入应使用 `workspace.file.*`。

## 配置与启动

主要环境变量见 `.env.example`：

- `PORTAL_RELAY_URL`
- `PORTAL_CONNECTOR_TOKEN`
- `PORTAL_CONNECTOR_AUTO_START`
- `PORTAL_CONNECTOR_REFRESH_MS`
- `PORTAL_MAX_CONCURRENT_TASKS_PER_ASSISTANT`
- `PORTAL_CONNECTOR_ID_PREFIX`
- `PORTAL_CONNECTOR_RUNTIME_LABEL`
- `PORTAL_CONNECTOR_INCLUDE_ASSISTANTS`
- `PORTAL_CONNECTOR_EXCLUDE_ASSISTANTS`
- 单 connector scope 的 `PORTAL_USER_ID` / `PORTAL_INSTANCE_ID` / `PORTAL_ASSISTANT_ID` / `PORTAL_PROJECT_ID`

本地 connector：

```bash
npm run portal:connector
```

本仓库直接 HTTP 兼容面由 `src/routes/portal.ts` 提供 health、conversation、chat 与 workspace file 路由；它不是云端 Portal 绕过 connector 直接访问本地 Workspace 的授权依据。

## 权威实现与验证

- `src/portal/connector.ts`
- `src/portal/concurrent-task-limiter.ts`
- `src/routes/portal.ts`
- `src/services/conversation-log.ts`
- `src/services/conversation-artifacts.ts`
- `src/services/file-retention.ts`
- `src/services/workspace-files.ts`

```bash
npm run smoke:portal-conversation-log
npm run smoke:portal-attachment
npm run verify
```

Portal 仓库与本地 runtime 改动协议时必须在同一变更窗口对齐 `protocolVersion`、command 类型与 scope 语义。
### Asset library fields and folders

`asset.list` 的成功数据在保持既有 `items` 字段兼容的同时，可返回：

```json
{"items": [], "folders": [], "catalog": [], "reportMappings": [], "storageUsage": {"usedBytes": 0, "reservedBytes": 0, "limitBytes": 209715200, "availableBytes": 209715200}}
```

客户端不得将该字段作为写入安全边界；上传仍由 Runtime 按解码后的单文件 `10 MiB`、单请求 `20 MiB` 和 scope `200 MiB` 强制校验。

`catalog` 是受控虚拟列表，条目 `catalogKind` 为 `asset` 或 `report`；报告条目只携带 opaque `reportMappingId`，不返回 Workspace 路径。`asset.upload` 保持旧单文件 payload 兼容，同时接受 `{ files: [...] }`；批量请求会先校验全部 base64 与总原始字节，只有通过前置校验才开始逐文件写入，并以 `{ items: [...] }` 返回每一项结果。

`asset.folder.list` 返回当前 connector scope 内至多两级的 opaque 文件夹描述；`asset.folder.create` 接受 `{ name, parentFolderId? }`，`asset.folder.rename` 接受 `{ folderId, name }` 并保持同级名称不区分大小写唯一，`asset.folder.delete` 接受 `{ folderId }` 且只允许删除没有直接资产和子文件夹的空目录，非空时返回 `ASSET_FOLDER_NOT_EMPTY`；`asset.move` 接受 `{ assetId, folderId }`。上述文件夹命令以及资产命令都必须使用 connector 注册的 `userId`、`projectId`、`instanceId` scope，payload 不得覆盖这些值。`asset.list` 未传 `folderId` 时保持跨目录汇总兼容，传 `folderId: null` 时只返回根目录资产，传 opaque `folderId` 时只返回该目录资产；目录限定查询的 `catalog` 与 `reportMappings` 只包含 backing asset 位于该目录的报告。`asset.upload` 的单文件 payload 以及批量 `files` 中的每一项都可携带 `folderId`，Runtime 必须按注册 scope 校验目录并把新资产写入该位置。

`asset.conversation.save` 只接受 scope-bound `artifactId` 和可选名称。它表示用户在 Portal 明确执行“保存到我的文件”，创建 `source=conversation` 的长期资产；临时附件和未保存交付物不自动占用 200 MiB 配额。`report.mapping.get` 只接受 opaque `mappingId`，同 scope 可读取映射的受控 backing bytes；backing asset/version 映射不得复制或重复计费。

`asset.convert_to_xlsx` 只允许转换当前活动版本仍为 CSV 的资产，要求 Portal 传入当前 `expectedVersionId`、显式 `confirmed: true` 和幂等键。Runtime 将 CSV 解析为结构化工作簿，应用冻结表头、筛选、受限自动列宽、换行和基础样式，并在同一 `assetId` 上提交新的 XLSX 版本；文件夹、资产名称和基于 `assetId` 的自动化绑定不变，原 CSV 版本保留用于历史恢复。该命令不得被用于批量或静默迁移真实 Workspace 文件。
