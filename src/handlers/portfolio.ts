import { callDeepSeek } from "../services/deepseek.js";
import { getQuote } from "../services/stock.js";
import { resolveStockRefs, resolveStockRefDetails, type StockRef } from "../services/stock-resolver.js";
import { logger } from "../lib/logger.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_USER_ID, type UserContext } from "../lib/user-context.js";
import { portfolioBackend, planBackend, type TradeActionRow } from "../lib/data-backend.js";

type PortfolioAction = "add" | "remove" | "query" | "unknown";
export type { StockRef };

interface ParsedPortfolioAction {
  action: PortfolioAction;
  codes?: string[];
  code?: string;
  costPrice?: number;
}

interface AiPortfolioPlan {
  action: "add" | "remove" | "query" | "unknown";
  stocks: StockRef[];
  note?: string;
}

const PORTFOLIO_AI_PROMPT = `你是投资助手的持有股票池理解器。
你的任务是从用户自然语言里提取"动作"、"股票标的"和"成本价(单价)"。

业务语义:
- 持仓/持有股票池表示用户当前关注的股票范围,用于盘中提醒和复盘。
- 系统存"每股成本价(单价)",用于浮亏/盈亏比计算;数量与总金额是隐私,不要求提供。

字段说明:
- costPrice: 用户提到的每股成本价(单价)。例如"70 块买的""成本 65.5""均价 38.2"→ 提取数字。
  没提到就不要编,留空(null/undefined)。负数或异常值视为没有。

动作枚举:
- add: 用户想新增或维护当前持有股票池。
- remove: 用户说不再持有、移除某些股票。
- query: 用户只是查看当前持仓。
- unknown: 其他。

只返回 JSON,不要 Markdown:
{"action":"add","stocks":[{"name":"赣锋锂业","costPrice":70},{"code":"600000","name":"浦发银行"}],"note":"可选说明"}`;

function parseAction(message: string): ParsedPortfolioAction {
  const codes = extractStockCodes(message);
  const costPrice = extractCostPrice(message);

  if (/不再持有|移除持仓|删除持仓|清仓|卖出/.test(message)) {
    return { action: "remove", codes, code: codes[0] };
  }

  if (codes.length > 0 && (/持有|持仓/.test(message))) {
    return { action: "add", codes, costPrice };
  }

  if (/持仓|仓位/.test(message)) {
    return { action: "query" };
  }

  return { action: "unknown" };
}

function extractCostPrice(message: string): number | undefined {
  const patterns = [
    /(?:成本价?|买入价|均价|成本|买入)\s*(?:大概|是|为)?\s*(\d+(?:\.\d+)?)/,
    /(\d+(?:\.\d+)?)\s*(?:块|元)\s*(?:买的|入手|买入|买进|成本)/,
  ];
  for (const pattern of patterns) {
    const matched = message.match(pattern)?.[1];
    if (matched) {
      const value = Number(matched);
      if (Number.isFinite(value) && value > 0 && value < 100000) return value;
    }
  }
  return undefined;
}

export async function handlePortfolio(message: string, ctx: UserContext = { userId: DEFAULT_USER_ID }): Promise<string> {
  const userId = ctx.userId;
  const instanceId = ctx.instanceId ?? DEFAULT_INSTANCE_ID;
  const parsed = parseAction(message);
  const aiFirst = shouldUseAiPortfolioPlan(parsed, message);
  if (aiFirst) {
    const aiResult = await tryHandlePortfolioWithAi(message, userId, instanceId);
    if (aiResult) return aiResult;
  }

  const { action, codes, code, costPrice } = parsed;

  switch (action) {
    case "add":
      if (codes && codes.length > 0) {
        const entries = codes.map((c) => ({ code: c, costPrice }));
        return setHoldingPool(userId, instanceId, entries);
      }
      return usageHint();
    case "remove":
      if (code) return closePosition(userId, instanceId, code);
      if (codes && codes.length > 0) return closePositions(userId, instanceId, codes);
      return usageHint();
    case "query":
      return queryPortfolio(userId, instanceId);
    default:
      return usageHint();
  }
}

export async function handlePortfolioTool(input: {
  operation: "add" | "remove" | "query";
  stocks?: StockRef[];
}, ctx: UserContext = { userId: DEFAULT_USER_ID }): Promise<string> {
  const userId = ctx.userId;
  const instanceId = ctx.instanceId ?? DEFAULT_INSTANCE_ID;
  if (input.operation === "query") return queryPortfolio(userId, instanceId);

  const refs = input.stocks ?? [];
  if (refs.length === 0) {
    return [
      "我可以维护你的持有股票池,但还需要知道具体股票。",
      "你可以说:我持有阳光电源和宁德时代",
    ].join("\n");
  }

  if (input.operation === "remove") {
    const resolved = await resolveStockRefs(refs);
    if (resolved.unresolved.length > 0) {
      return [
        "我理解你想维护持有股票池,但有些股票还没确认到代码:",
        resolved.unresolved.map((item) => `- ${item.name || item.code}`).join("\n"),
        "你可以补一句更明确的名称或代码。",
      ].join("\n");
    }
    return closePositions(userId, instanceId, resolved.codes);
  }

  const details = await resolveStockRefDetails(refs);
  if (details.unresolved.length > 0) {
    return [
      "我理解你想维护持有股票池,但有些股票还没确认到代码:",
      details.unresolved.map((item) => `- ${item.name || item.code}`).join("\n"),
      "你可以补一句更明确的名称或代码。",
    ].join("\n");
  }
  const entries = details.resolved.map((r) => ({
    code: r.code,
    costPrice: r.input.costPrice,
  }));
  return setHoldingPool(userId, instanceId, entries);
}

