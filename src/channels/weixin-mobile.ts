import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { createAgent, isDailyReviewRequest } from "../acp/agent.js";
import { getCurrentAcpAgent } from "../acp/stdio-agent.js";
import { hermesStdioAcpAgent } from "../acp/hermes-stdio-agent.js";
import { buildAcpPromptContext } from "../acp/prompt-context-builder.js";
import { db, initDb } from "../db/index.js";
import { channelIdentities, channelIdentityInstances } from "../db/schema.js";
import { buildDailyReviewContext } from "../handlers/review.js";
import { config } from "../lib/config.js";
import { sanitizeCustomerText } from "../lib/customer-output.js";
import { formatUnknownError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { recordCodexAcpTrace } from "../acp/trace.js";
import { resolveOrCreateChannelUser, markChannelIdentityWelcomed } from "../lib/user-identity.js";
import { DEFAULT_USER_ID, type UserContext } from "../lib/user-context.js";
import { FIXED_WELCOME_MESSAGE } from "../lib/welcome.js";
import { getOnboardingState } from "../lib/onboarding-state.js";
import { buildOnboardingReminder } from "../lib/onboarding-reminder.js";
import { handleAiIntentDraftTurn, handlePendingConversationTaskTurn, createDraftTask, type DraftType } from "../lib/conversation-tasks.js";
import { applyFastAlertSet } from "../lib/fast-alert-set.js";
import { and, desc, eq } from "drizzle-orm";
import { DIET_RECOMMENDATION_PROJECT_ID, DIET_RECOMMENDATION_SHARED_INSTANCE_ID } from "../platform/project-registry.js";
import { callDeepSeek } from "../services/deepseek.js";
import { handleAlertTool } from "../handlers/alert.js";
import { handleMonitorTool } from "../handlers/monitor.js";
import { handlePlanTool } from "../handlers/plan.js";
import { handlePortfolio, handlePortfolioTool } from "../handlers/portfolio.js";
import { handleWatchlist } from "../handlers/watchlist.js";
import { handleWatchlistTool } from "../handlers/watchlist.js";
import { handleReviewRecordsTool } from "../handlers/review-records.js";
import { handleTradeLogTool } from "../handlers/trade-log.js";
import { formatAlerts, runAlertCheck } from "../scheduler/alert-check.js";
import {
  extractRecentStockRefs,
  formatRecentMemoryForPrompt,
  hasContextReference,
  inferReferencedStockCount,
  loadRecentWeixinMemory,
  rememberWeixinTurn,
} from "../lib/weixin-conversation-memory.js";

type WeixinBackend = "codex" | "hermes";

type LoginStage = "idle" | "waiting_scan" | "scanned" | "connected" | "error";

const FAST_INTENT_TIMEOUT_MS = 8000;
const FAST_ADMIN_TIMEOUT_MS = 8000;
const FAST_ALERT_INTENT_SYSTEM_PROMPT = [
  "你是投资助手微信入口的快速意图识别器。",
  "只判断用户是否在设置股票到价提醒。",
  "如果是，必须只输出一段 XML：",
  "<invest_agent_intent>{\"intent\":\"set_alert\",\"stockName\":\"股票名称或空\",\"stockCode\":\"6位代码或空\",\"direction\":\"above 或 below\",\"price\":数字,\"rawText\":\"用户原话\"}</invest_agent_intent>",
  "direction 规则：涨到、达到、高于、突破、到某价格且未说明下跌时用 above；跌到、低于、回调到、支撑位附近用 below。",
  "如果不是设置到价提醒，只输出 NONE。",
  "不要解释，不要输出其他文字。",
].join("\n");
const FAST_ADMIN_SYSTEM_PROMPT = [
  "你是投资助手微信入口的快速管理员和工具路由器。",
  "你的任务是判断用户消息是否可以由确定性工具直接处理，还是必须交给复杂研究模型。",
  "只输出 JSON，不要 Markdown，不要解释。",
  "",
  "可用工具：",
  "- portfolio.query：查看持仓、仓位、持有股票",
  "- portfolio.add：把明确给出的股票，或上下文里刚提到的股票，加入持有股票池",
  "- portfolio.remove：把明确给出的股票，或上下文里刚提到的股票，移出持有股票池",
  "- watchlist.query：查看自选、自选股、自选池",
  "- alerts.query：查看提醒、提醒列表、预警规则",
  "- plans.query：查看预案、交易预案",
  "- trade_log.query：查看交易日志、操作记录、买卖记录、持仓变更记录",
  "- review_records.query：查看复盘记录、历史复盘、最近复盘、复盘存档",
  "- monitor.overview：查看监控、巡检、整体状态、概览",
  "- alerts.check：手动巡检、看看有没有新提醒",
  "- alert.set：设置股票到价提醒（直接写库，不需要用户确认）",
  "- watchlist.add：把明确给出的股票，或上下文里刚提到的股票，加入自选池",
  "- watchlist.remove：把明确给出的股票，或上下文里刚提到的股票，移出自选池",
  "- portfolio_watchlist.draft：一次消息里同时录入持仓和自选（含成本价），需要用户确认才写入",
  "- preference.draft：用户描述长期投资偏好、风格、风控规则，需要用户确认才写入长期偏好",
  "- strategy_expansion.draft：用户提出方法论/规则级别的变更（如“以后回踩支撑再提醒”、“默认低噪音”、“复盘风格改成XX”），需要用户确认才作为实例展开候选",
  "- smalltalk.reply：寒暄、能力介绍、问可以做什么",
  "",
  "如果是确定性工具任务，输出：",
  "{\"route\":\"tool\",\"tool\":\"portfolio.query\",\"confidence\":\"high\"}",
  "",
  "如果是设置到价提醒，输出：",
  "{\"route\":\"tool\",\"tool\":\"alert.set\",\"stockName\":\"股票名称或空\",\"stockCode\":\"6位代码或空\",\"direction\":\"above 或 below\",\"price\":数字,\"confidence\":\"high\"}",
  "如果是涨跌幅百分比提醒，例如“上涨5%提醒我”，tool 仍用 alert.set，但必须输出 percent:true，price 为百分比数字。",
  "如果用户一次给多个股票设置同一类提醒，必须输出 alerts 数组，不要只取第一只：",
  "{\"route\":\"tool\",\"tool\":\"alert.set\",\"alerts\":[{\"stockName\":\"股票A\",\"direction\":\"above\",\"price\":3,\"percent\":true},{\"stockName\":\"股票B\",\"direction\":\"above\",\"price\":3,\"percent\":true}],\"confidence\":\"high\"}",
  "如果是加入/移出自选，输出：",
  "{\"route\":\"tool\",\"tool\":\"watchlist.add\",\"stocks\":[{\"name\":\"股票名称\"},{\"code\":\"6位代码\"}],\"useRecentStocks\":false,\"confidence\":\"high\"}",
  "如果用户说“上面这几个/刚才那几个/它们/全部加入自选”，输出 useRecentStocks:true；如果说这3个，输出 count:3。",
  "如果是加入/移出持仓，输出：",
  "{\"route\":\"tool\",\"tool\":\"portfolio.add\",\"stocks\":[{\"name\":\"股票名称\"},{\"code\":\"6位代码\"}],\"useRecentStocks\":false,\"confidence\":\"high\"}",
  "持仓池只代表当前持有标的范围，不强制要求成本和数量；如果用户只是说持有某股票，可以直接用 portfolio.add。",
  "如果用户一次消息里同时要录入持仓和自选（例如“我持有A、B，自选C”），用 portfolio_watchlist.draft：",
  "{\"route\":\"tool\",\"tool\":\"portfolio_watchlist.draft\",\"confidence\":\"high\"}",
  "如果是长期偏好/风格描述（如“我稳健点，不要频繁操作”、“记住我偏好新能源”、“风格偏价值”），用 preference.draft：",
  "{\"route\":\"tool\",\"tool\":\"preference.draft\",\"confidence\":\"high\"}",
  "如果是方法论/规则变更（如“以后回踩支撑再提醒”、“默认低噪音，只有放量大涨才推送”、“复盘风格改成事实-推断-操作-验证”），用 strategy_expansion.draft：",
  "{\"route\":\"tool\",\"tool\":\"strategy_expansion.draft\",\"confidence\":\"high\"}",
  "如果是简单寒暄或能力介绍，输出：",
  "{\"route\":\"tool\",\"tool\":\"smalltalk.reply\",\"reply\":\"简短客户回复\",\"confidence\":\"high\"}",
  "",
  "如果是复杂任务，输出：",
  "{\"route\":\"complex\",\"reason\":\"需要分析/研究/复盘/策略判断\"}",
  "",
  "复杂任务包括：行业/公司/个股分析、选股、生成复盘、风险评估、估值、策略讨论、为什么、怎么看、值不值得买。",
  "如果用户只是查看、查询、列出已有数据，必须走工具，不要判为复杂。",
  "如果用户说查看复盘记录/历史复盘/最近复盘，必须走 review_records.query，不要生成复盘。",
  "重要：单纯的“设置X涨到Y提醒我”必须走 alert.set，不要误判为 strategy_expansion.draft。strategy_expansion.draft 只用于“方法论级别的变更”，不针对单只股票的具体价格触发。",
  "alert.set 也支持技术指标触发提醒,需要输出 indicator 字段:",
  "- 「突破 X 日线 / 跌破 X 日线 / X 日均线上方下方」 → indicator=ma_breakout_above 或 ma_breakout_below,period=X(默认 20)",
  "- 「MACD 金叉 / 死叉」 → indicator=macd_golden_cross 或 macd_death_cross",
  "- 「KDJ 超卖反弹 / 超买回落」 → indicator=kdj_oversold 或 kdj_overbought,kdjThreshold 默认 20/80",
  "技术指标提醒 schema:{\"route\":\"tool\",\"tool\":\"alert.set\",\"indicator\":\"ma_breakout_above\",\"period\":20,\"stockName\":\"股票名称\",\"confidence\":\"high\"}",
  "技术指标提醒不要输出 price/direction/percent 字段;「X日线」里的数字是 period 参数(周期),绝对不要当作 price。",
  "复杂指标(如「BOLL 突破」、「RSI 超买」、「顶背离」、「主力控盘」)当前 alert.set 仍不支持,判为 complex。",
  "如果是「涨跌幅达到 X%」类型的提醒,用 percent:true + price=X,不要用 indicator。",
  "如果用户表达不清但看起来想查看已有数据，选最接近的查看工具；完全无法判断时输出 {\"route\":\"unknown\",\"reply\":\"我还没判断清楚。你可以直接说：查持仓、查自选、查提醒、查交易日志、查复盘记录，或让我做个股/行业分析。\"}。",
].join("\n");

type FastAdminAlertIndicator =
  | "ma_breakout_above"
  | "ma_breakout_below"
  | "macd_golden_cross"
  | "macd_death_cross"
  | "kdj_oversold"
  | "kdj_overbought";

interface FastAdminAlertSpec {
  stockName?: string;
  stockCode?: string;
  direction?: "above" | "below";
  price?: number;
  percent?: boolean;
  indicator?: FastAdminAlertIndicator;
  period?: number;
  kdjThreshold?: number;
}

type FastAdminDecision =
  | { route: "tool"; tool: "portfolio.query" | "watchlist.query" | "alerts.query" | "plans.query" | "trade_log.query" | "review_records.query" | "monitor.overview" | "alerts.check"; confidence?: string }
  | { route: "tool"; tool: "preference.draft" | "strategy_expansion.draft" | "portfolio_watchlist.draft"; confidence?: string }
  | { route: "tool"; tool: "alert.set"; stockName?: string; stockCode?: string; direction?: "above" | "below"; price?: number; percent?: boolean; indicator?: FastAdminAlertIndicator; period?: number; kdjThreshold?: number; alerts?: Array<FastAdminAlertSpec>; confidence?: string }
  | { route: "tool"; tool: "watchlist.add" | "watchlist.remove" | "portfolio.add" | "portfolio.remove"; stocks?: Array<{ code?: string; name?: string }>; useRecentStocks?: boolean; count?: number; confidence?: string }
  | { route: "tool"; tool: "smalltalk.reply"; reply?: string; confidence?: string }
  | { route: "complex"; reason?: string }
  | { route: "unknown"; reply?: string };

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function tryFastAlertIntent(userContext: UserContext, text: string) {
  if (userContext.projectType === "diet-recommendation") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const raw = await withTimeout(
    callDeepSeek(trimmed, FAST_ALERT_INTENT_SYSTEM_PROMPT, [], {
      provider: "deepseek",
      profile: "light",
      thinking: false,
      temperature: 0,
      maxTokens: 300,
    }),
    FAST_INTENT_TIMEOUT_MS,
    "DeepSeek 快链路"
  );
  if (raw.trim() === "NONE") return null;
  return handleAiIntentDraftTurn(userContext, raw);
}

function parseFastAdminDecision(raw: string): FastAdminDecision | null {
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText) as Partial<FastAdminDecision>;
    if (parsed.route === "complex") return { route: "complex", reason: parsed.reason };
    if (parsed.route === "unknown") return { route: "unknown", reply: parsed.reply };
    if (parsed.route !== "tool" || typeof parsed.tool !== "string") return null;
    if (parsed.tool === "alert.set") {
      const price = Number((parsed as { price?: unknown }).price);
      const periodRaw = Number((parsed as { period?: unknown }).period);
      const kdjThresholdRaw = Number((parsed as { kdjThreshold?: unknown }).kdjThreshold);
      const indicatorRaw = (parsed as { indicator?: unknown }).indicator;
      const validIndicators: FastAdminAlertIndicator[] = [
        "ma_breakout_above",
        "ma_breakout_below",
        "macd_golden_cross",
        "macd_death_cross",
        "kdj_oversold",
        "kdj_overbought",
      ];
      const indicator = validIndicators.includes(indicatorRaw as FastAdminAlertIndicator)
        ? (indicatorRaw as FastAdminAlertIndicator)
        : undefined;
      const alertsPayload = (parsed as { alerts?: Array<Record<string, unknown>> }).alerts;
      const alerts = Array.isArray(alertsPayload)
        ? alertsPayload
          .map((item) => {
            const itemPrice = Number(item.price);
            const itemPeriod = Number(item.period);
            const itemKdj = Number(item.kdjThreshold);
            const itemInd = item.indicator;
            return {
              stockName: typeof item.stockName === "string" ? item.stockName : undefined,
              stockCode: typeof item.stockCode === "string" ? item.stockCode : undefined,
              direction: item.direction === "below" ? "below" as const : "above" as const,
              price: Number.isFinite(itemPrice) ? itemPrice : undefined,
              percent: Boolean(item.percent),
              indicator: validIndicators.includes(itemInd as FastAdminAlertIndicator)
                ? (itemInd as FastAdminAlertIndicator)
                : undefined,
              period: Number.isFinite(itemPeriod) ? itemPeriod : undefined,
              kdjThreshold: Number.isFinite(itemKdj) ? itemKdj : undefined,
            } as FastAdminAlertSpec;
          })
          .filter((item) => (item.stockName || item.stockCode) && (item.price || item.indicator))
        : undefined;
      return {
        route: "tool",
        tool: "alert.set",
        stockName: (parsed as { stockName?: string }).stockName,
        stockCode: (parsed as { stockCode?: string }).stockCode,
        direction: (parsed as { direction?: "above" | "below" }).direction,
        price: Number.isFinite(price) ? price : undefined,
        percent: Boolean((parsed as { percent?: unknown }).percent),
        indicator,
        period: Number.isFinite(periodRaw) ? periodRaw : undefined,
        kdjThreshold: Number.isFinite(kdjThresholdRaw) ? kdjThresholdRaw : undefined,
        alerts,
        confidence: parsed.confidence,
      };
    }
    if (parsed.tool === "watchlist.add" || parsed.tool === "watchlist.remove" || parsed.tool === "portfolio.add" || parsed.tool === "portfolio.remove") {
      const payload = parsed as {
        stocks?: Array<{ code?: string; name?: string }>;
        useRecentStocks?: boolean;
        count?: unknown;
        confidence?: string;
      };
      const count = Number(payload.count);
      return {
        route: "tool",
        tool: parsed.tool,
        stocks: Array.isArray(payload.stocks) ? payload.stocks.filter((item) => item && (item.code || item.name)) : [],
        useRecentStocks: Boolean(payload.useRecentStocks),
        count: Number.isFinite(count) && count > 0 ? count : undefined,
        confidence: payload.confidence,
      };
    }
    if (parsed.tool === "smalltalk.reply") {
      return { route: "tool", tool: "smalltalk.reply", reply: (parsed as { reply?: string }).reply, confidence: parsed.confidence };
    }
    if (["portfolio.query", "watchlist.query", "alerts.query", "plans.query", "trade_log.query", "review_records.query", "monitor.overview", "alerts.check", "preference.draft", "strategy_expansion.draft", "portfolio_watchlist.draft"].includes(parsed.tool)) {
      return { route: "tool", tool: parsed.tool as Exclude<FastAdminDecision & { route: "tool" }, { tool: "alert.set" }>["tool"], confidence: parsed.confidence };
    }
    return null;
  } catch {
    return null;
  }
}

