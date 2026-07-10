# Portal 图片与文档附件支持实现设计

## 背景

微信端已经支持图片附件：`weixin-agent-sdk` 将 media 传给 `InvestAgentMobileBridge`，桥接层把图片保存到 workspace 的 `attachments/YYYY-MM-DD/`，再把附件路径注入 ACP prompt，让 Codex 在用户 workspace 内读取和识别。

网页端目前只有纯文本链路：

- 本地 API：`src/routes/portal.ts` 的 `POST /api/portal/conversations/:conversationId/messages`
- 本地权威日志：`src/services/conversation-log.ts`
- Relay connector：`src/portal/connector.ts` 的 `conversation.chat`
- ACP 注入：`src/acp/agent.ts` 已能接收 `message.context.attachments` 并生成附件上下文

网页端缺少上传、存储、协议字段、conversation log 元数据、云端镜像附件展示和验收测试。

## 目标

第一版让网页端用户可以随聊天消息发送附件，并让 workspace ACP 能看到和处理这些附件。

支持类型：

- 图片：`jpg` / `jpeg` / `png` / `webp`
- 文档：`pdf` / `doc` / `docx` / `ppt` / `pptx` / `html` / `htm` / `md` / `txt`

大小限制建议：

- 单张图片最大 10 MB，沿用现有 `ATTACHMENT_IMAGE_MAX_BYTES`
- 单个文档最大 25 MB，新增 `ATTACHMENT_DOCUMENT_MAX_BYTES`
- 单条消息最多 8 个附件，新增 `ATTACHMENT_MAX_FILES_PER_MESSAGE`
- 单条消息附件总大小最多 40 MB，新增 `ATTACHMENT_MAX_TOTAL_BYTES_PER_MESSAGE`

## 非目标

- 不做音频、视频、压缩包、Excel 表格。
- 不在上传阶段做 OCR、PDF 解析、docx 文本抽取或向量化。
- 不让云端门户直接读取本地 workspace 文件。
- 不改变微信直达 workspace ACP 主链路。
- 不把本地 `/platform` 改造成公网用户门户。

## 当前代码事实

### 已有能力

- `src/lib/attachment-store.ts` 已有 `storeWeixinAttachment()`，但只支持微信图片。
- `src/acp/agent.ts` 的 `buildAttachmentPrompt()` 已能把 `attachments` 注入 ACP prompt。
- `src/channels/weixin-message-bridge.ts` 已有批量消息合并和图片附件进入 ACP 的样板。
- `conversation_messages.metadata` 已存在，可先承载附件 metadata，避免第一版新增复杂查询表。

### 缺口

- `chatViaConversationLog()` 只接收 `text`，没有 `attachments`。
- `routes/portal.ts` 只接受 JSON text，且要求 text 非空。
- `portal/connector.ts` 的 `conversation.chat` 协议只传 `text`。
- `docs/user-portal-protocol.md` 的 `ConversationChatRequest` 没有附件字段。
- 云端/网页 UI 需要新增文件选择、预览、删除、上传进度、错误状态。

## 设计方向

复用微信端模式，扩展成通用附件存储：

```text
Browser
  -> Cloud Portal 或 local /api/portal
  -> conversation.chat(text + attachments)
  -> local connector / local portal route
  -> storePortalAttachments(workspace)
  -> appendConversationMessage(metadata.attachments)
  -> createAgent.handleMessage(context.attachments)
  -> ACP reads local files inside workspace
```

第一版推荐使用 JSON + base64 附件载荷，不引入 multipart 依赖。原因：

- 当前项目没有 `@fastify/multipart`。
- 文件大小有明确上限。
- Relay WebSocket command 可以直接复用同一结构。
- 后续可以兼容新增 `downloadUrl`，不破坏本地接口。

## 数据结构

新增通用输入类型，建议放在 `src/lib/attachment-store.ts`：

```ts
export type IncomingPortalAttachment = {
  kind?: "image" | "document";
  fileName: string;
  mimeType: string;
  sizeBytes?: number;
  base64?: string;
  downloadUrl?: string;
};
```

扩展存储结果：

```ts
export type StoredAttachment = {
  id: string;
  type: "image" | "document";
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  path: string;
  relativePath: string;
  source: "weixin" | "portal";
};
```

`conversation_messages.metadata` 中记录安全 metadata，不记录 `path`：

```json
{
  "attachments": [
    {
      "id": "att_...",
      "type": "image",
      "mimeType": "image/png",
      "fileName": "portfolio.png",
      "sizeBytes": 123456,
      "relativePath": "attachments/2026-07-06/att_..._portfolio.png",
      "source": "portal"
    }
  ]
}
```

注意：返回给云端/浏览器的 message metadata 不应包含绝对路径 `path`。绝对路径只在 ACP prompt 内部使用。

