import { getQuote, formatQuoteSummary, searchStock } from "../services/stock.js";
import { resolveStockRefs, type StockRef } from "../services/stock-resolver.js";
import { analyzeIndicators, formatIndicatorReport } from "../services/indicators.js";
import { getKline } from "../services/stock.js";
import { logger } from "../lib/logger.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_USER_ID, type UserContext } from "../lib/user-context.js";
import { watchlistBackend } from "../lib/data-backend.js";

/** 解析自选股操作 */
function parseAction(message: string): {
  action: string;
  code?: string;
  reason?: string;
  source?: string;
} {
  const addMatch = message.match(/(?:加入自选|加自选|关注)\s*(\d{6})(?:\s*(.*))?/);
  if (addMatch) {
    const tail = (addMatch[2] ?? "").trim();
    return {
      action: "add",
      code: addMatch[1],
      reason: tail || undefined,
      source: detectSource(tail),
    };
  }

  const removeMatch = message.match(/(?:移除|删除|取消关注)\s*(\d{6})/);
  if (removeMatch) return { action: "remove", code: removeMatch[1] };

  // "自选 XXX" 查看某只自选股详情
  const detailMatch = message.match(/自选\s*(\d{6})/);
  if (detailMatch) return { action: "detail", code: detailMatch[1] };

  if (message.includes("自选") && (message.includes("列表") || message.includes("看看"))) {
    return { action: "list" };
  }

  return { action: "list" };
}

export async function handleWatchlist(message: string, ctx: UserContext = { userId: DEFAULT_USER_ID }): Promise<string> {
  const { action, code, reason, source } = parseAction(message);
  const instanceId = ctx.instanceId ?? DEFAULT_INSTANCE_ID;

  switch (action) {
    case "add":
      return addToWatchlist(ctx.userId, instanceId, code!, reason, source);
    case "remove":
      return removeFromWatchlist(ctx.userId, instanceId, code!);
    case "detail":
      return watchlistDetail(ctx.userId, instanceId, code!);
    case "list":
    default:
      return listWatchlist(ctx.userId, instanceId);
  }
}

export async function handleWatchlistTool(input: {
  operation: "add" | "remove" | "query";
  stocks?: StockRef[];
  reason?: string;
}, ctx: UserContext = { userId: DEFAULT_USER_ID }): Promise<string> {
  const instanceId = ctx.instanceId ?? DEFAULT_INSTANCE_ID;
  if (input.operation === "query") return listWatchlist(ctx.userId, instanceId);

  const refs = input.stocks ?? [];
  if (refs.length === 0) {
    return "我可以维护自选池,但还需要知道具体股票。\n例如:把阳光电源和宁德时代加入自选";
  }

  const resolved = input.operation === "remove"
    ? await resolveExistingWatchlistRefs(ctx.userId, instanceId, refs)
    : await resolveStockRefs(refs);
  if (resolved.unresolved.length > 0 && resolved.codes.length === 0) {
    return [
      "我理解你想维护自选池,但有些股票还没确认到代码:",
      resolved.unresolved.map((item) => `- ${item.name || item.code}`).join("\n"),
      "你可以补一句更明确的名称或代码。",
    ].join("\n");
  }

  const results: string[] = [];
  for (const code of resolved.codes) {
    results.push(
      input.operation === "remove"
        ? await removeFromWatchlist(ctx.userId, instanceId, code)
        : await addToWatchlist(ctx.userId, instanceId, code, input.reason ?? "AI 助手根据对话加入", "ai_conversation")
    );
  }
  if (resolved.unresolved.length > 0) {
    results.push(
      [
        "还有这些没确认到代码,暂时没处理:",
        resolved.unresolved.map((item) => `- ${item.name || item.code}`).join("\n"),
      ].join("\n")
    );
  }
  if (input.operation === "add") {
    const added = results.filter((line) => line.startsWith("已加入自选:")).map((line) => line.replace(/^已加入自选:/, ""));
    const existing = results.filter((line) => line.includes("已在自选"));
    const other = results.filter((line) => !line.startsWith("已加入自选:") && !line.includes("已在自选"));
    const lines: string[] = [];
    if (added.length > 0) lines.push("已加入自选:", ...added.map((item) => `- ${item}`));
    if (existing.length > 0) lines.push(...existing);
    if (other.length > 0) lines.push(...other);
    return lines.join("\n");
  }
  return results.join("\n");
}

