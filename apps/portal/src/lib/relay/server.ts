import { WebSocketServer, type WebSocket } from "ws";
import { nanoid } from "nanoid";

import { getConfig } from "@/lib/config";
import { openDatabase } from "@/lib/db";
import { AuditRepository } from "@/lib/db/users";
import {
  ConversationMirrorRepository,
  ConversationScopeMismatchError
} from "@/lib/db/conversations";
import { reconcilePendingConversations } from "@/lib/conversation-detail-sync";
import {
  buildErrorResponse,
  buildOkResponse,
  makeError,
  parseEnvelope,
  PORTAL_PROTOCOL_VERSION,
  PORTAL_TYPES,
  type ConnectorHeartbeatPayload,
  type ConnectorRegisterPayload,
  type ConnectorRegisterResult,
  type ConversationChatResult,
  type ConversationGetResult,
  type ConversationListResult,
  type ConversationSyncPayload,
  type PortalEnvelope
} from "@/lib/protocol";
import {
  getGlobalRegistry,
  type ConnectorInfo
} from "./registry";

export interface RelayServerOptions {
  port?: number;
  heartbeatIntervalMs?: number;
  /**
   * 当 connector 离线时被外部观察。例如可以让 HTTP API 推送状态。
   */
  onConnectorChange?: (event: { assistantId: string; online: boolean }) => void;
}

type OutboundResponse = {
  requestId?: string;
  ok?: boolean;
  data?: unknown;
  error?: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
};

type OutboundPending = {
  resolve: (response: OutboundResponse) => void;
  timer: NodeJS.Timeout;
};

const outboundPendingBySocket = new WeakMap<WebSocket, Map<string, OutboundPending>>();

function getOutboundPending(socket: WebSocket): Map<string, OutboundPending> {
  const existing = outboundPendingBySocket.get(socket);
  if (existing) return existing;

  const pending = new Map<string, OutboundPending>();
  outboundPendingBySocket.set(socket, pending);
  socket.on("message", (raw) => {
    let response: OutboundResponse;
    try {
      response = JSON.parse(raw.toString()) as OutboundResponse;
    } catch {
      return;
    }
    if (!response.requestId) return;
    const request = pending.get(response.requestId);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(response.requestId);
    request.resolve(response);
  });
  socket.on("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.resolve({
        ok: false,
        error: { code: "CONNECTOR_OFFLINE", message: "助手连接已断开", retryable: true }
      });
    }
    pending.clear();
  });
  return pending;
}

/**
 * 启动一个独立的 WebSocket Relay 服务。
 * 在 scripts/start-relay.ts 中调用,或者在自定义 Next.js server 中嵌入。
 */
export function startRelayServer(options: RelayServerOptions = {}) {
  const cfg = getConfig();
  const port = options.port ?? cfg.relayPort;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;

  const wss = new WebSocketServer({ port });
  const registry = getGlobalRegistry();
  const db = openDatabase();
  const conversations = new ConversationMirrorRepository(db);
  const audit = new AuditRepository(db);

  console.log(`[relay] listening on ws://0.0.0.0:${port}`);

  const staleTimer = setInterval(() => {
    const removed = registry.reapStale(heartbeatIntervalMs);
    for (const id of removed) {
      console.log(`[relay] reaped stale connector ${id}`);
    }
  }, heartbeatIntervalMs * 2);

  wss.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const token = url.searchParams.get("token") ?? req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (token !== cfg.connectorToken) {
      socket.close(4401, "UNAUTHORIZED");
      audit.recordAuthEvent({
        event: "connector_unauthorized",
        details: `remote=${req.socket.remoteAddress}`
      });
      return;
    }
    console.log(`[relay] incoming connection from ${req.socket.remoteAddress}, registry has ${registry.list().length} connectors`);
    attachConnectorHandlers(socket, registry, conversations, heartbeatIntervalMs, options.onConnectorChange);
  });

  return {
    wss,
    close: () => {
      clearInterval(staleTimer);
      wss.close();
      console.log("[relay] closed");
    }
  };
}

