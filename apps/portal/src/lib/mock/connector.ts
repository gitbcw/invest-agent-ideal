import { WebSocket } from "ws";
import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";

import { getConfig, getMockScenario } from "@/lib/config";
import {
  buildEnvelope,
  buildOkResponse,
  buildErrorResponse,
  makeError,
  PORTAL_PROTOCOL_VERSION,
  PORTAL_TYPES,
  type ArtifactDeleteConfirmResult,
  type ArtifactDeletePrepareResult,
  type ArtifactLibraryItem,
  type ArtifactLibraryListResult,
  type AttachmentGetResult,
  type ConnectorHeartbeatPayload,
  type ConnectorRegisterPayload,
  type ConversationChannel,
  type ConversationCancelRequest,
  type ConversationChatRequest,
  type ConversationChatResult,
  type ConversationGetRequest,
  type ConversationGetResult,
  type ConversationListRequest,
  type ConversationListResult,
  type ConversationMessage,
  type ConversationSummary,
  type WorkspaceFileGetResult,
  type WorkspaceFileListResult,
  type PortalEnvelope,
  type PortalResponse
} from "@/lib/protocol";
import { generateMockAssistantReply, pickFixture, type MockFixture } from "./fixtures";
import {
  MOCK_ARTIFACT_BYTES,
  MOCK_ATTACHMENT_BYTES,
  MOCK_LIBRARY_ITEMS,
  mockDeleteImpactNotes
} from "./retention-fixtures";