async function resolveExistingWatchlistRefs(userId: string, instanceId: string, refs: StockRef[]): Promise<{ codes: string[]; unresolved: StockRef[] }> {
  const items = await watchlistBackend.list(userId, instanceId);
  const codes: string[] = [];
  const unresolved: StockRef[] = [];

  for (const ref of refs) {
    const rawName = normalizeStockName(ref.name);
    const rawCode = ref.code?.trim();
    const matched = items.find((item) => {
      const itemName = normalizeStockName(item.name);
      return (
        (rawCode && item.code === rawCode) ||
        (rawName && (itemName === rawName || itemName.includes(rawName) || rawName.includes(itemName)))
      );
    });
    if (matched) {
      if (!codes.includes(matched.code)) codes.push(matched.code);
    } else {
      unresolved.push(ref);
    }
  }

  return { codes, unresolved };
}

function detectSource(text: string): string {
  if (text.includes("选股") || text.includes("报告") || text.includes("候选")) {
    return "screening_report";
  }
  if (text.includes("截图")) return "screenshot";
  return "manual";
}

function normalizeWatchlistReason(reason?: string) {
  return (reason || "实验版手动加入,待补充关注理由").replace(/观察池/g, "自选池").trim();
}

function normalizeStockName(name?: string | null) {
  return (name || "")
    .replace(/([一-龥])\s+(?=[一-龥])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

async function addToWatchlist(userId: string, instanceId: string, code: string, reason?: string, source = "manual"): Promise<string> {
  const normalizedReason = normalizeWatchlistReason(reason);
  const existing = await watchlistBackend.find(userId, instanceId, code);

  if (existing) {
    if (reason && !existing.reason) {
      await watchlistBackend.patch(userId, instanceId, code, {
        reason: normalizedReason,
        source,
      });
      return `${normalizeStockName(existing.name)}(${code}) 已在自选列表中,已补充关注理由`;
    }
    return `${normalizeStockName(existing.name)}(${code}) 已在自选列表中`;
  }

  // 查股票名称
  const quotes = await getQuote([code]);
  const name = quotes[0]?.name;

  if (!name) {
    // 尝试搜索
    const results = await searchStock(code);
    if (results.length === 0) {
      return `未找到股票代码 ${code},请确认代码是否正确`;
    }
  }

  const finalName = normalizeStockName(name) || code;
  await watchlistBackend.add(userId, instanceId, {
    code,
    name: finalName,
    reason: normalizedReason,
    source,
  });

  logger.info(`加入自选: ${finalName}(${code})`);
  return `已加入自选:${finalName}(${code})`;
}

async function removeFromWatchlist(userId: string, instanceId: string, code: string): Promise<string> {
  const existing = await watchlistBackend.find(userId, instanceId, code);
  if (!existing) {
    return `${code} 不在自选列表中`;
  }

  await watchlistBackend.remove(userId, instanceId, code);
  return `已移除自选:${normalizeStockName(existing.name)}(${code})`;
}

async function watchlistDetail(userId: string, instanceId: string, code: string): Promise<string> {
  const existing = await watchlistBackend.find(userId, instanceId, code);

  if (!existing) {
    return `${code} 不在自选列表中,先加入:加入自选 ${code}`;
  }

  // 获取实时行情 + 技术指标
  const [quotes, klines] = await Promise.all([getQuote([code]), getKline(code, 120)]);
  const quote = quotes[0];
  const indicator = klines.length > 30 ? analyzeIndicators(klines) : null;

  const lines = [`${normalizeStockName(existing.name)}(${code}) 详情\n`];
  if (quote) {
    lines.push(formatQuoteSummary(quote));
  }
  if (indicator) {
    lines.push("", formatIndicatorReport(indicator));
  }

  return lines.join("\n");
}

async function listWatchlist(userId: string, instanceId: string): Promise<string> {
  const items = await watchlistBackend.list(userId, instanceId);

  if (items.length === 0) {
    return "自选列表为空。\n使用「加入自选 000001」添加股票";
  }

  // 批量获取行情
  const codes = items.map((w) => w.code);
  const quotes = await getQuote(codes);
  const quoteMap = new Map(quotes.map((q) => [q.code, q]));

  const lines = [`自选股共 ${items.length} 只:`];
  for (const item of items) {
    const quote = quoteMap.get(item.code);
    const displayName = normalizeStockName(quote?.name || item.name);
    if (displayName && displayName !== item.name) {
      await watchlistBackend.patch(userId, instanceId, item.code, { name: displayName });
    }
    if (quote) {
      const change = `${quote.changePercent >= 0 ? "+" : ""}${quote.changePercent}%`;
      lines.push(`- ${displayName}(${item.code}):${quote.price},${change}`);
    } else {
      lines.push(`- ${displayName}(${item.code}),行情暂缺`);
    }
  }

  return lines.join("\n");
}
