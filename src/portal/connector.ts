import { randomUUID } from "node:crypto";
import { initDb, sqlite } from "../db/index.js";
import { config } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { cancelConversationChat, chatViaConversationLog, ConversationScopeError, getConversation, listConversations, setConversationMessageFeedback } from "../services/conversation-log.js";
import { getRulePatrolStatus, listRulePatrolRuns, runRulePatrolNow } from "../services/rule-patrol.js";
import { createWatchRule, deleteWatchRule, dryRunWatchRuleById, listWatchRuleCatalog, listWatchRules, updateWatchRule, validateWatchRule, type WatchRuleType } from "../services/watch-rules.js";
import { recordSandboxAudit } from "../lib/sandbox-audit.js";
import { listProjectRuntimeContexts, type AiProjectRuntimeContext } from "../platform/project-registry.js";
import { AttachmentStoreError } from "../lib/attachment-store.js";
import { WorkspaceReportAssetError, readWorkspaceReportAsset } from "../services/workspace-report-assets.js";
import {
  ConversationArtifactError,
  listCuratedArtifactLibrary,
  logArtifactEvent,
  publishLegacyPathArtifact,
  readConversationArtifactPayload,
} from "../services/conversation-artifacts.js";
import {
  AttachmentRetentionError,
  findAttachmentRecord,
  readAttachmentBytes,
} from "../services/file-retention.js";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  WorkspaceFileError,
} from "../services/workspace-files.js";
import { ConcurrentTaskLimiter, portalConcurrentTaskLimit } from "./concurrent-task-limiter.js";
import {
  AutomationTaskError,
  activateAutomationTask,
  archiveAutomationTask,
  batchAutomationTaskAction,
  createAutomationTask,
  updateAutomationTask,
  pauseAutomationTask,
  listAutomationTasks,
  getAutomationTask,
  listAutomationTaskRuns,
  listAutomationTaskRunsPage,
  listAutomationTaskPage,
  getAutomationTaskRun,
  downloadAutomationTaskAsset,
} from "../services/automation-tasks.js";
import { continueAutomationRunInChat, runAutomationTaskNow } from "../services/automation-runner.js";
import { migrateLegacyAutomationTaskToAssets } from "../services/automation-task-migration.js";
import {
  archiveUserAsset,
  deleteUserAsset,
  createUserAsset,
  convertUserAssetCsvToXlsx,
  getUserAsset,
  listUserAssetReferences,
  listUserAssetVersions,
  listUserAssets,
  listUserAssetFolders,
  createUserAssetFolder,
  renameUserAssetFolder,
  deleteUserAssetFolder,
  moveUserAsset,
  readCurrentUserAsset,
  readUserAssetVersion,
  renameUserAsset,
  restoreUserAssetVersion,
  UserAssetError,
  saveConversationArtifactAsUserAsset,
  uploadUserAssetVersion,
} from "../services/user-assets.js";
import { assertUploadRequestSize, getStorageUsage } from "../services/user-storage-quota.js";
import { USAGE_DAY_BUCKET_SQL, usageRange } from "./usage-range.js";
import { backfillFormalReportAssetMappings, getReportAssetMappingForRead, listReportAssetMappings, registerReportAssetMapping } from "../services/report-asset-mappings.js";
import { modelRoutingSnapshot, resolveAutoModel } from "../services/model-health.js";
import { pricingSummary } from "../services/model-pricing.js";

const PROTOCOL_VERSION = "2026-08-05";
const LEGACY_PROTOCOL_VERSION = "2026-07-04";
const TYPES = {
  REGISTER: "connector.register",
  HEARTBEAT: "connector.heartbeat",
  CONVERSATION_LIST: "conversation.list",
  CONVERSATION_GET: "conversation.get",
  CONVERSATION_CHAT: "conversation.chat",
  CONVERSATION_REGENERATE: "conversation.regenerate",
  CONVERSATION_FEEDBACK: "conversation.feedback",
  CONVERSATION_CANCEL: "conversation.cancel",
  TRACE_GET: "trace.get",
  CONVERSATION_CHAT_PROGRESS: "conversation.chat.progress",
  REPORT_ASSET_GET: "report.asset.get",
  REPORT_MAPPING_GET: "report.mapping.get",
  ARTIFACT_GET: "artifact.get",
  ARTIFACT_LIBRARY_LIST: "artifact.library.list",
  ARTIFACT_PUBLISH_LEGACY: "artifact.publish.legacy",
  ARTIFACT_EVENT: "artifact.event",
  ATTACHMENT_GET: "attachment.get",
  WORKSPACE_FILE_LIST: "workspace.file.list",
  WORKSPACE_FILE_GET: "workspace.file.get",
  AUTOMATION_LIST: "automation.list",
  AUTOMATION_GET: "automation.get",
  AUTOMATION_CREATE: "automation.create",
  AUTOMATION_UPDATE: "automation.update",
  AUTOMATION_ACTIVATE: "automation.activate",
  AUTOMATION_PAUSE: "automation.pause",
  AUTOMATION_BATCH_ACTION: "automation.batch_action",
  AUTOMATION_RUN_NOW: "automation.run_now",
  AUTOMATION_RUNS_LIST: "automation.runs.list",
  RULE_PATROL_STATUS: "rule_patrol.status",
  MODELS_STATE: "models.state",
  USAGE_SUMMARY: "usage.summary",
  USAGE_RECORDS: "usage.records",
  RULE_PATROL_RUN_NOW: "rule_patrol.run_now",
  RULE_PATROL_RULES_LIST: "rule_patrol.rules.list",
  RULE_PATROL_RULES_CREATE: "rule_patrol.rules.create",
  RULE_PATROL_RULES_UPDATE: "rule_patrol.rules.update",
  RULE_PATROL_RULES_DELETE: "rule_patrol.rules.delete",
  RULE_PATROL_RULES_DRY_RUN: "rule_patrol.rules.dry_run",
  AUTOMATION_RUN_GET: "automation.run.get",
  AUTOMATION_ASSET_GET: "automation.asset.get",
  AUTOMATION_CONTINUE_IN_CHAT: "automation.continue_in_chat",
  AUTOMATION_MIGRATE_LEGACY: "automation.migrate_legacy",
  ASSET_LIST: "asset.list",
  ASSET_FOLDER_LIST: "asset.folder.list",
  ASSET_FOLDER_CREATE: "asset.folder.create",
  ASSET_FOLDER_RENAME: "asset.folder.rename",
  ASSET_FOLDER_DELETE: "asset.folder.delete",
  ASSET_MOVE: "asset.move",
  ASSET_GET: "asset.get",
  ASSET_VERSION_GET: "asset.version.get",
  ASSET_VERSIONS_LIST: "asset.versions.list",
  ASSET_UPLOAD: "asset.upload",
  ASSET_CONVERSATION_SAVE: "asset.conversation.save",
  ASSET_RENAME: "asset.rename",
  ASSET_ARCHIVE: "asset.archive",
  ASSET_DELETE: "asset.delete",
  ASSET_RESTORE_VERSION: "asset.restore_version",
  ASSET_CONVERT_TO_XLSX: "asset.convert_to_xlsx",
  ASSET_REFERENCES_LIST: "asset.references.list",
} as const;

type PortalEnvelope = {
  protocolVersion: string;
  requestId: string;
  type: string;
  sentAt: string;
  payload?: any;
};

type PortalResponse = {
  protocolVersion: string;
  requestId: string;
  type: string;
  ok: boolean;
  sentAt: string;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
};

type AnyWebSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(event: string, listener: (...args: any[]) => void): void;
};

const WebSocketCtor = (globalThis as any).WebSocket as
  | (new (url: string) => AnyWebSocket)
  | undefined;

function env(name: string, fallback?: string) {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function connectorIdPrefix() {
  if (config.portal.localOnly) return "local";
  return env("PORTAL_CONNECTOR_ID_PREFIX", "local")!;
}

function connectorRuntimeLabel() {
  if (config.portal.localOnly) return "本机开发";
  return env("PORTAL_CONNECTOR_RUNTIME_LABEL", connectorIdPrefix())!;
}

function csvEnvSet(name: string): Set<string> {
  return new Set(
    (process.env[name] || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function connectorScopeAllowed(project: AiProjectRuntimeContext) {
  if (config.portal.localOnly) return true;
  const include = csvEnvSet("PORTAL_CONNECTOR_INCLUDE_ASSISTANTS");
  const exclude = csvEnvSet("PORTAL_CONNECTOR_EXCLUDE_ASSISTANTS");
  const keys = new Set([project.instanceId, project.ownerUserId]);
  if (include.size > 0 && ![...keys].some((key) => include.has(key))) return false;
  if ([...keys].some((key) => exclude.has(key))) return false;
  return true;
}

function ok(type: string, requestId: string, data: unknown): PortalResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    type,
    ok: true,
    sentAt: new Date().toISOString(),
    data,
  };
}

function fail(type: string, requestId: string, code: string, message: string, retryable = false): PortalResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    type,
    ok: false,
    sentAt: new Date().toISOString(),
    error: { code, message, retryable },
  };
}

function negotiatedProtocolVersion(requested: string): string {
  return requested === LEGACY_PROTOCOL_VERSION ? LEGACY_PROTOCOL_VERSION : PROTOCOL_VERSION;
}

function withProtocolVersion(response: PortalResponse, requested: string): PortalResponse {
  return { ...response, protocolVersion: negotiatedProtocolVersion(requested) };
}

function requiresCurrentProtocol(type: string, payload: any): boolean {
  if (type.startsWith("asset.") || type === TYPES.AUTOMATION_MIGRATE_LEGACY) return true;
  if (type !== TYPES.AUTOMATION_CREATE && type !== TYPES.AUTOMATION_UPDATE) return false;
  const hasLegacyAsset = payload && (Object.prototype.hasOwnProperty.call(payload, "sourceAsset") || Object.prototype.hasOwnProperty.call(payload, "asset"));
  const hasGenericFields = payload && ["instruction", "inputs", "output", "delivery"].some((field) => Object.prototype.hasOwnProperty.call(payload, field));
  return Boolean(hasGenericFields || !hasLegacyAsset);
}