const MOCK_HTML_REPORT = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>持仓风险报告</title><style>body{font-family:system-ui;padding:32px;color:#202123}h1{font-size:24px}section{margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb}</style></head><body><h1>持仓风险报告</h1><p>生成时间：2026-07-27</p><section><h2>风险摘要</h2><p>当前没有需要立即处理的异常信号。</p></section></body></html>";

export interface MockConnectorOptions {
  scenario: string;
  relayUrl: string;
  token: string;
  connectorId?: string;
  assistantId: string;
  instanceId: string;
  userId: string;
  projectId: string;
  displayName?: string;
  version?: string;
  // 允许测试时手动覆盖
  onLog?: (msg: string) => void;
}

/**
 * Mock connector:模拟本地 invest-agent-ideal 的 portal connector 行为。
 *
 * 不同场景(scenario)的行为:
 * - online: 正常 register + heartbeat + chat + list + get,响应快
 * - slow: chat 故意延迟 12 秒,等待状态可以观察
 * - failed: chat 返回 ACP_FAILED 错误
 * - offline: 启动后立刻关闭 socket,模拟 connector 不可用
 * - empty: 在线,但 fixture 没有任何会话历史
 * - paged: 在线,fixture 有 25 条会话,可验证分页
 */
export class MockConnector {
  private socket: WebSocket | null = null;
  private readonly heartbeatIntervalMs = 15_000;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private startedAt = new Date().toISOString();
  private currentFixture: MockFixture;
  private closed = false;
  private mockAssets = new Map<string, { asset: Record<string, unknown>; base64: string }>();
  private mockFolders = new Map<string, { folderId: string; parentFolderId: string | null; name: string; createdAt: string; updatedAt: string }>();
  private pendingChats = new Map<string, { requestId: string; timer: NodeJS.Timeout }>();

  constructor(private readonly options: MockConnectorOptions) {
    this.currentFixture = pickFixture(options.scenario);
    const content = "# Mock investment note\n\nThis fixture is available in My Files.\n";
    const assetId = "mock_asset_note";
    this.mockAssets.set(assetId, { base64: Buffer.from(content).toString("base64"), asset: mockAsset(assetId, "投资观察笔记", "investment-note.md", content.length, "conversation") });
    const reportContent = "# 每日复盘\n\nMock report preview.\n";
    const reportAssetId = "mock_asset_report_daily";
    this.mockAssets.set(reportAssetId, { base64: Buffer.from(reportContent).toString("base64"), asset: mockAsset(reportAssetId, "每日复盘", "daily-review.md", Buffer.byteLength(reportContent), "system") });
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.socket) {
      await new Promise<void>((resolve) => {
        const s = this.socket!;
        s.once("close", () => resolve());
        s.close(1000, "shutdown");
        setTimeout(() => {
          if (s.readyState !== WebSocket.CLOSED) s.terminate();
          resolve();
        }, 1500).unref();
      });
      this.socket = null;
    }
  }

  private connect() {
    if (this.closed) return;
    if (this.options.scenario === "offline") {
      this.options.onLog?.(`[mock:${this.options.scenario}] offline 模式:不建立连接`);
      return;
    }
    const url = new URL(this.options.relayUrl);
    url.searchParams.set("token", this.options.token);
    this.options.onLog?.(`[mock:${this.options.scenario}] connecting ${url.toString()}`);
    const socket = new WebSocket(url.toString());
    this.socket = socket;

    socket.on("open", () => {
      this.options.onLog?.(`[mock:${this.options.scenario}] connected, sending register`);
      this.sendRegister();
      this.scheduleHeartbeat();
    });

    socket.on("message", (raw) => {
      try {
        this.handleInbound(JSON.parse(raw.toString()) as PortalEnvelope | PortalResponse);
      } catch (err) {
        this.options.onLog?.(`[mock:${this.options.scenario}] parse error: ${(err as Error).message}`);
      }
    });

    socket.on("close", (code, reasonBuf) => {
      const reason = reasonBuf.toString();
      this.options.onLog?.(`[mock:${this.options.scenario}] closed code=${code} reason=${reason}`);
      if (this.heartbeatTimer) {
        clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (this.closed) return;
      this.scheduleReconnect();
    });

    socket.on("error", (err) => {
      this.options.onLog?.(`[mock:${this.options.scenario}] error: ${err.message}`);
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5_000);
  }

  private scheduleHeartbeat() {
    const tick = () => {
      const payload: ConnectorHeartbeatPayload = {
        connectorId: this.options.connectorId ?? this.defaultConnectorId(),
        assistantId: this.options.assistantId,
        status: "online",
        activeRequests: 0
      };
      this.sendEnvelope(PORTAL_TYPES.HEARTBEAT, `hb_${Date.now()}`, payload);
    };
    tick();
    this.heartbeatTimer = setInterval(tick, this.heartbeatIntervalMs);
  }

  private sendRegister() {
    const payload: ConnectorRegisterPayload = {
      connectorId: this.options.connectorId ?? this.defaultConnectorId(),
      assistantId: this.options.assistantId,
      instanceId: this.options.instanceId,
      userId: this.options.userId,
      projectId: this.options.projectId,
      displayName: this.options.displayName ?? "Mock Connector",
      version: this.options.version ?? "0.1.0-mock",
      startedAt: this.startedAt,
      capabilities: [
        "conversation.chat",
        "conversation.cancel",
        "conversation.list",
        "conversation.get",
        "conversation.sync",
        "conversation.attachments",
        // File-retention governance capabilities. The mock advertises them so
        // the Portal can exercise the file tree, attachment preview, image
        // lightbox and delete flows end-to-end without a real runtime.
        "artifact.library.list",
        "attachment.get",
        "workspace.file.list",
        "workspace.file.get",
        "report.mapping.get",
        "asset.list",
        "asset.folder.list",
        "asset.folder.create",
        "asset.folder.rename",
        "asset.folder.delete",
        "asset.move",
        "asset.get",
        "asset.version.get",
        "asset.versions.list",
        "asset.upload",
        "asset.conversation.save",
        "asset.rename",
        "asset.archive",
        "asset.convert_to_xlsx"
      ],
      mode: "mock"
    };
    this.sendEnvelope(PORTAL_TYPES.REGISTER, `reg_${nanoid(8)}`, payload);
  }

  private handleInbound(envelope: PortalEnvelope | PortalResponse) {
    // 我们发出请求后,relay 回的是 PortalResponse(envelope.requestId + ok)
    if ("ok" in envelope && typeof envelope.ok === "boolean") {
      // 注册响应、心跳响应,我们当前不打日志
      return;
    }
    const env = envelope as PortalEnvelope;
    switch (env.type) {
      case PORTAL_TYPES.CONVERSATION_LIST:
        this.handleList(env);
        break;
      case PORTAL_TYPES.CONVERSATION_GET:
        this.handleGet(env);
        break;
      case PORTAL_TYPES.CONVERSATION_CHAT:
        this.handleChat(env);
        break;
      case PORTAL_TYPES.CONVERSATION_CANCEL:
        this.handleCancel(env);
        break;
      case PORTAL_TYPES.ARTIFACT_LIBRARY_LIST:
        this.handleLibraryList(env);
        break;
      case PORTAL_TYPES.ARTIFACT_GET:
        this.handleArtifactGet(env);
        break;
      case PORTAL_TYPES.ATTACHMENT_GET:
        this.handleAttachmentGet(env);
        break;
      case PORTAL_TYPES.WORKSPACE_FILE_LIST:
        this.handleWorkspaceFileList(env);
        break;
      case PORTAL_TYPES.WORKSPACE_FILE_GET:
        this.handleWorkspaceFileGet(env);
        break;
      case PORTAL_TYPES.ASSET_LIST:
        this.handleAssetList(env);
        break;
      case PORTAL_TYPES.ASSET_FOLDER_LIST:
        this.sendResponse(env.type, env.requestId, { items: [...this.mockFolders.values()] });
        break;
      case PORTAL_TYPES.ASSET_FOLDER_CREATE:
        this.handleAssetFolderCreate(env);
        break;
      case PORTAL_TYPES.ASSET_FOLDER_RENAME:
        this.handleAssetFolderRename(env);
        break;
      case PORTAL_TYPES.ASSET_FOLDER_DELETE:
        this.handleAssetFolderDelete(env);
        break;
      case PORTAL_TYPES.ASSET_MOVE:
        this.handleAssetMove(env);
        break;
      case PORTAL_TYPES.ASSET_GET:
      case PORTAL_TYPES.ASSET_VERSION_GET:
        this.handleAssetGet(env);
        break;
      case PORTAL_TYPES.ASSET_VERSIONS_LIST:
        this.handleAssetVersions(env);
        break;
      case PORTAL_TYPES.ASSET_CONVERT_TO_XLSX:
        void this.handleAssetConvertToXlsx(env);
        break;
      case PORTAL_TYPES.ASSET_UPLOAD:
        this.handleAssetUpload(env);
        break;
      case PORTAL_TYPES.ASSET_CONVERSATION_SAVE:
        this.handleConversationSave(env);
        break;
      case PORTAL_TYPES.REPORT_MAPPING_GET:
        this.handleReportMappingGet(env);
        break;
      case PORTAL_TYPES.ARTIFACT_EVENT:
        // The UI records preview/download telemetry asynchronously. Acknowledge
        // it in the mock so browser acceptance does not leave relay requests
        // pending until shutdown.
        this.sendResponse(PORTAL_TYPES.ARTIFACT_EVENT, env.requestId, {});
        break;
      case PORTAL_TYPES.ARTIFACT_DELETE_PREPARE:
        this.handleDeletePrepare(env);
        break;
      case PORTAL_TYPES.ARTIFACT_DELETE_CONFIRM:
        this.handleDeleteConfirm(env);
        break;
      default:
        this.options.onLog?.(`[mock:${this.options.scenario}] unknown type ${env.type}`);
    }
  }

  private handleList(env: PortalEnvelope) {
    const req = env.payload as ConversationListRequest;
    const limit = clampInt(req.limit, 10, 50, 10);
    const items = this.currentFixture.conversations
      .filter((c) => !req.channel || c.channel === req.channel)
      .filter((c) => !req.cursor || c.updatedAt < req.cursor)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
    const result: ConversationListResult = {
      items,
      nextCursor: items.length === limit ? items[items.length - 1].updatedAt : undefined
    };
    this.sendResponse(PORTAL_TYPES.CONVERSATION_LIST, env.requestId, result);
  }

  private handleGet(env: PortalEnvelope) {
    const req = env.payload as ConversationGetRequest;
    const limit = clampInt(req.limit, 20, 100, 50);
    const all = this.currentFixture.messagesByConversation[req.conversationId] ?? [];
    const filtered = all
      .filter((m) => !req.cursor || m.createdAt > req.cursor)
      .slice(0, limit);
    const conv = this.currentFixture.conversations.find((c) => c.conversationId === req.conversationId);
    const result: ConversationGetResult = {
      conversationId: req.conversationId,
      title: conv?.title ?? "新的对话",
      messages: filtered,
      nextCursor: filtered.length === limit ? filtered[filtered.length - 1].createdAt : undefined
    };
    this.sendResponse(PORTAL_TYPES.CONVERSATION_GET, env.requestId, result);
  }

  private handleChat(env: PortalEnvelope) {
    const req = env.payload as ConversationChatRequest;

    if (this.options.scenario === "failed") {
      this.sendErrorResponse(PORTAL_TYPES.CONVERSATION_CHAT, env.requestId, {
        code: "ACP_FAILED",
        message: "mock connector 故意返回失败场景",
        retryable: true
      });
      return;
    }

    const delayMs = this.options.scenario === "slow" ? 12_000 : 600;
    const timer = setTimeout(() => {
      this.pendingChats.delete(req.conversationId);
      if (this.closed || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;

      // 维护 fixture:让本地立刻"看到"这条新消息
      const now = new Date().toISOString();
      const userMsg: ConversationMessage = {
        messageId: req.userMessageId,
        conversationId: req.conversationId,
        userId: req.userId,
        assistantId: req.assistantId,
        instanceId: req.instanceId,
        channel: "web",
        role: "user",
        content: req.text || attachmentOnlyText(req.attachments || []),
        status: "sent",
        requestId: env.requestId,
        createdAt: req.clientSentAt,
        metadata: req.attachments?.length
          ? { attachments: req.attachments.map((item, index) => ({
            id: `mock_att_${index + 1}`,
            attachmentId: `mock_att_${index + 1}`,
            type: item.kind || (item.mimeType.startsWith("image/") ? "image" : "document"),
            mimeType: item.mimeType,
            fileName: item.fileName,
            sizeBytes: item.sizeBytes,
            source: "portal",
            // 7-day server-side TTL, matching the runtime contract.
            expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
          })) }
          : undefined
      };
      const assistantMessageId = `msg_${nanoid(16)}`;
      const assistantText = generateMockAssistantReply(req.text || attachmentOnlyText(req.attachments || []));
      const assistantMsg: ConversationMessage = {
        messageId: assistantMessageId,
        conversationId: req.conversationId,
        userId: req.userId,
        assistantId: req.assistantId,
        instanceId: req.instanceId,
        channel: "web",
        role: "assistant",
        content: assistantText,
        status: "sent",
        traceId: `trace_mock_${nanoid(8)}`,
        requestId: env.requestId,
        createdAt: now
      };

      // 维护内存 fixture,这样后续 list/get 能看到新会话与消息
      const existingConv = this.currentFixture.conversations.find(
        (c) => c.conversationId === req.conversationId
      );
      if (!existingConv) {
        const newConv: ConversationSummary = {
          conversationId: req.conversationId,
          title: deriveTitle(req.text || attachmentOnlyText(req.attachments || [])),
          channel: "web" as ConversationChannel,
          lastMessagePreview: assistantText.slice(0, 80),
          messageCount: 2,
          createdAt: req.clientSentAt,
          updatedAt: now
        };
        this.currentFixture.conversations.unshift(newConv);
      } else {
        existingConv.lastMessagePreview = assistantText.slice(0, 80);
        existingConv.updatedAt = now;
        existingConv.messageCount += 2;
      }
      const list = this.currentFixture.messagesByConversation[req.conversationId] ?? [];
      list.push(userMsg, assistantMsg);
      this.currentFixture.messagesByConversation[req.conversationId] = list;

      const result: ConversationChatResult = {
        conversationId: req.conversationId,
        userMessage: userMsg,
        assistantMessage: assistantMsg,
        traceId: assistantMsg.traceId
      };
      this.sendResponse(PORTAL_TYPES.CONVERSATION_CHAT, env.requestId, result);
    }, delayMs);
    this.pendingChats.set(req.conversationId, { requestId: env.requestId, timer });
    timer.unref?.();
  }

  private handleCancel(env: PortalEnvelope) {
    const req = env.payload as ConversationCancelRequest;
    const pending = this.pendingChats.get(req.conversationId);
    if (!pending) {
      this.sendResponse(PORTAL_TYPES.CONVERSATION_CANCEL, env.requestId, {
        conversationId: req.conversationId,
        status: "no_active"
      });
      return;
    }
    this.pendingChats.delete(req.conversationId);
    clearTimeout(pending.timer);
    // Resolve the in-flight chat as a terminal connector failure so the
    // Portal can release its HTTP request and render the cancellation state.
    this.sendErrorResponse(PORTAL_TYPES.CONVERSATION_CHAT, pending.requestId, {
      code: "ACP_FAILED",
      message: "本次处理已停止",
      retryable: false,
      details: {
        executionStatus: "failed",
        executionErrorCode: "ACP_TURN_CANCELLED",
        executionErrorCategory: "cancelled",
        executionRetryable: false
      }
    });
    this.sendResponse(PORTAL_TYPES.CONVERSATION_CANCEL, env.requestId, {
      conversationId: req.conversationId,
      status: "cancelled"
    });
  }

  private sendEnvelope(type: string, requestId: string, payload: unknown) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(buildEnvelope(type, requestId, payload)));
  }

  // ---- File-retention governance handlers (mock) ----
  // The mock mirrors the runtime contract from user-portal-protocol.md so the
  // Portal can exercise the file tree, attachment preview, lightbox and delete
  // flows end-to-end. State is per-connector-instance and resets on restart.

  private deletedArtifactIds = new Set<string>();
  private deleteTokens = new Map<string, { artifactId: string; path: string; expiresAt: number }>();

  private handleLibraryList(env: PortalEnvelope) {
    const items = MOCK_LIBRARY_ITEMS.filter((item) => !this.deletedArtifactIds.has(item.artifactId));
    const result: ArtifactLibraryListResult = { items };
    this.sendResponse(PORTAL_TYPES.ARTIFACT_LIBRARY_LIST, env.requestId, result);
  }

  private handleWorkspaceFileList(env: PortalEnvelope) {
    const items: WorkspaceFileListResult["items"] = [
      mockWorkspaceFile("AGENTS.md", "text/markdown", "# 投资助手\n"),
      mockWorkspaceFile("docs/preview.html", "text/html", "<h1>Workspace preview</h1>\n"),
      mockWorkspaceFile("images/chart.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#f3f4f6"/><circle cx="160" cy="90" r="48" fill="#10a37f"/></svg>'),
      mockWorkspaceFile("knowledge/decision_protocol.md", "text/markdown", "# 决策协议\n"),
      mockWorkspaceFile("reports/daily/today.md", "text/markdown", "# 今日复盘\n"),
      mockWorkspaceFile(
        "reports/html/2026-07-27-portfolio-risk.html",
        "text/html",
        MOCK_HTML_REPORT
      )
    ];
    this.sendResponse(PORTAL_TYPES.WORKSPACE_FILE_LIST, env.requestId, { items });
  }

  private handleWorkspaceFileGet(env: PortalEnvelope) {
    const path = String((env.payload as { relativePath?: string }).relativePath || "");
    const contentByPath: Record<string, string> = {
      "AGENTS.md": "# 投资助手\n",
      "docs/preview.html": "<h1>Workspace preview</h1>\n",
      "images/chart.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#f3f4f6"/><circle cx="160" cy="90" r="48" fill="#10a37f"/></svg>',
      "knowledge/decision_protocol.md": "# 决策协议\n",
      "reports/daily/today.md": "# 今日复盘\n",
      "reports/html/2026-07-27-portfolio-risk.html": MOCK_HTML_REPORT
    };
    const content = contentByPath[path] ?? "";
    const mimeType = path.endsWith(".md") ? "text/markdown" : path.endsWith(".html") ? "text/html" : path.endsWith(".svg") ? "image/svg+xml" : "text/plain";
    const item = mockWorkspaceFile(path || "AGENTS.md", mimeType, content);
    const data: WorkspaceFileGetResult = { ...item, base64: Buffer.from(content).toString("base64"), checksum: createHash("sha256").update(content).digest("hex") };
    this.sendResponse(PORTAL_TYPES.WORKSPACE_FILE_GET, env.requestId, data);
  }

  private handleAssetList(env: PortalEnvelope) {
    const payload = env.payload as { source?: unknown; folderId?: unknown };
    const source = typeof payload?.source === "string" ? payload.source : undefined;
    const hasFolderFilter = Object.prototype.hasOwnProperty.call(payload || {}, "folderId");
    const folderId = typeof payload?.folderId === "string" && payload.folderId ? payload.folderId : null;
    const items = [...this.mockAssets.values()].map((entry) => entry.asset)
      .filter((asset) => !hasFolderFilter || asset.folderId === folderId)
      .filter((asset) => !source || (asset.currentVersion as { source?: string } | null)?.source === source);
    const reportAsset = this.mockAssets.get("mock_asset_report_daily")?.asset;
    const report = { mappingId: "mock_report_daily", reportId: "mock_report_daily", title: "每日复盘", fileName: "daily-review.md", mimeType: "text/markdown", sizeBytes: 42, backingAssetId: "mock_asset_report_daily", backingVersionId: reportAsset?.currentVersionId || null, createdAt: "2026-08-06T08:00:00.000Z" };
    const visibleReport = !hasFolderFilter || items.some((asset) => asset.assetId === report.backingAssetId);
    const catalog = [...items.map((asset) => ({ ...asset, catalogId: `asset:${asset.assetId}`, catalogKind: "asset", sources: [(asset.currentVersion as { source: string }).source] })), ...(visibleReport ? [{ assetId: "report:mock_report_daily", name: report.title, status: "active", currentVersionId: null, currentVersion: null, createdAt: report.createdAt, updatedAt: report.createdAt, archivedAt: null, folderId: null, catalogId: "report:mock_report_daily", catalogKind: "report", sources: ["report"], reportMappingId: report.mappingId, reportId: report.reportId }] : [])];
    this.sendResponse(PORTAL_TYPES.ASSET_LIST, env.requestId, { items, catalog, reportMappings: visibleReport ? [report] : [], folders: [...this.mockFolders.values()], storageUsage: { usedBytes: 64 * 1024, reservedBytes: 0, limitBytes: 200 * 1024 * 1024, availableBytes: 200 * 1024 * 1024 - 64 * 1024 } });
  }

  private handleAssetFolderCreate(env: PortalEnvelope) {
    const payload = env.payload as { name?: unknown; parentFolderId?: unknown };
    const name = String(payload?.name || "").trim();
    const parentFolderId = typeof payload?.parentFolderId === "string" && payload.parentFolderId ? payload.parentFolderId : null;
    if (!name) return this.sendErrorResponse(env.type, env.requestId, { code: "INVALID_REQUEST", message: "mock: folder name is required", retryable: false });
    if (parentFolderId && !this.mockFolders.has(parentFolderId)) return this.sendErrorResponse(env.type, env.requestId, { code: "ASSET_FOLDER_NOT_FOUND", message: "mock: folder not found", retryable: false });
    const parent = parentFolderId ? this.mockFolders.get(parentFolderId) : null;
    if (parent?.parentFolderId) return this.sendErrorResponse(env.type, env.requestId, { code: "ASSET_FOLDER_DEPTH_EXCEEDED", message: "mock: folder depth exceeded", retryable: false });
    const duplicate = [...this.mockFolders.values()].some((folder) => folder.parentFolderId === parentFolderId && folder.name.toLowerCase() === name.toLowerCase());
    if (duplicate) return this.sendErrorResponse(env.type, env.requestId, { code: "ASSET_FOLDER_NAME_CONFLICT", message: "mock: folder name conflict", retryable: false });
    const now = new Date().toISOString();
    const folder = { folderId: `mock_folder_${nanoid(8)}`, parentFolderId, name, createdAt: now, updatedAt: now };
    this.mockFolders.set(folder.folderId, folder);
    this.sendResponse(env.type, env.requestId, folder);
  }

  private handleAssetFolderRename(env: PortalEnvelope) {
    const payload = env.payload as { folderId?: unknown; name?: unknown };
    const folderId = String(payload?.folderId || "");
    const name = String(payload?.name || "").trim();
    const folder = this.mockFolders.get(folderId);
    if (!folder) return this.sendErrorResponse(env.type, env.requestId, { code: "ASSET_FOLDER_NOT_FOUND", message: "mock: folder not found", retryable: false });
    if (!name) return this.sendErrorResponse(env.type, env.requestId, { code: "INVALID_REQUEST", message: "mock: folder name is required", retryable: false });
    const duplicate = [...this.mockFolders.values()].some((candidate) => candidate.folderId !== folderId && candidate.parentFolderId === folder.parentFolderId && candidate.name.toLowerCase() === name.toLowerCase());
    if (duplicate) return this.sendErrorResponse(env.type, env.requestId, { code: "ASSET_FOLDER_NAME_CONFLICT", message: "mock: folder name conflict", retryable: false });
    folder.name = name;
    folder.updatedAt = new Date().toISOString();
    this.sendResponse(env.type, env.requestId, folder);
  }

  private handleAssetFolderDelete(env: PortalEnvelope) {
    const folderId = String((env.payload as { folderId?: unknown })?.folderId || "");
    if (!this.mockFolders.has(folderId)) return this.sendErrorResponse(env.type, env.requestId, { code: "ASSET_FOLDER_NOT_FOUND", message: "mock: folder not found", retryable: false });
    const hasChildren = [...this.mockFolders.values()].some((folder) => folder.parentFolderId === folderId);
    const hasAssets = [...this.mockAssets.values()].some((entry) => entry.asset.folderId === folderId);
    if (hasChildren || hasAssets) return this.sendErrorResponse(env.type, env.requestId, { code: "ASSET_FOLDER_NOT_EMPTY", message: "文件夹不是空的，请先移出其中的文件或子文件夹", retryable: false });
    this.mockFolders.delete(folderId);
    this.sendResponse(env.type, env.requestId, { folderId });
  }

  private handleAssetMove(env: PortalEnvelope) {
    const payload = env.payload as { assetId?: unknown; folderId?: unknown };
    const assetId = String(payload?.assetId || "");
    const folderId = typeof payload?.folderId === "string" && payload.folderId ? payload.folderId : null;
    const entry = this.mockAssets.get(assetId);
    if (!entry) return this.sendErrorResponse(env.type, env.requestId, { code: "ASSET_NOT_FOUND", message: "mock: asset not found", retryable: false });
    if (folderId && !this.mockFolders.has(folderId)) return this.sendErrorResponse(env.type, env.requestId, { code: "ASSET_FOLDER_NOT_FOUND", message: "mock: folder not found", retryable: false });
    entry.asset.folderId = folderId;
    entry.asset.updatedAt = new Date().toISOString();
    this.sendResponse(env.type, env.requestId, entry.asset);
  }

  private handleAssetGet(env: PortalEnvelope) {
    const assetId = String((env.payload as { assetId?: string })?.assetId || "mock_asset_note");
    const entry = this.mockAssets.get(assetId);
    if (!entry) return this.sendErrorResponse(env.type, env.requestId, { code: "ASSET_NOT_FOUND", message: "mock asset not found", retryable: false });
    if (env.type === PORTAL_TYPES.ASSET_VERSION_GET) return this.sendResponse(env.type, env.requestId, { ...(entry.asset.currentVersion as Record<string, unknown>), base64: entry.base64 });
    this.sendResponse(env.type, env.requestId, entry.asset);
  }

  private handleAssetVersions(env: PortalEnvelope) {
    const assetId = String((env.payload as { assetId?: string })?.assetId || "");
    const entry = this.mockAssets.get(assetId);
    if (!entry) return this.sendErrorResponse(env.type, env.requestId, { code: "ASSET_NOT_FOUND", message: "mock asset not found", retryable: false });
    this.sendResponse(env.type, env.requestId, { items: [entry.asset.currentVersion] });
  }

  private async handleAssetConvertToXlsx(env: PortalEnvelope) {
    const payload = env.payload as { assetId?: string; expectedVersionId?: string; confirmed?: boolean };
    const entry = this.mockAssets.get(String(payload.assetId || ""));
    if (!entry) return this.sendErrorResponse(env.type, env.requestId, { code: "ASSET_NOT_FOUND", message: "mock asset not found", retryable: false });
    if (payload.confirmed !== true) return this.sendErrorResponse(env.type, env.requestId, { code: "ASSET_CONFIRMATION_REQUIRED", message: "mock: confirmation required", retryable: false });
    const current = entry.asset.currentVersion as Record<string, unknown>;
    if (current.versionId !== payload.expectedVersionId) return this.sendErrorResponse(env.type, env.requestId, { code: "ASSET_VERSION_CONFLICT", message: "mock: stale version", retryable: false });
    if (current.format !== "csv") return this.sendErrorResponse(env.type, env.requestId, { code: "ASSET_UNSUPPORTED_FORMAT", message: "mock: CSV required", retryable: false });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("数据", { views: [{ state: "frozen", ySplit: 1 }] });
    for (const row of Buffer.from(entry.base64, "base64").toString("utf8").trimEnd().split(/\r?\n/)) sheet.addRow(row.split(","));
    if (sheet.rowCount && sheet.columnCount) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: sheet.rowCount, column: sheet.columnCount } };
    sheet.getRow(1).font = { bold: true };
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const versionId = `mock_version_${nanoid(8)}`;
    const fileName = String(current.fileName || "file.csv").replace(/\.csv$/i, ".xlsx");
    entry.base64 = bytes.toString("base64");
    entry.asset.currentVersionId = versionId;
    entry.asset.updatedAt = new Date().toISOString();
    entry.asset.currentVersion = { ...current, versionId, versionNumber: Number(current.versionNumber || 1) + 1, fileName, format: "xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sizeBytes: bytes.length, parentVersionId: current.versionId, createdAt: new Date().toISOString() };
    this.sendResponse(env.type, env.requestId, entry.asset);
  }

  private handleAssetUpload(env: PortalEnvelope) {
    const rawFiles = Array.isArray((env.payload as { files?: unknown[] })?.files) ? (env.payload as { files: Array<Record<string, unknown>> }).files : [env.payload as Record<string, unknown>];
    const total = rawFiles.reduce((sum, file) => sum + Buffer.byteLength(String(file.base64 || ""), "base64"), 0);
    if (total > 20 * 1024 * 1024 || rawFiles.some((file) => Buffer.byteLength(String(file.base64 || ""), "base64") > 10 * 1024 * 1024)) return this.sendErrorResponse(env.type, env.requestId, { code: "UPLOAD_REQUEST_TOO_LARGE", message: "mock upload exceeds limits", retryable: false });
    const results = rawFiles.map((file, index) => {
      const fileName = String(file.fileName || `upload-${index}.txt`);
      const assetId = `mock_asset_${nanoid(8)}`;
      const base64 = String(file.base64 || "");
      const asset = mockAsset(assetId, String(file.name || fileName), fileName, Buffer.byteLength(base64, "base64"), "upload", String(file.mimeType || "text/plain"));
      asset.folderId = typeof file.folderId === "string" && file.folderId ? file.folderId : null;
      this.mockAssets.set(assetId, { asset, base64 });
      return { index, fileName, ok: true, asset };
    });
    this.sendResponse(env.type, env.requestId, Array.isArray((env.payload as { files?: unknown[] })?.files) ? { items: results } : results[0].asset);
  }

  private handleConversationSave(env: PortalEnvelope) {
    const artifactId = String((env.payload as { artifactId?: string })?.artifactId || "mock_artifact_daily");
    const assetId = `mock_saved_${artifactId}`;
    const content = "# Saved conversation artifact\n";
    const asset = mockAsset(assetId, "已保存的对话文件", "saved-conversation.md", content.length, "conversation");
    this.mockAssets.set(assetId, { asset, base64: Buffer.from(content).toString("base64") });
    this.sendResponse(env.type, env.requestId, asset);
  }

  private handleReportMappingGet(env: PortalEnvelope) {
    const content = "# 每日复盘\n\nMock report preview.\n";
    this.sendResponse(env.type, env.requestId, { fileName: "daily-review.md", mimeType: "text/markdown", sizeBytes: Buffer.byteLength(content), base64: Buffer.from(content).toString("base64") });
  }

  private handleArtifactGet(env: PortalEnvelope) {
    const req = env.payload as { artifactId: string };
    if (this.deletedArtifactIds.has(req.artifactId)) {
      this.sendErrorResponse(PORTAL_TYPES.ARTIFACT_GET, env.requestId, {
        code: "ARTIFACT_DELETED",
        message: "mock: artifact deleted",
        retryable: false
      });
      return;
    }
    const item = MOCK_LIBRARY_ITEMS.find((i) => i.artifactId === req.artifactId);
    const bytes = MOCK_ARTIFACT_BYTES[req.artifactId];
    if (!item || !bytes) {
      this.sendErrorResponse(PORTAL_TYPES.ARTIFACT_GET, env.requestId, {
        code: "ARTIFACT_NOT_FOUND",
        message: "mock: unknown artifact id",
        retryable: false
      });
      return;
    }
    // The ArtifactGetResult shape is the inline-artifact descriptor + bytes.
    this.sendResponse(PORTAL_TYPES.ARTIFACT_GET, env.requestId, {
      artifactId: item.artifactId,
      title: item.title,
      fileName: item.fileName,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      kind: item.openRoute === "image" ? "chart" : "report",
      previewMode: item.previewMode,
      createdAt: item.createdAt,
      checksum: item.checksum,
      sanitized: false,
      base64: bytes.base64
    });
  }

  private handleAttachmentGet(env: PortalEnvelope) {
    const req = env.payload as { attachmentId: string };
    const record = MOCK_ATTACHMENT_BYTES[req.attachmentId];
    if (!record) {
      this.sendErrorResponse(PORTAL_TYPES.ATTACHMENT_GET, env.requestId, {
        code: "ATTACHMENT_NOT_FOUND",
        message: "mock: unknown attachment id",
        retryable: false
      });
      return;
    }
    if (record.status === "expired") {
      const result: AttachmentGetResult = {
        attachmentId: req.attachmentId,
        status: "expired",
        fileName: record.fileName,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        expiresAt: record.expiresAt
      };
      this.sendResponse(PORTAL_TYPES.ATTACHMENT_GET, env.requestId, result);
      return;
    }
    const result: AttachmentGetResult = {
      attachmentId: req.attachmentId,
      status: "active",
      fileName: record.fileName,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      storedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: record.expiresAt,
      base64: record.base64
    };
    this.sendResponse(PORTAL_TYPES.ATTACHMENT_GET, env.requestId, result);
  }

  private handleDeletePrepare(env: PortalEnvelope) {
    const req = env.payload as { artifactId: string };
    const item = MOCK_LIBRARY_ITEMS.find((i) => i.artifactId === req.artifactId);
    if (!item || this.deletedArtifactIds.has(req.artifactId)) {
      this.sendErrorResponse(PORTAL_TYPES.ARTIFACT_DELETE_PREPARE, env.requestId, {
        code: "ARTIFACT_NOT_DELETABLE",
        message: "mock: artifact not deletable",
        retryable: false
      });
      return;
    }
    const tokenId = `mock_del_${nanoid(12)}`;
    this.deleteTokens.set(tokenId, {
      artifactId: req.artifactId,
      path: item.displayPath,
      expiresAt: Date.now() + 10 * 60 * 1000
    });
    const result: ArtifactDeletePrepareResult = {
      tokenId,
      artifactId: item.artifactId,
      title: item.title,
      fileName: item.fileName,
      displayPath: item.displayPath,
      sizeBytes: item.sizeBytes,
      category: item.category,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      impactNotes: mockDeleteImpactNotes(item.category)
    };
    this.sendResponse(PORTAL_TYPES.ARTIFACT_DELETE_PREPARE, env.requestId, result);
  }

  private handleDeleteConfirm(env: PortalEnvelope) {
    const req = env.payload as { tokenId: string };
    const token = this.deleteTokens.get(req.tokenId);
    if (!token || Date.now() > token.expiresAt) {
      this.deleteTokens.delete(req.tokenId);
      this.sendErrorResponse(PORTAL_TYPES.ARTIFACT_DELETE_CONFIRM, env.requestId, {
        code: "ARTIFACT_DELETE_CONFIRMATION_EXPIRED",
        message: "mock: token expired or unknown",
        retryable: false
      });
      return;
    }
    this.deleteTokens.delete(req.tokenId);
    this.deletedArtifactIds.add(token.artifactId);
    const result: ArtifactDeleteConfirmResult = {
      artifactId: token.artifactId,
      deletedVersions: 1,
      trashRelativePath: `.trash/artifacts/mock/${token.artifactId}`,
      purgeAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    };
    this.sendResponse(PORTAL_TYPES.ARTIFACT_DELETE_CONFIRM, env.requestId, result);
  }

  private sendResponse<T>(type: string, requestId: string, data: T) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      JSON.stringify(buildOkResponse(type, requestId, data))
    );
  }

  private sendErrorResponse(
    type: string,
    requestId: string,
    err: { code: Parameters<typeof makeError>[0]; message: string; retryable: boolean; details?: Record<string, unknown> }
  ) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      JSON.stringify(
        buildErrorResponse(type, requestId, makeError(err.code, err.message, err.retryable, err.details))
      )
    );
  }

  private defaultConnectorId(): string {
    return `mock-connector-${this.options.scenario}`;
  }
}

