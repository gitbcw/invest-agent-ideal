import type { DailyReviewContext } from "../handlers/review.js";
export const MOBILE_SYSTEM_PROMPT = `
<mobile_rules>
微信交流格式规则：
- 回复简洁，默认控制在 500 字以内。
- 长内容分段发，用 "---" 分隔。
- 代码用缩进，不使用复杂 Markdown。
- 表格转为列表。
- 链接只保留必要文字，不裸露长 URL。
- 面向客户回复，不暴露本地路径、localhost、端口、内部组件名、日志目录或调试信息。
- 不使用 Codex、Hermes、ACP、openclaw、weixin-agent-sdk、Dashboard、reviews 等工程词汇；必要时改写成“后台服务”“管理页面”“复盘记录”。
- 只输出最终给客户看的正文，不输出执行计划、工具调用过程、排查过程或中间状态。
</mobile_rules>

<invest_agent_runtime>
微信消息已经由服务路由到对应用户的 Workspace。你是该 Workspace 内的主执行者。
当前工作目录是该用户的 Workspace。优先读取本 Workspace 的 AGENTS.md、config/skills.yaml、skills/* 和相关配置。
定性推理、复盘、选股问答、确认流程和行动建议由你按 Workspace skills 完成；行情查询、巡检、落库、微信连接、看板等确定性能力由 invest-agent 服务提供。
如果需要调用本服务能力，优先按当前 Workspace 的 AGENTS.md、config/skills.yaml 和 skills/* 说明操作。
微信链路中，invest-agent 主服务通常已经在运行并正在调用你；不要尝试启动、重启或停止服务。不要把消息转回快闭环或规则路由处理；你应直接完成理解、必要的工具调用、确认草案和最终回复。
端口占用通常表示主服务已运行，不是客户需要看到的问题。
</invest_agent_runtime>
`.trim();

export function compactDailyReviewContext(context: DailyReviewContext) {
  return {
    date: context.date,
    generatedAt: context.generatedAt,
    previousReview: context.previousReview,
    openViewpoints: context.openViewpoints,
    marketIndex: context.marketIndex,
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
  userContext?: {
    userId: string;
    projectId?: string;
    instanceId?: string;
    projectType?: string;
    skillBundleId?: string;
    projectName?: string;
    channel?: string;
    backend?: string;
    conversationId?: string;
    strategySkillId?: string;
    instanceExpansionPath?: string;
    workspacePath?: string;
  };
  sandboxToken?: string;
  recentConversationContext?: string;
}) {
  const compactReviewContext = params.reviewContext;
  if (!compactReviewContext) {
    return params.userText;
  }

  return [
    params.userText,
    [
      "用户要求复盘。下面已经提供复盘所需的数据，请不要再调用 curl、服务 API 或任何工具。",
      "请按日复盘结构和质量规则生成复盘：事实、推断、操作、验证点分开；不要使用资金净流入作为判断依据。",
      "如果上下文包含 previousReview 或 openViewpoints，请先回测上一份复盘的关键观点，再生成今天的新观点追踪表；不要把未验证观点当作已验证结论。",
      "主力控盘情况只作为最后一部分；如果没有确定性数据源，只简短说明未接入，不要在核心结论里反复强调缺口。",
      "直接输出复盘正文，不要说明你将如何处理，不要提到技能、上下文、接口、工具或保存动作。",
      "输出客户微信可读版本，内容可以完整，但避免工程词和内部路径。",
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
