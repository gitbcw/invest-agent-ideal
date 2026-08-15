/**
 * 服务端确定性流程的 market-data MCP 消费端 (规则巡检取价/取K线)。
 *
 * Agent 会话经 resolveExternalMastraToolsets 接同一个 MCP；本模块供
 * patrol/alert-check 等无 Agent 的服务流程直连:纯 fetch + JSON-RPC
 * streamable HTTP,不依赖 agent 运行时内部结构。URL 与 Token 只从 env
 * 读取,不进日志;所有失败以 MarketDataMcpError 降级,由调用方决定
 * usable=false 等表现形式,绝不抛进巡检主循环。
 */

export type MarketDataMcpErrorCode =
  | "MARKET_DATA_MCP_NOT_CONFIGURED"
  | "MARKET_DATA_MCP_UNAVAILABLE"
  | "MARKET_DATA_MCP_TOOL_ERROR"
  | "MARKET_DATA_MCP_BAD_PAYLOAD";

export class MarketDataMcpError extends Error {
  constructor(readonly code: MarketDataMcpErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "MarketDataMcpError";
  }
}

export interface McpTableResult {
  columns: string[];
  rows: unknown[][];
  meta: Record<string, unknown>;
}

export interface McpRealtimeQuote {
  code: string;
  name: string | null;
  price: number | null;
  asOf: string | null;
  provider: string | null;
  status: string | null;
  changePercent: number | null;
  prevClose: number | null;
}

export interface McpDailyKline {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

type FetchLike = typeof fetch;

interface McpClientDeps {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

let activeFetch: FetchLike | null = null;
/** 测试注入点:替换底层 fetch。传 null 恢复全局 fetch。 */
export function setMarketDataFetchForTests(fetchImpl: FetchLike | null): void {
  activeFetch = fetchImpl;
  session = null;
}

let session: { id: string; url: string } | null = null;

function clientConfig(env: NodeJS.ProcessEnv): { url: string; token: string } {
  const url = (env.MARKET_DATA_MCP_URL || "").trim();
  const token = (env.MARKET_DATA_MCP_TOKEN || "").trim();
  if (!url || !token) {
    throw new MarketDataMcpError("MARKET_DATA_MCP_NOT_CONFIGURED", "MARKET_DATA_MCP_URL/TOKEN 未配置");
  }
  return { url: `${url.replace(/\/+$/, "")}`, token };
}

function parseRpcPayload(body: string, contentType: string): Record<string, unknown> {
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        return JSON.parse(data) as Record<string, unknown>;
      } catch {
        // 跳过非 JSON 的 SSE 注释/心跳行
      }
    }
    throw new MarketDataMcpError("MARKET_DATA_MCP_BAD_PAYLOAD", "SSE 流中没有 JSON-RPC 数据帧");
  }
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new MarketDataMcpError("MARKET_DATA_MCP_BAD_PAYLOAD", `非 JSON 响应: ${body.slice(0, 120)}`);
  }
}

