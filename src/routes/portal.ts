import type { FastifyInstance } from "fastify";
import { ConversationScopeError, chatViaConversationLog, getConversation, listConversations } from "../services/conversation-log.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID, defaultInstanceIdForUser } from "../lib/user-context.js";
import { logger } from "../lib/logger.js";
import { AttachmentStoreError, type IncomingPortalAttachment } from "../lib/attachment-store.js";

function scopeFrom(input: {
  userId?: string;
  assistantId?: string;
  instanceId?: string;
  projectId?: string;
}) {
  const userId = input.userId?.trim() || DEFAULT_USER_ID;
  const instanceId = input.instanceId?.trim() || defaultInstanceIdForUser(userId);
  return {
    userId,
    projectId: input.projectId?.trim() || DEFAULT_PROJECT_ID,
    instanceId,
    assistantId: input.assistantId?.trim() || instanceId || DEFAULT_INSTANCE_ID,
  };
}

export function registerPortalRoutes(app: FastifyInstance) {
  const safe = (handler: (request: any, reply: any) => Promise<any> | any) =>
    async (request: any, reply: any) => {
      try {
        return await handler(request, reply);
      } catch (error) {
        if (error instanceof AttachmentStoreError) {
          return reply.status(400).send({
            ok: false,
            error: error.message,
            code: error.code,
            details: error.details,
          });
        }
        if (error instanceof ConversationScopeError) {
          return reply.status(403).send({ ok: false, error: "conversation does not belong to this scope", code: "CONVERSATION_SCOPE_MISMATCH" });
        }
        logger.error("Portal 本地接口失败:", error);
        return reply.status(500).send({
          ok: false,
          error: error instanceof Error ? error.message : "portal local api failed",
        });
      }
    };

  app.get("/api/portal/health", safe(async () => ({
    ok: true,
    mode: "local-runtime",
    capabilities: ["conversation.chat", "conversation.list", "conversation.get", "conversation.attachments"],
    timestamp: new Date().toISOString(),
  })));

  app.get<{
    Querystring: {
      userId?: string;
      assistantId?: string;
      instanceId?: string;
      projectId?: string;
      channel?: "web" | "weixin-mobile";
      cursor?: string;
      limit?: string;
    };
  }>("/api/portal/conversations", safe(async (request) => {
    const scope = scopeFrom(request.query);
    return {
      ok: true,
      ...listConversations({
        ...scope,
        channel: request.query.channel,
        cursor: request.query.cursor,
        limit: request.query.limit ? Number(request.query.limit) : undefined,
      }),
    };
  }));

  app.get<{
    Params: { conversationId: string };
    Querystring: {
      userId?: string;
      assistantId?: string;
      instanceId?: string;
      projectId?: string;
      cursor?: string;
      limit?: string;
    };
  }>("/api/portal/conversations/:conversationId", safe(async (request) => {
    const scope = scopeFrom(request.query);
    return {
      ok: true,
      ...getConversation({
        ...scope,
        conversationId: request.params.conversationId,
        cursor: request.query.cursor,
        limit: request.query.limit ? Number(request.query.limit) : undefined,
      }),
    };
  }));

  app.post<{
    Params: { conversationId: string };
    Body: {
      userId?: string;
      assistantId?: string;
      instanceId?: string;
      projectId?: string;
      userMessageId?: string;
      text?: string;
      attachments?: IncomingPortalAttachment[];
      idempotencyKey?: string;
      clientSentAt?: string;
    };
  }>("/api/portal/conversations/:conversationId/messages", safe(async (request, reply) => {
    const text = request.body?.text?.trim();
    const attachments = Array.isArray(request.body?.attachments) ? request.body.attachments : [];
    if (!text && attachments.length === 0) {
      return reply.status(400).send({ ok: false, error: "text or attachments is required", code: "INVALID_REQUEST" });
    }
    const scope = scopeFrom(request.body || {});
    const result = await chatViaConversationLog({
      ...scope,
      conversationId: request.params.conversationId,
      userMessageId: request.body?.userMessageId,
      text,
      attachments,
      idempotencyKey: request.body?.idempotencyKey,
      clientSentAt: request.body?.clientSentAt,
    });
    return { ok: true, ...result };
  }));
}
