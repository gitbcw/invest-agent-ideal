import { defaultInstanceIdForUser, type UserContext } from "../lib/user-context.js";
import type { ToolLike } from "../mastra/tool-discovery.js";
import { readFullToolResultOffload } from "../mastra/tool-result-offload.js";

type AssetRecord = Record<string, unknown>;

export interface ScreeningPreparationInput {
  userText: string;
  userContext: UserContext;
  projection: { holdings?: unknown; watchlist?: unknown; stockPlans?: unknown };
  externalToolsets: Record<string, unknown>;
}

/** 预取消费方的 offload 信封解包 scope（与 agent.ts 观察者 scope 同口径）。 */
function offloadScopeFor(userContext: UserContext) {
  return {
    userId: userContext.userId,
    projectId: userContext.projectId ?? "invest-agent",
    instanceId: userContext.instanceId ?? defaultInstanceIdForUser(userContext.userId),
  };
}

export interface ScreeningPreparationResult {
  enabled: boolean;
  prompt: string;
  stockCodes: string[];
  etfCodes: string[];
  toolCalls: string[];
}

const PREPARED_MARKET_TOOL_NAMES = new Set([
  "get_hist_kline",
  "get_hist_klines",
  "get_realtime_quote",
  "get_volume_ma",
  "get_volume_mas",
]);

export function hidePreparedMarketTools(
  toolsets: Record<string, unknown>,
  preparation: ScreeningPreparationResult,
): Record<string, unknown> {
  if (!preparation.enabled || preparation.toolCalls.length === 0) return toolsets;
  const marketData = toolsets["market-data-tool"];
  if (!marketData || typeof marketData !== "object") return toolsets;
  return {
    ...toolsets,
    "market-data-tool": Object.fromEntries(
      Object.entries(marketData as Record<string, unknown>)
        .filter(([name]) => !PREPARED_MARKET_TOOL_NAMES.has(name)),
    ),
  };
}

const FULL_SCOPE_PATTERN = /(全持仓|全部持仓|所有持仓|持仓.*筛选|持仓.*复盘|组合.*筛选|组合.*复盘)/;

export function isFullScopeScreeningRequest(text: string): boolean {
  return FULL_SCOPE_PATTERN.test(text);
}

function records(value: unknown): AssetRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is AssetRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function codeOf(record: AssetRecord): string | undefined {
  const value = record.code ?? record.symbol ?? record.stockCode ?? record.stock_code;
  const code = typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
  return /^\d{6}$/.test(code) ? code : undefined;
}

function isEtfCode(code: string): boolean {
  return /^(15|16|51|56|58)\d{4}$/.test(code);
}

function parseToolText(value: unknown, offloadScope: { userId: string; projectId: string; instanceId: string }): unknown {
  const text = (value as { content?: Array<{ type?: string; text?: string }> } | null)?.content
    ?.find((item) => item.type === "text")?.text;
  const parsed = text ? safeJsonParse(text) ?? { text: text.slice(0, 4000) } : value;
  // 预取通道消费的是观察者包装后的工具：超预算结果已是「预览 + result_ref」
  // 信封（content 文本形态或 structuredContent 普通对象形态）。预取是服务端
  // 程序化消费，从暂存库解包全文（scope 同口径校验）。
  const envelope = parsed as { status?: string; result_ref?: string } | null;
  if (envelope && typeof envelope === "object" && envelope.status === "data_truncated_preview" && typeof envelope.result_ref === "string") {
    const full = readFullToolResultOffload(offloadScope, envelope.result_ref);
    if (typeof full === "string") return safeJsonParse(full) ?? { text: full.slice(0, 4000) };
  }
  return parsed;
}

function safeJsonParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

function compactMarketResult(value: unknown, offloadScope: { userId: string; projectId: string; instanceId: string }): Record<string, unknown> {
  const parsed = parseToolText(value, offloadScope);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { result: parsed };
  const record = parsed as Record<string, unknown>;
  const rows = Array.isArray(record.rows) ? record.rows : [];
  const columns = Array.isArray(record.columns) ? record.columns : undefined;
  // Keep enough history for 25/60-day reasoning without injecting the full raw
  // payload into the model context. The original call remains fully audited.
  const bySymbol = new Map<string, unknown[]>();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const symbolIndex = columns?.findIndex((column) => column === "代码" || column === "symbol" || column === "code") ?? 0;
    const symbol = typeof row[symbolIndex] === "string" ? row[symbolIndex] : "unknown";
    const list = bySymbol.get(symbol) ?? [];
    if (list.length < 70) list.push(row);
    bySymbol.set(symbol, list);
  }
  return {
    columns,
    rowsBySymbol: Object.fromEntries(bySymbol.entries()),
    meta: record.meta ?? {},
  };
}