function envelope(type: string, requestId: string, payload: unknown): PortalEnvelope {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    type,
    sentAt: new Date().toISOString(),
    payload,
  };
}

function send(socket: AnyWebSocket, message: PortalEnvelope | PortalResponse) {
  if (socket.readyState !== 1) return false;
  socket.send(JSON.stringify(message));
  return true;
}

/**
 * T-199：已注册 relay socket 的轮内进度转发通道。尽力而为——socket 未开或
 * 断连时事件直接丢弃，聊天轮结果本身不受影响。
 */
// 每个生产助手都有独立的 relay socket；不能用单一全局转发器，否则最后注册的
// connector 会覆盖其他用户的进度通道。
const progressForwarders = new Map<string, (payload: Record<string, unknown>) => void>();

function makeProgressForwarder(socketRef: () => AnyWebSocket | null): (payload: Record<string, unknown>) => void {
  return (payload) => {
    const socket = socketRef();
    if (!socket) return;
    try {
      send(socket, {
        protocolVersion: PROTOCOL_VERSION,
        requestId: `prog_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: TYPES.CONVERSATION_CHAT_PROGRESS,
        sentAt: new Date().toISOString(),
        payload,
      });
    } catch {
      // 进度事件失败不影响轮次。
    }
  };
}

type ConnectorScope = {
  userId: string;
  assistantId: string;
  instanceId: string;
  projectId: string;
  connectorId: string;
  displayName: string;
};

function localPayloadScope(scope: ConnectorScope, payload: any) {
  return {
    userId: scope.userId,
    assistantId: scope.assistantId,
    instanceId: scope.instanceId,
    projectId: scope.projectId,
    channel: payload?.channel,
  };
}

function usageCursor(message: { payload?: unknown }): number {
  const payload = (message.payload ?? {}) as Record<string, unknown>;
  const cursor = Number(payload.cursor);
  return Number.isFinite(cursor) && cursor > 0 ? cursor : Number.MAX_SAFE_INTEGER;
}

function usageLimit(message: { payload?: unknown }): number {
  const payload = (message.payload ?? {}) as Record<string, unknown>;
  const limit = Number(payload.limit);
  return Number.isFinite(limit) && limit >= 1 && limit <= 200 ? Math.floor(limit) : 50;
}

function automationScope(scope: ConnectorScope) {
  return { userId: scope.userId, instanceId: scope.instanceId, projectId: scope.projectId };
}

/** 巡检页消息的 ruleType 白名单：只接受服务目录里 active 的规则类型。 */
function normalizePatrolRuleType(value: unknown): WatchRuleType | null {
  if (typeof value !== "string") return null;
  return listWatchRuleCatalog().some((item) => item.key === value && item.status === "active")
    ? (value as WatchRuleType)
    : null;
}

/** 按规则类型从消息 payload 构造参数（逐字段白名单，越界值回退默认，最终由服务层校验）。 */
function buildPatrolRuleParams(ruleType: WatchRuleType, payload: any): Record<string, unknown> {
  const periodOf = (): number | undefined => (payload?.period === undefined ? undefined : Math.trunc(Number(payload.period)));
  switch (ruleType) {
    case "price_cross":
      return { operator: payload?.operator === "<=" ? "<=" : ">=", value: Number(payload?.value) };
    case "ma_cross":
      return { period: periodOf(), direction: payload?.direction === "break_below" ? "break_below" : "break_above" };
    case "macd_cross":
      return { direction: payload?.direction === "death_cross" ? "death_cross" : "golden_cross" };
    case "kdj_cross": {
      const params: Record<string, unknown> = {
        direction: payload?.direction === "death_cross" ? "death_cross" : "golden_cross",
      };
      if (payload?.threshold !== undefined) params.threshold = Number(payload.threshold);
      return params;
    }
    case "rsi_threshold": {
      const params: Record<string, unknown> = {
        direction: payload?.direction === "above" ? "above" : "below",
        threshold: Number(payload?.threshold),
      };
      const period = periodOf();
      if (period !== undefined) params.period = period;
      return params;
    }
    case "boll_break": {
      const params: Record<string, unknown> = {
        direction: payload?.direction === "break_lower" ? "break_lower" : "break_upper",
      };
      const period = periodOf();
      if (period !== undefined) params.period = period;
      if (payload?.multiplier !== undefined) params.multiplier = Number(payload.multiplier);
      return params;
    }
    case "wr_threshold": {
      const params: Record<string, unknown> = {
        direction: payload?.direction === "below" ? "below" : "above",
        threshold: Number(payload?.threshold),
      };
      const period = periodOf();
      if (period !== undefined) params.period = period;
      return params;
    }
  }
}

function declaredScopeField(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  for (const field of ["userId", "assistantId", "instanceId", "projectId", "workspacePath", "relativePath"]) {
    if (field in (payload as Record<string, unknown>)) return field;
  }
  return null;
}

function normalizeStringArray(value: unknown, allowed: readonly string[], field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20 || value.some((item) => typeof item !== "string" || !allowed.includes(item))) {
    throw new AutomationTaskError("AUTOMATION_BATCH_INVALID", field);
  }
  return [...new Set(value as string[])];
}

function normalizeAutomationListQuery(payload: any) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return {
    query: typeof payload.query === "string" ? payload.query.trim() || undefined : undefined,
    statuses: normalizeStringArray(payload.statuses, ["paused", "active", "needs_attention", "archived"], "statuses") as any,
    frequencies: normalizeStringArray(payload.frequencies, ["daily", "trading_days", "weekdays", "weekly"], "frequencies") as any,
    deliveryModes: normalizeStringArray(payload.deliveryModes, ["none", "wechat_summary", "wechat_on_condition"], "deliveryModes") as any,
    outputModes: normalizeStringArray(payload.outputModes, ["none", "agent", "create", "update"], "outputModes") as any,
    cursor: typeof payload.cursor === "string" ? payload.cursor : undefined,
    limit: payload.limit === undefined ? undefined : Number(payload.limit),
  };
}

function normalizeAutomationRunListQuery(payload: any) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  return {
    taskId: typeof payload.taskId === "string" && payload.taskId.trim() ? payload.taskId.trim() : undefined,
    query: typeof payload.query === "string" ? payload.query.trim() || undefined : undefined,
    statuses: normalizeStringArray(payload.statuses, ["running", "succeeded", "failed", "skipped", "cancelled"], "statuses") as any,
    origins: normalizeStringArray(payload.origins, ["manual", "scheduled"], "origins") as any,
    deliveryStatuses: normalizeStringArray(payload.deliveryStatuses, ["not_requested", "pending", "sent", "suppressed", "failed"], "deliveryStatuses"),
    hasOutput: typeof payload.hasOutput === "boolean" ? payload.hasOutput : undefined,
    from: typeof payload.from === "string" ? payload.from : undefined,
    to: typeof payload.to === "string" ? payload.to : undefined,
    cursor: typeof payload.cursor === "string" ? payload.cursor : undefined,
    limit: payload.limit === undefined ? undefined : Number(payload.limit),
  };
}

function normalizeAutomationBatchActionPayload(payload: any) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new AutomationTaskError("AUTOMATION_BATCH_INVALID", "payload");
  if (!["pause", "activate", "archive"].includes(payload.action)) throw new AutomationTaskError("AUTOMATION_BATCH_INVALID", "action");
  if (!Array.isArray(payload.items)) throw new AutomationTaskError("AUTOMATION_BATCH_INVALID", "items");
  return {
    action: payload.action as "pause" | "activate" | "archive",
    items: payload.items,
    idempotencyKey: typeof payload.idempotencyKey === "string" ? payload.idempotencyKey : "",
  };
}

function decodeAutomationAsset(payload: any) {
  const asset = payload?.sourceAsset || payload?.asset;
  if (!asset || typeof asset.fileName !== "string" || typeof asset.base64 !== "string") {
    throw new AutomationTaskError("AUTOMATION_ASSET_REQUIRED", "fileName and base64 are required");
  }
  if (!isStrictBase64(asset.base64)) throw new AutomationTaskError("AUTOMATION_ASSET_INVALID_CONTENT", "invalid base64");
  const bytes = Buffer.from(asset.base64, "base64");
  if (bytes.length === 0) throw new AutomationTaskError("AUTOMATION_ASSET_REQUIRED", "empty asset");
  return { fileName: asset.fileName, mimeType: typeof asset.mimeType === "string" ? asset.mimeType : undefined, bytes };
}

function isStrictBase64(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  const firstPadding = value.indexOf("=");
  return firstPadding < 0 || firstPadding >= value.length - 2;
}

function sanitizeAssetVersion(version: any) {
  const { storagePath: _storagePath, userId: _userId, projectId: _projectId, instanceId: _instanceId, ...safe } = version || {};
  return safe;
}

function sanitizeAssetDescriptor(asset: any) {
  const { userId: _userId, projectId: _projectId, instanceId: _instanceId, currentVersion, ...safe } = asset || {};
  return {
    ...safe,
    ...(currentVersion ? { currentVersion: sanitizeAssetVersion(currentVersion) } : { currentVersion: null }),
  };
}

function isArtifactEventName(value: string): value is "open" | "success" | "failure" | "download" {
  return value === "open" || value === "success" || value === "failure" || value === "download";
}

async function handleCommand(scope: ConnectorScope, message: PortalEnvelope) {
  const commandScope = localPayloadScope(scope, message.payload);
  const startedAt = Date.now();
  logger.info(`Portal connector command start assistant=${scope.assistantId} type=${message.type} request=${message.requestId}`);
  const finish = (response: PortalResponse) => {
    logger.info(`Portal connector command done assistant=${scope.assistantId} type=${message.type} request=${message.requestId} ok=${response.ok} elapsedMs=${Date.now() - startedAt}`);
    return withProtocolVersion(response, message.protocolVersion);
  };
  if (requiresCurrentProtocol(message.type, message.payload) && message.protocolVersion !== PROTOCOL_VERSION) {
    return finish(fail(message.type, message.requestId, "PROTOCOL_VERSION_UNSUPPORTED", `命令 ${message.type} 需要协议 ${PROTOCOL_VERSION}`));
  }
  if ((message.type.startsWith("asset.") || message.type.startsWith("automation.")) && declaredScopeField(message.payload)) {
    return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "scope and workspace path must come from the registered connector"));
  }
  if (message.type === TYPES.CONVERSATION_CANCEL && declaredScopeField(message.payload)) {
    return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "scope must come from the registered connector"));
  }
  switch (message.type) {
    case TYPES.CONVERSATION_LIST:
      return finish(ok(message.type, message.requestId, listConversations({
        ...commandScope,
        cursor: message.payload?.cursor,
        limit: message.payload?.limit,
      })));
    case TYPES.CONVERSATION_GET:
      return finish(ok(message.type, message.requestId, getConversation({
        ...commandScope,
        conversationId: String(message.payload?.conversationId || ""),
        cursor: message.payload?.cursor,
        limit: message.payload?.limit,
      })));
    case TYPES.CONVERSATION_CHAT: {
      if (!String(message.payload?.text || "").trim() && (!Array.isArray(message.payload?.attachments) || message.payload.attachments.length === 0)) {
        return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "text or attachments is required"));
      }
      // T-199：把轮内过程事件尽力而为转发给 relay（断连/未注册时静默丢弃）。
      const progressConversationId = String(message.payload?.conversationId || "");
      const forwardProgress = progressConversationId
        ? (event: import("../runtime/protocol.js").AgentTurnProgressEvent) => {
            progressForwarders.get(scope.assistantId)?.({ conversationId: progressConversationId, requestId: message.requestId, event });
          }
        : undefined;
      return finish(ok(message.type, message.requestId, await chatViaConversationLog({
        ...commandScope,
        conversationId: String(message.payload?.conversationId || ""),
        userMessageId: message.payload?.userMessageId,
        text: String(message.payload?.text || ""),
        attachments: Array.isArray(message.payload?.attachments) ? message.payload.attachments : undefined,
        idempotencyKey: message.payload?.idempotencyKey,
        clientSentAt: message.payload?.clientSentAt,
        model: typeof message.payload?.model === "string" && message.payload.model.trim() ? message.payload.model.trim() : undefined,
        ...(forwardProgress ? { onProgress: forwardProgress } : {}),
      })));
    }
    case TYPES.CONVERSATION_REGENERATE: {
      const conversationId = String(message.payload?.conversationId || "").trim();
      const regenerateMessageId = String(message.payload?.messageId || "").trim();
      if (!conversationId || !regenerateMessageId) {
        return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "conversationId and messageId are required"));
      }
      const progressForward = (event: import("../runtime/protocol.js").AgentTurnProgressEvent) => {
        progressForwarders.get(scope.assistantId)?.({ conversationId, requestId: message.requestId, event });
      };
      return finish(ok(message.type, message.requestId, await chatViaConversationLog({
        ...commandScope,
        conversationId,
        regenerateAssistantMessageId: regenerateMessageId,
        idempotencyKey: message.payload?.idempotencyKey,
        model: typeof message.payload?.model === "string" && message.payload.model.trim() ? message.payload.model.trim() : undefined,
        onProgress: progressForward,
      })));
    }
    case TYPES.CONVERSATION_FEEDBACK: {
      const conversationId = String(message.payload?.conversationId || "").trim();
      const feedbackMessageId = String(message.payload?.messageId || "").trim();
      const rating = message.payload?.rating;
      // comment（owner 2026-08-28 点踩弹窗）：缺省 = 不动已有文字反馈；
      // null = 清除；string = 覆盖。非法类型直接拒。
      const rawComment = message.payload?.comment;
      const comment = rawComment === undefined || rawComment === null
        ? (rawComment as null | undefined)
        : typeof rawComment === "string"
          ? rawComment
          : undefined;
      if (!conversationId || !feedbackMessageId
        || (rating !== "like" && rating !== "dislike" && rating !== null)
        || (rawComment !== undefined && rawComment !== null && typeof rawComment !== "string")) {
        return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "conversationId, messageId and rating (like|dislike|null) are required; comment must be a string or null"));
      }
      try {
        return finish(ok(message.type, message.requestId, {
          message: setConversationMessageFeedback({
            ...commandScope,
            conversationId,
            messageId: feedbackMessageId,
            rating,
            comment,
          }),
        }));
      } catch (error) {
        return finish(fail(message.type, message.requestId, "INVALID_REQUEST", (error as Error).message));
      }
    }
    case TYPES.TRACE_GET: {
      const traceId = String(message.payload?.traceId || "").trim();
      const messageId = String(message.payload?.messageId || "").trim();
      if (!traceId && !messageId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "traceId or messageId is required"));
      const row = sqlite.prepare(`
        SELECT trace_id AS traceId, message_id AS messageId, conversation_id AS conversationId, created_at AS createdAt,
               channel, mode, agent_model AS model, status, elapsed_ms AS elapsedMs, first_token_ms AS firstTokenMs,
               input_tokens AS inputTokens, output_tokens AS outputTokens, total_tokens AS totalTokens,
               cost_amount AS cost, cost_currency AS costCurrency, error_message AS errorMessage, tool_calls AS toolCalls
        FROM agent_traces
        WHERE user_id = ? AND instance_id = ? AND (trace_id = ? OR message_id = ?)
        ORDER BY id DESC LIMIT 1
      `).get(commandScope.userId, commandScope.instanceId, traceId || messageId, messageId || traceId) as Record<string, unknown> | undefined;
      if (!row) return finish(ok(message.type, message.requestId, { trace: null }));
      // 摘要级回放：只含工具时间线与计量，不含 prompt/reply 正文。
      let toolCalls: unknown[] = [];
      try {
        const parsed = JSON.parse(String(row.toolCalls ?? "[]"));
        if (Array.isArray(parsed)) toolCalls = parsed;
      } catch { toolCalls = []; }
      delete row.toolCalls;
      return finish(ok(message.type, message.requestId, { trace: { ...row, toolCalls } }));
    }
    case TYPES.CONVERSATION_CANCEL: {
      const conversationId = String(message.payload?.conversationId || "").trim();
      if (!conversationId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "conversationId is required"));
      return finish(ok(message.type, message.requestId, await cancelConversationChat({
        ...commandScope,
        conversationId,
      })));
    }
    case TYPES.USAGE_SUMMARY: {
      const usageScope = automationScope(scope);
      const range = usageRange(message);
      const totals = sqlite.prepare(`
        SELECT COUNT(*) AS calls,
               COALESCE(SUM(total_tokens), 0) AS tokens,
               COALESCE(SUM(cost_amount), 0) AS cost,
               COALESCE(SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END), 0) AS failures
        FROM agent_traces
        WHERE user_id = ? AND instance_id = ? AND created_at >= ? AND created_at <= ?
      `).get(usageScope.userId, usageScope.instanceId, range.from, range.to);
      const byModel = sqlite.prepare(`
        SELECT agent_model AS model, COUNT(*) AS calls,
               COALESCE(SUM(cost_amount), 0) AS cost,
               COALESCE(SUM(total_tokens), 0) AS tokens
        FROM agent_traces
        WHERE user_id = ? AND instance_id = ? AND created_at >= ? AND created_at <= ?
        GROUP BY agent_model ORDER BY cost DESC
      `).all(usageScope.userId, usageScope.instanceId, range.from, range.to);
      const byDay = sqlite.prepare(`
        SELECT ${USAGE_DAY_BUCKET_SQL} AS day, COUNT(*) AS calls,
               COALESCE(SUM(cost_amount), 0) AS cost
        FROM agent_traces
        WHERE user_id = ? AND instance_id = ? AND created_at >= ? AND created_at <= ?
        GROUP BY day ORDER BY day
      `).all(usageScope.userId, usageScope.instanceId, range.from, range.to);
      return finish(ok(message.type, message.requestId, { range, totals, byModel, byDay }));
    }
    case TYPES.USAGE_RECORDS: {
      const usageScope = automationScope(scope);
      const range = usageRange(message);
      const cursor = usageCursor(message);
      const limit = usageLimit(message);
      const rows = sqlite.prepare(`
        SELECT id, created_at, agent_model AS model, model_source AS modelSource, conversation_id AS conversationId,
               channel, status, input_tokens AS inputTokens, output_tokens AS outputTokens, total_tokens AS totalTokens,
               cost_amount AS cost, elapsed_ms AS elapsedMs, first_token_ms AS firstTokenMs
        FROM agent_traces
        WHERE user_id = ? AND instance_id = ? AND created_at >= ? AND created_at <= ? AND id < ?
        ORDER BY id DESC LIMIT ?
      `).all(usageScope.userId, usageScope.instanceId, range.from, range.to, cursor, limit + 1);
      const hasMore = rows.length > limit;
      const items = (hasMore ? rows.slice(0, limit) : rows) as Array<Record<string, unknown>>;
      return finish(ok(message.type, message.requestId, {
        items,
        nextCursor: hasMore ? String(items[items.length - 1]?.id ?? cursor) : null,
      }));
    }
    case TYPES.MODELS_STATE: {
      const snapshot = modelRoutingSnapshot();
      const pricing = pricingSummary();
      const options = Object.entries(snapshot.descriptions).map(([model, description]) => {
        const entry = pricing.models.find((item) => item.model === model);
        // 展示口径（owner 2026-08-17 二次修订）：输入/输出双价；峰谷模型统一按峰值。
        const tier = entry?.timeTiered ? entry.timeTiered.peak : entry?.tier;
        return {
          model,
          description,
          inputPrice: tier?.input ?? null,
          outputPrice: tier?.output ?? null,
        };
      });
      return finish(ok(message.type, message.requestId, {
        auto: {
          textModel: resolveAutoModel({ hasImage: false }).model,
          imageModel: resolveAutoModel({ hasImage: true }).model,
        },
        chain: snapshot.chain,
        thresholds: snapshot.thresholds,
        options,
      }));
    }
    case TYPES.RULE_PATROL_STATUS: {
      const patrolScope = automationScope(scope);
      const status = getRulePatrolStatus(patrolScope);
      return finish(ok(message.type, message.requestId, { status, runs: listRulePatrolRuns(patrolScope, 20) }));
    }
    case TYPES.RULE_PATROL_RUN_NOW: {
      const patrolScope = automationScope(scope);
      return finish(ok(message.type, message.requestId, await runRulePatrolNow(patrolScope)));
    }
    case TYPES.RULE_PATROL_RULES_LIST: {
      const patrolScope = automationScope(scope);
      return finish(ok(message.type, message.requestId, { items: await listWatchRules(patrolScope.userId, patrolScope.instanceId) }));
    }
    case TYPES.RULE_PATROL_RULES_CREATE: {
      const patrolScope = automationScope(scope);
      const ruleType = normalizePatrolRuleType(message.payload?.ruleType);
      if (!ruleType) {
        return finish(fail(message.type, message.requestId, "RULE_PATROL_RULE_INVALID", "不支持的 ruleType（仅支持规则目录中的 active 类型）"));
      }
      const params = buildPatrolRuleParams(ruleType, message.payload);
      const input = {
        userId: patrolScope.userId,
        instanceId: patrolScope.instanceId,
        stockCode: String(message.payload?.stockCode || "").trim(),
        stockName: String(message.payload?.stockName || "").trim() || undefined,
        ruleType,
        targetScope: "manual" as const,
        params,
        notification: {
          priority: message.payload?.priority === "P0" || message.payload?.priority === "P1" ? message.payload.priority : "P2",
          push: true,
        },
        source: { kind: "portal_patrol_page", actor: scope.userId },
      };
      const validation = await validateWatchRule(input);
      if (!validation.ok) {
        return finish(fail(message.type, message.requestId, "RULE_PATROL_RULE_INVALID", validation.errors?.join("; ") || "规则参数无效"));
      }
      const rule = await createWatchRule(input);
      await recordSandboxAudit({
        context: { userId: patrolScope.userId, projectId: patrolScope.projectId, instanceId: patrolScope.instanceId, role: "user", channel: "dashboard", permissions: [] },
        operation: "rule_patrol.rules.create",
        resourceType: "watch_rule",
        resourceId: String(rule.id),
        requestBody: { stockCode: input.stockCode, ruleType: input.ruleType, params: input.params },
        resultSummary: `portal patrol page created ${input.ruleType} rule for ${input.stockCode}`,
        status: "success",
      }).catch(() => undefined);
      return finish(ok(message.type, message.requestId, { rule }));
    }
    case TYPES.RULE_PATROL_RULES_UPDATE: {
      const patrolScope = automationScope(scope);
      const id = Number(message.payload?.id);
      if (!Number.isInteger(id) || id <= 0) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "id is required"));
      const update: Record<string, unknown> = {};
      if (typeof message.payload?.stockName === "string" && message.payload.stockName.trim()) update.stockName = message.payload.stockName.trim();
      // 显式带 ruleType 时按类型构造参数（新规则类型通道）；不带时保留
      // 旧版巡检页按参数形状推断 price_cross/ma_cross 的行为。
      const explicitType = normalizePatrolRuleType(message.payload?.ruleType);
      if (explicitType && explicitType !== "price_cross" && explicitType !== "ma_cross") {
        update.params = buildPatrolRuleParams(explicitType, message.payload);
      } else {
        if (message.payload?.operator === ">=" || message.payload?.operator === "<=") {
          update.params = { operator: message.payload.operator, value: Number(message.payload?.value) };
        }
        if (message.payload?.period !== undefined || message.payload?.direction !== undefined) {
          update.params = {
            period: Math.trunc(Number(message.payload?.period)),
            direction: message.payload?.direction === "break_below" ? "break_below" : "break_above",
          };
        }
      }
      if (message.payload?.enabled === true || message.payload?.enabled === false) update.enabled = message.payload.enabled;
      if (message.payload?.priority === "P0" || message.payload?.priority === "P1" || message.payload?.priority === "P2") {
        update.notification = { priority: message.payload.priority, push: true };
      }
      if (Object.keys(update).length === 0) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "nothing to update"));
      try {
        const rule = await updateWatchRule(id, update, patrolScope.userId, patrolScope.instanceId);
        await recordSandboxAudit({
          context: { userId: patrolScope.userId, projectId: patrolScope.projectId, instanceId: patrolScope.instanceId, role: "user", channel: "dashboard", permissions: [] },
          operation: "rule_patrol.rules.update",
          resourceType: "watch_rule",
          resourceId: String(id),
          requestBody: update,
          resultSummary: `portal patrol page updated rule ${id}`,
          status: "success",
        }).catch(() => undefined);
        return finish(ok(message.type, message.requestId, { rule }));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return finish(fail(message.type, message.requestId, detail.includes("不存在") ? "RULE_PATROL_RULE_NOT_FOUND" : "RULE_PATROL_RULE_INVALID", detail));
      }
    }
    case TYPES.RULE_PATROL_RULES_DELETE: {
      const patrolScope = automationScope(scope);
      const id = Number(message.payload?.id);
      if (!Number.isInteger(id) || id <= 0) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "id is required"));
      const removed = await deleteWatchRule(id, patrolScope.userId, patrolScope.instanceId);
      if (!removed) return finish(fail(message.type, message.requestId, "RULE_PATROL_RULE_NOT_FOUND", String(id)));
      await recordSandboxAudit({
        context: { userId: patrolScope.userId, projectId: patrolScope.projectId, instanceId: patrolScope.instanceId, role: "user", channel: "dashboard", permissions: [] },
        operation: "rule_patrol.rules.delete",
        resourceType: "watch_rule",
        resourceId: String(id),
        resultSummary: `portal patrol page deleted rule ${id}`,
        status: "success",
      }).catch(() => undefined);
      return finish(ok(message.type, message.requestId, { removed: true }));
    }
    case TYPES.RULE_PATROL_RULES_DRY_RUN: {
      const patrolScope = automationScope(scope);
      const id = Number(message.payload?.id);
      if (!Number.isInteger(id) || id <= 0) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "id is required"));
      try {
        return finish(ok(message.type, message.requestId, await dryRunWatchRuleById(id, patrolScope.userId, patrolScope.instanceId)));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return finish(fail(message.type, message.requestId, detail.includes("不存在") ? "RULE_PATROL_RULE_NOT_FOUND" : "RULE_PATROL_DRY_RUN_FAILED", detail));
      }
    }
    case TYPES.AUTOMATION_LIST:
      return finish(ok(message.type, message.requestId, await listAutomationTaskPage(automationScope(scope), normalizeAutomationListQuery(message.payload))));
    case TYPES.AUTOMATION_GET: {
      const taskId = String(message.payload?.taskId || "");
      if (!taskId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "taskId is required"));
      const task = await getAutomationTask({ ...automationScope(scope), taskId });
      if (!task) return finish(fail(message.type, message.requestId, "AUTOMATION_TASK_NOT_FOUND", taskId));
      return finish(ok(message.type, message.requestId, task));
    }
    case TYPES.AUTOMATION_CREATE: {
      const rawAsset = message.payload?.sourceAsset || message.payload?.asset;
      const task = await createAutomationTask({
        ...automationScope(scope),
        name: String(message.payload?.name || ""),
        description: typeof message.payload?.description === "string" ? message.payload.description : undefined,
        schedule: message.payload?.schedule,
        instruction: typeof message.payload?.instruction === "string" ? message.payload.instruction : undefined,
        inputs: Array.isArray(message.payload?.inputs) ? message.payload.inputs : undefined,
        output: message.payload?.output,
        delivery: message.payload?.delivery,
        ...(rawAsset ? { sourceAsset: decodeAutomationAsset(message.payload) } : {}),
      });
      return finish(ok(message.type, message.requestId, task));
    }
    case TYPES.AUTOMATION_UPDATE: {
      const taskId = String(message.payload?.taskId || "");
      if (!taskId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "taskId is required"));
      const rawAsset = message.payload?.sourceAsset || message.payload?.asset;
      const task = await updateAutomationTask({
        ...automationScope(scope),
        taskId,
        expectedRevision: typeof message.payload?.expectedRevision === "number" ? message.payload.expectedRevision : undefined,
        name: typeof message.payload?.name === "string" ? message.payload.name : undefined,
        description: typeof message.payload?.description === "string" || message.payload?.description === null ? message.payload.description : undefined,
        schedule: message.payload?.schedule,
        instruction: typeof message.payload?.instruction === "string" ? message.payload.instruction : undefined,
        inputs: Array.isArray(message.payload?.inputs) ? message.payload.inputs : undefined,
        output: message.payload?.output,
        delivery: message.payload?.delivery,
        ...(rawAsset ? { sourceAsset: decodeAutomationAsset(message.payload) } : {}),
      });
      return finish(ok(message.type, message.requestId, task));
    }
    case TYPES.AUTOMATION_ACTIVATE: {
      const taskId = String(message.payload?.taskId || "");
      if (!taskId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "taskId is required"));
      return finish(ok(message.type, message.requestId, await activateAutomationTask({ ...automationScope(scope), taskId, expectedRevision: message.payload?.expectedRevision })));
    }
    case TYPES.AUTOMATION_PAUSE: {
      const taskId = String(message.payload?.taskId || "");
      if (!taskId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "taskId is required"));
      return finish(ok(message.type, message.requestId, await pauseAutomationTask({ ...automationScope(scope), taskId, expectedRevision: message.payload?.expectedRevision })));
    }
    case TYPES.AUTOMATION_BATCH_ACTION: {
      const payload = normalizeAutomationBatchActionPayload(message.payload);
      return finish(ok(message.type, message.requestId, await batchAutomationTaskAction({ ...automationScope(scope), ...payload })));
    }
    case TYPES.AUTOMATION_RUN_NOW: {
      const taskId = String(message.payload?.taskId || "");
      if (!taskId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "taskId is required"));
      const result = await runAutomationTaskNow({ scope: automationScope(scope), taskId, origin: "manual", idempotencyKey: String(message.payload?.idempotencyKey || `portal:${message.requestId}`) });
      return finish(ok(message.type, message.requestId, result));
    }
    case TYPES.AUTOMATION_RUNS_LIST: {
      return finish(ok(message.type, message.requestId, await listAutomationTaskRunsPage({ ...automationScope(scope), ...normalizeAutomationRunListQuery(message.payload) })));
    }
    case TYPES.AUTOMATION_RUN_GET: {
      const runId = String(message.payload?.runId || "");
      if (!runId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "runId is required"));
      const run = await getAutomationTaskRun({ ...automationScope(scope), runId });
      if (!run) return finish(fail(message.type, message.requestId, "AUTOMATION_RUN_NOT_FOUND", runId));
      return finish(ok(message.type, message.requestId, run));
    }
    case TYPES.AUTOMATION_ASSET_GET: {
      const assetId = String(message.payload?.assetId || "");
      if (!assetId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "assetId is required"));
      const asset = await downloadAutomationTaskAsset({ ...automationScope(scope), assetId });
      return finish(ok(message.type, message.requestId, { ...asset.descriptor, base64: asset.base64, checksum: asset.checksum }));
    }
    case TYPES.AUTOMATION_CONTINUE_IN_CHAT: {
      const runId = String(message.payload?.runId || "");
      if (!runId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "runId is required"));
      return finish(ok(message.type, message.requestId, await continueAutomationRunInChat({ scope: automationScope(scope), runId })));
    }
    case TYPES.AUTOMATION_MIGRATE_LEGACY: {
      const taskId = String(message.payload?.taskId || "");
      if (!taskId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "taskId is required"));
      return finish(ok(message.type, message.requestId, await migrateLegacyAutomationTaskToAssets({ ...automationScope(scope), taskId })));
    }
    case TYPES.ASSET_LIST: {
      const rawStatus = message.payload?.status;
      if (rawStatus !== undefined && rawStatus !== "active" && rawStatus !== "archived" && rawStatus !== "all") {
        return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "status must be active, archived, or all"));
      }
      const items = await listUserAssets({
        ...automationScope(scope),
        status: rawStatus === "archived" ? "archived" : rawStatus === "all" ? "all" : "active",
        search: typeof message.payload?.search === "string" ? message.payload.search : undefined,
        format: typeof message.payload?.format === "string" ? message.payload.format as any : undefined,
        source: typeof message.payload?.source === "string" ? message.payload.source as any : undefined,
        folderId: typeof message.payload?.folderId === "string" ? message.payload.folderId : message.payload?.folderId === null ? null : undefined,
        limit: message.payload?.limit === undefined ? undefined : Number(message.payload.limit),
      });
      const assetScope = automationScope(scope);
      backfillFormalReportAssetMappings(assetScope);
      const allReports = listReportAssetMappings(assetScope);
      const visibleAssetIds = new Set(items.map((item) => item.assetId));
      const reports = message.payload?.folderId === undefined
        ? allReports
        : allReports.filter((report) => report.backingAssetId && visibleAssetIds.has(report.backingAssetId));
      const catalog = [
        ...items.map((asset) => ({ ...sanitizeAssetDescriptor(asset), catalogId: `asset:${asset.assetId}`, catalogKind: "asset" as const, sources: [asset.currentVersion?.source || "system"] })),
        ...reports.map((report) => ({
          assetId: `report:${report.mappingId}`, name: report.title, status: "active" as const,
          currentVersionId: null, currentVersion: null, createdAt: report.createdAt, updatedAt: report.createdAt,
          archivedAt: null, catalogId: `report:${report.mappingId}`, catalogKind: "report" as const,
          sources: ["report" as const], reportMappingId: report.mappingId, reportId: report.reportId,
        })),
      ];
      const folders = await listUserAssetFolders(assetScope);
      return finish(ok(message.type, message.requestId, { items: items.map(sanitizeAssetDescriptor), catalog, reportMappings: reports, folders, storageUsage: getStorageUsage(automationScope(scope)) }));
    }
    case TYPES.ASSET_FOLDER_LIST: {
      return finish(ok(message.type, message.requestId, { items: await listUserAssetFolders(automationScope(scope)) }));
    }
    case TYPES.ASSET_FOLDER_CREATE: {
      const name = typeof message.payload?.name === "string" ? message.payload.name : "";
      if (!name.trim()) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "name is required"));
      const folder = await createUserAssetFolder({ ...automationScope(scope), name, parentFolderId: typeof message.payload?.parentFolderId === "string" ? message.payload.parentFolderId : null });
      return finish(ok(message.type, message.requestId, folder));
    }
    case TYPES.ASSET_FOLDER_RENAME: {
      const folderId = String(message.payload?.folderId || "");
      const name = typeof message.payload?.name === "string" ? message.payload.name : "";
      if (!folderId || !name.trim()) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "folderId and name are required"));
      const folder = await renameUserAssetFolder({ ...automationScope(scope), folderId, name });
      return finish(ok(message.type, message.requestId, folder));
    }
    case TYPES.ASSET_FOLDER_DELETE: {
      const folderId = String(message.payload?.folderId || "");
      if (!folderId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "folderId is required"));
      return finish(ok(message.type, message.requestId, await deleteUserAssetFolder({ ...automationScope(scope), folderId })));
    }
    case TYPES.ASSET_MOVE: {
      const assetId = String(message.payload?.assetId || "");
      if (!assetId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "assetId is required"));
      const asset = await moveUserAsset({ ...automationScope(scope), assetId, folderId: typeof message.payload?.folderId === "string" ? message.payload.folderId : null });
      return finish(ok(message.type, message.requestId, sanitizeAssetDescriptor(asset)));
    }
    case TYPES.ASSET_GET: {
      const assetId = String(message.payload?.assetId || "");
      if (!assetId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "assetId is required"));
      const asset = await getUserAsset({ ...automationScope(scope), assetId });
      if (!asset) return finish(fail(message.type, message.requestId, "ASSET_NOT_FOUND", assetId));
      return finish(ok(message.type, message.requestId, sanitizeAssetDescriptor(asset)));
    }
    case TYPES.ASSET_VERSION_GET: {
      const assetId = String(message.payload?.assetId || "");
      if (!assetId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "assetId is required"));
      const result = typeof message.payload?.versionId === "string" && message.payload.versionId
        ? await readUserAssetVersion({ ...automationScope(scope), assetId, versionId: message.payload.versionId })
        : await readCurrentUserAsset({ ...automationScope(scope), assetId });
      return finish(ok(message.type, message.requestId, {
        ...sanitizeAssetVersion(result.descriptor),
        base64: result.bytes.toString("base64"),
      }));
    }
    case TYPES.ASSET_VERSIONS_LIST: {
      const assetId = String(message.payload?.assetId || "");
      if (!assetId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "assetId is required"));
      const items = await listUserAssetVersions({ ...automationScope(scope), assetId });
      return finish(ok(message.type, message.requestId, { items: items.map(sanitizeAssetVersion) }));
    }
    case TYPES.ASSET_UPLOAD: {
      if (Array.isArray(message.payload?.files)) {
        const files = message.payload.files as Array<Record<string, unknown>>;
        if (!files.length || files.length > 50) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "files must contain 1-50 items"));
        const decoded = files.map((item) => ({
          fileName: String(item.fileName || ""), base64: String(item.base64 || ""),
          mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined,
          name: typeof item.name === "string" ? item.name : undefined,
          folderId: typeof item.folderId === "string" ? item.folderId : item.folderId === null ? null : undefined,
          idempotencyKey: typeof item.idempotencyKey === "string" ? item.idempotencyKey : undefined,
        }));
        if (decoded.some((item) => !item.fileName || !item.base64 || !isStrictBase64(item.base64))) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "every file requires valid fileName and base64"));
        assertUploadRequestSize(decoded.map((item) => Buffer.byteLength(item.base64, "base64")));
        const results: Array<Record<string, unknown>> = [];
        for (let index = 0; index < decoded.length; index += 1) {
          const item = decoded[index];
          try {
            const asset = await createUserAsset({ ...automationScope(scope), fileName: item.fileName, mimeType: item.mimeType, name: item.name, folderId: item.folderId, bytes: Buffer.from(item.base64, "base64"), source: "upload", idempotencyKey: item.idempotencyKey || `${message.requestId}:${index}` });
            results.push({ index, fileName: item.fileName, ok: true, asset: sanitizeAssetDescriptor(asset) });
          } catch (error) {
            const domain = error instanceof UserAssetError ? error : new UserAssetError("ASSET_COMMIT_FAILED", "asset upload failed");
            results.push({ index, fileName: item.fileName, ok: false, error: { code: domain.code, message: domain.message, details: domain.details } });
          }
        }
        return finish(ok(message.type, message.requestId, { items: results }));
      }
      const fileName = String(message.payload?.fileName || "");
      const base64 = String(message.payload?.base64 || "");
      if (!fileName || !base64) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "fileName and base64 are required"));
      if (!isStrictBase64(base64)) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "base64 is invalid"));
      const decodedSize = Buffer.byteLength(base64, "base64");
      assertUploadRequestSize([decodedSize]);
      const assetId = typeof message.payload?.assetId === "string" && message.payload.assetId.trim() ? message.payload.assetId : undefined;
      const folderId = typeof message.payload?.folderId === "string" ? message.payload.folderId : message.payload?.folderId === null ? null : undefined;
      if (assetId && (typeof message.payload?.expectedVersionId !== "string" || !message.payload.expectedVersionId.trim() || typeof message.payload?.idempotencyKey !== "string" || !message.payload.idempotencyKey.trim())) {
        return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "existing asset upload requires expectedVersionId and idempotencyKey"));
      }
      const asset = assetId
        ? await uploadUserAssetVersion({
            ...automationScope(scope),
            assetId,
            fileName,
            mimeType: typeof message.payload?.mimeType === "string" ? message.payload.mimeType : undefined,
            folderId,
            bytes: Buffer.from(base64, "base64"),
            expectedVersionId: typeof message.payload?.expectedVersionId === "string" ? message.payload.expectedVersionId : undefined,
            source: "upload",
            idempotencyKey: typeof message.payload?.idempotencyKey === "string" ? message.payload.idempotencyKey : undefined,
          })
        : await createUserAsset({
            ...automationScope(scope),
            name: typeof message.payload?.name === "string" ? message.payload.name : undefined,
            fileName,
            mimeType: typeof message.payload?.mimeType === "string" ? message.payload.mimeType : undefined,
            folderId,
            bytes: Buffer.from(base64, "base64"),
            source: "upload",
            idempotencyKey: typeof message.payload?.idempotencyKey === "string" && message.payload.idempotencyKey.trim()
              ? message.payload.idempotencyKey
              : `portal:${message.requestId}`,
          });
      return finish(ok(message.type, message.requestId, sanitizeAssetDescriptor(asset)));
    }
    case TYPES.ASSET_CONVERSATION_SAVE: {
      const artifactId = String(message.payload?.artifactId || "");
      if (!artifactId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "artifactId is required"));
      const result = await readConversationArtifactPayload({ artifactId, userId: scope.userId, instanceId: scope.instanceId });
      const saved = await saveConversationArtifactAsUserAsset({ ...automationScope(scope), name: typeof message.payload?.name === "string" ? message.payload.name : result.descriptor.title, fileName: result.payload.fileName, mimeType: result.payload.mimeType, bytes: Buffer.from(result.payload.base64, "base64"), confirmedByUser: true, conversationId: result.descriptor.conversationId, idempotencyKey: typeof message.payload?.idempotencyKey === "string" ? message.payload.idempotencyKey : `conversation-save:${artifactId}` });
      // 回写附件绑定：保存后卡片必须翻到「已保存到我的文件」态；
      // 未绑定时用户会重复点击保存，卡片也永远显示未保存。
      if (saved.currentVersionId) {
        try {
          sqlite.prepare("UPDATE conversation_artifacts SET asset_id = ?, version_id = ?, updated_at = ? WHERE artifact_id = ? AND user_id = ? AND instance_id = ?")
            .run(saved.assetId, saved.currentVersionId, new Date().toISOString(), artifactId, scope.userId, scope.instanceId);
        } catch (error) {
          logger.warn(`附件保存绑定回写失败 artifact=${artifactId}: ${(error as Error).message}`);
        }
      }
      return finish(ok(message.type, message.requestId, sanitizeAssetDescriptor(saved)));
    }
    case TYPES.ASSET_RENAME: {
      const assetId = String(message.payload?.assetId || "");
      const name = String(message.payload?.name || "");
      if (!assetId || !name) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "assetId and name are required"));
      const asset = await renameUserAsset({ ...automationScope(scope), assetId, name });
      return finish(ok(message.type, message.requestId, sanitizeAssetDescriptor(asset)));
    }
    case TYPES.ASSET_ARCHIVE: {
      const assetId = String(message.payload?.assetId || "");
      if (!assetId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "assetId is required"));
      const asset = await archiveUserAsset({ ...automationScope(scope), assetId });
      return finish(ok(message.type, message.requestId, sanitizeAssetDescriptor(asset)));
    }
    case TYPES.ASSET_DELETE: {
      const assetId = String(message.payload?.assetId || "");
      if (!assetId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "assetId is required"));
      return finish(ok(message.type, message.requestId, await deleteUserAsset({ ...automationScope(scope), assetId })));
    }
    case TYPES.ASSET_RESTORE_VERSION: {
      const assetId = String(message.payload?.assetId || "");
      const versionId = String(message.payload?.versionId || "");
      if (!assetId || !versionId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "assetId and versionId are required"));
      const asset = await restoreUserAssetVersion({
        ...automationScope(scope),
        assetId,
        versionId,
        expectedVersionId: typeof message.payload?.expectedVersionId === "string" ? message.payload.expectedVersionId : undefined,
        source: "restore",
        idempotencyKey: typeof message.payload?.idempotencyKey === "string" && message.payload.idempotencyKey.trim()
          ? message.payload.idempotencyKey
          : `portal:${message.requestId}`,
      });
      return finish(ok(message.type, message.requestId, sanitizeAssetDescriptor(asset)));
    }
    case TYPES.ASSET_CONVERT_TO_XLSX: {
      const assetId = String(message.payload?.assetId || "");
      const expectedVersionId = String(message.payload?.expectedVersionId || "");
      const idempotencyKey = String(message.payload?.idempotencyKey || "");
      if (!assetId || !expectedVersionId || !idempotencyKey) {
        return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "assetId, expectedVersionId and idempotencyKey are required"));
      }
      if (message.payload?.confirmed !== true) {
        return finish(fail(message.type, message.requestId, "ASSET_CONFIRMATION_REQUIRED", "CSV 转换为 Excel 需要用户明确确认"));
      }
      const asset = await convertUserAssetCsvToXlsx({
        ...automationScope(scope), assetId, expectedVersionId, idempotencyKey, confirmed: true,
      });
      return finish(ok(message.type, message.requestId, sanitizeAssetDescriptor(asset)));
    }
    case TYPES.ASSET_REFERENCES_LIST: {
      const assetId = String(message.payload?.assetId || "");
      if (!assetId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "assetId is required"));
      const references = await listUserAssetReferences({ ...automationScope(scope), assetId });
      return finish(ok(message.type, message.requestId, {
        taskBindings: references.taskBindings,
        provenance: references.provenance.map(sanitizeAssetVersion),
      }));
    }
    case TYPES.REPORT_ASSET_GET:
      return finish(ok(message.type, message.requestId, await readWorkspaceReportAsset({
        userId: scope.userId,
        projectId: scope.projectId,
        instanceId: scope.instanceId,
        relativePath: String(message.payload?.relativePath || ""),
      })));
    case TYPES.REPORT_MAPPING_GET: {
      const mappingId = String(message.payload?.mappingId || "");
      if (!mappingId) return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "mappingId is required"));
      // Scope-bound lookup: a mapping that does not belong to the caller is
      // indistinguishable from a missing one, so cross-scope opens fail safely.
      const mapping = getReportAssetMappingForRead(automationScope(scope), mappingId);
      if (!mapping) {
        return finish(fail(message.type, message.requestId, "REPORT_MAPPING_NOT_FOUND", mappingId));
      }
      try {
        if (mapping.backingAssetId) {
          const backing = mapping.backingVersionId
            ? await readUserAssetVersion({ ...automationScope(scope), assetId: mapping.backingAssetId, versionId: mapping.backingVersionId })
            : await readCurrentUserAsset({ ...automationScope(scope), assetId: mapping.backingAssetId });
          return finish(ok(message.type, message.requestId, {
            mappingId: mapping.mappingId,
            reportId: mapping.reportId,
            title: mapping.title,
            fileName: backing.descriptor.fileName,
            mimeType: backing.descriptor.mimeType,
            sizeBytes: backing.descriptor.sizeBytes,
            base64: backing.bytes.toString("base64"),
          }));
        }
        if (!mapping.readPath) return finish(fail(message.type, message.requestId, "REPORT_MAPPING_NOT_FOUND", mappingId));
        const payload = await readWorkspaceReportAsset({ userId: scope.userId, projectId: scope.projectId, instanceId: scope.instanceId, relativePath: mapping.readPath });
        return finish(ok(message.type, message.requestId, {
          mappingId: mapping.mappingId,
          reportId: mapping.reportId,
          title: mapping.title,
          fileName: payload.fileName,
          mimeType: payload.mimeType,
          sizeBytes: payload.sizeBytes,
          base64: payload.base64,
        }));
      } catch (error) {
        if (error instanceof WorkspaceReportAssetError) {
          return finish(fail(message.type, message.requestId, error.code, error.message));
        }
        throw error;
      }
    }
    case TYPES.ARTIFACT_GET: {
      const artifactId = String(message.payload?.artifactId || "");
      // The connector no longer records open/success events here. Those
      // are owned by the Portal client (which fires them once per real
      // user interaction, deduplicated across collapse/expand). The
      // connector still records a failure when it cannot serve the
      // payload, since that signal is only visible at this layer.
      try {
        const result = await readConversationArtifactPayload({
          artifactId,
          userId: scope.userId,
          instanceId: scope.instanceId,
        });
        return finish(ok(message.type, message.requestId, {
          artifactId: result.descriptor.artifactId,
          assetId: result.descriptor.assetId ?? null,
          versionId: result.descriptor.versionId ?? null,
          title: result.descriptor.title,
          fileName: result.payload.fileName,
          mimeType: result.payload.mimeType,
          sizeBytes: result.payload.sizeBytes,
          base64: result.payload.base64,
          checksum: result.payload.checksum,
          sanitized: result.payload.sanitized,
          kind: result.descriptor.kind,
          previewMode: result.descriptor.previewMode,
          createdAt: result.descriptor.createdAt,
          workspacePath: isWorkspaceBrowsableArtifact(result.descriptor.previewMode) ? result.descriptor.relativePath : undefined,
        }));
      } catch (error) {
        const reason = error instanceof ConversationArtifactError ? error.code : (error as Error).message;
        logArtifactEvent({
          artifactId,
          userId: scope.userId,
          instanceId: scope.instanceId,
          event: "failure",
          status: "failure",
          reason,
        });
        throw error;
      }
    }
    case TYPES.ARTIFACT_LIBRARY_LIST: {
      // The library list is scope-only: the payload may carry pagination
      // (`cursor`, `limit`) and nothing else. Any other field — especially
      // path/glob-like parameters — is rejected deterministically instead of
      // being silently ignored, so a malformed client fails loudly.
      const payload = (message.payload ?? {}) as Record<string, unknown>;
      for (const key of Object.keys(payload)) {
        if (key !== "cursor" && key !== "limit") {
          return finish(fail(message.type, message.requestId, "INVALID_REQUEST", `unsupported payload field: ${key}`, false));
        }
      }
      if (payload.cursor !== undefined && typeof payload.cursor !== "string") {
        return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "cursor must be a string", false));
      }
      if (payload.limit !== undefined && typeof payload.limit !== "number") {
        return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "limit must be a number", false));
      }
      const result = await listCuratedArtifactLibrary({
        userId: scope.userId,
        projectId: scope.projectId,
        instanceId: scope.instanceId,
        cursor: payload.cursor as string | undefined,
        limit: payload.limit as number | undefined,
      });
      return finish(ok(message.type, message.requestId, result));
    }
    case TYPES.WORKSPACE_FILE_LIST: {
      const payload = (message.payload ?? {}) as Record<string, unknown>;
      if (Object.keys(payload).length > 0) {
        return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "workspace file list does not accept filters", false));
      }
      return finish(ok(message.type, message.requestId, await listWorkspaceFiles({
        userId: scope.userId,
        projectId: scope.projectId,
        instanceId: scope.instanceId,
      })));
    }
    case TYPES.WORKSPACE_FILE_GET: {
      const relativePath = String(message.payload?.relativePath || "");
      if (!relativePath) {
        return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "relativePath is required", false));
      }
      try {
        return finish(ok(message.type, message.requestId, await readWorkspaceFile({
          userId: scope.userId,
          projectId: scope.projectId,
          instanceId: scope.instanceId,
          relativePath,
        })));
      } catch (error) {
        if (error instanceof WorkspaceFileError) {
          return finish(fail(message.type, message.requestId, error.code, error.message, false));
        }
        throw error;
      }
    }
    case TYPES.ARTIFACT_PUBLISH_LEGACY: {
      const record = await publishLegacyPathArtifact({
        userId: scope.userId,
        instanceId: scope.instanceId,
        projectId: scope.projectId,
        assistantId: scope.assistantId,
        conversationId: typeof message.payload?.conversationId === "string" ? message.payload.conversationId : null,
        relativePath: String(message.payload?.relativePath || ""),
      });
      if (record.relativePath.startsWith("reports/")) {
        await registerReportAssetMapping({
          userId: scope.userId, projectId: scope.projectId, instanceId: scope.instanceId,
          reportId: record.artifactId, title: record.title, fileName: record.fileName,
          mimeType: record.mimeType, sizeBytes: record.sizeBytes,
          backingAssetId: null, backingVersionId: null,
          readPath: record.relativePath,
        });
      }
      return finish(ok(message.type, message.requestId, {
        artifactId: record.artifactId,
        title: record.title,
        fileName: record.fileName,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        kind: record.kind,
        previewMode: record.previewMode,
        createdAt: record.createdAt,
        checksum: record.checksum,
        workspacePath: isWorkspaceBrowsableArtifact(record.previewMode) ? record.relativePath : undefined,
      }));
    }
    case TYPES.ARTIFACT_EVENT: {
      const artifactId = String(message.payload?.artifactId || "");
      const rawEvent = String(message.payload?.event || "");
      const event = isArtifactEventName(rawEvent) ? rawEvent : null;
      if (!event) {
        return finish(fail(message.type, message.requestId, "INVALID_REQUEST", `unknown artifact event: ${rawEvent}`));
      }
      // Validate that the artifact actually belongs to the caller before
      // accepting the event. Without this gate a malicious client could
      // poison telemetry with arbitrary artifact IDs.
      const owned = sqlite
        .prepare(
          `SELECT 1 FROM conversation_artifacts
           WHERE artifact_id = ? AND user_id = ? AND instance_id = ?`
        )
        .get(artifactId, scope.userId, scope.instanceId);
      if (!owned) {
        return finish(fail(message.type, message.requestId, "ARTIFACT_SCOPE_MISMATCH", "artifact does not belong to caller", false));
      }
      logArtifactEvent({
        artifactId,
        userId: scope.userId,
        instanceId: scope.instanceId,
        event,
        status: typeof message.payload?.status === "string" ? (message.payload.status as "success" | "failure" | "denied") : undefined,
        reason: typeof message.payload?.reason === "string" ? message.payload.reason : undefined,
      });
      return finish(ok(message.type, message.requestId, { accepted: true }));
    }
    case TYPES.ATTACHMENT_GET: {
      // Attachment reads are scope-bound: the browser only sends the
      // attachmentId (and optionally a download flag); userId/instanceId come
      // from the authenticated connector session. The service refuses to
      // resolve raw paths.
      const attachmentId = String(message.payload?.attachmentId || "");
      if (!attachmentId) {
        return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "attachmentId is required", false));
      }
      const preview = findAttachmentRecord({ attachmentId, userId: scope.userId, projectId: scope.projectId, instanceId: scope.instanceId });
      if (!preview) {
        return finish(fail(message.type, message.requestId, "ATTACHMENT_NOT_FOUND", attachmentId, false));
      }
      if (preview.status !== "active") {
        // Expired/deleted attachments keep their metadata so the Portal can
        // render the right card state, but no bytes are returned.
        return finish(ok(message.type, message.requestId, {
          attachmentId: preview.attachmentId,
          status: preview.status,
          fileName: preview.fileName,
          mimeType: preview.mimeType,
          sizeBytes: preview.sizeBytes,
          expiresAt: preview.expiresAt,
        }));
      }
      try {
        const { bytes, record } = await readAttachmentBytes({ attachmentId, userId: scope.userId, projectId: scope.projectId, instanceId: scope.instanceId });
        return finish(ok(message.type, message.requestId, {
          attachmentId: record.attachmentId,
          status: "active" as const,
          fileName: record.fileName,
          mimeType: record.mimeType,
          sizeBytes: record.sizeBytes,
          checksum: record.checksum,
          storedAt: record.storedAt,
          expiresAt: record.expiresAt,
          base64: bytes.toString("base64"),
        }));
      } catch (error) {
        if (error instanceof AttachmentRetentionError) {
          return finish(fail(message.type, message.requestId, error.code, error.message, false));
        }
        throw error;
      }
    }
    default:
      return finish(fail(message.type, message.requestId, "INVALID_REQUEST", `unsupported command: ${message.type}`));
  }
}

function isWorkspaceBrowsableArtifact(previewMode: string): boolean {
  return previewMode === "markdown" || previewMode === "html" || previewMode === "image";
}

export const __test__ = { handleCommand, scopeFromProject };

function scopeFromEnv(): ConnectorScope {
  const userId = env("PORTAL_USER_ID", DEFAULT_USER_ID)!;
  const instanceId = env("PORTAL_INSTANCE_ID", DEFAULT_INSTANCE_ID)!;
  const assistantId = env("PORTAL_ASSISTANT_ID", instanceId)!;
  return {
    userId,
    instanceId,
    assistantId,
    projectId: env("PORTAL_PROJECT_ID", DEFAULT_PROJECT_ID)!,
    connectorId: env("PORTAL_CONNECTOR_ID", `${connectorIdPrefix()}-${assistantId}`)!,
    displayName: env("PORTAL_CONNECTOR_DISPLAY_NAME", `${connectorRuntimeLabel()} 投资助手`)!,
  };
}

function scopeFromProject(project: AiProjectRuntimeContext): ConnectorScope {
  return {
    userId: project.ownerUserId,
    assistantId: project.instanceId,
    instanceId: project.instanceId,
    projectId: project.legacyProjectId || DEFAULT_PROJECT_ID,
    connectorId: `${connectorIdPrefix()}-${project.instanceId}`,
    displayName: project.name ? `${connectorRuntimeLabel()} ${project.name}` : `${connectorRuntimeLabel()} ${project.ownerUserId} 投资助手`,
  };
}

function startPortalConnectorForScope(scope: ConnectorScope) {
  if (!WebSocketCtor) {
    throw new Error("当前 Node.js 运行时没有全局 WebSocket，请升级 Node 或改用门户项目 mock connector 联调。");
  }

  const relayUrl = config.portal.localOnly
    ? "ws://127.0.0.1:3199"
    : env("PORTAL_RELAY_URL", "ws://localhost:3199")!;
  const token = config.portal.localOnly
    ? "dev-connector-token"
    : env("PORTAL_CONNECTOR_TOKEN", "dev-connector-token")!;
  const startedAt = new Date().toISOString();
  let socket: AnyWebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let activeRequests = 0;
  const taskLimiter = new ConcurrentTaskLimiter(portalConcurrentTaskLimit());
  let lastInboundAt = Date.now();

  const cleanupSocket = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (livenessTimer) {
      clearInterval(livenessTimer);
      livenessTimer = null;
    }
    progressForwarders.delete(scope.assistantId);
    socket = null;
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 5_000);
  };

  const forceReconnect = (reason: string) => {
    if (closed) return;
    logger.warn(`Portal connector reconnecting assistant=${scope.assistantId}: ${reason}`);
    const current = socket;
    cleanupSocket();
    scheduleReconnect();
    try {
      current?.close(1012, reason.slice(0, 120));
    } catch {
      // Ignore close errors; reconnect is already scheduled.
    }
  };

  const connect = () => {
    if (closed) return;
    const url = new URL(relayUrl);
    url.searchParams.set("token", token);
    const safeUrl = new URL(url.toString());
    safeUrl.searchParams.set("token", "***");
    logger.info(`Portal connector connecting assistant=${scope.assistantId} url=${safeUrl.toString()}`);
    socket = new WebSocketCtor(url.toString());

    socket.addEventListener("open", () => {
      if (!socket) return;
      lastInboundAt = Date.now();
      const registered = send(socket, envelope(TYPES.REGISTER, `reg_${randomUUID()}`, {
        connectorId: scope.connectorId,
        assistantId: scope.assistantId,
        instanceId: scope.instanceId,
        userId: scope.userId,
        projectId: scope.projectId,
        displayName: scope.displayName,
        version: "0.1.0-local",
        startedAt,
        capabilities: ["conversation.chat", "conversation.regenerate", "conversation.feedback", "conversation.cancel", "trace.get", "conversation.chat.progress", "conversation.list", "conversation.get", "conversation.sync", "conversation.attachments", "report.asset.get", "report.mapping.get", "artifact.get", "artifact.library.list", "artifact.publish.legacy", "artifact.event", "attachment.get", "workspace.file.list", "workspace.file.get", "automation.list", "automation.get", "automation.create", "automation.update", "automation.activate", "automation.pause", "automation.batch_action", "automation.run_now", "automation.runs.list", "automation.run.get", "automation.asset.get", "automation.continue_in_chat", "automation.migrate_legacy", "asset.list", "asset.folder.list", "asset.folder.create", "asset.folder.rename", "asset.folder.delete", "asset.move", "asset.get", "asset.version.get", "asset.versions.list", "asset.upload", "asset.conversation.save", "asset.rename", "asset.archive", "asset.delete", "asset.restore_version", "asset.convert_to_xlsx", "asset.references.list"],
        mode: env("PORTAL_CONNECTOR_MODE", "real"),
      }));
      if (!registered) {
        forceReconnect("register send failed");
        return;
      }
      // T-199：socket 打开即挂进度转发；断连由 cleanupSocket 清空。
      progressForwarders.set(scope.assistantId, makeProgressForwarder(() => socket));
      heartbeatTimer = setInterval(() => {
        if (!socket) return;
        try {
          const sent = send(socket, envelope(TYPES.HEARTBEAT, `hb_${Date.now()}`, {
            connectorId: scope.connectorId,
            assistantId: scope.assistantId,
            status: activeRequests > 0 ? "busy" : "online",
            activeRequests,
            lastActivityAt: new Date().toISOString(),
          }));
          if (!sent) forceReconnect("heartbeat send skipped because socket is not open");
        } catch (error) {
          forceReconnect(`heartbeat send failed: ${(error as Error).message}`);
        }
      }, 15_000);
      livenessTimer = setInterval(() => {
        if (!socket) return;
        const idleMs = Date.now() - lastInboundAt;
        if (idleMs > 45_000) {
          forceReconnect(`no relay acknowledgement for ${idleMs}ms`);
        }
      }, 10_000);
    });

    socket.addEventListener("message", (event: any) => {
      void (async () => {
        if (!socket) return;
        lastInboundAt = Date.now();
        let message: PortalEnvelope | PortalResponse;
        try {
          message = JSON.parse(String(event.data));
        } catch (error) {
          send(socket, fail("invalid", "parse-error", "INVALID_REQUEST", (error as Error).message));
          return;
        }
        if ("ok" in message) {
          if (message.type === TYPES.REGISTER) {
            if (message.ok) {
              logger.info(`Portal connector registered assistant=${scope.assistantId} connector=${scope.connectorId}`);
            } else {
              logger.warn(`Portal connector register rejected assistant=${scope.assistantId}: ${message.error?.message || "unknown"}`);
            }
          } else if (message.type === TYPES.HEARTBEAT && !message.ok) {
            logger.warn(`Portal connector heartbeat rejected assistant=${scope.assistantId}: ${message.error?.message || "unknown"}`);
          }
          return;
        }
        const isChatTask = message.type === TYPES.CONVERSATION_CHAT || message.type === TYPES.CONVERSATION_REGENERATE || message.type === TYPES.AUTOMATION_RUN_NOW;
        if (isChatTask && !taskLimiter.tryAcquire()) {
          send(socket, fail(
            message.type,
            message.requestId,
            "CONCURRENT_TASK_LIMIT",
            `当前已有 ${taskLimiter.limit} 个任务正在处理中，请等待其中一个完成后再试。`,
            true,
          ));
          return;
        }
        activeRequests += 1;
        try {
          send(socket, await handleCommand(scope, message));
        } catch (error) {
          logger.error(`Portal connector command failed assistant=${scope.assistantId}:`, error);
          if (error instanceof AttachmentStoreError) {
          send(socket, withProtocolVersion(fail(message.type, message.requestId, "INVALID_REQUEST", error.message, false), message.protocolVersion));
            return;
          }
          if (error instanceof WorkspaceReportAssetError) {
            send(socket, withProtocolVersion(fail(message.type, message.requestId, error.code, error.message, false), message.protocolVersion));
            return;
          }
          if (error instanceof AttachmentRetentionError) {
            send(socket, withProtocolVersion(fail(message.type, message.requestId, error.code, error.message, false), message.protocolVersion));
            return;
          }
          if (error instanceof ConversationArtifactError) {
            send(socket, withProtocolVersion(fail(message.type, message.requestId, error.code, error.message, false), message.protocolVersion));
            return;
          }
          if (error instanceof ConversationScopeError) {
            send(socket, withProtocolVersion(fail(message.type, message.requestId, "FORBIDDEN", error.message, false), message.protocolVersion));
            return;
          }
          if (error instanceof AutomationTaskError) {
            send(socket, withProtocolVersion(fail(
              message.type,
              message.requestId,
              error.code,
              error.message,
              error.code === "AUTOMATION_TASK_BUSY" || error.code === "AUTOMATION_RUN_LEASE_LOST",
            ), message.protocolVersion));
            return;
          }
          if (error instanceof UserAssetError) {
            const leaseLost = error.code === "ASSET_LEASE_LOST";
            send(socket, withProtocolVersion(fail(
              message.type,
              message.requestId,
              error.code,
              leaseLost ? "自动化运行已结束，当前文件未保存；请重新打开任务后再操作。" : error.message,
              error.code === "ASSET_VERSION_CONFLICT",
            ), message.protocolVersion));
            return;
          }
          send(socket, withProtocolVersion(fail(message.type, message.requestId, "AGENT_RUNTIME_FAILED", (error as Error).message, true), message.protocolVersion));
        } finally {
          activeRequests = Math.max(0, activeRequests - 1);
          if (isChatTask) taskLimiter.release();
        }
      })();
    });

    socket.addEventListener("close", (event: any) => {
      logger.warn(
        `Portal connector socket closed assistant=${scope.assistantId}: code=${event?.code ?? "unknown"} reason=${event?.reason || ""}`
      );
      cleanupSocket();
      scheduleReconnect();
    });

    socket.addEventListener("error", (event: any) => {
      logger.warn(`Portal connector socket error assistant=${scope.assistantId}: ${event?.message || "unknown error"}`);
      const current = socket;
      cleanupSocket();
      scheduleReconnect();
      try {
        current?.close(1011, "socket error");
      } catch {
        // Some WebSocket implementations throw when closing a failed handshake.
      }
    });
  };

  connect();

  return {
    stop() {
      closed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (livenessTimer) clearInterval(livenessTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      socket?.close(1000, "shutdown");
      socket = null;
    },
  };
}

export function startPortalConnector() {
  initDb();
  if (process.env.PORTAL_USER_ID || process.env.PORTAL_INSTANCE_ID || process.env.PORTAL_ASSISTANT_ID) {
    const connector = startPortalConnectorForScope(scopeFromEnv());
    return {
      stop() {
        connector.stop();
      },
    };
  }

  const connectors = new Map<string, ReturnType<typeof startPortalConnectorForScope>>();
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const refresh = async () => {
    if (stopped) return;
    const projects = (await listProjectRuntimeContexts()).filter(connectorScopeAllowed);
    const activeIds = new Set(projects.map((project) => project.instanceId));
    for (const project of projects) {
      if (connectors.has(project.instanceId)) continue;
      const scope = scopeFromProject(project);
      connectors.set(project.instanceId, startPortalConnectorForScope(scope));
      logger.info(`Portal connector manager registered assistant=${scope.assistantId}`);
    }
    for (const [instanceId, connector] of connectors) {
      if (activeIds.has(instanceId)) continue;
      connector.stop();
      connectors.delete(instanceId);
      logger.info(`Portal connector manager stopped archived assistant=${instanceId}`);
    }
  };

  void refresh().catch((error) => logger.error("Portal connector manager refresh failed:", error));
  const refreshMs = Math.max(Number(process.env.PORTAL_CONNECTOR_REFRESH_MS || 30_000), 5_000);
  refreshTimer = setInterval(() => {
    void refresh().catch((error) => logger.error("Portal connector manager refresh failed:", error));
  }, refreshMs);
  keepAliveTimer = setInterval(() => {
    // Keep standalone connector processes alive even when the runtime WebSocket
    // implementation unrefs idle sockets between heartbeats.
  }, 60_000);

  return {
    stop() {
      stopped = true;
      if (refreshTimer) clearInterval(refreshTimer);
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      for (const connector of connectors.values()) connector.stop();
      connectors.clear();
    },
  };
}

if (process.argv[1]?.endsWith("src/portal/connector.ts") || process.argv[1]?.endsWith("dist/portal/connector.js")) {
  const connector = startPortalConnector();
  const shutdown = (signal: string) => {
    logger.info(`收到 ${signal}，停止 Portal connector...`);
    connector.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
