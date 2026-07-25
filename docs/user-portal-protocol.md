# 用户门户 Relay 协议草案

## 文件目的

本文档定义独立云端门户项目 `invest-agent-portal` 与本地 `invest-agent-ideal` connector 之间的第一版协议。它的目标是让门户项目可以先用 mock connector 独立开发和测试，再无缝切换到真实本地 connector 做端到端联调。

本文档是协议草案，优先保证边界清晰、可测试、可演进。实现时可以把这里的类型提炼成 JSON Schema、Zod schema 或共享 npm package，但第一阶段不要求先做 package。

## 设计原则

- 云端门户不直接访问本地文件系统、SQLite 或 workspace。
- 本地 connector 主动连云端 Relay。
- 云端发给本地的是结构化命令，不是裸 HTTP 代理。
- 所有请求必须有 `requestId`，所有写入必须幂等。
- 同一用户助手同一时间只有一个 active connector。
- 用户可见对话历史以本地 canonical conversation log 为权威源，云端保存完整镜像用于体验。
- 第一版不要求真实后端流式；后端可返回完整回复，前端做打字机式呈现。

## Transport

第一版建议：

- Connector -> Relay：WebSocket 长连接。
- Browser -> Portal：普通 HTTP API + 页面状态；后续可升级 SSE/WebSocket。
- Portal 内部把 browser 请求转成 Relay command，再转给 connector。

连接地址示例：

```text
wss://portal.example.com/api/relay/connect
```

认证建议：

```http
Authorization: Bearer <PORTAL_CONNECTOR_TOKEN>
```

浏览器永远不能拿到 connector token。

本地 runtime 的 `/api/portal/*` 仅供受信任的本机运维/relay 调用，必须携带 `Authorization: Bearer <INVEST_AGENT_API_TOKEN>`；浏览器不得直接访问本机端口或持有该令牌。

## Envelope

所有 connector 与 relay 之间的消息都使用统一 envelope：

```ts
type PortalProtocolVersion = "2026-07-04";

interface PortalEnvelope<T = unknown> {
  protocolVersion: PortalProtocolVersion;
  requestId: string;
  type: string;
  sentAt: string;
  payload: T;
}
```

响应：

```ts
interface PortalResponse<T = unknown> {
  protocolVersion: PortalProtocolVersion;
  requestId: string;
  type: string;
  ok: boolean;
  sentAt: string;
  data?: T;
  error?: PortalError;
}
```

错误：

```ts
interface PortalError {
  code:
    | "UNAUTHORIZED"
    | "FORBIDDEN"
    | "CONNECTOR_CONFLICT"
    | "CONNECTOR_OFFLINE"
    | "ASSISTANT_NOT_FOUND"
    | "CONVERSATION_NOT_FOUND"
    | "INVALID_REQUEST"
    | "TIMEOUT"
    | "ACP_FAILED"
    | "INTERNAL_ERROR";
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}
```

## Connector Register

Connector 建立 WebSocket 后第一条消息必须是 register。

```ts
interface ConnectorRegisterPayload {
  connectorId: string;
  assistantId: string;
  instanceId: string;
  userId: string;
  projectId: string;
  displayName?: string;
  version: string;
  startedAt: string;
  capabilities: Array<
    | "conversation.chat"
    | "conversation.list"
    | "conversation.get"
    | "conversation.sync"
    | "conversation.attachments"
    | "dashboard.snapshot"
  >;
  mode: "real" | "mock";
}
```

示例：

```json
{
  "protocolVersion": "2026-07-04",
  "requestId": "req_register_001",
  "type": "connector.register",
  "sentAt": "2026-07-04T10:00:00.000Z",
  "payload": {
    "connectorId": "local-macbook-primary",
    "assistantId": "invest-agent-primary",
    "instanceId": "invest-agent-primary",
    "userId": "primary",
    "projectId": "invest-agent",
    "displayName": "默认测试实例",
    "version": "0.1.0",
    "startedAt": "2026-07-04T09:59:50.000Z",
    "capabilities": ["conversation.chat", "conversation.list", "conversation.get", "conversation.sync", "conversation.attachments"],
    "mode": "real"
  }
}
```