function usageHint(): string {
  return [
    "我可以维护你的持有股票池,记录股票和成本价(数量/金额不存)。",
    "示例:",
    "- 我持有 000001 和 600000",
    "- 我持有赣锋锂业 成本 70",
    "- 不再持有 000001",
    "- 查看我的持仓",
  ].join("\n");
}

function shouldUseAiPortfolioPlan(parsed: ParsedPortfolioAction, message: string): boolean {
  if (isPortfolioQueryMessage(message)) return false;
  if (parsed.codes && parsed.codes.length > 0 && parsed.action !== "unknown") return false;
  if (parsed.code && parsed.action !== "unknown") return false;
  return /持有|持仓|仓位|不再持有|移除持仓|删除持仓/.test(message) || parsed.action === "unknown";
}

function isPortfolioQueryMessage(message: string): boolean {
  const hasQueryWord = /我的持仓|当前持仓|查看|查询|列表|看看/.test(message);
  const hasMaintainWord = /更新|修改|调整|改成|改为|持有|不再持有|移除|删除/.test(message);
  return hasQueryWord && !hasMaintainWord;
}

async function tryHandlePortfolioWithAi(message: string, userId: string, instanceId: string): Promise<string | null> {
  const plan = await planPortfolioWithAi(message);
  if (!plan) return null;

  if (plan.action === "query") return queryPortfolio(userId, instanceId);
  if (plan.action === "unknown") return null;

  if (plan.action === "remove") {
    const resolved = await resolveStockRefs(plan.stocks);
    if (resolved.unresolved.length > 0) {
      return [
        "我理解你想维护持有股票池,但有些股票还没确认到代码:",
        resolved.unresolved.map((item) => `- ${item.name || item.code}`).join("\n"),
        "你可以补一句更明确的名称或代码,例如:我持有 平安银行 000001",
      ].join("\n");
    }
    if (resolved.codes.length === 0) {
      return [
        "我可以维护你的持有股票池,但还需要知道具体股票。",
        "你可以直接说:我持有平安银行和浦发银行",
      ].join("\n");
    }
    return closePositions(userId, instanceId, resolved.codes);
  }

  const details = await resolveStockRefDetails(plan.stocks);
  if (details.unresolved.length > 0) {
    return [
      "我理解你想维护持有股票池,但有些股票还没确认到代码:",
      details.unresolved.map((item) => `- ${item.name || item.code}`).join("\n"),
      "你可以补一句更明确的名称或代码,例如:我持有 平安银行 000001",
    ].join("\n");
  }
  if (details.resolved.length === 0) {
    return [
      "我可以维护你的持有股票池,但还需要知道具体股票。",
      "你可以直接说:我持有平安银行和浦发银行",
      "或:我持有 000001 和 600000",
    ].join("\n");
  }

  const entries = details.resolved.map((r) => ({
    code: r.code,
    costPrice: r.input.costPrice,
  }));
  return setHoldingPool(userId, instanceId, entries);
}

async function planPortfolioWithAi(message: string): Promise<AiPortfolioPlan | null> {
  try {
    const raw = await callDeepSeek(message, PORTFOLIO_AI_PROMPT, [], {
      profile: "light",
      thinking: false,
      temperature: 0,
      maxTokens: 500,
    });
    const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!jsonText) return null;
    const parsed = JSON.parse(jsonText) as Partial<AiPortfolioPlan>;
    if (!parsed.action || !Array.isArray(parsed.stocks)) return null;
    if (!["add", "remove", "query", "unknown"].includes(parsed.action)) return null;
    const plan = {
      action: parsed.action,
      stocks: parsed.stocks
        .filter((item) => item && (item.code || item.name))
        .map((item) => ({
          code: item.code,
          name: item.name,
          costPrice: typeof item.costPrice === "number" && item.costPrice > 0 && item.costPrice < 100000
            ? item.costPrice
            : undefined,
        })),
      note: parsed.note,
    };
    logger.info(
      `AI 持仓理解: action=${plan.action} stocks=${plan.stocks
        .map((item) => item.code || item.name)
        .join(",")}`
    );
    return plan;
  } catch (error) {
    logger.warn(`AI 持仓理解失败,使用本地解析: ${(error as Error).message}`);
    return null;
  }
}

function extractStockCodes(message: string): string[] {
  return Array.from(new Set(Array.from(message.matchAll(/\b\d{6}\b/g)).map((match) => match[0])));
}

