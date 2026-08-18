import { logger } from "../lib/logger.js";
import { buildExternalRegistrations, isExternalRegistrationActivated } from "../mcp/external-mcp-registrations.js";
import { recordObservedExternalToolCall } from "../services/external-mcp-observer.js";

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

/** Test hook: clear shared connections. */
export function __resetExternalMcpConnectionsForTest(): void {
  for (const connection of connections.values()) void connection.disconnect().catch(() => undefined);
  connections.clear();
  inflight.clear();
}

export interface ExternalToolCallObserverScope {
  userId: string;
  projectId: string;
  instanceId: string;
  conversationId?: string;
  runId?: string;
}

/**
 * Wrap every tool in the shared toolsets with a `external_mcp_tool_calls`
 * recorder. The old HTTP-observer path died with the ACP runtime; this
 * restores the audit evidence at the W4 shared-connection choke point.
 * Recording failures must never affect the tool call itself.
 */
export function withExternalToolCallObserver(
  toolsets: Record<string, unknown>,
  scope: ExternalToolCallObserverScope,
): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {};
  for (const [serverId, toolset] of Object.entries(toolsets)) {
    wrapped[serverId] = wrapObservableToolset(String(serverId), toolset, scope);
  }
  return wrapped;
}

function serializedLength(value: unknown): number | undefined {
  try {
    return JSON.stringify(value)?.length;
  } catch {
    return undefined;
  }
}

function isToolLike(tool: unknown): tool is { execute: (...args: unknown[]) => Promise<unknown> } {
  return Boolean(tool) && typeof tool === "object" && typeof (tool as { execute?: unknown }).execute === "function";
}

/**
 * `MCPClient.listToolsets()` returns Record<serverId, Record<toolName, Tool>>;
 * a legacy `{ tools: {...} }` shape is still tolerated. Tool copies keep the
 * original prototype so instanceof checks survive.
 */
function wrapObservableToolset(serverId: string, toolset: unknown, scope: ExternalToolCallObserverScope): unknown {
  if (!toolset || typeof toolset !== "object") return toolset;
  const container = toolset as { tools?: unknown };
  const tools = container.tools && typeof container.tools === "object" ? container.tools : toolset;
  const wrappedTools: Record<string, unknown> = {};
  let wrappedAny = false;
  for (const [toolName, tool] of Object.entries(tools as Record<string, unknown>)) {
    if (isToolLike(tool)) {
      wrappedTools[toolName] = wrapObservableTool(serverId, String(toolName), tool, scope);
      wrappedAny = true;
    } else {
      wrappedTools[toolName] = tool;
    }
  }
  if (!wrappedAny) return toolset;
  if (tools === toolset) return wrappedTools;
  return { ...(toolset as Record<string, unknown>), tools: wrappedTools };
}

function wrapObservableTool(
  serverId: string,
  toolName: string,
  tool: { execute: (...args: unknown[]) => Promise<unknown> } & object,
  scope: ExternalToolCallObserverScope,
): unknown {
  const originalExecute = tool.execute;
  const wrappedExecute = async function (...args: unknown[]) {
    const startedAt = Date.now();
    let status: "completed" | "failed" = "completed";
    let errorClass: string | undefined;
    let outputChars: number | undefined;
    try {
      const result = await originalExecute.apply(tool, args);
      outputChars = serializedLength(result);
      return result;
    } catch (error) {
      status = "failed";
      errorClass = error instanceof Error ? error.name : typeof error;
      throw error;
    } finally {
      try {
        void recordObservedExternalToolCall({
          scope,
          serverId,
          toolName,
          status,
          elapsedMs: Date.now() - startedAt,
          inputChars: serializedLength(args[0]),
          outputChars,
          errorClass,
        }).catch(() => undefined);
      } catch {
        // Observability must not break the tool call.
      }
    }
  };
  const copy = Object.create(Object.getPrototypeOf(tool), Object.getOwnPropertyDescriptors(tool)) as Record<string, unknown>;
  Object.defineProperty(copy, "execute", { value: wrappedExecute, writable: true, configurable: true, enumerable: true });
  return copy;
}