async function rpc(
  method: string,
  payload: Record<string, unknown> | null,
  config: { url: string; token: string },
  options: { notification?: boolean; sessionId?: string } = {},
): Promise<Record<string, unknown> | null> {
  const doFetch = activeFetch ?? fetch;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${config.token}`,
  };
  if (options.sessionId) headers["Mcp-Session-Id"] = options.sessionId;
  const body = payload === null
    ? { jsonrpc: "2.0", method }
    : { jsonrpc: "2.0", id: Date.now() % 2_000_000_000, method, params: payload };
  const response = await doFetch(config.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new MarketDataMcpError(
      response.status === 401 || response.status === 403 ? "MARKET_DATA_MCP_UNAVAILABLE" : "MARKET_DATA_MCP_TOOL_ERROR",
      `HTTP ${response.status}`,
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const newSessionId = response.headers.get("mcp-session-id");
  if (newSessionId) session = { id: newSessionId, url: config.url };
  if (options.notification || !text.trim()) return null;
  const message = parseRpcPayload(text, contentType);
  if (message.error) {
    throw new MarketDataMcpError("MARKET_DATA_MCP_TOOL_ERROR", String((message.error as Record<string, unknown>).message ?? "unknown"));
  }
  return (message.result ?? {}) as Record<string, unknown>;
}

async function ensureSession(config: { url: string; token: string }): Promise<string> {
  if (session && session.url === config.url) return session.id;
  await rpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "invest-agent-service-flows", version: "1.0.0" },
  }, config);
  await rpc("notifications/initialized", null, config, { notification: true, sessionId: session?.id });
  if (!session) {
    throw new MarketDataMcpError("MARKET_DATA_MCP_BAD_PAYLOAD", "initialize 未返回会话 id");
  }
  return session.id;
}

function parseToolTable(result: Record<string, unknown>): McpTableResult {
  // 优先 structuredContent,兼容 content[0].text 内嵌 JSON 两种 MCP 返回形态。
  const candidates: unknown[] = [result.structuredContent];
  const content = result.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text") {
        const text = (part as Record<string, unknown>).text;
        if (typeof text === "string") {
          try { candidates.push(JSON.parse(text)); } catch { /* 非 JSON 文本,跳过 */ }
        }
      }
    }
  }
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && Array.isArray((candidate as McpTableResult).columns)
      && Array.isArray((candidate as McpTableResult).rows)) {
      const table = candidate as McpTableResult;
      return { columns: table.columns, rows: table.rows, meta: (table.meta ?? {}) as Record<string, unknown> };
    }
  }
  throw new MarketDataMcpError("MARKET_DATA_MCP_BAD_PAYLOAD", "工具结果不是 columns/rows 表");
}

export async function callMarketDataTool(
  toolName: string,
  args: Record<string, unknown>,
  deps: McpClientDeps = {},
): Promise<McpTableResult> {
  const config = clientConfig(deps.env ?? process.env);
  const sessionId = await ensureSession(config);
  try {
    const result = await rpc("tools/call", { name: toolName, arguments: args }, config, { sessionId });
    return parseToolTable(result ?? {});
  } catch (error) {
    // 会话过期(FastMCP 对失效 session 返回 404/400):重建一次再试。
    if (error instanceof MarketDataMcpError && (error.message.includes("HTTP 404") || error.message.includes("HTTP 400"))) {
      session = null;
      const freshSession = await ensureSession(config);
      const retry = await rpc("tools/call", { name: toolName, arguments: args }, config, { sessionId: freshSession });
      return parseToolTable(retry ?? {});
    }
    throw error;
  }
}

function columnIndex(columns: string[], name: string): number {
  return columns.indexOf(name);
}

function cell(row: unknown[], columns: string[], name: string): unknown {
  const idx = columnIndex(columns, name);
  return idx >= 0 ? row[idx] : undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function mcpRealtimeQuotes(
  codes: string[],
  deps: McpClientDeps = {},
): Promise<Map<string, McpRealtimeQuote>> {
  const table = await callMarketDataTool("get_realtime_quote", { symbols: codes }, deps);
  const quotes = new Map<string, McpRealtimeQuote>();
  for (const row of table.rows) {
    const code = String(cell(row, table.columns, "代码") ?? "");
    if (!/^\d{6}$/.test(code)) continue;
    quotes.set(code, {
      code,
      name: typeof cell(row, table.columns, "名称") === "string" ? String(cell(row, table.columns, "名称")) : null,
      price: finiteNumber(cell(row, table.columns, "最新价")),
      asOf: typeof cell(row, table.columns, "数据日期") === "string" ? String(cell(row, table.columns, "数据日期")) : null,
      provider: typeof cell(row, table.columns, "数据源") === "string" ? String(cell(row, table.columns, "数据源")) : null,
      status: typeof cell(row, table.columns, "交易状态") === "string" ? String(cell(row, table.columns, "交易状态")) : null,
      changePercent: finiteNumber(cell(row, table.columns, "涨跌幅")),
      prevClose: finiteNumber(cell(row, table.columns, "昨收")),
    });
  }
  return quotes;
}

export async function mcpDailyKlines(
  code: string,
  count: number,
  deps: McpClientDeps = {},
): Promise<{ items: McpDailyKline[]; provider: string | null; fetchedAt: string | null }> {
  const table = await callMarketDataTool("get_hist_kline", { symbol: code, period: "day", limit: count }, deps);
  const items: McpDailyKline[] = [];
  for (const row of table.rows) {
    const close = finiteNumber(cell(row, table.columns, "收盘"));
    const date = cell(row, table.columns, "日期");
    if (close === null || typeof date !== "string") continue;
    items.push({
      date,
      open: finiteNumber(cell(row, table.columns, "开盘")) ?? close,
      close,
      high: finiteNumber(cell(row, table.columns, "最高")) ?? close,
      low: finiteNumber(cell(row, table.columns, "最低")) ?? close,
      volume: finiteNumber(cell(row, table.columns, "成交量")) ?? 0,
    });
  }
  const meta = table.meta ?? {};
  return {
    items,
    provider: typeof meta.source === "string" ? meta.source : null,
    fetchedAt: typeof meta.fetched_at === "string" ? meta.fetched_at : null,
  };
}
