import { randomUUID } from "node:crypto";
import { initDb } from "../db/index.js";
import { disposeAllAcp } from "../acp/stdio-agent.js";
import { logger } from "../lib/logger.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { chatViaConversationLog, getConversation, listConversations } from "../services/conversation-log.js";

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
  if (socket.readyState !== 1) return;
  socket.send(JSON.stringify(message));
}

async function handleCommand(message: PortalEnvelope) {
  switch (message.type) {
    case TYPES.CONVERSATION_LIST:
      return ok(message.type, message.requestId, listConversations({
        userId: message.payload?.userId,
        assistantId: message.payload?.assistantId,
        instanceId: message.payload?.instanceId,
        channel: message.payload?.channel,
        cursor: message.payload?.cursor,
        limit: message.payload?.limit,
      }));
    case TYPES.CONVERSATION_GET:
      return ok(message.type, message.requestId, getConversation({
        userId: message.payload?.userId,
        assistantId: message.payload?.assistantId,
        instanceId: message.payload?.instanceId,
        conversationId: String(message.payload?.conversationId || ""),
        cursor: message.payload?.cursor,
        limit: message.payload?.limit,
      }));
    case TYPES.CONVERSATION_CHAT:
      return ok(message.type, message.requestId, await chatViaConversationLog({
        userId: message.payload?.userId,
        assistantId: message.payload?.assistantId,
        instanceId: message.payload?.instanceId,
        conversationId: String(message.payload?.conversationId || ""),
        userMessageId: message.payload?.userMessageId,
        text: String(message.payload?.text || ""),
        idempotencyKey: message.payload?.idempotencyKey,
        clientSentAt: message.payload?.clientSentAt,
      }));
    default:
      return fail(message.type, message.requestId, "INVALID_REQUEST", `unsupported command: ${message.type}`);
  }
}

export function startPortalConnector() {
  if (!WebSocketCtor) {
    throw new Error("当前 Node.js 运行时没有全局 WebSocket，请升级 Node 或改用门户项目 mock connector 联调。");
  }

  initDb();

  const relayUrl = env("PORTAL_RELAY_URL", "ws://localhost:3199")!;
  const token = env("PORTAL_CONNECTOR_TOKEN", "dev-connector-token")!;
  const userId = env("PORTAL_USER_ID", DEFAULT_USER_ID)!;
  const instanceId = env("PORTAL_INSTANCE_ID", DEFAULT_INSTANCE_ID)!;
  const assistantId = env("PORTAL_ASSISTANT_ID", instanceId)!;
  const projectId = env("PORTAL_PROJECT_ID", DEFAULT_PROJECT_ID)!;
  const connectorId = env("PORTAL_CONNECTOR_ID", `local-${assistantId}`)!;
  const displayName = env("PORTAL_CONNECTOR_DISPLAY_NAME", "本地投资助手")!;
  const startedAt = new Date().toISOString();
  let socket: AnyWebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let activeRequests = 0;

  const connect = () => {
    if (closed) return;
    const url = new URL(relayUrl);
    url.searchParams.set("token", token);
    logger.info(`Portal connector connecting ${url.toString()}`);
    socket = new WebSocketCtor(url.toString());

    socket.addEventListener("open", () => {
      if (!socket) return;
      send(socket, envelope(TYPES.REGISTER, `reg_${randomUUID()}`, {
        connectorId,
        assistantId,
        instanceId,
        userId,
        projectId,
        displayName,
        version: "0.1.0-local",
        startedAt,
        capabilities: ["conversation.chat", "conversation.list", "conversation.get", "conversation.sync"],
        mode: "real",
      }));
      heartbeatTimer = setInterval(() => {
        if (!socket) return;
        send(socket, envelope(TYPES.HEARTBEAT, `hb_${Date.now()}`, {
          connectorId,
          assistantId,
          status: activeRequests > 0 ? "busy" : "online",
          activeRequests,
          lastActivityAt: new Date().toISOString(),
        }));
      }, 15_000);
    });

    socket.addEventListener("message", (event: any) => {
      void (async () => {
        if (!socket) return;
        let message: PortalEnvelope | PortalResponse;
        try {
          message = JSON.parse(String(event.data));
        } catch (error) {
          send(socket, fail("invalid", "parse-error", "INVALID_REQUEST", (error as Error).message));
          return;
        }
        if ("ok" in message) {
          if (message.type === TYPES.REGISTER && !message.ok) {
            logger.warn(`Portal connector register rejected: ${message.error?.message || "unknown"}`);
          }
          return;
        }
        activeRequests += 1;
        try {
          send(socket, await handleCommand(message));
        } catch (error) {
          logger.error("Portal connector command failed:", error);
          send(socket, fail(message.type, message.requestId, "ACP_FAILED", (error as Error).message, true));
        } finally {
          activeRequests = Math.max(0, activeRequests - 1);
        }
      })();
    });

    socket.addEventListener("close", () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      socket = null;
      if (closed || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 5_000);
    });

    socket.addEventListener("error", (event: any) => {
      logger.warn(`Portal connector socket error: ${event?.message || "unknown error"}`);
    });
  };

  connect();

  return {
    stop() {
      closed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close(1000, "shutdown");
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
