import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { chatHistory } from "../db/schema.js";
import { logger } from "./logger.js";
import { DEFAULT_INSTANCE_ID, type UserContext } from "./user-context.js";

const MEMORY_LIMIT = 12;

const EVENT_TYPE = "conversation_turn";
const LEGACY_WEIXIN_EVENT_TYPE = "wechat_conversation_turn";

export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export async function rememberConversationTurn(userContext: UserContext, userText: string, assistantText: string) {
  const now = new Date().toISOString();
  const instanceId = userContext.instanceId ?? DEFAULT_INSTANCE_ID;
  try {
    await db.insert(chatHistory).values([
      {
        userId: userContext.userId,
        instanceId,
        conversationId: userContext.conversationId ?? null,
        role: "user",
        content: compactContent(userText),
        createdAt: now,
      },
      {
        userId: userContext.userId,
        instanceId,
        conversationId: userContext.conversationId ?? null,
        role: "assistant",
        content: compactContent(assistantText),
        createdAt: now,
      },
    ]);
  } catch (error) {
    logger.warn("短期对话记忆写入失败:", error);
  }
}

export async function rememberWeixinTurn(userContext: UserContext, userText: string, assistantText: string) {
  return rememberConversationTurn({ ...userContext, channel: userContext.channel ?? "weixin-mobile" }, userText, assistantText);
}

export interface WeixinMemoryLoadOptions {
  scope?: "user_instance" | "conversation";
}

export async function loadRecentConversationMemory(
  userContext: UserContext,
  limit = MEMORY_LIMIT,
  options: WeixinMemoryLoadOptions = {}
): Promise<ConversationMessage[]> {
  const instanceId = userContext.instanceId ?? DEFAULT_INSTANCE_ID;
  const conversationId = options.scope === "conversation" ? userContext.conversationId : undefined;
  return loadRecentFromSQLite(userContext, instanceId, conversationId, limit);
}

export async function loadRecentWeixinMemory(
  userContext: UserContext,
  limit = MEMORY_LIMIT,
  options: WeixinMemoryLoadOptions = {}
): Promise<ConversationMessage[]> {
  return loadRecentConversationMemory(userContext, limit, options);
}

async function loadRecentFromSQLite(userContext: UserContext, instanceId: string, conversationId: string | undefined, limit: number): Promise<ConversationMessage[]> {
  const filters = [
    eq(chatHistory.userId, userContext.userId),
    eq(chatHistory.instanceId, instanceId),
  ];
  if (conversationId) {
    filters.push(eq(chatHistory.conversationId, conversationId));
  }
  const rows = await db
    .select()
    .from(chatHistory)
    .where(and(...filters))
    .orderBy(desc(chatHistory.createdAt), desc(chatHistory.id))
    .limit(limit);

  return rows
    .reverse()
    .map((row) => ({
      role: row.role === "assistant" ? "assistant" : "user",
      content: row.content,
    }));
}

/**
 * 从 memory/behavior_events.jsonl 读取最近 limit 条消息。
 *
 * limit 语义与 SQLite 路径一致:消息条数(一轮对话 = user + assistant = 2 条)。
 *
 * behavior_events.jsonl 是混合事件流(action_confirmed / out_of_scope_query / conversation_turn),
 * 这里只筛 conversation_turn,并兼容历史 wechat_conversation_turn,按写入顺序展开为 user/assistant 消息对,再取最后 limit 条。
 *
 * conversationId 作为可选过滤项:为 null/空时不过滤(读取所有 conversation 的最近对话)。
 */
export function formatRecentMemoryForPrompt(messages: ConversationMessage[]) {
  if (messages.length === 0) return "";
  return messages
    .map((message) => `${message.role === "assistant" ? "助手" : "用户"}：${message.content}`)
    .join("\n");
}

export function hasContextReference(text: string) {
  return /(上面|刚才|前面|上一条|前一条|这些|这几个|那几个|全部|它们|他们|第二个|第2个|第一个|第1个|第三个|第3个)/.test(text);
}

export function extractRecentStockRefs(messages: ConversationMessage[], maxCount?: number) {
  const refs: Array<{ code?: string; name?: string }> = [];
  const seen = new Set<string>();
  const joined = messages.map((message) => message.content).join("\n");
  const nameCodePattern = /([一-龥A-Za-z0-9·*]{2,30})[（(](\d{6})[）)]/g;
  for (const match of joined.matchAll(nameCodePattern)) {
    const name = cleanupName(match[1]);
    const code = match[2];
    if (!code || seen.has(code)) continue;
    seen.add(code);
    refs.push({ code, name: name || undefined });
  }

  for (const match of joined.matchAll(/\b(\d{6})\b/g)) {
    const code = match[1];
    if (seen.has(code)) continue;
    seen.add(code);
    refs.push({ code });
  }

  return typeof maxCount === "number" && maxCount > 0 ? refs.slice(-maxCount) : refs;
}

export function inferReferencedStockCount(text: string) {
  const explicit = text.match(/(?:这|那|上面|刚才)?\s*([一二三四五六七八九十\d]+)\s*(?:个|只|支)/)?.[1];
  if (!explicit) return undefined;
  const parsed = parseChineseNumber(explicit);
  return parsed > 0 ? parsed : undefined;
}

function compactContent(value: string) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function cleanupName(value: string) {
  return value
    .replace(/^[-\d.、\s]+/, "")
    .replace(/^(股票|标的|自选股|持仓|提醒|目标|支撑|压力)+/, "")
    .trim()
    .slice(0, 24);
}

function parseChineseNumber(value: string) {
  if (/^\d+$/.test(value)) return Number(value);
  const map: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  if (value === "十") return 10;
  if (value.includes("十")) {
    const [ten, unit] = value.split("十");
    return (ten ? map[ten] ?? 0 : 1) * 10 + (unit ? map[unit] ?? 0 : 0);
  }
  return map[value] ?? 0;
}
