import type { DailyReviewContext } from "../handlers/review.js";
import { renderSkillBundlePrompt } from "../platform/skill-bundles.js";

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
当前工作目录是 invest-agent 项目根目录。优先读取 AGENTS.md 和 .codex/skills 中的项目技能。
定性推理、复盘、选股问答由智能分析服务和 skill 完成；行情查询、巡检、落库、微信连接、看板等确定性能力由 invest-agent 服务提供。
如果需要调用本服务能力，优先查看 .codex/skills/invest-agent-service-tools/SKILL.md 中的本地 HTTP 接口说明。
微信链路中，invest-agent 主服务通常已经在运行并正在调用你；不要尝试启动、重启或停止服务。端口占用通常表示主服务已运行，不是客户需要看到的问题。
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
  };
  sandboxToken?: string;
  recentConversationContext?: string;
  isFirstConversation?: boolean;
}) {
  const compactReviewContext = params.reviewContext;
  const userContextLine = params.userContext
    ? `当前 AI 项目上下文：projectId=${params.userContext.projectId ?? "invest-agent"}; instanceId=${params.userContext.instanceId ?? "invest-agent-primary"}; projectType=${params.userContext.projectType ?? "invest-agent"}; skillBundle=${params.userContext.skillBundleId ?? "-"}; strategySkill=${params.userContext.strategySkillId ?? "-"}; instanceExpansion=${params.userContext.instanceExpansionPath ?? "-"}; userId=${params.userContext.userId}; channel=${params.userContext.channel ?? "-"}; backend=${params.userContext.backend ?? "-"}; conversationId=${params.userContext.conversationId ?? "-"}. 所有查询和写入都必须限定在该项目/实例/用户。`
    : "";
  const projectType = params.userContext?.projectType || "invest-agent";
  const skillBundleLine = params.userContext
    ? renderSkillBundlePrompt(params.userContext.skillBundleId || (projectType === "diet-recommendation" ? "diet-recommendation-default" : "invest-agent-default"))
    : "";
  const projectLine = projectType === "diet-recommendation"
    ? [
        "当前项目是饮食推荐助手。优先按饮食推荐 skill 的规则回复：先询问或利用用户目标、忌口、过敏、口味、预算、时间和运动情况，再给出可执行的饮食建议。",
        "不要给出医疗诊断、治疗承诺或极端节食方案。涉及疾病、孕期、儿童、进食障碍、严重过敏或用药冲突时，建议咨询专业医生/营养师。",
        "当前饮食项目暂不使用投资助手的持仓、自选、交易预案、提醒和复盘接口。",
      ].join("\n")
    : "当前项目是投资助手。所有持仓、自选、预案、提醒和复盘查询都必须限定在该实例/用户。";
const sandboxLine = params.sandboxToken
    ? `如需调用本服务确定性能力，只能调用 /api/sandbox/* 用户态接口，并使用请求头 Authorization: Bearer ${params.sandboxToken}。不要在 query、header 或 body 中传 userId；服务端会从 sandbox token 决定用户身份。不要调用 /api/users、/api/signals、/api/interval、/api/weixin、/api/hermes-weixin 等管理接口。`
    : "";
  const intentLine = projectType === "invest-agent"
    ? [
        "重要：如果用户表达的是需要改变长期状态或写入业务数据的请求，先由你理解自然语言意图，但不要直接调用接口写入，也不要回复“已设置/已写入”。",
        "当前支持的结构化确认意图：设置到价提醒。若用户要你监控某股票到某价格提醒，请只输出一段机器可读标记，不要附加客户正文：",
        "<invest_agent_intent>{\"intent\":\"set_alert\",\"stockName\":\"股票名称或空\",\"stockCode\":\"6位代码或空\",\"direction\":\"above 或 below\",\"price\":数字,\"rawText\":\"用户原话\"}</invest_agent_intent>",
        "direction 规则：涨到、达到、高于、突破、到某价格且未说明下跌时用 above；跌到、低于、回调到、支撑位附近用 below。",
        "如果只是查询、解释、分析、复盘或普通聊天，则正常回复客户正文，不要输出 intent 标记。",
      ].join("\n")
    : "";
  const onboardingLine = params.isFirstConversation
    ? [
        "【首次对话・强制约束】这是用户首次与本助手对话。必须严格按 .codex/skills/invest-agent-onboarding-flow/SKILL.md 输出欢迎语。",
        "如果你的回复不符合下面这些约束,视为失败:",
        "- 必须三段结构(顺序固定):(1) 自我介绍 1 行,定位为「投资观察助手」,核心价值是「盯盘 + 主动提醒」;(2) 能帮你做什么 3-4 行要点,盯盘/提醒放首位,复盘只作其中一项,可写「自定技术指标」但不点具体指标名;(3) 怎么开始 2-3 行,示例可包含「我持有 X 成本 Y」「X 到 Y 提醒我」。",
        "- 末尾可加一句隐私边界(数量金额不存,只存每股成本价)。",
        "- 总共不超过 8 行,微信场景一眼能读完。",
        "- 禁止出现「查持仓 / 查自选 / 查交易日志 / 设置提醒 / 录入持仓」这种能力清单式开场——这是错位。",
        "- 不追问数量、金额、仓位价值、止盈止损;不调用任何接口或工具;只输出欢迎正文。",
        "请先 cat .codex/skills/invest-agent-onboarding-flow/SKILL.md 读参考文案,然后按上述结构输出,不要变体。",
      ].join("\n")
    : "";

  return [
    "请按客户微信消息直接回复，不要暴露本地路径、localhost、端口、内部组件名、日志目录、调试信息、技能名、接口名或执行过程。",
    "最终回复只保留客户需要看到的结论、依据和下一步。",
    "不要输出“我会/我正在/我先检查/服务没有响应/端口被占用/继续排查”等执行过程；如果已经完成操作，只回复完成结果。",
    userContextLine,
    projectLine,
    skillBundleLine,
    sandboxLine,
    intentLine,
    onboardingLine,
    params.recentConversationContext
      ? [
          "最近微信对话上下文如下，仅用于理解“上面/刚才/它们/这些”等指代；当前用户的新请求仍以最后一条为准。",
          params.recentConversationContext,
        ].join("\n")
      : "",
    compactReviewContext
      ? [
          "用户要求复盘。下面已经提供复盘所需的数据，请不要再调用 curl、服务 API 或任何工具。",
          "请按日复盘结构和质量规则生成复盘：事实、推断、操作、验证点分开；不要使用资金净流入作为判断依据。",
          "如果上下文包含 previousReview 或 openViewpoints，请先回测上一份复盘的关键观点，再生成今天的新观点追踪表；不要把未验证观点当作已验证结论。",
          "主力控盘情况只作为最后一部分；如果没有确定性数据源，只简短说明未接入，不要在核心结论里反复强调缺口。",
          "直接输出复盘正文，不要说明你将如何处理，不要提到技能、上下文、接口、工具或保存动作。",
          "输出客户微信可读版本，内容可以完整，但避免工程词和内部路径。",
          `复盘上下文 JSON：${JSON.stringify(compactReviewContext)}`,
        ].join("\n")
      : "",
    "",
    params.userText,
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