function attachConnectorHandlers(
  socket: WebSocket,
  registry: ReturnType<typeof getGlobalRegistry>,
  conversations: ConversationMirrorRepository,
  heartbeatIntervalMs: number,
  onConnectorChange?: (event: { assistantId: string; online: boolean }) => void
) {
  let registered: ConnectorInfo | null = null;
  const pendingRequests = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();

  socket.on("message", async (raw) => {
    let envelope: PortalEnvelope;
    try {
      envelope = parseEnvelope(raw.toString());
    } catch (err) {
      socket.send(
        JSON.stringify(
          buildErrorResponse("invalid", "parse-error", makeError("INVALID_REQUEST", (err as Error).message, false))
        )
      );
      return;
    }

    if (envelope.type === PORTAL_TYPES.REGISTER) {
      handleRegister(envelope as PortalEnvelope<ConnectorRegisterPayload>);
      return;
    }

    if (!registered) {
      socket.send(
        JSON.stringify(
          buildErrorResponse(
            envelope.type,
            envelope.requestId,
            makeError("UNAUTHORIZED", "connector not registered", false)
          )
        )
      );
      return;
    }

    if (envelope.type === PORTAL_TYPES.HEARTBEAT) {
      const payload = envelope.payload as ConnectorHeartbeatPayload;
      registry.heartbeat(registered.connectorId, {
        status: payload.status,
        activeRequests: payload.activeRequests,
        lastActivityAt: payload.lastActivityAt
      });
      socket.send(
        JSON.stringify(
          buildOkResponse(PORTAL_TYPES.HEARTBEAT, envelope.requestId, { acknowledgedAt: new Date().toISOString() })
        )
      );
      return;
    }

    // 其他都是 Relay 主动发出去的请求对应的响应
    const pending = pendingRequests.get(envelope.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingRequests.delete(envelope.requestId);
      // 注意:这是 connector 返回的 PortalResponse,不是 envelope
      pending.resolve(envelope);
      return;
    }

    if (envelope.type === PORTAL_TYPES.CONVERSATION_SYNC) {
      handleSync(envelope as PortalEnvelope<ConversationSyncPayload>);
      return;
    }

    // 未识别类型,忽略
  });

  socket.on("close", () => {
    if (registered) {
      const info = registry.unregister(registered.connectorId);
      if (info) {
        onConnectorChange?.({ assistantId: info.assistantId, online: false });
        console.log(`[relay] connector ${info.connectorId} (${info.assistantId}) disconnected`);
      }
    }
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pendingRequests.delete(id);
      pending.reject(new Error("connector_closed"));
    }
  });

  socket.on("error", (err) => {
    console.error(`[relay] socket error:`, err.message);
  });

  function handleRegister(envelope: PortalEnvelope<ConnectorRegisterPayload>) {
    const payload = envelope.payload;
    const info: ConnectorInfo = {
      connectorId: payload.connectorId,
      assistantId: payload.assistantId,
      instanceId: payload.instanceId,
      userId: payload.userId,
      projectId: payload.projectId,
      displayName: payload.displayName,
      version: payload.version,
      startedAt: payload.startedAt,
      capabilities: payload.capabilities,
      mode: payload.mode,
      registeredAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      status: "online",
      activeRequests: 0,
      socket
    };
    const result = registry.register(info);
    if (result.replaced) {
      console.log(
        `[relay] connector ${info.connectorId} took over assistant=${info.assistantId} from ${result.replaced.connectorId}`
      );
      try {
        result.replaced.socket.close(4410, "CONNECTOR_TAKEOVER");
      } catch {
        // The old socket may already be closing; registry state has been updated.
      }
      onConnectorChange?.({ assistantId: result.replaced.assistantId, online: false });
    }
    if (!result.accepted) {
      socket.send(
        JSON.stringify(
          buildErrorResponse(
            PORTAL_TYPES.REGISTER,
            envelope.requestId,
            makeError(
              "CONNECTOR_CONFLICT",
              `assistant ${payload.assistantId} already has active connector ${result.conflict?.activeConnectorId}`,
              false,
              result.conflict ? { conflict: result.conflict } : undefined
            )
          )
        )
      );
      socket.close(4409, "CONNECTOR_CONFLICT");
      return;
    }
    registered = info;
    const data: ConnectorRegisterResult = {
      accepted: true,
      active: true,
      serverTime: new Date().toISOString(),
      heartbeatIntervalMs
    };
    socket.send(JSON.stringify(buildOkResponse(PORTAL_TYPES.REGISTER, envelope.requestId, data)));
    console.log(
      `[relay] connector ${info.connectorId} registered (assistant=${info.assistantId}, mode=${info.mode})`
    );
    onConnectorChange?.({ assistantId: info.assistantId, online: true });
    void reconcilePendingConversations({
      repo: conversations,
      assistantId: info.assistantId,
      requestPage: (scope, conversationId, cursor, limit) =>
        sendConnectorRequest<ConversationGetResult>(
          info.assistantId,
          PORTAL_TYPES.CONVERSATION_GET,
          {
            userId: scope.userId,
            assistantId: scope.assistantId,
            instanceId: scope.instanceId,
            conversationId,
            limit,
            cursor
          }
        )
    }).catch((error) => {
      console.warn(`[relay] pending conversation reconciliation failed assistant=${info.assistantId}: ${(error as Error).message}`);
    });
  }

  function handleSync(envelope: PortalEnvelope<ConversationSyncPayload>) {
    const payload = envelope.payload;
    if (
      !registered ||
      payload.userId !== registered.userId ||
      payload.assistantId !== registered.assistantId ||
      payload.instanceId !== registered.instanceId ||
      payload.messages.some(
        (message) =>
          message.assistantId !== registered?.assistantId ||
          message.instanceId !== registered?.instanceId
      )
    ) {
      socket.send(
        JSON.stringify(
          buildErrorResponse(
            PORTAL_TYPES.CONVERSATION_SYNC,
            envelope.requestId,
            makeError("FORBIDDEN", "conversation sync scope mismatch", false)
          )
        )
      );
      return;
    }
    const conversationIds = new Set(payload.conversations.map((conversation) => conversation.conversationId));
    for (const conv of payload.conversations) {
      const existing = conversations.getConversation(conv.conversationId);
      if (
        existing &&
        (existing.user_id !== registered.userId ||
          existing.assistant_id !== registered.assistantId ||
          existing.instance_id !== registered.instanceId)
      ) {
        socket.send(
          JSON.stringify(
            buildErrorResponse(
              PORTAL_TYPES.CONVERSATION_SYNC,
              envelope.requestId,
              makeError("FORBIDDEN", "conversation sync scope mismatch", false)
            )
          )
        );
        return;
      }
    }
    if (payload.messages.some((message) => !conversationIds.has(message.conversationId))) {
      socket.send(
        JSON.stringify(
          buildErrorResponse(
            PORTAL_TYPES.CONVERSATION_SYNC,
            envelope.requestId,
            makeError("FORBIDDEN", "conversation sync scope mismatch", false)
          )
        )
      );
      return;
    }
    for (const conv of payload.conversations) {
      conversations.upsertConversation({
        conversationId: conv.conversationId,
        userId: payload.userId,
        assistantId: payload.assistantId,
        instanceId: payload.instanceId,
        channel: conv.channel,
        title: conv.title,
        lastMessagePreview: conv.lastMessagePreview,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt
      });
    }
    for (const msg of payload.messages) {
      try {
        conversations.upsertMessage({ ...msg, userId: registered.userId });
      } catch (error) {
        if (error instanceof ConversationScopeMismatchError) {
          socket.send(
            JSON.stringify(
              buildErrorResponse(
                PORTAL_TYPES.CONVERSATION_SYNC,
                envelope.requestId,
                makeError("FORBIDDEN", "conversation sync scope mismatch", false)
              )
            )
          );
          return;
        }
        throw error;
      }
    }
    for (const conversationId of conversationIds) {
      const pending = conversations.getReconciliation({
        conversationId,
        userId: registered.userId,
        assistantId: registered.assistantId,
        instanceId: registered.instanceId
      });
      if (!pending) continue;
      const user = pending.userMessageId
        ? payload.messages.find((message) => message.messageId === pending.userMessageId)
        : undefined;
      const requestId = user?.requestId ?? pending.requestId;
      const assistant = payload.messages.find(
        (message) => message.role === "assistant" && Boolean(requestId) && message.requestId === requestId
      );
      const userIndex = pending.userMessageId
        ? payload.messages.findIndex((message) => message.messageId === pending.userMessageId)
        : -1;
      const nextUserIndex = userIndex >= 0
        ? payload.messages.findIndex((message, index) => index > userIndex && message.role === "user")
        : -1;
      const assistantInTurn = userIndex >= 0
        ? payload.messages.find(
            (message, index) =>
              index > userIndex &&
              (nextUserIndex < 0 || index < nextUserIndex) &&
              message.role === "assistant" &&
              message.status !== "pending"
          )
        : undefined;
      if (assistant || assistantInTurn) {
        conversations.clearReconciliation({
          conversationId,
          userId: registered.userId,
          assistantId: registered.assistantId,
          instanceId: registered.instanceId
        });
      }
    }
    socket.send(
      JSON.stringify(
        buildOkResponse(PORTAL_TYPES.CONVERSATION_SYNC, envelope.requestId, {
          appliedConversations: payload.conversations.length,
          appliedMessages: payload.messages.length
        })
      )
    );
  }
}

