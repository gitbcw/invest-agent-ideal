import { getQuote } from "../services/stock.js";
import { resolveStockRefs } from "../services/stock-resolver.js";
import { logger } from "../lib/logger.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_USER_ID, type UserContext } from "../lib/user-context.js";
import { planBackend, type PlanRow } from "../lib/data-backend.js";

interface ParsedPlanMessage {
  action: "set" | "detail" | "list" | "delete";
  code?: string;
  support?: number;
  resistance?: number;
  targetPrice?: number;
  stopLoss?: number;
  notes?: string;
}

export async function handleStockPlan(message: string, ctx: UserContext = { userId: DEFAULT_USER_ID }): Promise<string> {
  const parsed = parsePlanMessage(message);
  const instanceId = ctx.instanceId ?? DEFAULT_INSTANCE_ID;
  switch (parsed.action) {
    case "set":
      return setStockPlan(ctx.userId, instanceId, parsed);
    case "delete":
      return deleteStockPlan(ctx.userId, instanceId, parsed.code!);
    case "detail":
      return showStockPlan(ctx.userId, instanceId, parsed.code!);
    case "list":
    default:
      return listStockPlans(ctx.userId, instanceId);
  }
}

function parsePlanMessage(message: string): ParsedPlanMessage {
  const code = message.match(/(\d{6})/)?.[1];
  if (!code) return { action: "list" };

  if (/删除预案|移除预案|取消预案/.test(message)) return { action: "delete", code };

  const hasSetIntent = /设置预案|更新预案|交易预案|预案/.test(message) &&
    /支撑|压力|目标|止损|备注/.test(message);

  if (!hasSetIntent) return { action: "detail", code };

  return {
    action: "set",
    code,
    support: pickNumber(message, /支撑(?:位)?\s*([\d.]+)/),
    resistance: pickNumber(message, /压力(?:位)?\s*([\d.]+)/),
    targetPrice: pickNumber(message, /目标(?:位|价)?\s*([\d.]+)/),
    stopLoss: pickNumber(message, /止损(?:位|价)?\s*([\d.]+)/),
    notes: pickNotes(message),
  };
}

function pickNumber(message: string, pattern: RegExp): number | undefined {
  const matched = message.match(pattern);
  if (!matched) return undefined;
  const value = Number(matched[1]);
  return Number.isFinite(value) ? value : undefined;
}

function pickNotes(message: string): string | undefined {
  const matched = message.match(/(?:备注|理由|策略)\s*[:：]?\s*(.+)$/);
  return matched?.[1]?.trim();
}

async function setStockPlan(userId: string, instanceId: string, parsed: ParsedPlanMessage): Promise<string> {
  const code = parsed.code!;
  const quotes = await getQuote([code]);
  const name = quotes[0]?.name || code;
  const existing = await planBackend.find(userId, instanceId, code);

  const input = {
    code,
    name,
    support: parsed.support ?? existing?.support ?? null,
    resistance: parsed.resistance ?? existing?.resistance ?? null,
    targetPrice: parsed.targetPrice ?? existing?.targetPrice ?? null,
    stopLoss: parsed.stopLoss ?? existing?.stopLoss ?? null,
    notes: parsed.notes ?? existing?.notes ?? null,
  };
  const saved = await planBackend.upsert(userId, instanceId, input);

  logger.info(`更新交易预案: ${name}(${code})`);
  return [`已更新交易预案:${name}(${code})`, formatStockPlan(saved)].join("\n\n");
}

async function showStockPlan(userId: string, instanceId: string, code: string): Promise<string> {
  const plan = await planBackend.find(userId, instanceId, code);
  if (!plan) {
    return `未找到 ${code} 的交易预案。\n可发送:设置预案 ${code} 支撑 10 压力 12 目标 14 止损 9.5 备注 低位观察`;
  }
  return formatStockPlanDetail(plan);
}

async function listStockPlans(userId: string, instanceId: string): Promise<string> {
  const rows = await planBackend.list(userId, instanceId);
  if (rows.length === 0) {
    return "暂无交易预案。\n可发送:设置预案 000001 支撑 10 压力 12 目标 14 止损 9.5 备注 低位观察";
  }
  return ["交易预案", ...rows.map(formatStockPlanSummary)].join("\n");
}

async function deleteStockPlan(userId: string, instanceId: string, code: string): Promise<string> {
  const existing = await planBackend.find(userId, instanceId, code);
  if (!existing) return `${code} 暂无交易预案,无需删除`;
  await planBackend.remove(userId, instanceId, code);
  return `已删除交易预案:${existing.name}(${code})`;
}

