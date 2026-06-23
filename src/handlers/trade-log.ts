import { desc, eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { tradeActions } from "../db/schema.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_USER_ID, type UserContext } from "../lib/user-context.js";

const ACTION_LABELS: Record<string, string> = {
  buy: "买入/录入",
  sell: "卖出/移出",
  hold: "标记持有",
  update: "更新持仓",
};

export async function handleTradeLogTool(ctx: UserContext = { userId: DEFAULT_USER_ID }): Promise<string> {
  const instanceId = ctx.instanceId ?? DEFAULT_INSTANCE_ID;
  const rows = await db
    .select()
    .from(tradeActions)
    .where(and(eq(tradeActions.userId, ctx.userId), eq(tradeActions.instanceId, instanceId)))
    .orderBy(desc(tradeActions.createdAt))
    .limit(8);

  if (rows.length === 0) {
    return "当前还没有交易/持仓操作记录。\n之后录入持仓、移出持仓或更新持仓时，我会把操作留在这里，方便复盘。";
  }

  const lines = [`最近 ${rows.length} 条操作记录：`];
  for (const row of rows) {
    const date = formatShortTime(row.createdAt);
    const action = ACTION_LABELS[row.action] || row.action;
    const details = [
      row.price != null ? `价格 ${row.price}` : null,
      row.quantity != null ? `数量 ${row.quantity}` : null,
    ].filter(Boolean).join("，");
    lines.push(`- ${date} ${row.stockCode}：${action}${details ? `（${details}）` : ""}${row.notes ? `，${row.notes}` : ""}`);
  }
  return lines.join("\n");
}

function formatShortTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