async function tryFastAdminTool(userContext: UserContext, text: string): Promise<{ mode: string; text: string } | null> {
  if (userContext.projectType === "diet-recommendation") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const recentMemory = await loadRecentWeixinMemory(userContext);
  const recentContext = formatRecentMemoryForPrompt(recentMemory);
  const history = recentContext
    ? [{ role: "user" as const, content: `最近对话上下文（用于解析“上面/刚才/它们”等指代，不要把它当成当前用户新请求）：\n${recentContext}` }]
    : [];

  const raw = await withTimeout(
    callDeepSeek(trimmed, FAST_ADMIN_SYSTEM_PROMPT, history, {
      provider: "deepseek",
      profile: "light",
      thinking: false,
      temperature: 0,
      maxTokens: 500,
    }),
    FAST_ADMIN_TIMEOUT_MS,
    "DeepSeek 快速管理员"
  );
  const decision = parseFastAdminDecision(raw);
  if (!decision) return null;
  if (decision.route === "complex") return null;
  if (decision.route === "unknown") {
    return {
      mode: "fast-admin-unknown",
      text: decision.reply || "我还没判断清楚。你可以直接说：查持仓、查自选、查提醒、查交易日志、查复盘记录，或让我做个股/行业分析。",
    };
  }

  const ctx = { ...userContext, instanceId: userContext.instanceId || "invest-agent-primary" };
  switch (decision.tool) {
    case "portfolio.query":
      return { mode: "fast-admin-portfolio-query", text: await handlePortfolio("我的持仓", ctx) };
    case "portfolio.add":
    case "portfolio.remove": {
      const refs = decision.useRecentStocks || (hasContextReference(trimmed) && !(decision.stocks?.length))
        ? extractRecentStockRefs(recentMemory, decision.count ?? inferReferencedStockCount(trimmed))
        : decision.stocks ?? [];
      if (refs.length === 0) {
        return { mode: "fast-admin-portfolio-clarify", text: "我还没定位到要处理的持仓标的。你可以直接发股票名称或代码，例如：我持有贵州茅台，或：不再持有 600519。" };
      }
      const operation = decision.tool === "portfolio.add" ? "add" : "remove";
      return {
        mode: `fast-admin-${decision.tool.replace(".", "-")}`,
        text: await handlePortfolioTool({ operation, stocks: refs }, ctx),
      };
    }
    case "watchlist.query":
      return { mode: "fast-admin-watchlist-query", text: await handleWatchlist("自选列表", ctx) };
    case "watchlist.add":
    case "watchlist.remove": {
      const refs = decision.useRecentStocks || (hasContextReference(trimmed) && !(decision.stocks?.length))
        ? extractRecentStockRefs(recentMemory, decision.count ?? inferReferencedStockCount(trimmed))
        : decision.stocks ?? [];
      if (refs.length === 0) {
        return { mode: "fast-admin-watchlist-clarify", text: "我还没定位到要处理的股票。你可以直接发股票名称或代码，例如：把科大讯飞、中科曙光加入自选。" };
      }
      const operation = decision.tool === "watchlist.add" ? "add" : "remove";
      return {
        mode: `fast-admin-${decision.tool.replace(".", "-")}`,
        text: await handleWatchlistTool({ operation, stocks: refs, reason: "来自最近对话，用户确认加入自选" }, ctx),
      };
    }
    case "alerts.query":
      return { mode: "fast-admin-alert-query", text: await handleAlertTool({ operation: "query" }, ctx) };
    case "plans.query":
      return { mode: "fast-admin-plan-query", text: await handlePlanTool({ operation: "query" }, ctx) };
    case "trade_log.query":
      return { mode: "fast-admin-trade-log-query", text: await handleTradeLogTool(ctx) };
    case "review_records.query":
      return { mode: "fast-admin-review-records-query", text: await handleReviewRecordsTool(ctx) };
    case "monitor.overview":
      return { mode: "fast-admin-monitor-overview", text: await handleMonitorTool({ operation: "overview" }, ctx) };
    case "alerts.check": {
      const items = await runAlertCheck({ force: true, userId: ctx.userId, instanceId: ctx.instanceId });
      return {
        mode: "fast-admin-alert-check",
        text: items.length > 0 ? formatAlerts(items) : "当前强制巡检完成：没有触发新的提醒。",
      };
    }
    case "preference.draft": {
      const reply = await createDraftTask(userContext, "preference", trimmed);
      return reply ? { mode: "fast-admin-preference-draft", text: reply } : null;
    }
    case "strategy_expansion.draft": {
      const reply = await createDraftTask(userContext, "strategy_expansion", trimmed);
      return reply ? { mode: "fast-admin-strategy-expansion-draft", text: reply } : null;
    }
    case "portfolio_watchlist.draft": {
      const reply = await createDraftTask(userContext, "portfolio_watchlist", trimmed);
      return reply ? { mode: "fast-admin-portfolio-watchlist-draft", text: reply } : null;
    }
    case "alert.set": {
      const result = await applyFastAlertSet({
        userId: userContext.userId,
        instanceId: userContext.instanceId,
        rawText: trimmed,
        single: decision.alerts?.length ? undefined : {
          stockName: decision.stockName,
          stockCode: decision.stockCode,
          direction: decision.direction,
          price: decision.price,
          percent: decision.percent,
          indicator: decision.indicator,
          period: decision.period,
          kdjThreshold: decision.kdjThreshold,
        },
        batch: decision.alerts?.length ? decision.alerts : undefined,
      });
      return { mode: result.mode, text: result.text };
    }
    case "smalltalk.reply":
      return {
        mode: "fast-admin-smalltalk",
        text: decision.reply || "我在。你可以直接查持仓、自选、提醒、预案，也可以让我做复盘或选股分析。",
      };
    default:
      return null;
  }
}