Relay 响应：

```ts
interface ConnectorRegisterResult {
  accepted: boolean;
  active: boolean;
  conflict?: {
    activeConnectorId: string;
    policy: "reject_new" | "takeover";
  };
  serverTime: string;
  heartbeatIntervalMs: number;
}
```

同一 `assistantId` 已有 active connector 时，第一版默认 `reject_new`。

## Heartbeat

Connector 定期发送 heartbeat。

```ts
interface ConnectorHeartbeatPayload {
  connectorId: string;
  assistantId: string;
  status: "online" | "busy" | "degraded";
  activeRequests: number;
  lastActivityAt?: string;
}
```

Relay 如果超过 2 个 heartbeat interval 未收到心跳，应标记 connector offline。

## Conversation List

Relay 可向 connector 查询本地权威会话列表，用于云端镜像补齐或对账。

```ts
interface ConversationListRequest {
  userId: string;
  assistantId: string;
  instanceId: string;
  channel?: "web" | "weixin-mobile";
  cursor?: string;
  limit: number;
}

interface ConversationSummary {
  conversationId: string;
  title: string;
  channel: "web" | "weixin-mobile";
  lastMessagePreview?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

interface ConversationListResult {
  items: ConversationSummary[];
  nextCursor?: string;
}
```

## Conversation Get

```ts
interface ConversationGetRequest {
  userId: string;
  assistantId: string;
  instanceId: string;
  conversationId: string;
  cursor?: string;
  limit: number;
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

interface ConversationGetResult {
  conversationId: string;
  title: string;
  messages: ConversationMessage[];
  nextCursor?: string;
}
```

## Chat Request

浏览器发消息后，Portal 生成 `conversation.chat` command 给 connector。

```ts
interface PortalAttachmentInput {
  kind?: "image" | "document";
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  base64?: string;
  downloadUrl?: string;
}

interface ConversationChatRequest {
  userId: string;
  assistantId: string;
  instanceId: string;
  conversationId: string;
  userMessageId: string;
  text?: string;
  attachments?: PortalAttachmentInput[];
  idempotencyKey: string;
  clientSentAt: string;
}
```

`text` 和 `attachments` 至少一个非空。第一版附件支持：

- 图片：`jpg` / `jpeg` / `png` / `webp`，单个最大 10 MB。
- 文档：`pdf` / `doc` / `docx` / `ppt` / `pptx` / `html` / `htm` / `md` / `txt`，单个最大 25 MB。
- 单条消息最多 8 个附件，总大小最多 40 MB。
- 推荐使用 `base64`；`downloadUrl` 默认关闭，只有其 HTTPS 主机被本地 `PORTAL_ATTACHMENT_DOWNLOAD_HOSTS` 精确列入白名单时才可用。本地 connector 下载后仍执行同一套类型、大小和 magic bytes 校验。
- 云端消息镜像只能保存 `metadata.attachments` 中的安全字段：`id`、`type`、`mimeType`、`fileName`、`sizeBytes`、`relativePath`、`source`，不得保存或展示本地绝对路径。

## Report Asset Get

用户在对话中打开 workspace 生成的图表或报告时，Portal 通过 `report.asset.get` 向该用户的 connector 读取内容。浏览器只访问 Portal 的登录态路由，不能访问本地 runtime、workspace 或 connector token。

请求只包含相对 workspace 路径：

```ts
interface ReportAssetGetRequest {
  relativePath: string; // 必须以 reports/ 开头
}
```

connector 强制使用已注册的 user / assistant scope，拒绝绝对路径、路径穿越、`reports/` 外的路径、逃逸 reports 目录的符号链接、非白名单扩展名和超过 15 MB 的文件。响应为 `{ fileName, mimeType, sizeBytes, base64 }`，仅用于 Portal 将内容流式返回给当前登录用户。

Connector 需要：

1. 写入本地 canonical conversation log 的用户消息。
2. 调用 workspace ACP。
3. 写入本地 canonical conversation log 的助手消息。
4. 返回完整助手回复。

第一版响应：

