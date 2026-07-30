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

附件限制由本地 attachment store 强制执行：单条最多 8 个，总大小最多 40 MB；图片单个最多 10 MB，文档单个最多 25 MB。优先传 `base64`。`downloadUrl` 默认拒绝，只有 HTTPS host 被 `PORTAL_ATTACHMENT_DOWNLOAD_HOSTS` 精确列入白名单才允许，下载后仍执行类型、大小和 magic-byte 校验。

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

## Artifact 与 Attachment

`artifact.get`、`artifact.event`、`artifact.library.list` 和 `attachment.get` 都以注册的 user/instance scope 查询。只知道 ID 不能跨用户读取或写 telemetry。

`artifact.event.event` 仅接受 `open`、`success`、`failure`、`download`。`artifact.library.list` payload 只接受 `cursor` 和 `limit`，多余字段返回 `INVALID_REQUEST`。`artifact.publish.legacy` 仅用于既有相对路径兼容；新产物应由服务/MCP 的正式发布流程登记。

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
