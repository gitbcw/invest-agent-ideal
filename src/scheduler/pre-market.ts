import { getQuote } from "../services/stock.js";
import { callDeepSeek } from "../services/deepseek.js";
import { logger } from "../lib/logger.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { getLatestReviewPreMarketContext } from "../handlers/review.js";
import { watchlistBackend } from "../lib/data-backend.js";

/**
 * 开盘前提醒 — 每日 9:15 执行
 * 汇总隔夜信息 + 自选股概况
 */
export async function runPreMarketAlert(options: { userId?: string; instanceId?: string } = {}): Promise<string> {
  const userId = options.userId ?? DEFAULT_USER_ID;
  const instanceId = options.instanceId ?? DEFAULT_INSTANCE_ID;
  const items = await watchlistBackend.list(userId, instanceId);
  if (items.length === 0) {
    logger.info("自选列表为空,跳过开盘前提醒");
    return "";
  }

  const codes = items.map((w) => w.code);
  const quotes = await getQuote(codes);

  // 构建自选股概况
  const stockSummary = quotes
    .map((q) => `${q.name}(${q.code}) 昨收: ${q.yesterdayClose} 涨跌: ${q.changePercent}%`)
    .join("\n");
  const reviewContext = await getLatestReviewPreMarketContext({ userId, instanceId });
  const reviewBlock = reviewContext
    ? [
        `最近复盘日期：${reviewContext.date}`,
        "昨日复盘要点：",
        reviewContext.coreConclusion || "暂无可提取要点",
        "今日观察重点：",
        reviewContext.observationFocus || "暂无明确观察重点",
      ].join("\n")
    : "最近复盘要点：暂无可用复盘记录。";

  const prompt = `请为以下自选股生成一份简短的盘前分析（200字以内）：

${stockSummary}

${reviewBlock}

要求：
1. 简要回顾昨日表现
2. 必须引用昨日复盘要点和今日观察重点；如果没有复盘记录，明确说缺少昨日复盘依据
3. 提示今日关注要点
4. 如有明显风险或机会请重点提示
5. 按事实、推断、建议分层表达
6. 不要编造隔夜新闻、研报或主力资金数据；缺少外部信息源时明确说明
7. 不构成投资建议`;

  try {
    const analysis = await callDeepSeek(prompt, undefined, [], {
      profile: "light",
      thinking: false,
      maxTokens: 800,
    });
    const lines = [
      "🌅 盘前提醒\n",
      "自选股概况：",
      stockSummary,
      "\n昨日复盘要点：",
      reviewContext?.coreConclusion || "暂无可用复盘记录。",
      "\n今日观察重点：",
      reviewContext?.observationFocus || "暂无明确观察重点。",
      "\n今日关注：",
      analysis,
      "\n—\n仅供参考，不构成投资建议",
    ];
    return lines.join("\n");
  } catch (error) {
    logger.error("盘前提醒生成失败:", error);
    return [
      "🌅 盘前提醒",
      "",
      "自选股概况：",
      stockSummary,
      "",
      "昨日复盘要点：",
      reviewContext?.coreConclusion || "暂无可用复盘记录。",
      "",
      "今日观察重点：",
      reviewContext?.observationFocus || "暂无明确观察重点。",
      "",
      "（AI 分析暂时不可用）",
    ].join("\n");
  }
}