async function logTradeAction(
  userId: string,
  instanceId: string,
  params: {
    code: string;
    action: TradeActionRow["action"];
    notes: string;
  }
): Promise<void> {
  await portfolioBackend.recordTradeAction({
    userId,
    instanceId,
    code: params.code,
    action: params.action,
    notes: params.notes,
    createdAt: new Date().toISOString(),
  });
}

async function setHoldingPool(
  userId: string,
  instanceId: string,
  entries: Array<{ code: string; costPrice?: number }>
): Promise<string> {
  const codes = entries.map((e) => e.code);
  const quotes = await getQuote(codes);
  const quoteMap = new Map(quotes.map((quote) => [quote.code, quote]));
  const added: string[] = [];
  const existing: string[] = [];

  for (const entry of entries) {
    const { code, costPrice } = entry;
    const open = await portfolioBackend.findActive(userId, instanceId, code);

    if (open) {
      const quote = quoteMap.get(code);
      const displayName = quote?.name || open.name;
      if (costPrice != null) {
        await portfolioBackend.upsertActive(userId, instanceId, {
          code,
          name: displayName,
          costPrice,
        });
        existing.push(`${displayName}(${code})(已更新成本 ${costPrice})`);
      } else {
        existing.push(`${displayName}(${code})`);
      }
      continue;
    }

    const quote = quoteMap.get(code);
    const name = quote?.name || code;
    await portfolioBackend.upsertActive(userId, instanceId, { code, name, costPrice: costPrice ?? null });
    await logTradeAction(userId, instanceId, {
      code,
      action: "hold",
      notes: costPrice != null
        ? `标记持有:${name}(${code}) 成本 ${costPrice}`
        : `标记持有:${name}(${code})`,
    });
    added.push(costPrice != null ? `${name}(${code}) 成本 ${costPrice}` : `${name}(${code})`);
  }

  const lines = ["已更新持有股票池"];
  if (added.length > 0) lines.push(`新增: ${added.join("、")}`);
  if (existing.length > 0) lines.push(`已存在: ${existing.join("、")}`);

  // 场景 A:持仓新增后,如果新加股暂无交易预案,附轻量提示(不主动起草)。
  if (added.length > 0) {
    const newCodes = entries
      .filter((e) => added.some((a) => a.includes(`(${e.code})`)))
      .map((e) => e.code);
    const noPlanCodes: string[] = [];
    for (const code of newCodes) {
      const plan = await planBackend.find(userId, instanceId, code);
      if (!plan) noPlanCodes.push(code);
    }
    if (noPlanCodes.length > 0) {
      lines.push("");
      lines.push(
        `上述${noPlanCodes.length > 1 ? "其中" : ""}暂无交易预案的:${
          noPlanCodes.join("、")
        }。需要的话告诉我,可以按你的策略起草一份。`,
      );
    }
  }

  return lines.join("\n");
}

async function closePosition(userId: string, instanceId: string, code: string): Promise<string> {
  const pos = await portfolioBackend.findActive(userId, instanceId, code);
  if (!pos) {
    return `未找到 ${code} 的持仓记录`;
  }
  if (pos.status === "closed") {
    return `${pos.name}(${code}) 已不在持仓池中`;
  }

  await portfolioBackend.markClosed(userId, instanceId, code);
  await logTradeAction(userId, instanceId, {
    code,
    action: "sell",
    notes: `移出持有池:${pos.name}(${code})`,
  });

  return `已移出持有股票池:${pos.name}(${code})`;
}

async function closePositions(userId: string, instanceId: string, codes: string[]): Promise<string> {
  const results: string[] = [];
  for (const code of codes) {
    const result = await closePosition(userId, instanceId, code);
    results.push(result.split("\n")[0]);
  }
  return ["已更新持有股票池", ...results].join("\n");
}

async function queryPortfolio(userId: string, instanceId: string): Promise<string> {
  const positions = await portfolioBackend.listActive(userId, instanceId);

  if (positions.length === 0) {
    return "当前持有股票池为空。\n你可以说:我持有 000001 和 600000";
  }

  const codes = positions.map((p) => p.code);
  const quotes = await getQuote(codes);
  const quoteMap = new Map(quotes.map((q) => [q.code, q]));

  const lines = [`当前持有 ${positions.length} 只:`];
  for (const pos of positions) {
    const quote = quoteMap.get(pos.code);
    const displayName = quote?.name || pos.name;
    const currentPrice = quote?.price;
    const cost = pos.costPrice;
    if (currentPrice == null) {
      lines.push(
        cost != null
          ? `- ${displayName}(${pos.code}) 成本 ${cost}`
          : `- ${displayName}(${pos.code})`
      );
      continue;
    }
    if (cost == null) {
      lines.push(`- ${displayName}(${pos.code}),当前价 ${currentPrice}`);
      continue;
    }
    const pnl = currentPrice - cost;
    const pnlPct = (pnl / cost) * 100;
    const sign = pnl >= 0 ? "+" : "";
    lines.push(
      `- ${displayName}(${pos.code}) 当前价 ${currentPrice} / 成本 ${cost} / 浮亏 ${sign}${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%)`
    );
  }

  return lines.join("\n");
}
