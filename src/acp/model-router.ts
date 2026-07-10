import { callDeepSeek } from "../services/deepseek.js";
import { logger } from "../lib/logger.js";
import type { ContextPacket } from "./context-packet.js";

export type AcpModelTier = "simple" | "complex";

export interface ChatModelRouteInput {
  text: string;
  contextPacket?: ContextPacket;
}

export interface ChatRouteDecision {
  tier: AcpModelTier;
  confidence: number;
  category: string;
  reason: string;
}

type ChatRouteJudge = (input: {
  userMessage: string;
  systemPrompt: string;
}) => Promise<string>;

const ROUTER_TIMEOUT_MS = Number(process.env.ACP_MODEL_ROUTER_TIMEOUT_MS) || 3_000;

export async function resolveChatModelTier(
  input: string | ChatModelRouteInput,
  options: { judge?: ChatRouteJudge; routerEnabled?: boolean; simpleEnabled?: boolean } = {},
): Promise<AcpModelTier> {
  const routeInput = typeof input === "string" ? { text: input } : input;
  const text = routeInput.text.trim();
  if (!text) return "complex";
  if (options.simpleEnabled === false || (options.simpleEnabled === undefined && !isSimpleModelTierEnabled())) {
    logger.info("ACP simple model tier disabled, using complex tier");
    return "complex";
  }
  if (options.routerEnabled === false || (options.routerEnabled === undefined && !isChatModelRouterEnabled())) {
    logger.info("ACP model route disabled, using complex tier");
    return "complex";
  }

  try {
    const raw = await withTimeout(
      (options.judge || defaultChatRouteJudge)({
        userMessage: buildRouteUserMessage(routeInput),
        systemPrompt: buildRouteSystemPrompt(),
      }),
      ROUTER_TIMEOUT_MS,
    );
    const decision = parseChatRouteDecision(raw);
    logger.info(
      `ACP model route tier=${decision.tier} confidence=${decision.confidence} category=${decision.category} reason=${decision.reason.slice(0, 120)}`,
    );
    return decision.tier;
  } catch (error) {
    logger.warn(`ACP model route failed, fallback to complex: ${(error as Error).message}`);
    return "complex";
  }
}

export function resolveScheduledModelTier(mode: string): AcpModelTier {
  if (/^scheduled-(daily|weekly|monthly)-review$/.test(mode)) return "complex";
  return isSimpleModelTierEnabled() ? "simple" : "complex";
}

export function isChatModelRouterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ACP_MODEL_ROUTER_ENABLED;
  if (raw === undefined || raw.trim() === "") return true;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

export function isSimpleModelTierEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ACP_SIMPLE_MODEL_ENABLED;
  if (raw === undefined || raw.trim() === "") return false;
  return ["1", "true", "on", "yes"].includes(raw.trim().toLowerCase());
}

export function parseChatRouteDecision(raw: string): ChatRouteDecision {
  const value = parseJsonObject(raw);
  const tier = value.tier === "simple" || value.tier === "complex" ? value.tier : undefined;
  if (!tier) throw new Error("route decision missing valid tier");
  const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence)
    ? Math.max(0, Math.min(1, value.confidence))
    : 0;
  return {
    tier,
    confidence,
    category: String(value.category || "unknown").slice(0, 80),
    reason: String(value.reason || "").slice(0, 240),
  };
}

async function defaultChatRouteJudge(input: {
  userMessage: string;
  systemPrompt: string;
}) {
  return callDeepSeek(input.userMessage, input.systemPrompt, [], {
    profile: "light",
    thinking: false,
    temperature: 0,
    maxTokens: 300,
  });
}

function buildRouteSystemPrompt() {
  return [
    "你是投资助手的模型路由裁判，只判断下一步该用 simple 还是 complex 模型，不回答用户问题。",
    "simple: 低风险、低推理量的状态查询、列表读取、寒暄、明确确认/取消、无需投资判断的操作。",
    "complex: 任何投资判断、买卖/持有/卖出建议、复盘、选股、筛选、研究、估值、财报、公告解读、策略匹配、预案起草、含糊但可能涉及投资决策的短句。",
    "短句不代表 simple；如“能买吗”“怎么看”“要不要卖”“这个票怎么样”必须判 complex。",
    "如果上下文显示用户在延续一个投资判断/预案/复盘/筛选任务，即使当前消息很短，也判 complex。",
    "只输出严格 JSON，不要 Markdown，不要解释前后缀。",
    'JSON schema: {"tier":"simple|complex","confidence":0-1,"category":"string","reason":"string"}',
  ].join("\n");
}

function buildRouteUserMessage(input: ChatModelRouteInput) {
  const packet = input.contextPacket;
  const lines: string[] = [];
  lines.push(`当前用户消息: ${input.text}`);
  if (packet?.recentConversation?.length) {
    lines.push("最近对话(最多4条):");
    for (const message of packet.recentConversation.slice(-4)) {
      lines.push(`- ${message.role}: ${compact(message.content, 180)}`);
    }
  }
  if (packet?.pendingConfirmations?.length) {
    lines.push("待确认事项:");
    for (const item of packet.pendingConfirmations.slice(0, 4)) {
      lines.push(`- ${item.kind}: ${compact(item.summary, 160)}`);
    }
  }
  if (packet?.stateSummary) {
    lines.push(
      `状态摘要: 持仓${packet.stateSummary.portfolioCount}, 自选${packet.stateSummary.watchlistCount}, 提醒${packet.stateSummary.alertCount}, 预案${packet.stateSummary.planCount}, 最新复盘${packet.stateSummary.latestReviewDate ?? "无"}`,
    );
  }
  return lines.join("\n");
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const text = String(raw || "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || text;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error("route judge response is not JSON");
  }
}

function compact(value: string, max: number) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`route judge timeout ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}