## 存储与校验

把 `src/lib/attachment-store.ts` 改造成通用模块：

- 保留 `storeWeixinAttachment()`，内部调用通用 `storeIncomingAttachment()`。
- 新增 `storePortalAttachment()` / `storePortalAttachments()`。
- 所有附件统一保存到 `${workspacePath}/attachments/YYYY-MM-DD/`。
- 文件名必须用 `path.basename()` 且只保留安全字符。
- 用扩展名、MIME、magic bytes 三层校验。

允许列表：

```ts
const ALLOWED_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_DOCUMENT_MIME = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/html",
  "text/markdown",
  "text/plain",
];
```

magic bytes 至少校验：

- PNG：`89 50 4E 47`
- JPEG：`FF D8 FF`
- WEBP：`RIFF....WEBP`
- PDF：`%PDF`
- DOC/PPT legacy：OLE header `D0 CF 11 E0 A1 B1 1A E1`
- DOCX/PPTX：ZIP header `PK`
- HTML/MD/TXT：按 UTF-8 文本读取前若干 KB，拒绝明显二进制内容

文档类不要执行宏、脚本或外部引用。HTML 只作为文件交给 ACP 读取，不在本地页面直接渲染。

## API 与协议改造

### 本地 HTTP API

扩展 `POST /api/portal/conversations/:conversationId/messages` body：

```ts
{
  userId?: string;
  assistantId?: string;
  instanceId?: string;
  projectId?: string;
  userMessageId?: string;
  text?: string;
  attachments?: IncomingPortalAttachment[];
  idempotencyKey?: string;
  clientSentAt?: string;
}
```

规则：

- `text` 和 `attachments` 至少一个非空。
- 如果只有附件没有文字，生成内部用户文本：
  - 图片：`用户上传了一张图片，请识别其中可能的持仓、观察仓、交易记录或投资相关信息。`
  - 文档：`用户上传了一份文档，请先概括内容并说明可提取的信息。`
- API 返回的 `userMessage.metadata.attachments` 只含安全 metadata。
- 400 错误要能区分：类型不支持、MIME 不匹配、文件过大、附件数量过多、base64 非法。

### Connector 协议

更新 `docs/user-portal-protocol.md`：

