import type { DailyReviewContext } from "../handlers/review.js";

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
  sandboxTokenFile?: string | null;
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
      internalRuntimeContext ? `【内部执行上下文】\n${internalRuntimeContext}` : "",
    ].filter(Boolean).join("\n");
  }

  return [
    params.userText,
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
