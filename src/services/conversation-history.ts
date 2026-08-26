import type { MastraMessage } from "../mastra/types.js";
import { logger } from "../lib/logger.js";
import { sqlite } from "../db/index.js";

const DEFAULT_LIMIT = 24;
const DEFAULT_MAX_CHARS_PER_MESSAGE = 2400;
const DEFAULT_TOTAL_CHARS_BUDGET = 24_000;

export interface LoadConversationHistoryInput {
  conversationId: string;
  /** request_id of the in-flight turn; its already-persisted user row must not
   * re-enter the model context (runMastraTurn appends the current text). */
  excludeRequestId?: string;
  /** Newest-row guard: some channels persist the current user message without
   * a shared request id; drop it when it exactly matches the current text. */
  excludeCurrentText?: string;
  limit?: number;
  maxCharsPerMessage?: number;
  totalCharsBudget?: number;
}

interface HistoryRow {
  role: string;
  content: string;
  request_id: string | null;
}

/**
 * Read the authoritative conversation_messages table for one conversation and
 * map it to caller-owned Mastra history. The adapter never persists and never
 * reads other conversations. Failures degrade to empty history so a memory
 * outage can never take the interactive turn down.
 */
export function loadConversationHistory(input: LoadConversationHistoryInput): MastraMessage[] {
  if (!input.conversationId) return [];
  const limit = input.limit ?? DEFAULT_LIMIT;
  try {
    const rows = sqlite
      .prepare(
        `SELECT role, content, request_id FROM conversation_messages
         WHERE conversation_id = ?
           AND role IN ('user', 'assistant')
           AND status NOT IN ('failed', 'superseded')
           AND (? IS NULL OR request_id IS NULL OR request_id != ?)
         ORDER BY created_at DESC, message_id DESC
         LIMIT ? * 2`
      )
      .all(input.conversationId, input.excludeRequestId ?? null, input.excludeRequestId ?? null, limit) as HistoryRow[];
    let ordered = rows.reverse();
    if (input.excludeCurrentText && ordered.length > 0) {
      const newest = ordered[ordered.length - 1];
      if (newest.role === "user" && newest.content.trim() === input.excludeCurrentText.trim()) {
        ordered = ordered.slice(0, -1);
      }
    }
    return applyBudget(ordered, {
      limit,
      maxCharsPerMessage: input.maxCharsPerMessage ?? DEFAULT_MAX_CHARS_PER_MESSAGE,
      totalCharsBudget: input.totalCharsBudget ?? DEFAULT_TOTAL_CHARS_BUDGET,
    });
  } catch (error) {
    logger.warn(`会话历史读取失败 conversationId=${input.conversationId}: ${(error as Error).message}`);
    return [];
  }
}

function applyBudget(
  rows: HistoryRow[],
  budget: { limit: number; maxCharsPerMessage: number; totalCharsBudget: number },
): MastraMessage[] {
  // Walk newest → oldest so the budget always drops the oldest overflow, then
  // restore chronological order for the model.
  const newestFirst: MastraMessage[] = [];
  let used = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (newestFirst.length >= budget.limit) break;
    const content = row.content.length > budget.maxCharsPerMessage
      ? `${row.content.slice(0, budget.maxCharsPerMessage)}…[截断]`
      : row.content;
    if (used + content.length > budget.totalCharsBudget && newestFirst.length > 0) break;
    newestFirst.push({ role: row.role as "user" | "assistant", content });
    used += content.length;
  }
  return newestFirst.reverse();
}
