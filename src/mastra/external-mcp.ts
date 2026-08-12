import { buildExternalRegistrations, isExternalRegistrationActivated } from "../mcp/external-mcp-registrations.js";

export interface ResolvedExternalMcp {
  id: string;
  url: string;
  headers: Record<string, string>;
  sessionKinds: readonly string[];
}

export function listActivatedExternalMcps(env: NodeJS.ProcessEnv = process.env): ResolvedExternalMcp[] {
  const resolved: ResolvedExternalMcp[] = [];
  for (const registration of buildExternalRegistrations()) {
    if (!isExternalRegistrationActivated(registration, env) || registration.transport.kind !== "http") continue;
    const url = registration.transport.url.replace(/^<env:([A-Za-z_][A-Za-z0-9_]*)>$/, (_, name: string) => env[name] ?? "").trim();
    if (!url || (registration.transport.requiredEnvRefs ?? []).some((name) => !env[name]?.trim())) continue;
    const headers: Record<string, string> = {};
    for (const header of registration.transport.headers ?? []) {
      const value = env[header.envRef]?.trim();
      if (value) headers[header.name] = `${header.prefix ?? ""}${value}`;
    }
    resolved.push({ id: registration.id, url, headers, sessionKinds: registration.sessionKinds });
  }
  return resolved;
}

export async function resolveExternalMastraToolsets(
  sessionKind: "interactive" | "scheduled-read",
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ toolsets: Record<string, unknown>; disconnect: () => Promise<void> }> {
  const servers = listActivatedExternalMcps(env).filter((server) => server.sessionKinds.includes(sessionKind));
  if (servers.length === 0) return { toolsets: {}, disconnect: async () => undefined };
  const { MCPClient } = await import("@mastra/mcp");
  const client = new MCPClient({
    id: `invest-agent-mastra-${sessionKind}-${Date.now()}`,
    servers: Object.fromEntries(servers.map((server) => [server.id, {
      url: new URL(server.url),
      requestInit: { headers: server.headers },
    }])),
    timeout: 30_000,
  });
  return { toolsets: await client.listToolsets(), disconnect: () => client.disconnect() };
}