/**
 * 通过已注册的 connector 发送请求并等待响应。
 * 供 HTTP API 路由调用。
 *
 * 超时单位毫秒,默认跟配置走;门户同步聊天当前要求至少 10 分钟。
 */
export async function sendConnectorRequest<T>(
  assistantId: string,
  type: string,
  payload: unknown,
  timeoutMs = getConfig().connectorRequestTimeoutMs
): Promise<{ ok: true; data: T } | { ok: false; code: string; message: string; retryable: boolean; details?: Record<string, unknown> }> {
  const registry = getGlobalRegistry();
  const connector = registry.getByAssistant(assistantId);
  if (!connector) {
    return {
      ok: false,
      code: "CONNECTOR_OFFLINE",
      message: "助手暂时离线",
      retryable: true
    };
  }

  const requestId = `req_${nanoid(16)}`;
  const envelope: PortalEnvelope = {
    protocolVersion: PORTAL_PROTOCOL_VERSION,
    requestId,
    type,
    sentAt: new Date().toISOString(),
    payload
  };

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const pending = getOutboundPending(connector.socket);
    console.log(`[relay] request start type=${type} requestId=${requestId} assistant=${assistantId} connector=${connector.connectorId} timeoutMs=${timeoutMs}`);
    const timer = setTimeout(() => {
      pending.delete(requestId);
      console.warn(`[relay] request timeout type=${type} requestId=${requestId} assistant=${assistantId} elapsedMs=${Date.now() - startedAt} timeoutMs=${timeoutMs}`);
      resolve({
        ok: false,
        code: "TIMEOUT",
        message: "助手响应超时",
        retryable: true
      });
    }, timeoutMs);

    pending.set(requestId, {
      timer,
      resolve: (response) => {
        const obj = response as OutboundResponse & { data?: T };
        console.log(`[relay] request done type=${type} requestId=${requestId} assistant=${assistantId} ok=${Boolean(obj.ok)} elapsedMs=${Date.now() - startedAt}`);
        if (obj.ok) {
          resolve({ ok: true, data: obj.data as T });
        } else if (obj.error) {
          resolve({
            ok: false,
            code: obj.error.code,
            message: obj.error.message,
            retryable: obj.error.retryable,
            details: obj.error.details
          });
        } else {
          resolve({
            ok: false,
            code: "INTERNAL_ERROR",
            message: "未知错误",
            retryable: false
          });
        }
      }
    });

    try {
      connector.socket.send(JSON.stringify(envelope));
    } catch {
      clearTimeout(timer);
      pending.delete(requestId);
      resolve({ ok: false, code: "CONNECTOR_OFFLINE", message: "助手连接已断开", retryable: true });
    }
  });
}

export type ConversationListResultResponse = ConversationListResult;
export type ConversationGetResultResponse = ConversationGetResult;
export type ConversationChatResultResponse = ConversationChatResult;
