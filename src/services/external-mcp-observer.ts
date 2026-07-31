import { db } from "../db/index.js";
import { externalMcpToolCalls } from "../db/schema.js";
import { buildExternalRegistrations, isExternalRegistrationActivated } from "../acp/external-mcp-registrations.js";
import { resolveExternalHttpServer } from "../acp/mcp-registry.js";

export type ExternalMcpObserverScope = {
  userId: string;
  projectId: string;
  instanceId: string;
  conversationId?: string;
};

export function resolveObservedExternalMcp(serverId: string, env: NodeJS.ProcessEnv = process.env) {
  const registration = buildExternalRegistrations().find((item) => item.id === serverId);
  if (!registration || !isExternalRegistrationActivated(registration, env)) return null;
  const resolved = resolveExternalHttpServer(registration, env);
  return resolved ? { registration, resolved } : null;
}

export function observedToolCallFromBody(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const rpc = body as { method?: unknown; id?: unknown; params?: { name?: unknown } };
  if (rpc.method !== "tools/call" || typeof rpc.params?.name !== "string") return null;
  return {
    toolName: rpc.params.name,
    requestId: typeof rpc.id === "string" || typeof rpc.id === "number" ? String(rpc.id) : undefined,
  };
}

export async function recordObservedExternalToolCall(input: {
  scope: ExternalMcpObserverScope;
  serverId: string;
  toolName: string;
  requestId?: string;
  status: "completed" | "failed";
  elapsedMs: number;
  inputChars?: number;
  outputChars?: number;
  errorClass?: string;
}) {
  await db.insert(externalMcpToolCalls).values({
    userId: input.scope.userId,
    projectId: input.scope.projectId,
    instanceId: input.scope.instanceId,
    conversationId: input.scope.conversationId,
    serverId: input.serverId,
    toolName: input.toolName,
    requestId: input.requestId,
    status: input.status,
    elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
    inputChars: input.inputChars,
    outputChars: input.outputChars,
    errorClass: input.errorClass,
    createdAt: new Date().toISOString(),
  });
}

export function serializedSize(value: unknown): number | undefined {
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : undefined;
  } catch {
    return undefined;
  }
}
