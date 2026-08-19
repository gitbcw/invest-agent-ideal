import type { DailyReviewContext } from "../handlers/review.js";
import { OUTPUT_VOLUME_POLICY } from "./spreadsheet-output-policy.js";

export function compactDailyReviewContext(context: DailyReviewContext) {
  return {
    date: context.date,
    generatedAt: context.generatedAt,
    previousReview: context.previousReview,
    openViewpoints: context.openViewpoints,
    marketIndex: context.marketIndex,
    sourceQuality: context.sourceQuality,
    holdings: context.holdings.map(compactStock),
    watchlist: context.watchlist.map(compactStock),
    infoFilter: context.infoFilter.slice(0, 2400),
    alerts: context.alerts.slice(0, 10).map((alert) => ({
      stock: `${alert.stockName}(${alert.stockCode})`,
      signal: alert.signalKey || alert.eventType,
      message: alert.message,
      relationToPlan: alert.relationToPlan,
      severity: alert.severity,
      status: alert.status,
      feedback: alert.feedback,
      createdAt: alert.createdAt,
    })),
    alertCount: context.alerts.length,
    existingPlans: context.existingPlans.map((plan) => ({
      stock: `${plan.name}(${plan.code})`,
      support: plan.support,
      resistance: plan.resistance,
      targetPrice: plan.targetPrice,
      stopLoss: plan.stopLoss,
      notes: plan.notes,
      updatedAt: plan.updatedAt,
    })),
    focusPoints: context.template.focusPoints,
    customInstructions: context.template.customInstructions,
    dataLimits: context.dataLimits,
  };
}

export type CompactDailyReviewContext = ReturnType<typeof compactDailyReviewContext>;

/** 服务器当前时间（Asia/Shanghai）。模型没有任何内置“今天”概念；没有这个权威
 * 锚点时，长会话历史里的旧日期范围（如“截止到8/12日的复盘”）会成为上下文里
 * 最强的日期信号并被沿用为取数参数（2026-08-19 mg 复盘旧数据事故根因之一）。 */
export function currentServerDateAnchor(now: Date = new Date()): string {
  const formatted = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now);
  return `【当前日期锚】服务器当前时间：${formatted}（Asia/Shanghai）。凡“今日/当日/最新交易日/最新数据”一律以该日期为准；会话历史消息中出现的旧日期或日期范围（如“截止到X日”）不得用于本轮取数参数，除非当前用户消息明确重申。`;
}

export function buildMobilePrompt(params: {
  userText: string;
  reviewContext?: CompactDailyReviewContext | null;
  allowReviewPublication?: boolean;
  userContext?: {
    userId: string;
    projectId?: string;
    instanceId?: string;
    projectName?: string;
    channel?: string;
    backend?: string;
    conversationId?: string;
    instanceExpansionPath?: string;
    workspacePath?: string;
  };
  sandboxPermissions?: string[];
}) {
  const compactReviewContext = params.reviewContext;
  const internalRuntimeContext = [
    params.userContext?.projectId ? `projectId=${params.userContext.projectId}` : "",
    params.userContext?.instanceId ? `instanceId=${params.userContext.instanceId}` : "",
    params.userContext?.channel ? `channel=${params.userContext.channel}` : "",
    params.userContext?.conversationId ? `conversationId=${params.userContext.conversationId}` : "",
    params.sandboxPermissions?.length ? `sandboxPermissions=${params.sandboxPermissions.join(",")}` : "",
  ].filter(Boolean).join("\n");
  if (!compactReviewContext) {
    return [
      params.userText,
      currentServerDateAnchor(),
      `【结果数量与表格规则】${OUTPUT_VOLUME_POLICY}`,
      internalRuntimeContext ? `【内部执行上下文】\n${internalRuntimeContext}` : "",
    ].filter(Boolean).join("\n");
  }

  return [
    params.userText,
    currentServerDateAnchor(),
    [
      params.allowReviewPublication
        ? "下面已经提供复盘所需的数据。不要再调用 curl、服务 API 或研究工具；定时日复盘的发布例外是必须调用 reviews.save。"
        : "用户要求复盘。下面已经提供复盘所需的数据，请不要再调用 curl、服务 API 或任何工具。",
      "请按日复盘结构和质量规则生成复盘：事实、推断、操作、验证点分开；不要使用资金净流入作为判断依据。",
      "数据来源与质量必须使用复盘上下文 JSON 的 sourceQuality；微信正文只写可读来源摘要和风险提示，不要展示原始 URL、provider endpoint/referenceUrl、本地 sandbox API、token、curl 或内部路径。",
      "如果上下文包含 previousReview 或 openViewpoints，请先回测上一份复盘的关键观点，再生成今天的新观点追踪表；不要把未验证观点当作已验证结论。",
      "主力控盘情况只作为最后一部分；如果没有确定性数据源，只简短说明未接入，不要在核心结论里反复强调缺口。",
      "直接输出复盘正文，不要说明你将如何处理，不要提到技能、上下文、工具或保存动作；数据来源章节只写“腾讯行情、腾讯日K、东方财富新闻线索、巨潮资讯公告”等可读来源名。",
      "输出客户微信可读版本，内容可以完整，但避免工程词和内部路径。",
      `【结果数量与表格规则】${OUTPUT_VOLUME_POLICY}`,
      params.sandboxPermissions?.length ? `当前允许权限：${params.sandboxPermissions.join(",")}` : "",
      "当用户明确要求新增或修改盯盘规则时，不要直接落库；先输出结构化草案，等待服务端确认后再执行。",
      internalRuntimeContext ? `【内部执行上下文】\n${internalRuntimeContext}` : "",
      `复盘上下文 JSON：${JSON.stringify(compactReviewContext)}`,
    ].join("\n"),
  ].join("\n");
}

function compactStock(stock: DailyReviewContext["stocks"][number]) {
  return {
    stock: `${stock.name}(${stock.code})`,
    pool: stock.pool,
    price: stock.price,
    changePercent: stock.changePercent,
    trend: stock.trend,
    macd: stock.macd,
    volume: stock.volume,
    support: stock.support,
    resistance: stock.resistance,
    observe: stock.observe,
    risks: stock.risks,
    confidence: stock.confidence,
  };
}
