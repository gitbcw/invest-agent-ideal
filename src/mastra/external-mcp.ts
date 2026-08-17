import { logger } from "../lib/logger.js";
import { buildExternalRegistrations, isExternalRegistrationActivated } from "../mcp/external-mcp-registrations.js";

export interface ResolvedExternalMcp {
  id: string;
  url: string;
  headers: Record<string, string>;
  sessionKinds: readonly string[];
}

/**
 * W4（docs/open-work-items.md）：行情/数据源 MCP 的连接韧性。
 *
 * 回放实测（2026-08-17）：此前每轮对话新建一次 MCP 连接、用完即断，
 * market-data-tool 的 3s 连接抖动会直接判死整轮。本模块改为：
 * - 进程级共享连接（按 sessionKind 缓存），调用方的 disconnect 变为 no-op；
 * - 连接建立带 3 次指数退避重试（500ms/1.5s/4s）；
 * - 全部重试失败时降级返回空 toolsets 并告警——轮次继续（Agent 以
 *   「数据不可用」作答），而不是整轮失败；
 * - 连接超过 TTL 后择机换新（新旧蓝绿：新连接建成前不断旧的）。
 */

const CONNECT_ATTEMPTS = 3;
const CONNECT_BACKOFF_MS = [500, 1_500, 4_000];
const CONNECTION_TTL_MS = 10 * 60 * 1000;

interface SharedConnection {
  toolsets: Record<string, unknown>;
  disconnect: () => Promise<void>;
  connectedAt: number;
}

const connections = new Map<string, SharedConnection>();
const inflight = new Map<string, Promise<SharedConnection | null>>();

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectWithRetry(servers: ResolvedExternalMcp[]): Promise<SharedConnection | null> {
  const { MCPClient } = await import("@mastra/mcp");
  let lastError: unknown;
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
    const client = new MCPClient({
      id: `invest-agent-mastra-${servers.map((server) => server.id).join("+")}-${Date.now()}`,
      servers: Object.fromEntries(servers.map((server) => [server.id, {
        url: new URL(server.url),
        requestInit: { headers: server.headers },
      }])),
      timeout: 30_000,
    });
    try {
      const toolsets = await client.listToolsets();
      return { toolsets: toolsets as Record<string, unknown>, disconnect: () => client.disconnect(), connectedAt: Date.now() };
    } catch (error) {
      lastError = error;
      if (attempt < CONNECT_ATTEMPTS) {
        const backoff = CONNECT_BACKOFF_MS[Math.min(attempt - 1, CONNECT_BACKOFF_MS.length - 1)];
        logger.warn(`外部 MCP 连接失败（第 ${attempt}/${CONNECT_ATTEMPTS} 次，${backoff}ms 后重试）: ${(error as Error).message}`);
        await sleep(backoff);
      }
    }
  }
  logger.error(`外部 MCP 连接在 ${CONNECT_ATTEMPTS} 次重试后仍失败，本轮降级为无数据源工具: ${(lastError as Error)?.message ?? lastError}`);
  return null;
}

async function ensureConnection(sessionKind: string, servers: ResolvedExternalMcp[]): Promise<SharedConnection | null> {
  const cached = connections.get(sessionKind);
  if (cached && Date.now() - cached.connectedAt < CONNECTION_TTL_MS) return cached;
  const pending = inflight.get(sessionKind);
  if (pending) return pending;
  const promise = (async () => {
    const next = await connectWithRetry(servers);
    if (next) {
      const previous = connections.get(sessionKind);
      connections.set(sessionKind, next);
      if (previous) await previous.disconnect().catch(() => undefined);
      return next;
    }
    // 新连接失败：旧的仍在 TTL 外也继续用（聊胜于无），没有旧的才真正降级。
    return connections.get(sessionKind) ?? null;
  })().finally(() => inflight.delete(sessionKind));
  inflight.set(sessionKind, promise);
  return promise;
}

export async function resolveExternalMastraToolsets(
  sessionKind: "interactive" | "scheduled-read",
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ toolsets: Record<string, unknown>; disconnect: () => Promise<void> }> {
  const servers = listActivatedExternalMcps(env).filter((server) => server.sessionKinds.includes(sessionKind));
  if (servers.length === 0) return { toolsets: {}, disconnect: async () => undefined };
  const shared = await ensureConnection(sessionKind, servers);
  if (!shared) return { toolsets: {}, disconnect: async () => undefined };
  // 共享连接：调用方的 disconnect 是 no-op，连接生命周期归本模块管理。
  return { toolsets: shared.toolsets, disconnect: async () => undefined };
}

/** 测试钩子：清空共享连接。 */
export function __resetExternalMcpConnectionsForTest(): void {
  for (const connection of connections.values()) void connection.disconnect().catch(() => undefined);
  connections.clear();
  inflight.clear();
}