```ts
interface PortalAttachmentInput {
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

第一版 cloud portal 可以传 `base64`。如果云端已经有对象存储，则也可以传 `downloadUrl`，本地 connector 下载后仍执行同一套校验和大小限制。

注册能力新增：

```json
"capabilities": [
  "conversation.chat",
  "conversation.list",
  "conversation.get",
  "conversation.sync",
  "conversation.attachments"
]
```

### Conversation Log

扩展 `chatViaConversationLog()` 入参：

```ts
attachments?: IncomingPortalAttachment[];
```

流程：

1. `ensureWorkspace()`。
2. 保存附件，得到 `StoredAttachment[]`。
3. 生成 `userTextForAgent`。
4. `appendConversationMessage({ metadata: { attachments: publicAttachmentMetadata } })`。
5. `createAgent().handleMessage({ context: { ..., attachments: storedAttachments } })`。
6. `rememberConversationTurn()` 使用 `userTextForAgent`，不要把绝对路径写入长期记忆。

`getConversation()` 返回 messages 时保留 `metadata.attachments`，供网页端渲染附件卡片。

## ACP Prompt 处理

`src/acp/agent.ts` 已有 `buildAttachmentPrompt()`，需要扩展文案：

- 图片：提示可读取图片并识别截图内容。
- PDF/doc/ppt/html/md/txt：提示可读取本地文件，先总结/提取结构化内容。
- 所有类型：不要向用户暴露 `localPath`。
- 如果无法读取附件，必须说明限制，不得编造内容。

建议 prompt 行格式保持：

```text
1. type=document mime=application/pdf fileName=xxx.pdf localPath=/abs/path/...
```

## 网页端 UI 要求

云端 portal 项目实现，非本仓库 `/platform`：

- 聊天输入区支持选择文件和拖拽上传。
- 发送前显示附件 chip/card：文件名、类型、大小、删除按钮。
- 图片显示缩略图；文档显示类型图标。
- 附件超限时阻止发送并显示具体原因。
- 发送中禁用重复发送，但允许用户取消未发送的附件。
- 历史消息展示附件卡片，点击可查看云端镜像文件或显示“本地附件，仅本机可读”的状态。
- 不在浏览器暴露本地绝对路径。

如果第一版云端没有附件下载能力，至少要把附件 metadata 随消息镜像保存，并展示文件名/类型/大小。

## 实施步骤

1. 扩展附件存储模块。
   - 重构 `src/lib/attachment-store.ts`。
   - 新增 portal 附件输入、base64 解码、文档校验、大小限制。
   - 保持微信图片 smoke 不回归。

2. 扩展 conversation log。
   - `ConversationMessageRecord.metadata` 已存在，补类型注释即可。
   - `chatViaConversationLog()` 接收 `attachments`。
   - 写入 user message metadata。
   - 调用 ACP 时传 `context.attachments`。

3. 扩展本地 portal route。
   - `src/routes/portal.ts` 放宽 `text required` 为 `text or attachments required`。
   - 透传 attachments。
   - `/api/portal/health` capabilities 加 `conversation.attachments`。

4. 扩展 connector。
   - `src/portal/connector.ts` 从 `message.payload.attachments` 透传给 `chatViaConversationLog()`。
   - register capabilities 加 `conversation.attachments`。

5. 更新协议文档。
   - `docs/user-portal-protocol.md` 增加 attachment schema。
   - `docs/user-portal-goal-and-acceptance.md` 增加附件验收。

6. 更新 ACP prompt。
   - `src/acp/agent.ts` 的 `buildAttachmentPrompt()` 支持 document。
   - 确保 customer output sanitizer 不泄露 `localPath`。

7. 补测试与 smoke。
   - 新增 `scripts/portal-attachment-smoke.mjs`。
   - 扩展 `scripts/attachment-store-smoke.mjs`。
   - 保留 `scripts/portal-conversation-log-smoke.mjs`。

## 验收标准

### 本地运行时

- `npm run build` 通过。
- 微信附件 smoke 仍通过。
- 本地 portal 可发送纯图片、纯文档、文字 + 附件。
- 只发附件不发文字时，ACP 仍能收到合理用户意图。
- `conversation_messages.metadata.attachments` 有文件名、MIME、大小、relativePath、source，不包含绝对路径。
- ACP prompt 内部包含 localPath，但最终用户回复不泄露 localPath。
- 超限文件返回 400，不写入 conversation log，也不调用 ACP。
- 不支持类型返回 400。
- 同一 `idempotencyKey` 重试不会重复写用户消息。

### Connector / Portal

- `conversation.chat` 可携带 `attachments`。
- register capabilities 包含 `conversation.attachments`。
- 云端镜像能保存并展示附件 metadata。
- connector 离线或附件下载失败时，前端显示可理解错误，不创建虚假 assistant 回复。

### 安全

- 拒绝路径穿越文件名。
- 拒绝 MIME 与扩展名明显不匹配的文件。
- 拒绝超出单文件、总大小、数量限制的请求。
- HTML 文件不在本地管理页面直接渲染。
- 绝对路径不进入云端镜像或用户可见历史。

## 建议测试用例

- `portal image only`：上传 1 张 PNG，无 text，返回 assistant message。
- `portal text plus pdf`：上传 PDF + 文本“总结这份文档和投资相关信息”。
- `portal md/txt`：上传 UTF-8 文本，确认可保存和注入。
- `reject unsupported`：上传 `.zip`，返回 400。
- `reject too large`：构造超过限制的 base64，返回 400。
- `reject disguised binary txt`：二进制改名 `.txt`，返回 400。
- `idempotent retry`：同一 `idempotencyKey` 重试，不重复写入。
- `conversation get`：历史消息返回附件 metadata。

## 风险与取舍

- base64 会放大体积约 33%，所以第一版必须严格限制大小。后续可升级为云端对象存储 `downloadUrl`。
- doc/docx/ppt/pptx 是否能被 ACP 充分读取取决于当前 Codex 工具能力。实现层只保证文件进入 workspace 和 prompt。
- legacy `.doc/.ppt` 可能解析能力弱于 `.docx/.pptx`，回复中必须允许模型说明读取限制。
- 如果云端门户保留附件原文件，需要独立做权限控制、过期策略和病毒扫描；本仓库只负责本地 workspace 副本。

## Executor Prompt

请基于 `docs/portal-attachments-implementation-brief.md` 在本项目实现网页端图片与文档附件支持。优先修改本地运行时：`src/lib/attachment-store.ts`、`src/services/conversation-log.ts`、`src/routes/portal.ts`、`src/portal/connector.ts`、`src/acp/agent.ts` 和相关协议/验收文档。保持微信图片附件能力不回归，不要改造 `/platform` 为用户门户。实现后运行 `npm run build`，补充并运行 portal attachment smoke。

## Reviewer Prompt

请按 `docs/portal-attachments-implementation-brief.md` 审查实现结果。重点检查类型/大小/安全校验、conversation log metadata、ACP prompt 注入、connector 协议、绝对路径不外泄、微信附件不回归，以及 smoke 是否覆盖图片、文档、超限、非法类型和幂等重试。
