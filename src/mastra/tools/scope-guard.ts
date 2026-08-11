import {
  classifyServiceTool,
  isScheduledTaskType,
  resolveScheduledServiceGrant,
  SERVICE_TOOL_CLASSIFICATION,
} from "../../mcp/service-tool-classification.js";
import type { ServiceToolContext } from "../../mcp/service-tools-core.js";

export type MastraToolContext = ServiceToolContext & {
  taskType?: string;
  mcpAllowedTools?: string[];
};

export interface ScopeGuardDecision {
  allowed: boolean;
  reason?: string;
}

export function resolveAllowedTools(context: MastraToolContext): Set<string> | undefined {
  if (context.taskType && isScheduledTaskType(context.taskType)) {
    return new Set(resolveScheduledServiceGrant(context.taskType));
  }
  if (context.mcpAllowedTools && context.mcpAllowedTools.length > 0) {
    return new Set(context.mcpAllowedTools);
  }
  return undefined;
}

export function isCompleteToolContext(context: unknown): context is MastraToolContext {
  if (!context || typeof context !== "object") return false;
  const candidate = context as Partial<MastraToolContext>;
  return typeof candidate.userId === "string" && candidate.userId.trim().length > 0
    && typeof candidate.instanceId === "string" && candidate.instanceId.trim().length > 0;
}

export function checkToolScope(toolName: string, context: unknown): ScopeGuardDecision {
  if (!isCompleteToolContext(context)) {
    return { allowed: false, reason: "service tool context is missing userId or instanceId" };
  }
  if (!(toolName in SERVICE_TOOL_CLASSIFICATION)) {
    return { allowed: false, reason: `unclassified service tool rejected: ${toolName}` };
  }
  const allowed = resolveAllowedTools(context);
  if (allowed === undefined || allowed.has(toolName)) return { allowed: true };
  const task = context.taskType;
  return {
    allowed: false,
    reason: `tool ${toolName} (${classifyServiceTool(toolName)}) is not authorized${task ? ` for ${task}` : " by the current allowlist"}`,
  };
}

export function scopeDeniedResult(toolName: string, reason: string): Record<string, unknown> {
  return { ok: false, error: "scope_denied", tool: toolName, message: reason };
}
