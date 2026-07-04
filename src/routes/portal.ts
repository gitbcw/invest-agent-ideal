import type { FastifyInstance } from "fastify";
import { chatViaConversationLog, getConversation, listConversations } from "../services/conversation-log.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID, defaultInstanceIdForUser } from "../lib/user-context.js";
import { logger } from "../lib/logger.js";

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
    capabilities: ["conversation.chat", "conversation.list", "conversation.get"],
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
      idempotencyKey?: string;
      clientSentAt?: string;
    };
  }>("/api/portal/conversations/:conversationId/messages", safe(async (request, reply) => {
    const text = request.body?.text?.trim();
    if (!text) {
      return reply.status(400).send({ ok: false, error: "text is required" });
    }
    const scope = scopeFrom(request.body || {});
    const result = await chatViaConversationLog({
      ...scope,
      conversationId: request.params.conversationId,
      userMessageId: request.body?.userMessageId,
      text,
      idempotencyKey: request.body?.idempotencyKey,
      clientSentAt: request.body?.clientSentAt,
    });
    return { ok: true, ...result };
  }));
}
