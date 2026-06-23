import { DEFAULT_INSTANCE_ID, DEFAULT_USER_ID, type UserContext } from "../lib/user-context.js";
import { dailyPlanBackend } from "../lib/daily-plan-backend.js";

export async function handleReviewRecordsTool(ctx: UserContext = { userId: DEFAULT_USER_ID }): Promise<string> {
  const instanceId = ctx.instanceId ?? DEFAULT_INSTANCE_ID;
  // WP4.7:handleReviewRecordsTool 取最新 5 条,latest 可用 getLatest,这里需要列表,
  // 用 listInRange 取最近一年范围(保守,实际不会超过用户使用历史)
  const today = new Date();
  const endDate = today.toISOString().slice(0, 10);
  const startDate = new Date(today.getTime() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const all = await dailyPlanBackend.listInRange(ctx.userId, instanceId, startDate, endDate);
  const rows = all.slice(0, 5);

  if (rows.length === 0) {
    return "当前还没有复盘记录。\n你可以说“生成今日复盘”，我会先整理事实、推断、操作和后续验证点。";
  }

  const lines = [`最近 ${rows.length} 条复盘记录：`];
  for (const row of rows) {
    const preview = compactPreview(row.summary || row.content);
    lines.push(`- ${row.planDate}：${preview || "已保存复盘内容"}`);
  }
  lines.push("需要展开某一天，可以直接说：查看 2026-06-11 的复盘。");
  return lines.join("\n");
}

function compactPreview(value: string) {
  return String(value || "")
    .replace(/^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}