function formatStockPlanDetail(plan: PlanRow): string {
  return [
    `${plan.name}(${plan.code}) 交易预案`,
    `支撑 ${plan.support ?? "-"} | 压力 ${plan.resistance ?? "-"} | 目标 ${plan.targetPrice ?? "-"} | 止损 ${plan.stopLoss ?? "-"}`,
    `备注: ${plan.notes ?? "无"}`,
    `更新: ${formatTime(plan.updatedAt ?? "")}`,
  ].join("\n");
}

function formatStockPlanSummary(plan: PlanRow): string {
  return `${plan.name}(${plan.code}) 支撑${plan.support ?? "-"} 压力${plan.resistance ?? "-"} 目标${plan.targetPrice ?? "-"} 止损${plan.stopLoss ?? "-"} ${plan.notes ?? ""}`.trim();
}

function formatStockPlan(plan: PlanRow): string {
  return [
    `支撑位: ${plan.support ?? "未设置"}`,
    `压力位: ${plan.resistance ?? "未设置"}`,
    `目标位: ${plan.targetPrice ?? "未设置"}`,
    `止损位: ${plan.stopLoss ?? "未设置"}`,
    `策略备注: ${plan.notes ?? "未设置"}`,
    `更新时间: ${plan.updatedAt ?? "-"}`,
  ].join("\n");
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

/** Runtime 结构化入口 */
export interface PlanToolInput {
  operation: "query" | "set" | "remove";
  stocks?: Array<{ code?: string; name?: string }>;
  support?: number;
  resistance?: number;
  targetPrice?: number;
  stopLoss?: number;
  notes?: string;
}

export async function handlePlanTool(input: PlanToolInput, ctx: UserContext = { userId: DEFAULT_USER_ID }): Promise<string> {
  const instanceId = ctx.instanceId ?? DEFAULT_INSTANCE_ID;
  switch (input.operation) {
    case "query":
      return queryAllPlans(ctx.userId, instanceId);
    case "set":
      return setPlanViaTool(ctx.userId, instanceId, input);
    case "remove":
      return removePlanViaTool(ctx.userId, instanceId, input);
    default:
      return "不支持的预案操作。";
  }
}

async function queryAllPlans(userId: string, instanceId: string): Promise<string> {
  const rows = await planBackend.list(userId, instanceId);
  if (rows.length === 0) return "当前没有交易预案。\n你可以先说某只股票的支撑、压力、目标或止损,我会整理成草案。";
  return [`交易预案共 ${rows.length} 条:`, ...rows.map((row) => `- ${formatStockPlanSummary(row)}`)].join("\n");
}

async function setPlanViaTool(userId: string, instanceId: string, input: PlanToolInput): Promise<string> {
  if (!input.stocks || input.stocks.length === 0) {
    return "请指定要设置预案的股票。";
  }
  const { codes, unresolved } = await resolveStockRefs(input.stocks);
  if (codes.length === 0) {
    return `未找到对应股票:${unresolved.map((s) => s.name ?? s.code ?? "").join(", ")}`;
  }

  const results: string[] = [];
  for (const code of codes) {
    const quotes = await getQuote([code]);
    const name = quotes[0]?.name || code;
    const existing = await planBackend.find(userId, instanceId, code);

    const saved = await planBackend.upsert(userId, instanceId, {
      code,
      name,
      support: input.support ?? existing?.support ?? null,
      resistance: input.resistance ?? existing?.resistance ?? null,
      targetPrice: input.targetPrice ?? existing?.targetPrice ?? null,
      stopLoss: input.stopLoss ?? existing?.stopLoss ?? null,
      notes: input.notes ?? existing?.notes ?? null,
    });

    logger.info(`更新交易预案(Runtime): ${name}(${code})`);
    results.push(`${name}(${code}) ${existing ? "已更新" : "已设置"}预案:支撑${saved.support ?? "-"} 压力${saved.resistance ?? "-"} 目标${saved.targetPrice ?? "-"} 止损${saved.stopLoss ?? "-"}`);
  }

  return results.join("\n");
}

async function removePlanViaTool(userId: string, instanceId: string, input: PlanToolInput): Promise<string> {
  if (!input.stocks || input.stocks.length === 0) {
    return "请指定要删除预案的股票。";
  }
  const { codes, unresolved } = await resolveStockRefs(input.stocks);
  if (codes.length === 0) {
    return `未找到对应股票:${unresolved.map((s) => s.name ?? s.code ?? "").join(", ")}`;
  }

  const results: string[] = [];
  for (const code of codes) {
    const existing = await planBackend.find(userId, instanceId, code);
    if (!existing) {
      results.push(`${code} 暂无交易预案,无需删除`);
      continue;
    }
    await planBackend.remove(userId, instanceId, code);
    results.push(`已删除交易预案:${existing.name}(${code})`);
  }
  return results.join("\n");
}