function findTool(toolsets: Record<string, unknown>, serverId: string, name: string): ToolLike | undefined {
  const server = toolsets[serverId];
  if (!server || typeof server !== "object") return undefined;
  const candidate = (server as Record<string, unknown>)[name];
  return candidate && typeof candidate === "object" && typeof (candidate as { execute?: unknown }).execute === "function"
    ? candidate as ToolLike
    : undefined;
}

function mountedCapabilitySummary(toolsets: Record<string, unknown>): string[] {
  return Object.entries(toolsets).flatMap(([serverId, tools]) => {
    if (!tools || typeof tools !== "object") return [`${serverId}: (已挂载但无可见工具)`];
    const names = Object.keys(tools as Record<string, unknown>).sort();
    return [`${serverId}: ${names.length > 0 ? names.join(", ") : "(已挂载但无可见工具)"}`];
  }).sort();
}

async function executeTool(tool: ToolLike, input: Record<string, unknown>): Promise<unknown> {
  return tool.execute(input as never);
}

export async function preparePortfolioScreening(input: ScreeningPreparationInput): Promise<ScreeningPreparationResult> {
  if (!isFullScopeScreeningRequest(input.userText)) {
    return { enabled: false, prompt: "", stockCodes: [], etfCodes: [], toolCalls: [] };
  }

  const all = [
    ...records(input.projection.holdings),
    ...records(input.projection.watchlist),
    ...records(input.projection.stockPlans),
  ];
  const codes = [...new Set(all.map(codeOf).filter((code): code is string => Boolean(code)))];
  const stockCodes = codes.filter((code) => !isEtfCode(code));
  const etfCodes = codes.filter(isEtfCode);
  const marketData = input.externalToolsets["market-data-tool"];
  const offloadScope = offloadScopeFor(input.userContext);
  const toolCalls: string[] = [];
  const evidence: Record<string, unknown> = {
    scope: { stockCodes, etfCodes },
    policy: "股票统一批量取数；ETF 不进入股票批量工具；程序只准备事实，Agent 负责判断",
    gaps: [] as string[],
  };

  const batch = findTool(input.externalToolsets, "market-data-tool", "get_hist_klines");
  if (stockCodes.length > 0 && batch) {
    const result = await executeTool(batch, { symbols: stockCodes, period: "day", limit: 120, adjust: "qfq" });
    evidence.stockHistory = compactMarketResult(result, offloadScope);
    toolCalls.push("market-data-tool.get_hist_klines");
  } else if (stockCodes.length > 0) {
    (evidence.gaps as string[]).push("股票批量历史工具不可用，未预取股票 K 线");
  }

  const quote = findTool(input.externalToolsets, "market-data-tool", "get_realtime_quote");
  if (etfCodes.length > 0 && quote) {
    const result = await executeTool(quote, { symbols: etfCodes });
    evidence.etfQuotes = compactMarketResult(result, offloadScope);
    (evidence.gaps as string[]).push("ETF 本轮仅预取实时快照，未假设存在股票批量历史 K 线");
    toolCalls.push("market-data-tool.get_realtime_quote");
  } else if (etfCodes.length > 0) {
    (evidence.gaps as string[]).push("ETF 实时行情工具不可用");
  }

  evidence.gaps = [...new Set(evidence.gaps as string[])];
  const mounted = mountedCapabilitySummary(input.externalToolsets);
  const expectedMarketTools = [
    "market-data-tool.get_hist_klines",
    "market-data-tool.get_realtime_quote",
  ];
  const unavailable = expectedMarketTools.filter((name) => {
    const [serverId, toolName] = name.split(".");
    return !findTool(input.externalToolsets, serverId, toolName);
  });
  return {
    enabled: true,
    prompt: [
      "【程序预取·全持仓筛选数据包】",
      `本轮已挂载能力（运行时清单）：${mounted.length > 0 ? mounted.join("；") : "无外部/扩展工具，仅有基础服务读取能力"}`,
      `本轮程序实际调用：${toolCalls.length > 0 ? toolCalls.join("、") : "无行情预取调用"}`,
      `本轮未挂载而无法验证：${unavailable.length > 0 ? unavailable.join("、") : "无"}`,
      "以下数据由程序按资产类型预取并保留来源/时点/缺口；不要重复请求相同股票历史窗口。",
      "程序只准备事实，不替你决定关注、准备行动或暂不处理；请基于证据包进行判断，数据缺口只影响受影响子结论。",
      "本轮用户未请求文件交付时，不要生成或发布表格制品；只在对话中返回结果。",
      JSON.stringify(evidence),
    ].join("\n"),
    stockCodes,
    etfCodes,
    toolCalls,
  };
}
