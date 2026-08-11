import type { UserContext } from "../lib/user-context.js";

export type ExecutionBackend = "acp" | "mastra";

export interface BackendSelection {
  backend: ExecutionBackend;
  reason: "default-acp" | "mastra-enabled-internal" | "mastra-not-enabled" | "mastra-allowlist-required" | "mastra-user-not-allowlisted";
}

function csv(env: NodeJS.ProcessEnv, name: string): Set<string> {
  return new Set((env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean));
}

/**
 * Resolve the execution kernel from server/instance policy only. User message
 * fields are deliberately absent from this API. Production remains ACP unless
 * an operator explicitly enables Mastra and names an internal user.
 */
export function selectExecutionBackend(
  context: Pick<UserContext, "userId" | "instanceId">,
  env: NodeJS.ProcessEnv = process.env,
): BackendSelection {
  if (env.INVEST_AGENT_MASTRA_ENABLED !== "true") {
    return { backend: "acp", reason: "default-acp" };
  }
  const users = csv(env, "INVEST_AGENT_MASTRA_INTERNAL_USERS");
  const instances = csv(env, "INVEST_AGENT_MASTRA_INTERNAL_INSTANCES");
  if (users.size === 0 && instances.size === 0) {
    return { backend: "acp", reason: "mastra-allowlist-required" };
  }
  if ((users.size === 0 || users.has(context.userId)) && (instances.size === 0 || instances.has(context.instanceId ?? ""))) {
    return { backend: "mastra", reason: "mastra-enabled-internal" };
  }
  return { backend: "acp", reason: "mastra-user-not-allowlisted" };
}

export function mastraBackendEnabledForTests(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "test" && env.INVEST_AGENT_MASTRA_ENABLED === "true";
}
