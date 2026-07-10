import { randomUUID } from "node:crypto";
import { initDb } from "../db/index.js";
import { disposeAllAcp } from "../acp/stdio-agent.js";
import { logger } from "../lib/logger.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { chatViaConversationLog, getConversation, listConversations } from "../services/conversation-log.js";
import { listProjectRuntimeContexts, type AiProjectRuntimeContext } from "../platform/project-registry.js";
import { AttachmentStoreError } from "../lib/attachment-store.js";

const PROTOCOL_VERSION = "2026-07-04";
const TYPES = {
  REGISTER: "connector.register",
  HEARTBEAT: "connector.heartbeat",
  CONVERSATION_LIST: "conversation.list",
  CONVERSATION_GET: "conversation.get",
  CONVERSATION_CHAT: "conversation.chat",
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
  return env("PORTAL_CONNECTOR_ID_PREFIX", "local")!;
}

function connectorRuntimeLabel() {
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

async function handleCommand(scope: ConnectorScope, message: PortalEnvelope) {
  const commandScope = localPayloadScope(scope, message.payload);
  const startedAt = Date.now();
  logger.info(`Portal connector command start assistant=${scope.assistantId} type=${message.type} request=${message.requestId}`);
  const finish = (response: PortalResponse) => {
    logger.info(`Portal connector command done assistant=${scope.assistantId} type=${message.type} request=${message.requestId} ok=${response.ok} elapsedMs=${Date.now() - startedAt}`);
    return response;
  };
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
    case TYPES.CONVERSATION_CHAT:
      if (!String(message.payload?.text || "").trim() && (!Array.isArray(message.payload?.attachments) || message.payload.attachments.length === 0)) {
        return finish(fail(message.type, message.requestId, "INVALID_REQUEST", "text or attachments is required"));
      }
      return finish(ok(message.type, message.requestId, await chatViaConversationLog({
        ...commandScope,
        conversationId: String(message.payload?.conversationId || ""),
        userMessageId: message.payload?.userMessageId,
        text: String(message.payload?.text || ""),
        attachments: Array.isArray(message.payload?.attachments) ? message.payload.attachments : undefined,
        idempotencyKey: message.payload?.idempotencyKey,
        clientSentAt: message.payload?.clientSentAt,
      })));
    default:
      return finish(fail(message.type, message.requestId, "INVALID_REQUEST", `unsupported command: ${message.type}`));
  }
}

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
    projectId: project.projectId || DEFAULT_PROJECT_ID,
    connectorId: `${connectorIdPrefix()}-${project.instanceId}`,
    displayName: project.name ? `${connectorRuntimeLabel()} ${project.name}` : `${connectorRuntimeLabel()} ${project.ownerUserId} 投资助手`,
  };
}

function startPortalConnectorForScope(scope: ConnectorScope) {
  if (!WebSocketCtor) {
    throw new Error("当前 Node.js 运行时没有全局 WebSocket，请升级 Node 或改用门户项目 mock connector 联调。");
  }

  const relayUrl = env("PORTAL_RELAY_URL", "ws://localhost:3199")!;
  const token = env("PORTAL_CONNECTOR_TOKEN", "dev-connector-token")!;
  const startedAt = new Date().toISOString();
  let socket: AnyWebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let activeRequests = 0;
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
        capabilities: ["conversation.chat", "conversation.list", "conversation.get", "conversation.sync", "conversation.attachments"],
        mode: env("PORTAL_CONNECTOR_MODE", "real"),
      }));
      if (!registered) {
        forceReconnect("register send failed");
        return;
      }
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
        activeRequests += 1;
      try {
        send(socket, await handleCommand(scope, message));
      } catch (error) {
        logger.error(`Portal connector command failed assistant=${scope.assistantId}:`, error);
        if (error instanceof AttachmentStoreError) {
          send(socket, fail(message.type, message.requestId, "INVALID_REQUEST", error.message, false));
          return;
        }
        send(socket, fail(message.type, message.requestId, "ACP_FAILED", (error as Error).message, true));
      } finally {
          activeRequests = Math.max(0, activeRequests - 1);
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
        disposeAllAcp();
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
      disposeAllAcp();
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