function normalizeFastText(text: string) {
  return text.replace(/\s+/g, "").trim();
}

function isComplexResearchIntent(text: string) {
  return /分析|调研|研究|选股|筛选|怎么看|值不值得|能不能买|逻辑|风险|复盘|总结|策略|方法论|为什么|行业|题材|概念|财报|估值/.test(text);
}

function hasReadIntent(text: string) {
  return /查看|查询|看看|看一下|看下|列一下|列出|列表|情况|有哪些|当前|我的|现在|帮我看/.test(text);
}

function hasWriteIntent(text: string) {
  return /买入|卖出|加仓|清仓|录入|新增|加入|添加|设置|更新|修改|调整|移除|删除|取消|关闭|不再/.test(text);
}

async function tryFastDeterministicReply(userContext: UserContext, text: string): Promise<{ mode: string; text: string } | null> {
  if (userContext.projectType === "diet-recommendation") return null;
  const raw = text.trim();
  const compact = normalizeFastText(raw);
  if (!compact || isComplexResearchIntent(compact)) return null;

  const ctx = { ...userContext, instanceId: userContext.instanceId || "invest-agent-primary" };

  if (
    (/^(我的|当前)?(持仓|持有股票|持有股票池|仓位)(列表|情况|有哪些)?$/.test(compact) || (/(持仓|持有股票|持有股票池|仓位)/.test(compact) && hasReadIntent(compact))) &&
    !hasWriteIntent(compact)
  ) {
    return { mode: "fast-portfolio-query", text: await handlePortfolio("我的持仓", ctx) };
  }

  if (
    (/^(我的|当前)?(自选|自选股|自选池)(列表|情况|有哪些)?$/.test(compact) || (/(自选|自选股|自选池)/.test(compact) && hasReadIntent(compact))) &&
    !hasWriteIntent(compact)
  ) {
    return { mode: "fast-watchlist-query", text: await handleWatchlist("自选列表", ctx) };
  }

  if (
    (/^(我的|当前)?(提醒|提醒规则|预警|预警规则)(列表|情况|有哪些)?$/.test(compact) || (/(提醒|提醒规则|预警|预警规则)/.test(compact) && hasReadIntent(compact))) &&
    !hasWriteIntent(compact)
  ) {
    return { mode: "fast-alert-query", text: await handleAlertTool({ operation: "query" }, ctx) };
  }

  if (
    (/^(我的|当前)?(预案|交易预案)(列表|情况|有哪些)?$/.test(compact) || (/(预案|交易预案)/.test(compact) && hasReadIntent(compact))) &&
    !hasWriteIntent(compact)
  ) {
    return { mode: "fast-plan-query", text: await handlePlanTool({ operation: "query" }, ctx) };
  }

  if (/(交易日志|操作记录|买卖记录|持仓变更记录)/.test(compact) && (hasReadIntent(compact) || /^(我的|当前)?(交易日志|操作记录|买卖记录|持仓变更记录)$/.test(compact)) && !hasWriteIntent(compact)) {
    return { mode: "fast-trade-log-query", text: await handleTradeLogTool(ctx) };
  }

  if (/(复盘记录|历史复盘|复盘列表|复盘存档|最近复盘)/.test(compact) && (hasReadIntent(compact) || /^(我的|当前)?(复盘记录|历史复盘|复盘列表|复盘存档|最近复盘)$/.test(compact)) && !hasWriteIntent(compact)) {
    return { mode: "fast-review-records-query", text: await handleReviewRecordsTool(ctx) };
  }

  if (/^(监控|巡检|看板|概览|状态)(情况|概览|状态)?$/.test(compact) || /^(查看|查询|看看)(监控|巡检|看板|概览|状态)$/.test(compact)) {
    return { mode: "fast-monitor-overview", text: await handleMonitorTool({ operation: "overview" }, ctx) };
  }

  if (/^(检查|执行|跑|触发|手动)?(巡检|提醒检查)$/.test(compact) || /^看看有没有(新)?提醒$/.test(compact)) {
    const items = await runAlertCheck({ force: true, userId: ctx.userId, instanceId: ctx.instanceId });
    return {
      mode: "fast-alert-check",
      text: items.length > 0 ? formatAlerts(items) : "当前强制巡检完成：没有触发新的提醒。",
    };
  }

  return null;
}

