import { db } from "../db/index.js";
import { codexAcpTraces } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { redactSensitiveText } from "../lib/customer-output.js";

const TEXT_LIMIT = 8000;
const ERROR_LIMIT = 1200;

type TraceStatus = "success" | "timeout" | "error";

export interface AcpTraceInput {
  userId?: string;
  projectId?: string;
  instanceId?: string;
  conversationId: string;
  messageId?: string;
  channel: string;
  userText: string;
  promptText?: string;
  replyTextRaw?: string;
  replyTextSanitized?: string;
  mode: string;
  reviewContextSummary?: unknown;
  sandboxTokenId?: string;
  sandboxPermissions?: string[];
  status: TraceStatus;
  errorMessage?: string;
  elapsedMs?: number;
}

function truncate(value: unknown, limit = TEXT_LIMIT) {
  if (value === undefined || value === null) return undefined;
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const text = redactSensitiveText(raw);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

export async function recordAcpTrace(input: AcpTraceInput) {
  try {
    await db.insert(codexAcpTraces).values({
      userId: truncate(input.userId, 120) ?? DEFAULT_USER_ID,
      projectId: truncate(input.projectId, 120) ?? DEFAULT_PROJECT_ID,
      instanceId: truncate(input.instanceId, 180) ?? DEFAULT_INSTANCE_ID,
      conversationId: truncate(input.conversationId, 300) ?? "unknown",
      messageId: truncate(input.messageId, 300),
      channel: truncate(input.channel, 120) ?? "unknown",
      userText: truncate(input.userText) ?? "",
      promptText: truncate(input.promptText),
      replyTextRaw: truncate(input.replyTextRaw),
      replyTextSanitized: truncate(input.replyTextSanitized),
      mode: truncate(input.mode, 120) ?? "chat",
      reviewContextSummary: truncate(input.reviewContextSummary, 2000),
      sandboxTokenId: truncate(input.sandboxTokenId, 120),
      sandboxPermissions: truncate(input.sandboxPermissions, 1000),
      status: input.status,
      errorMessage: truncate(input.errorMessage, ERROR_LIMIT),
      elapsedMs: input.elapsedMs,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.warn("ACP trace 写入失败:", error);
  }
}