function mockAsset(assetId: string, name: string, fileName: string, sizeBytes: number, source: string, mimeType = "text/markdown"): Record<string, unknown> {
  const format = fileName.endsWith(".csv") ? "csv" : fileName.endsWith(".xlsx") ? "xlsx" : fileName.endsWith(".pdf") ? "pdf" : fileName.endsWith(".png") ? "png" : "markdown";
  const versionId = `mock_version_${assetId}`;
  return {
    assetId, name, folderId: null, status: "active", currentVersionId: versionId,
    currentVersion: { versionId, assetId, versionNumber: 1, fileName, format, mimeType, sizeBytes, checksum: createHash("sha256").update(assetId).digest("hex"), source, createdAt: "2026-08-06T08:00:00.000Z" },
    createdAt: "2026-08-06T08:00:00.000Z", updatedAt: "2026-08-06T08:00:00.000Z", archivedAt: null,
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "新的对话";
  return clean.length > 24 ? `${clean.slice(0, 24)}…` : clean;
}

function attachmentOnlyText(attachments: { kind?: string; mimeType: string }[]): string {
  const imageCount = attachments.filter((item) => item.kind === "image" || item.mimeType.startsWith("image/")).length;
  const documentCount = attachments.length - imageCount;
  if (imageCount > 0 && documentCount > 0) return `上传了 ${imageCount} 张图片和 ${documentCount} 份文档`;
  if (imageCount > 0) return `上传了 ${imageCount} 张图片`;
  if (documentCount > 0) return `上传了 ${documentCount} 份文档`;
  return "";
}

function mockWorkspaceFile(relativePath: string, mimeType: string, content: string): WorkspaceFileListResult["items"][number] {
  const bytes = Buffer.byteLength(content);
  const previewMode = mimeType === "text/markdown" ? "markdown" : mimeType === "text/html" ? "html" : mimeType.startsWith("image/") ? "image" : mimeType.startsWith("text/") || mimeType.includes("yaml") ? "text" : "unsupported";
  return {
    fileId: createHash("sha256").update(relativePath).digest("hex").slice(0, 24),
    relativePath,
    fileName: relativePath.split("/").at(-1) || relativePath,
    mimeType,
    sizeBytes: bytes,
    updatedAt: new Date().toISOString(),
    previewMode,
    downloadable: true
  };
}

/**
 * 启动 mock connector 的便捷工厂。读 PORTAL_MOCK_SCENARIO 环境变量。
 */
export function createMockConnectorFromEnv(): MockConnector {
  const cfg = getConfig();
  const scenario = getMockScenario();
  return new MockConnector({
    scenario,
    relayUrl: `ws://127.0.0.1:${cfg.relayPort}/`,
    token: cfg.connectorToken,
    assistantId: cfg.defaultAssistantId,
    instanceId: cfg.defaultInstanceId,
    userId: "primary",
    projectId: cfg.defaultProjectId,
    onLog: (msg) => console.log(msg)
  });
}

export const PROTOCOL_VERSION = PORTAL_PROTOCOL_VERSION;