```ts
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

第一版不要求 connector 返回 chunk。Portal 收到完整 `assistantMessage.content` 后，在前端做打字机式呈现。

## Artifact Library List

Portal 右侧文件树不是 workspace 目录浏览，而是 Runtime 基于 artifact 权威索引生成的精选只读文档库。Portal 通过 `artifact.library.list` 向当前 session 的 connector 拉取一页描述符，树刷新和"加载更多"都走这一条命令；文件内容读取继续走 `artifact.get`。

```ts
interface ArtifactLibraryListRequest {
  cursor?: string;
  limit?: number; // 默认 200，最大 500
}

interface ArtifactLibraryItem {
  artifactId: string;
  title: string;
  fileName: string;
  displayPath: string; // reports/ 以下的安全相对展示路径，不含 reports 前缀
  directorySegments: string[];
  mimeType: "text/markdown" | "text/html";
  previewMode: "markdown" | "html";
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  checksum?: string;
}

interface ArtifactLibraryListResult {
  items: ArtifactLibraryItem[];
  nextCursor?: string;
}
```

约束：

- `userId` / `instanceId` 由 connector 从已注册 session scope 注入，payload 不接受浏览器提交；payload 只允许 `cursor` 和 `limit` 两个字段，任何其他字段（尤其是 path / glob / 目录遍历类参数）都返回 `INVALID_REQUEST` 确定错误，不做静默忽略。
- `limit` 默认 200，超过 500 时 clamp 到 500，不报错；非数字由 connector 拒绝（`INVALID_REQUEST`）。
- cursor 不透明（base64url 编码的 keyset 位置），排序固定为 `updated_at DESC, artifact_id DESC`，保证翻页无重复、无漏项；无法解码或形状不符的 cursor 返回 `fail`，`error.code = "ARTIFACT_INVALID_CURSOR"`，`retryable = false`。
- 精选准入由 Runtime 服务层权威执行：`source ∈ {artifacts.publish, reviews.save}`（排除 `legacy_path`）、`previewMode ∈ {markdown, html}`、路径在 `reports/**` 下、无隐藏路径段、文件名不属于固定临时/备份模式（`.#` 前缀，`~`/`.tmp`/`.temp`/`.bak`/`.swp` 后缀，大小写不敏感），且文件当前存在、是普通文件、realpath 仍在真实 reports 根内（防 symlink 逃逸）。Portal 不自行判断文件资格。
- 同一 `displayPath` 多条发布记录只返回最新有效版本；最新记录不合格时回退到同路径最近一个仍有效的正式版本，但绝不回退到 legacy 来源；同路径全部失效则该路径不出现。
- 返回项是严格白名单描述符：不含 absolute path、`userId`、`instanceId`、`conversationId`、`projectId`、内部 `scope` 或 `source`，列表阶段不读取文件正文。`displayPath` 仅用于构造虚拟树展示，不能当作读取路径回传。
- 每次 list 由 Runtime 写入一条聚合审计事件（scope、返回数量、分页信息），不为每个树节点写事件。
- capability 列表显式包含 `artifact.library.list`；旧 connector 不支持时 Portal 显示"文件目录暂时不可用"，不影响聊天与已打开 artifact。

## Artifact Preview

一等 artifact 通过 `artifact.get` / `artifact.publish.legacy` 通道传输（base64 bytes + checksum），不经过任何同源 inline 路由。助手消息通过 `metadata.artifacts` 携带 descriptor。

```ts
type ArtifactPreviewMode =
  | "markdown"
  | "html"
  | "image"
  | "pdf"
  | "text"
  | "table"
  | "unsupported";
```

Runtime 侧的映射规则：

- `.svg` / `.png` / `.jpg` / `.jpeg` / `.webp` → `image`；`.md` / `.markdown` → `markdown`；`.html` / `.htm` → `text/html` → `html`；`.pdf` → `pdf`；`.txt` / `.json` → `text`；`.csv` → `table`。
- 所有类型沿用 reports 目录约束、realpath/symlink 检查、scope 隔离、checksum 和 MIME 一致性校验。通用上限 15 MB；`text/html` 单独收紧到 1 MB。
- `report.asset.get` 的扩展名白名单不包含 `html`/`htm`：HTML 文档永远不会通过 legacy 同源路由 inline 返回，只能作为 artifact bytes 由 Portal 在受限 sandbox iframe 中预览。
- Portal 遇到未知的 preview mode 必须降级为 `unsupported`。

## History Sync

Connector 或 Relay 可以通过 sync 事件同步云端镜像。

```ts
interface ConversationSyncPayload {
  assistantId: string;
  instanceId: string;
  userId: string;
  conversations: ConversationSummary[];
  messages: ConversationMessage[];
  syncCursor?: string;
  fullSnapshot: boolean;
}
```

规则：

- `messageId` 必须全局稳定。
- 云端按 `messageId` upsert，避免重复。
- 云端镜像可以延迟，但不能伪造本地不存在的消息。
- 如果云端发现缺口，应发 `conversation.get` 向 connector 补齐。

## Dashboard Snapshot

第一阶段可选。用于未来轻量首页或状态提示。

```ts
interface DashboardSnapshotRequest {
  userId: string;
  assistantId: string;
  instanceId: string;
}

interface DashboardSnapshotResult {
  assistantOnline: boolean;
  latestReviewAt?: string;
  pendingAlertCount?: number;
  recentConversationCount?: number;
}
```

## Mock Connector Scenarios

门户项目第一轮开发必须能用 mock connector 覆盖这些场景：

### connector-online

- register 成功。
- heartbeat 正常。
- 会话列表有 2-3 条记录。
- chat 返回正常完整回复。

### connector-offline

- Relay 标记助手离线。
- 历史可从云端镜像读取。
- 发送按钮禁用。

### slow-reply

- chat 请求延迟 10-30 秒返回。
- 前端等待状态逐级变化。

### failed-reply

- chat 返回 `ACP_FAILED` 或 `TIMEOUT`。
- 前端展示失败消息和重试入口。

### empty-history

- 会话列表为空。
- 前端展示空态和新建对话入口。

### paged-history

- 会话列表超过一页。
- 消息列表超过一页。
- 前端分页或虚拟滚动正常。

## Integration Runbook

### Mock 联调

1. 启动门户项目。
2. 启动 mock connector 或加载 mock fixtures。
3. 登录测试账号。
4. 验证左侧历史、发送消息、慢回复、失败回复、离线状态。
5. 验证云端镜像写入。

### 真实 connector 联调

1. 启动本地 invest-agent 服务。
   - `npm run dev`
   - 本地健康检查：`GET http://localhost:22655/api/portal/health`
2. 启动本地 portal connector 测试模式。
   - 默认连接 `ws://localhost:3199`：`PORTAL_CONNECTOR_TOKEN=<token> npm run portal:connector`
   - 可覆盖：`PORTAL_RELAY_URL=ws://<portal-host>:3199 PORTAL_USER_ID=primary PORTAL_INSTANCE_ID=invest-agent-primary npm run portal:connector`
3. connector 注册到门户 Relay。
4. 门户显示用户助手 online。
5. 网页发送一条消息。
6. 本地 connector 写入 canonical conversation log。
7. 本地 connector 调用 workspace ACP。
8. 回复返回网页。
9. 云端镜像写入同一 `messageId`。
10. 刷新页面后历史仍可读取。

本地侧也提供调试 API，便于在 Relay 联调前确认 canonical log：

- `GET /api/portal/conversations?userId=primary&instanceId=invest-agent-primary`
- `GET /api/portal/conversations/:conversationId?userId=primary&instanceId=invest-agent-primary`
- `POST /api/portal/conversations/:conversationId/messages`

基础烟测：

```bash
npm run smoke:portal-conversation-log
```

## Versioning

第一版协议版本为：

```text
2026-07-04
```

破坏性变更必须升级 `protocolVersion`。非破坏性新增字段必须保持旧客户端可忽略。

## Handoff Prompt

```text
请基于 docs/user-portal-protocol.md 在新门户项目中实现 Relay 和 mock connector 测试路径。门户项目不得 import invest-agent-ideal 内部源码，只能依赖协议文档、fixtures 和运行时连接。第一阶段先通过 mock connector 验收 UI/登录/历史/发送/失败/离线状态，再接真实 local connector 做端到端验收。
```