interface WeixinLoginSession {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
  refreshCount: number;
}

interface WeixinConnectState {
  enabled: boolean;
  backend: WeixinBackend;
  stage: LoginStage;
  stateDir: string;
  accountId?: string;
  message: string;
  qrcodeUrl?: string;
  qrcodeDataUrl?: string;
  sessionKey?: string;
  updatedAt: string;
  listenerRunning: boolean;
  lastError?: string;
  lastConversationId?: string;
  lastConversationAt?: string;
  pushReady?: boolean;
  accounts?: Array<{
    accountId: string;
    listenerRunning: boolean;
    lastConversationId?: string;
    lastConversationAt?: string;
    pushReady?: boolean;
  }>;
}

interface WeixinAccountRecord {
  token?: string;
  baseUrl?: string;
  userId?: string;
  lastConversationId?: string;
  lastConversationAt?: string;
  lastContextToken?: string;
}

interface StartLoginResult {
  qrcodeUrl?: string;
  message: string;
  sessionKey: string;
}

interface WaitLoginResult {
  connected: boolean;
  message: string;
  botToken?: string;
  accountId?: string;
  baseUrl?: string;
  userId?: string;
}

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const MAX_QR_REFRESH_COUNT = 3;
const ACTIVE_LOGIN_TTL_MS = 5 * 60 * 1000;
const QR_LONG_POLL_TIMEOUT_MS = 35 * 1000;
const WEIXIN_MESSAGE_ITEM_TEXT = 1;
const WEIXIN_MESSAGE_TYPE_BOT = 2;
const WEIXIN_MESSAGE_STATE_FINISH = 2;

let weixinSdkPromise: Promise<{
  start: (
    agent: { chat(request: { conversationId: string; text: string; media?: { type: string } }): Promise<{ text?: string }>; clearSession?: (conversationId: string) => void },
    opts?: { accountId?: string; abortSignal?: AbortSignal; log?: (msg: string) => void }
  ) => Promise<void>;
}> | null = null;

function syncWeixinSdkStateDirEnv(stateDir = config.weixin.stateDir) {
  process.env.OPENCLAW_STATE_DIR = stateDir;
}

function loadWeixinSdk(stateDir = config.weixin.stateDir) {
  syncWeixinSdkStateDirEnv(stateDir);
  if (!weixinSdkPromise) {
    weixinSdkPromise = import("weixin-agent-sdk");
  }
  return weixinSdkPromise;
}

function resolveStateDir(stateDir = config.weixin.stateDir) {
  return stateDir;
}

function resolveWeixinStateDir(stateDir = config.weixin.stateDir) {
  return path.join(resolveStateDir(stateDir), "openclaw-weixin");
}

function resolveAccountIndexPath(stateDir = config.weixin.stateDir) {
  return path.join(resolveWeixinStateDir(stateDir), "accounts.json");
}

function resolveAccountsDir(stateDir = config.weixin.stateDir) {
  return path.join(resolveWeixinStateDir(stateDir), "accounts");
}

function resolveAccountPath(accountId: string, stateDir = config.weixin.stateDir) {
  return path.join(resolveAccountsDir(stateDir), `${accountId}.json`);
}

function normalizeAccountId(raw: string) {
  return raw.trim().toLowerCase().replace(/[@.]/g, "-");
}

function registerWeixinAccountId(accountId: string, stateDir = config.weixin.stateDir) {
  const dir = resolveWeixinStateDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const ids = listWeixinAccountIds(stateDir).filter((id) => id !== accountId);
  ids.push(accountId);
  fs.writeFileSync(resolveAccountIndexPath(stateDir), JSON.stringify(ids, null, 2), "utf-8");
}

function listWeixinAccountIds(stateDir = config.weixin.stateDir): string[] {
  const ids: string[] = [];
  try {
    const filePath = resolveAccountIndexPath(stateDir);
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (Array.isArray(parsed)) {
        ids.push(...parsed.filter((id) => typeof id === "string"));
      }
    }
  } catch {
    // Fall through to account file discovery below.
  }
  try {
    const dir = resolveAccountsDir(stateDir);
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.endsWith(".json") && !entry.endsWith(".sync.json")) {
          ids.push(entry.slice(0, -".json".length));
        }
      }
    }
  } catch {
    // Ignore corrupt state directories; callers handle an empty account list.
  }
  return Array.from(new Set(ids.map((id) => normalizeAccountId(id)).filter(Boolean)));
}

function loadWeixinAccount(accountId: string, stateDir = config.weixin.stateDir): WeixinAccountRecord | null {
  try {
    const filePath = resolveAccountPath(accountId, stateDir);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as WeixinAccountRecord;
  } catch {
    return null;
  }
}

