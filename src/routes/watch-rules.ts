import type { FastifyInstance } from "fastify";
import { logger } from "../lib/logger.js";
import { defaultInstanceIdForUser, instanceIdFromRequest, userIdFromRequest } from "../lib/user-context.js";
import {
  createWatchRule,
  deleteWatchRule,
  dryRunWatchRuleById,
  listWatchRuleCatalog,
  listWatchRules,
  updateWatchRule,
  validateWatchRule,
} from "../services/watch-rules.js";

export function registerWatchRuleRoutes(app: FastifyInstance) {
  const safe = (handler: (request: any, reply: any) => Promise<any>) =>
    async (request: any, reply: any) => {
      try {
        return await handler(request, reply);
      } catch (error) {
        logger.error("WatchRule 操作失败:", error);
        return reply.status(500).send({ ok: false, error: (error as Error).message || "操作失败，请重试" });
      }
    };

  app.get("/api/watch-rules/catalog", safe(async () => {
    return { ok: true, items: listWatchRuleCatalog() };
  }));

  app.get<{ Querystring: { userId?: string; instanceId?: string } }>("/api/watch-rules", safe(async (request) => {
    const userId = userIdFromRequest(request);
    const instanceId = instanceIdFromRequest(request, userId);
    const items = await listWatchRules(userId, instanceId);
    return { ok: true, userId, instanceId, items };
  }));

  app.post<{ Body: Record<string, unknown> }>("/api/watch-rules/validate", safe(async (request, reply) => {
    const userId = userIdFromRequest(request);
    const instanceId = instanceIdFromRequest(request, userId);
    const result = await validateWatchRule({ ...request.body, userId, instanceId });
    if (!result.ok) {
      return reply.status(400).send({ ok: false, errors: result.errors });
    }
    return { ok: true, validation: result };
  }));

  app.post<{ Body: Record<string, unknown> }>("/api/watch-rules", safe(async (request, reply) => {
    const userId = userIdFromRequest(request);
    const instanceId = instanceIdFromRequest(request, userId);
    const rule = await createWatchRule({
      ...(request.body as any),
      userId,
      instanceId,
      source: { kind: "platform_api" },
    });
    return reply.status(201).send({ ok: true, userId, instanceId, rule });
  }));

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/watch-rules/:id", safe(async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ ok: false, error: "非法规则 id" });
    const userId = userIdFromRequest(request);
    const instanceId = instanceIdFromRequest(request, userId);
    const rule = await updateWatchRule(id, {
      ...(request.body as any),
      source: { kind: "platform_api" },
    }, userId, instanceId);
    return { ok: true, userId, instanceId, rule };
  }));

  app.delete<{ Params: { id: string }; Querystring: { userId?: string; instanceId?: string } }>("/api/watch-rules/:id", safe(async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ ok: false, error: "非法规则 id" });
    const userId = userIdFromRequest(request);
    const instanceId = instanceIdFromRequest(request, userId);
    const removed = await deleteWatchRule(id, userId, instanceId);
    if (!removed) return reply.status(404).send({ ok: false, error: "规则不存在" });
    return { ok: true, userId, instanceId };
  }));

  app.post<{ Params: { id: string }; Body: { userId?: string; instanceId?: string } }>("/api/watch-rules/:id/dry-run", safe(async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.status(400).send({ ok: false, error: "非法规则 id" });
    const userId = userIdFromRequest(request);
    const instanceId = instanceIdFromRequest(request, userId);
    const result = await dryRunWatchRuleById(id, userId, instanceId);
    return { ok: true, userId, instanceId, result };
  }));

  app.get("/api/watch-rules/default-scope", safe(async (request) => {
    const userId = userIdFromRequest(request);
    return {
      ok: true,
      userId,
      instanceId: defaultInstanceIdForUser(userId),
    };
  }));
}
