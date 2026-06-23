import { db } from "../db/index.js";
import { sandboxAuditLogs } from "../db/schema.js";
import type { SandboxContext } from "./sandbox-context.js";

export async function recordSandboxAudit(input: {
  context: SandboxContext;
  operation: string;
  resourceType: string;
  resourceId?: string;
  requestBody?: unknown;
  resultSummary?: string;
  status: "success" | "denied" | "error";
}) {
  await db.insert(sandboxAuditLogs).values({
    userId: input.context.userId,
    projectId: input.context.projectId,
    instanceId: input.context.instanceId,
    role: input.context.role,
    channel: input.context.channel,
    backend: input.context.backend,
    conversationId: input.context.conversationId,
    tokenId: input.context.tokenId,
    operation: input.operation,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    requestBody: JSON.stringify(input.requestBody ?? {}),
    resultSummary: input.resultSummary,
    status: input.status,
    createdAt: new Date().toISOString(),
  });
}