function saveWeixinAccount(accountId: string, update: WeixinAccountRecord, stateDir = config.weixin.stateDir) {
  fs.mkdirSync(resolveAccountsDir(stateDir), { recursive: true });
  const existing = loadWeixinAccount(accountId, stateDir) ?? {};
  const next = {
    token: update.token?.trim() || existing.token,
    baseUrl: update.baseUrl?.trim() || existing.baseUrl || DEFAULT_BASE_URL,
    userId: update.userId?.trim() || existing.userId,
    lastConversationId: update.lastConversationId?.trim() || existing.lastConversationId,
    lastConversationAt: update.lastConversationAt?.trim() || existing.lastConversationAt,
    lastContextToken: update.lastContextToken?.trim() || existing.lastContextToken,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(resolveAccountPath(accountId, stateDir), JSON.stringify(next, null, 2), "utf-8");
}

function resolveWeixinAccount(accountId?: string, stateDir = config.weixin.stateDir) {
  const ids = listWeixinAccountIds(stateDir);
  const resolvedId = normalizeAccountId(accountId || ids[0] || "");
  if (!resolvedId) {
    return {
      accountId: "",
      configured: false,
      token: undefined,
      baseUrl: DEFAULT_BASE_URL,
    };
  }

  const account = loadWeixinAccount(resolvedId, stateDir);
  return {
    accountId: resolvedId,
    configured: Boolean(account?.token),
    token: account?.token,
    baseUrl: account?.baseUrl || DEFAULT_BASE_URL,
    lastConversationId: account?.lastConversationId || account?.userId,
    lastConversationAt: account?.lastConversationAt,
    lastContextToken: account?.lastContextToken,
  };
}

async function resolvePushConversation(params: {
  accountId: string;
  backend: WeixinBackend;
  userId?: string;
  instanceId?: string;
  fallbackConversationId?: string;
  fallbackContextToken?: string;
}) {
  const userId = params.userId?.trim() || DEFAULT_USER_ID;
  const instanceId = params.instanceId?.trim();
  if (instanceId) {
    const rows = await db
      .select({
        externalAccountId: channelIdentities.externalAccountId,
        lastConversationId: channelIdentities.lastConversationId,
        lastContextToken: channelIdentities.lastContextToken,
      })
      .from(channelIdentityInstances)
      .innerJoin(channelIdentities, eq(channelIdentityInstances.channelIdentityId, channelIdentities.id))
      .where(and(
        eq(channelIdentityInstances.instanceId, instanceId),
        eq(channelIdentities.channel, "weixin-mobile"),
        eq(channelIdentities.backend, params.backend),
      ))
      .orderBy(desc(channelIdentities.updatedAt))
      .limit(1);

    const identity = rows[0];
    if (identity?.lastConversationId) {
      if (identity.externalAccountId && identity.externalAccountId !== params.accountId) {
        logger.warn(`微信主动推送跳过：实例 ${instanceId} 绑定账号 ${identity.externalAccountId}，当前账号 ${params.accountId}`);
        return { conversationId: undefined, contextToken: undefined };
      }
      return {
        conversationId: identity.lastConversationId,
        contextToken: identity.lastContextToken ?? undefined,
      };
    }
  }
  if (userId === DEFAULT_USER_ID) {
    return {
      conversationId: params.fallbackConversationId,
      contextToken: params.fallbackContextToken,
    };
  }

  const rows = await db
    .select({
      externalAccountId: channelIdentities.externalAccountId,
      lastConversationId: channelIdentities.lastConversationId,
      lastContextToken: channelIdentities.lastContextToken,
    })
    .from(channelIdentities)
    .where(and(
      eq(channelIdentities.userId, userId),
      eq(channelIdentities.channel, "weixin-mobile"),
      eq(channelIdentities.backend, params.backend),
    ))
    .orderBy(desc(channelIdentities.updatedAt))
    .limit(1);

  const identity = rows[0];
  if (!identity?.lastConversationId) {
    return { conversationId: undefined, contextToken: undefined };
  }
  if (identity.externalAccountId && identity.externalAccountId !== params.accountId) {
    logger.warn(`微信主动推送跳过：用户 ${userId} 绑定账号 ${identity.externalAccountId}，当前账号 ${params.accountId}`);
    return { conversationId: undefined, contextToken: undefined };
  }
  return {
    conversationId: identity.lastConversationId,
    contextToken: identity.lastContextToken ?? undefined,
  };
}

function isLoginFresh(session: WeixinLoginSession) {
  return Date.now() - session.startedAt < ACTIVE_LOGIN_TTL_MS;
}

async function fetchQRCode(apiBaseUrl: string, botType = "3") {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    base
  );
  const response = await fetch(url.toString());
  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`获取微信二维码失败: ${response.status} ${body}`);
  }
  return (await response.json()) as {
    qrcode: string;
    qrcode_img_content: string;
  };
}

async function pollQRStatus(apiBaseUrl: string, qrcode: string) {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(
    `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
    base
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`轮询二维码状态失败: ${response.status} ${body}`);
    }
    return (await response.json()) as {
      status: string;
      bot_token?: string;
      ilink_bot_id?: string;
      baseurl?: string;
      ilink_user_id?: string;
    };
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === "AbortError") {
      return { status: "wait" };
    }
    throw error;
  }
}

function buildBaseInfo() {
  return { channel_version: process.env.WEIXIN_CHANNEL_VERSION || "web-1.0.0" };
}

function randomWechatUin() {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function generateWeixinClientId() {
  return `invest-agent:${Date.now()}-${randomBytes(4).toString("hex")}`;
}

async function sendWeixinTextMessage(params: {
  baseUrl: string;
  token: string;
  to: string;
  text: string;
  contextToken?: string;
}) {
  const base = params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`;
  const url = new URL("ilink/bot/sendmessage", base);
  const body = JSON.stringify({
    msg: {
      from_user_id: "",
      to_user_id: params.to,
      client_id: generateWeixinClientId(),
      message_type: WEIXIN_MESSAGE_TYPE_BOT,
      message_state: WEIXIN_MESSAGE_STATE_FINISH,
      item_list: [
        {
          type: WEIXIN_MESSAGE_ITEM_TEXT,
          text_item: { text: params.text },
        },
      ],
      context_token: params.contextToken || undefined,
    },
    base_info: buildBaseInfo(),
  });

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${params.token.trim()}`,
      "Content-Length": String(Buffer.byteLength(body, "utf-8")),
      "X-WECHAT-UIN": randomWechatUin(),
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(unreadable)");
    throw new Error(`微信主动推送失败: ${response.status} ${text.slice(0, 300)}`);
  }
}

class InvestAgentMobileBridge {
  private readonly agent = createAgent();
  private readonly backgroundJobs = new Set<string>();

  constructor(
    private readonly accountId: string,
    private readonly stateDir = config.weixin.stateDir
  ) {}

  async chat(request: {
    conversationId: string;
    text: string;
    media?: { type: string };
    contextToken?: string;
  }): Promise<{ text?: string }> {
    const conversationId = request.conversationId || `weixin-mobile-${this.accountId}`;
    const userContext = await resolveOrCreateChannelUser({
      channel: "weixin-mobile",
      backend: "codex",
      externalUserId: conversationId,
      externalAccountId: this.accountId,
      conversationId,
      contextToken: request.contextToken,
    });

    const isFirstConversation = !userContext.welcomedAt;

    if (request.conversationId) {
      saveWeixinAccount(
        this.accountId,
        {
          lastConversationId: request.conversationId,
          lastConversationAt: new Date().toISOString(),
          lastContextToken: request.contextToken,
        },
        this.stateDir
      );
    }

    if (request.media && !request.text) {
      return {
        text: "实验版暂只支持文本消息。图片、语音、文件会在后续多模态阶段支持。",
      };
    }

    if (isDailyReviewRequest(request.text || "")) {
      const jobKey = `${this.accountId}:${request.conversationId || "weixin-mobile"}:daily-review`;
      if (this.backgroundJobs.has(jobKey)) {
        await recordCodexAcpTrace({
          userId: userContext.userId,
          conversationId: request.conversationId || "weixin-mobile",
          channel: "weixin-mobile",
          userText: request.text || "",
          replyTextSanitized: "复盘正在生成中，我会在完成后直接发给你。",
          mode: "daily-review-ack",
          status: "success",
        });
        return {
          text: "复盘正在生成中，我会在完成后直接发给你。",
        };
      }

      this.backgroundJobs.add(jobKey);
      this.runBackgroundReview(request, jobKey, userContext).catch((error: unknown) => {
        logger.error("后台复盘任务异常:", error);
      });
      await recordCodexAcpTrace({
        userId: userContext.userId,
        conversationId: request.conversationId || "weixin-mobile",
        channel: "weixin-mobile",
        userText: request.text || "",
        replyTextSanitized: "收到，复盘已经开始生成。今天数据和提醒会先整理成事实、推断、操作和验证点，预计几分钟后发给你。",
        mode: "daily-review-ack",
        reviewContextSummary: { jobKey, asyncDelivery: true },
        status: "success",
      });
      return {
        text: "收到，复盘已经开始生成。今天数据和提醒会先整理成事实、推断、操作和验证点，预计几分钟后发给你。",
      };
    }

    const response = await this.agent.handleMessage({
      id: `wx-${Date.now()}`,
      from: request.conversationId || "weixin-mobile",
      timestamp: Date.now(),
      content: { type: "text", text: request.text || "" },
      context: {
        channel: "weixin-mobile",
        conversationId: request.conversationId,
        userId: userContext.userId,
        projectId: userContext.projectId,
        instanceId: userContext.instanceId,
        projectType: userContext.projectType,
        skillBundleId: userContext.skillBundleId,
        strategySkillId: userContext.strategySkillId,
        instanceExpansionPath: userContext.instanceExpansionPath,
        isFirstConversation,
      },
    });

    if (isFirstConversation) {
      await markChannelIdentityWelcomed(userContext.userId, "weixin-mobile", conversationId);
    }

    return { text: sanitizeCustomerText(response.content.text ?? "处理完成，但没有生成文本回复。") };
  }

  private async runBackgroundReview(
    request: {
      conversationId: string;
      text: string;
      media?: { type: string };
      contextToken?: string;
    },
    jobKey: string,
    userContext: UserContext
  ) {
    const startedAt = Date.now();
    try {
      logger.info(`开始后台 Codex 日复盘任务: ${jobKey}`);
      const response = await this.agent.handleMessage({
        id: `wx-bg-${Date.now()}`,
        from: request.conversationId || "weixin-mobile",
        timestamp: Date.now(),
        content: { type: "text", text: request.text || "" },
        context: {
          channel: "weixin-mobile",
          conversationId: request.conversationId,
          userId: userContext.userId,
          projectId: userContext.projectId,
          instanceId: userContext.instanceId,
          projectType: userContext.projectType,
          skillBundleId: userContext.skillBundleId,
          strategySkillId: userContext.strategySkillId,
          instanceExpansionPath: userContext.instanceExpansionPath,
          asyncDelivery: true,
        },
      });
      const text = sanitizeCustomerText(response.content.text ?? "复盘已完成，但没有生成文本回复。");
      await this.pushToConversation(request.conversationId, text, request.contextToken);
      await recordCodexAcpTrace({
        userId: userContext.userId,
        conversationId: request.conversationId || "weixin-mobile",
        channel: "weixin-mobile",
        userText: request.text || "",
        replyTextSanitized: text,
        mode: "daily-review-push",
        reviewContextSummary: { jobKey, asyncDelivery: true },
        status: "success",
        elapsedMs: Date.now() - startedAt,
      });
      logger.info(`后台 Codex 日复盘已推送: ${jobKey}`);
    } catch (error) {
      logger.error("后台 Codex 日复盘失败:", error);
      const errorMessage = formatUnknownError(error);
      await recordCodexAcpTrace({
        userId: userContext.userId,
        conversationId: request.conversationId || "weixin-mobile",
        channel: "weixin-mobile",
        userText: request.text || "",
        mode: "daily-review-push",
        reviewContextSummary: { jobKey, asyncDelivery: true },
        status: errorMessage.includes("超时") ? "timeout" : "error",
        errorMessage,
        elapsedMs: Date.now() - startedAt,
      });
      await this.pushToConversation(
        request.conversationId,
        "这次复盘生成超时了，我已记录异常，稍后可以重新发起一次。",
        request.contextToken
      ).catch((pushError: unknown) => {
        logger.warn("后台复盘失败提示推送失败:", pushError);
      });
    } finally {
      this.backgroundJobs.delete(jobKey);
    }
  }

  private async pushToConversation(conversationId: string, text: string, contextToken?: string) {
    const account = resolveWeixinAccount(this.accountId, this.stateDir);
    if (!account.configured || !account.token) {
      throw new Error(`账号 ${this.accountId} 未配置 token，无法推送后台复盘结果`);
    }
    await sendWeixinTextMessage({
      baseUrl: account.baseUrl,
      token: account.token,
      to: conversationId,
      text,
      contextToken: contextToken || account.lastContextToken,
    });
  }

  clearSession(conversationId?: string): void {
    if (conversationId) {
      void getCurrentAcpAgent().then((agent) => agent.clearSession(conversationId));
    }
  }
}

class HermesWeixinMobileBridge {
  constructor(
    private readonly accountId: string,
    private readonly stateDir: string,
    private readonly projectBinding?: {
      projectId: string;
      instanceId: string;
      hermesProfile?: string;
      sharedUsers?: boolean;
    }
  ) {}

  async chat(request: {
    conversationId: string;
    text: string;
    media?: { type: string };
    contextToken?: string;
  }): Promise<{ text?: string }> {
    const conversationId = request.conversationId || `hermes-weixin-${this.accountId}`;
    const userContext = await resolveOrCreateChannelUser({
      channel: "weixin-mobile",
      backend: "hermes",
      externalUserId: conversationId,
      externalAccountId: this.accountId,
      conversationId,
      contextToken: request.contextToken,
      projectBinding: this.projectBinding,
    });

    if (request.conversationId) {
      saveWeixinAccount(
        this.accountId,
        {
          lastConversationId: request.conversationId,
          lastConversationAt: new Date().toISOString(),
          lastContextToken: request.contextToken,
        },
        this.stateDir
      );
    }

    if (request.media && !request.text) {
      return {
        text: "Hermes 项目微信连接暂只支持文本消息。图片、语音、文件会在后续阶段支持。",
      };
    }

    const startedAt = Date.now();
    const remember = async (text: string) => {
      await rememberWeixinTurn(userContext, request.text || "", text);
      return { text };
    };

    const taskReply = await handlePendingConversationTaskTurn(userContext, request.text || "");
    if (taskReply) {
      const text = sanitizeCustomerText(taskReply);
      await recordCodexAcpTrace({
        userId: userContext.userId,
        projectId: userContext.projectId,
        instanceId: userContext.instanceId,
        conversationId,
        channel: "weixin-hermes",
        userText: request.text || "",
        replyTextSanitized: text,
        mode: "pending-conversation-task",
        status: "success",
        elapsedMs: Date.now() - startedAt,
      });
      return remember(text);
    }

    const isFirstConversation = !userContext.welcomedAt;
    const isSmalltalk = /^(你好|您好|哈喽|hello|hi|嗨|在吗|在不在|在|早\b|早上好|下午好|晚上好|晚安)/i.test((request.text || "").trim());

    if (isSmalltalk) {
      const onboardingState = await getOnboardingState(userContext.userId);
      const reminder = buildOnboardingReminder(onboardingState);
      const text = reminder ? `${FIXED_WELCOME_MESSAGE}\n\n${reminder}` : FIXED_WELCOME_MESSAGE;

      if (isFirstConversation) {
        await markChannelIdentityWelcomed(userContext.userId, "weixin-mobile", conversationId);
      }
      await recordCodexAcpTrace({
        userId: userContext.userId,
        projectId: userContext.projectId,
        instanceId: userContext.instanceId,
        conversationId,
        channel: "weixin-hermes",
        userText: request.text || "",
        replyTextSanitized: text,
        mode: isFirstConversation ? "onboarding-fixed" : "smalltalk-onboarding",
        status: "success",
        elapsedMs: Date.now() - startedAt,
      });
      return remember(text);
    }

    try {
      const adminReply = await tryFastAdminTool(userContext, request.text || "");
      if (adminReply) {
        const text = sanitizeCustomerText(adminReply.text);
        await recordCodexAcpTrace({
          userId: userContext.userId,
          projectId: userContext.projectId,
          instanceId: userContext.instanceId,
          conversationId,
          channel: "weixin-hermes",
          userText: request.text || "",
          replyTextSanitized: text,
          mode: adminReply.mode,
          status: "success",
          elapsedMs: Date.now() - startedAt,
        });
        return remember(text);
      }
    } catch (error) {
      logger.warn(`DeepSeek 快速管理员跳过: ${(error as Error).message}`);
    }

    try {
      const deterministicReply = await tryFastDeterministicReply(userContext, request.text || "");
      if (deterministicReply) {
        const text = sanitizeCustomerText(deterministicReply.text);
        await recordCodexAcpTrace({
          userId: userContext.userId,
          projectId: userContext.projectId,
          instanceId: userContext.instanceId,
          conversationId,
          channel: "weixin-hermes",
          userText: request.text || "",
          replyTextSanitized: text,
          mode: deterministicReply.mode,
          status: "success",
          elapsedMs: Date.now() - startedAt,
        });
        return remember(text);
      }
    } catch (error) {
      logger.warn(`确定性快链路跳过: ${(error as Error).message}`);
    }

    try {
      const fastIntentReply = await tryFastAlertIntent(userContext, request.text || "");
      if (fastIntentReply) {
        await recordCodexAcpTrace({
          userId: userContext.userId,
          projectId: userContext.projectId,
          instanceId: userContext.instanceId,
          conversationId,
          channel: "weixin-hermes",
          userText: request.text || "",
          replyTextSanitized: fastIntentReply,
          mode: "fast-alert-intent",
          status: "success",
          elapsedMs: Date.now() - startedAt,
        });
        return remember(fastIntentReply);
      }
    } catch (error) {
      logger.warn(`DeepSeek 快链路跳过: ${(error as Error).message}`);
    }

    const recentConversationContext = formatRecentMemoryForPrompt(await loadRecentWeixinMemory(userContext));
    let promptText: string;
    let mode = "chat";
    let reviewContextSummary: Record<string, unknown> | undefined;
    let sandboxTokenId: string | undefined;
    let sandboxPermissions: string[] | undefined;

    if (userContext.projectType !== "diet-recommendation" && isDailyReviewRequest(request.text || "")) {
      mode = "daily-review";
      const reviewContext = await buildDailyReviewContext({ userId: userContext.userId, instanceId: userContext.instanceId });
      const promptContext = await buildAcpPromptContext({
        userText: request.text || "请生成今日复盘",
        reviewContext,
        userContext,
        recentConversationContext,
        isFirstConversation,
      });
      promptText = promptContext.promptText;
      reviewContextSummary = promptContext.reviewContextSummary;
      sandboxTokenId = promptContext.sandboxContext.tokenId;
      sandboxPermissions = promptContext.sandboxContext.permissions;
    } else {
      const promptContext = await buildAcpPromptContext({
        userText: request.text || "",
        userContext,
        recentConversationContext,
        isFirstConversation,
      });
      promptText = promptContext.promptText;
      sandboxTokenId = promptContext.sandboxContext.tokenId;
      sandboxPermissions = promptContext.sandboxContext.permissions;
    }

    try {
      const acpAgent = await getCurrentAcpAgent();
      const raw = await acpAgent.chat({
        conversationId,
        text: promptText,
        messageId: randomUUID(),
      });
      const intentReply = await handleAiIntentDraftTurn(userContext, raw);
      if (intentReply) {
        await recordCodexAcpTrace({
          userId: userContext.userId,
          projectId: userContext.projectId,
          instanceId: userContext.instanceId,
          conversationId,
          channel: "weixin-hermes",
          userText: request.text || "",
          promptText,
          replyTextSanitized: intentReply,
          mode: "intent-draft",
          reviewContextSummary,
          sandboxTokenId,
          sandboxPermissions,
          status: "success",
          elapsedMs: Date.now() - startedAt,
        });
        return remember(intentReply);
      }
      const text = sanitizeCustomerText(raw);
      await recordCodexAcpTrace({
        userId: userContext.userId,
        projectId: userContext.projectId,
        instanceId: userContext.instanceId,
        conversationId,
        channel: "weixin-hermes",
        userText: request.text || "",
        promptText,
        replyTextSanitized: text,
        mode,
        reviewContextSummary,
        sandboxTokenId,
        sandboxPermissions,
        status: "success",
        elapsedMs: Date.now() - startedAt,
      });
      if (isFirstConversation) {
        await markChannelIdentityWelcomed(userContext.userId, "weixin-mobile", conversationId);
      }
      return remember(text);
    } catch (error) {
      const errorMessage = formatUnknownError(error);
      await recordCodexAcpTrace({
        userId: userContext.userId,
        projectId: userContext.projectId,
        instanceId: userContext.instanceId,
        conversationId,
        channel: "weixin-hermes",
        userText: request.text || "",
        promptText,
        mode,
        reviewContextSummary,
        sandboxTokenId,
        sandboxPermissions,
        status: errorMessage.includes("超时") ? "timeout" : "error",
        errorMessage,
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  clearSession(conversationId?: string): void {
    if (conversationId) {
      void getCurrentAcpAgent().then((agent) => agent.clearSession(conversationId));
    }
  }
}

export class WeixinMobileManager {
  private state: WeixinConnectState = {
    enabled: false,
    backend: "codex",
    stage: "idle",
    stateDir: resolveWeixinStateDir(),
    message: "未连接微信",
    updatedAt: new Date().toISOString(),
    listenerRunning: false,
  };

  private loginSession: WeixinLoginSession | null = null;
  private listenerAbortControllers = new Map<string, AbortController>();
  private loginPollTask: Promise<void> | null = null;
  private readonly backend: WeixinBackend;
  private readonly stateDir: string;
  private readonly label: string;
  private readonly projectBinding?: {
    projectId: string;
    instanceId: string;
    hermesProfile?: string;
    sharedUsers?: boolean;
  };

  constructor(
    private readonly options: {
      backend?: WeixinBackend;
      stateDir?: string;
      label?: string;
      projectBinding?: {
        projectId: string;
        instanceId: string;
        ownerUserId?: string;
        ownerDisplayName?: string;
        hermesProfile?: string;
        sharedUsers?: boolean;
      };
    } = {}
  ) {
    this.backend = this.options.backend ?? "codex";
    this.stateDir = this.options.stateDir ?? config.weixin.stateDir;
    this.label = this.options.label ?? "微信";
    this.projectBinding = this.options.projectBinding;
    this.state.backend = this.backend;
    this.state.stateDir = resolveWeixinStateDir(this.stateDir);
    this.state.message = `未连接${this.label}`;

    const accounts = this.accountSummaries();
    const account = accounts[accounts.length - 1];
    if (account) {
      this.state = {
        enabled: true,
        backend: this.backend,
        stage: "connected",
        stateDir: resolveWeixinStateDir(this.stateDir),
        accountId: account.accountId,
        message: `已连接${this.label}账号 ${accounts.length} 个`,
        updatedAt: new Date().toISOString(),
        listenerRunning: accounts.some((item) => item.listenerRunning),
        lastConversationId: account.lastConversationId,
        lastConversationAt: account.lastConversationAt,
        pushReady: accounts.some((item) => item.pushReady),
        accounts,
      };
    }
  }

  getState(): WeixinConnectState {
    return { ...this.state, ...this.accountStatePatch() };
  }

  async startLogin(force = false): Promise<WeixinConnectState> {
    if (!force && this.state.stage === "waiting_scan" && this.loginSession && isLoginFresh(this.loginSession)) {
      return this.withState({
        qrcodeUrl: this.loginSession.qrcodeUrl,
        sessionKey: this.loginSession.sessionKey,
        message: "二维码已生成，请扫码。",
      });
    }

    const qr = await fetchQRCode(DEFAULT_BASE_URL, "3");
    this.loginSession = {
      sessionKey: randomUUID(),
      qrcode: qr.qrcode,
      qrcodeUrl: qr.qrcode_img_content,
      startedAt: Date.now(),
      refreshCount: 1,
    };

    const qrcodeDataUrl = await QRCode.toDataURL(qr.qrcode_img_content, {
      width: 260,
      margin: 1,
      errorCorrectionLevel: "M",
    });

    this.withState({
      enabled: this.accountSummaries().length > 0,
      stage: "waiting_scan",
      qrcodeUrl: qr.qrcode_img_content,
      qrcodeDataUrl,
      sessionKey: this.loginSession.sessionKey,
      message: `请使用微信扫码连接${this.label}。`,
      lastError: undefined,
    });

    this.ensurePolling();
    return this.getState();
  }

  stop() {
    const stoppedCount = this.listenerAbortControllers.size;
    for (const controller of this.listenerAbortControllers.values()) {
      controller.abort();
    }
    this.listenerAbortControllers.clear();
    this.loginSession = null;
    this.loginPollTask = null;
    this.withState({
      enabled: this.accountSummaries().length > 0,
      stage: this.accountSummaries().length > 0 ? "connected" : "idle",
      qrcodeUrl: undefined,
      qrcodeDataUrl: undefined,
      sessionKey: undefined,
      message: stoppedCount > 0 ? `已停止${this.label}监听 ${stoppedCount} 个账号` : `当前没有运行中的${this.label}监听`,
      listenerRunning: false,
    });
  }

  async ensureListenerStarted(accountId?: string) {
    syncWeixinSdkStateDirEnv(this.stateDir);
    const accountIds = accountId ? [normalizeAccountId(accountId)] : listWeixinAccountIds(this.stateDir);
    if (accountIds.length === 0) {
      throw new Error("当前没有已连接的微信账号");
    }

    const started: string[] = [];
    for (const id of accountIds) {
      if (await this.startAccountListener(id)) {
        started.push(id);
      }
    }

    const accounts = this.accountSummaries();
    this.withState({
      enabled: accounts.length > 0,
      stage: accounts.length > 0 ? "connected" : this.state.stage,
      accountId: started[started.length - 1] || this.state.accountId || accounts[accounts.length - 1]?.accountId,
      listenerRunning: this.listenerAbortControllers.size > 0,
      message: started.length > 0
        ? `${this.label}消息监听中：${started.length} 个账号`
        : `${this.label}已无新增账号需要启动监听`,
    });
  }

  async simulateIncomingText(input: {
    text: string;
    conversationId: string;
    accountId?: string;
    contextToken?: string;
  }): Promise<{ text?: string; accountId: string; conversationId: string }> {
    const accountId = normalizeAccountId(input.accountId || this.state.accountId || `${this.backend}-simulator`);
    const bridge =
      this.backend === "hermes"
        ? new HermesWeixinMobileBridge(accountId, this.stateDir, this.projectBinding)
        : new InvestAgentMobileBridge(accountId, this.stateDir);
    const response = await bridge.chat({
      conversationId: input.conversationId,
      text: input.text,
      contextToken: input.contextToken,
    });
    return {
      ...response,
      accountId,
      conversationId: input.conversationId,
    };
  }

  private async startAccountListener(accountId: string): Promise<boolean> {
    const account = resolveWeixinAccount(accountId, this.stateDir);
    if (!account.configured || !account.accountId) {
      logger.warn(`${this.label}监听跳过：账号 ${accountId} 未配置 token`);
      return false;
    }
    if (this.listenerAbortControllers.has(account.accountId)) {
      return false;
    }

    const { start } = await loadWeixinSdk(this.stateDir);
    initDb();
    const bridge =
      this.backend === "hermes"
        ? new HermesWeixinMobileBridge(account.accountId, this.stateDir, this.projectBinding)
        : new InvestAgentMobileBridge(account.accountId, this.stateDir);
    const abortController = new AbortController();
    this.listenerAbortControllers.set(account.accountId, abortController);

    start(bridge, {
      accountId: account.accountId,
      abortSignal: abortController.signal,
      log: (msg) => logger.info(`[weixin-mobile:${this.backend}:${account.accountId}] ${msg}`),
    }).catch((error) => {
      this.listenerAbortControllers.delete(account.accountId);
      this.withState({
        stage: "error",
        listenerRunning: this.listenerAbortControllers.size > 0,
        message: `${this.label}账号 ${account.accountId} 消息监听异常退出`,
        lastError: (error as Error).message,
      });
      logger.error(`${this.label}账号 ${account.accountId} 消息监听失败:`, error);
    });
    return true;
  }

  async pushText(message: string, options: { userId?: string; instanceId?: string } = {}): Promise<boolean> {
    const accounts = listWeixinAccountIds(this.stateDir)
      .map((accountId) => resolveWeixinAccount(accountId, this.stateDir))
      .filter((account) => account.configured && account.accountId && account.token);
    if (accounts.length === 0) {
      logger.warn("微信主动推送跳过：当前没有已连接账号");
      return false;
    }

    for (const account of accounts.slice().reverse()) {
      const target = await resolvePushConversation({
        accountId: account.accountId,
        backend: this.backend,
        userId: options.userId,
        instanceId: options.instanceId,
        fallbackConversationId: account.lastConversationId,
        fallbackContextToken: account.lastContextToken,
      });
      if (!target.conversationId || !account.token) {
        continue;
      }

      await sendWeixinTextMessage({
        baseUrl: account.baseUrl,
        token: account.token,
        to: target.conversationId,
        text: sanitizeCustomerText(message),
        contextToken: target.contextToken,
      });
      this.withState({
        accountId: account.accountId,
        lastConversationId: target.conversationId,
        lastConversationAt: account.lastConversationAt,
        pushReady: true,
        lastError: undefined,
      });
      return true;
    }

    const latest = accounts[accounts.length - 1];
    if (!latest) {
      return false;
    }
    {
      logger.warn(`微信主动推送跳过：用户 ${options.userId || DEFAULT_USER_ID} 尚无最近会话，请先让该用户给助手发送一条消息`);
      this.withState({
        accountId: latest.accountId,
        lastConversationId: latest.lastConversationId,
        lastConversationAt: latest.lastConversationAt,
        pushReady: false,
        lastError: "尚无最近会话，无法主动推送",
      });
      return false;
    }
  }

  private ensurePolling() {
    if (this.loginPollTask) return;
    this.loginPollTask = this.pollUntilConnected().finally(() => {
      this.loginPollTask = null;
    });
  }

  private async pollUntilConnected() {
    while (this.loginSession && isLoginFresh(this.loginSession)) {
      try {
        const result = await pollQRStatus(DEFAULT_BASE_URL, this.loginSession.qrcode);

        if (result.status === "scaned") {
          this.withState({
            stage: "scanned",
            message: "已扫码，请在微信中确认登录。",
          });
          continue;
        }

        if (result.status === "wait") {
          continue;
        }

        if (result.status === "expired") {
          if (!this.loginSession) return;
          this.loginSession.refreshCount += 1;
          if (this.loginSession.refreshCount > MAX_QR_REFRESH_COUNT) {
            this.withState({
              stage: "error",
              message: "二维码已多次过期，请重新生成。",
              lastError: "二维码过期",
            });
            this.loginSession = null;
            return;
          }

          const qr = await fetchQRCode(DEFAULT_BASE_URL, "3");
          this.loginSession.qrcode = qr.qrcode;
          this.loginSession.qrcodeUrl = qr.qrcode_img_content;
          this.loginSession.startedAt = Date.now();
          const qrcodeDataUrl = await QRCode.toDataURL(qr.qrcode_img_content, {
            width: 260,
            margin: 1,
            errorCorrectionLevel: "M",
          });
          this.withState({
            stage: "waiting_scan",
            qrcodeUrl: qr.qrcode_img_content,
            qrcodeDataUrl,
            message: `二维码已刷新（${this.loginSession.refreshCount}/${MAX_QR_REFRESH_COUNT}）`,
          });
          continue;
        }

        if (result.status === "confirmed") {
          if (!result.bot_token || !result.ilink_bot_id) {
            throw new Error("扫码已确认，但没有拿到 bot token 或账号 ID");
          }

          const accountId = normalizeAccountId(result.ilink_bot_id);
          saveWeixinAccount(
            accountId,
            {
              token: result.bot_token,
              baseUrl: result.baseurl || DEFAULT_BASE_URL,
              userId: result.ilink_user_id,
            },
            this.stateDir
          );
          registerWeixinAccountId(accountId, this.stateDir);

          this.loginSession = null;
          this.withState({
            enabled: true,
            stage: "connected",
            accountId,
            qrcodeUrl: undefined,
            qrcodeDataUrl: undefined,
            sessionKey: undefined,
            message: `${this.label}连接成功：${accountId}`,
            lastError: undefined,
          });
          await this.ensureListenerStarted(accountId);
          return;
        }
      } catch (error) {
        this.withState({
          stage: "error",
          message: "微信连接过程中出现异常",
          lastError: (error as Error).message,
        });
        logger.error("微信登录轮询失败:", error);
        return;
      }
    }

    if (this.loginSession && !isLoginFresh(this.loginSession)) {
      this.withState({
        stage: "error",
        message: "二维码已过期，请重新生成。",
        lastError: "二维码过期",
      });
      this.loginSession = null;
    }
  }

  private withState(patch: Partial<WeixinConnectState>) {
    const next = {
      ...this.state,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.state = {
      ...next,
      ...this.accountStatePatch(next),
    };
    return this.state;
  }

  private accountSummaries(): NonNullable<WeixinConnectState["accounts"]> {
    const summaries: NonNullable<WeixinConnectState["accounts"]> = [];
    for (const accountId of listWeixinAccountIds(this.stateDir)) {
      const account = resolveWeixinAccount(accountId, this.stateDir);
      if (!account.configured || !account.accountId) continue;
      summaries.push({
        accountId: account.accountId,
        listenerRunning: this.listenerAbortControllers.has(account.accountId),
        lastConversationId: account.lastConversationId,
        lastConversationAt: account.lastConversationAt,
        pushReady: Boolean(account.lastConversationId),
      });
    }
    return summaries;
  }

  private accountStatePatch(base: WeixinConnectState = this.state): Partial<WeixinConnectState> {
    const accounts = this.accountSummaries();
    const preferred =
      accounts.find((account) => account.accountId === base.accountId) ||
      accounts[accounts.length - 1];
    return {
      accounts,
      enabled: accounts.length > 0 || base.enabled,
      accountId: preferred?.accountId || base.accountId,
      listenerRunning: accounts.some((account) => account.listenerRunning),
      lastConversationId: base.lastConversationId || preferred?.lastConversationId,
      lastConversationAt: base.lastConversationAt || preferred?.lastConversationAt,
      pushReady: accounts.some((account) => account.pushReady) || Boolean(base.pushReady),
    };
  }
}

export const weixinMobileManager = new WeixinMobileManager();
export const hermesWeixinMobileManager = new WeixinMobileManager({
  backend: "hermes",
  stateDir: path.join(config.weixin.stateDir, "hermes-bypass"),
  label: "Hermes 项目微信",
});
export const dietWeixinMobileManager = new WeixinMobileManager({
  backend: "hermes",
  stateDir: path.join(config.weixin.stateDir, "diet-recommendation-weixin"),
  label: "饮食推荐助手微信",
  projectBinding: {
    projectId: DIET_RECOMMENDATION_PROJECT_ID,
    instanceId: DIET_RECOMMENDATION_SHARED_INSTANCE_ID,
    hermesProfile: "diet-recommendation",
    sharedUsers: true,
  },
});
