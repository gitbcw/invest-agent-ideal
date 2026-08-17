import { db } from "../db/index.js";
import { agentTraces } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_PROJECT_ID, DEFAULT_USER_ID } from "../lib/user-context.js";
import { redactSensitiveText } from "../lib/customer-output.js";
import { computeModelCost } from "../services/model-pricing.js";
import { recordModelFeedback } from "../services/model-health.js";

const TEXT_LIMIT = 8000;
const ERROR_LIMIT = 1200;
const JSON_FIELD_LIMIT = 16_000;
const STORE_PROMPT_TEXT = process.env.AGENT_TRACE_STORE_PROMPT_TEXT === "true";
const STORE_RAW_REPLY = process.env.AGENT_TRACE_STORE_RAW_REPLY === "true";

type TraceStatus = "success" | "timeout" | "error";

export interface AgentTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  totalTokens?: number;
  contextWindowUsed?: number;
  contextWindowSize?: number;
  costAmount?: number;
  costCurrency?: string;
  source?: string;
  raw?: unknown;
}

export interface AgentTraceInput {
  traceId?: string;
  runId?: string;
  taskId?: string;
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
  agentBackend?: string;
  agentModel?: string;
  modelSource?: string;
  toolManifest?: unknown;
  toolCalls?: unknown;
  status: TraceStatus;
  errorMessage?: string;
  elapsedMs?: number;
  firstTokenMs?: number;
  usage?: AgentTokenUsage;
}

function truncate(value: unknown, limit = TEXT_LIMIT) {
  if (value === undefined || value === null) return undefined;
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  const text = redactSensitiveText(raw);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

function serializeJsonForStorage(value: unknown, limit = JSON_FIELD_LIMIT) {
  if (value === undefined || value === null) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = JSON.stringify({ serializationError: true });
  }
  if (serialized === undefined) return undefined;
  const redacted = redactSensitiveText(serialized);
  if (redacted.length <= limit) return redacted;

  const envelope = (preview: string) => JSON.stringify({
    truncated: true,
    originalChars: redacted.length,
    preview,
  });
  let preview = redacted.slice(0, Math.max(0, limit - 160));
  while (preview.length > 0 && envelope(preview).length > limit) preview = preview.slice(0, -64);
  return envelope(preview);
}

/** Records bounded, redacted agent observability independently of any transport. */
export async function recordAgentTrace(input: AgentTraceInput) {
  try {
    // E10: costs are priced at write time so a trace row is the cost record
    // (per-model registry; provider-reported cost wins when present). The
    // computed source rides along in the bounded usageRaw envelope.
    const priced = input.usage
      ? computeModelCost(input.agentModel, input.usage)
      : undefined;
    const usageRawEnvelope = input.usage && priced
      ? { costSource: priced.source, raw: input.usage.raw }
      : input.usage?.raw;
    await db.insert(agentTraces).values({
      traceId: truncate(input.traceId, 300),
      runId: truncate(input.runId, 300),
      taskId: truncate(input.taskId, 300),
      userId: truncate(input.userId, 120) ?? DEFAULT_USER_ID,
      projectId: truncate(input.projectId, 120) ?? DEFAULT_PROJECT_ID,
      instanceId: truncate(input.instanceId, 180) ?? DEFAULT_INSTANCE_ID,
      conversationId: truncate(input.conversationId, 300) ?? "unknown",
      messageId: truncate(input.messageId, 300),
      channel: truncate(input.channel, 120) ?? "unknown",
      userText: truncate(input.userText) ?? "",
      promptText: STORE_PROMPT_TEXT || input.status !== "success" ? truncate(input.promptText) : undefined,
      replyTextRaw: STORE_RAW_REPLY || input.status !== "success" ? truncate(input.replyTextRaw) : undefined,
      replyTextSanitized: truncate(input.replyTextSanitized),
      mode: truncate(input.mode, 120) ?? "chat",
      reviewContextSummary: truncate(input.reviewContextSummary, 2000),
      sandboxTokenId: truncate(input.sandboxTokenId, 120),
      sandboxPermissions: truncate(input.sandboxPermissions, 1000),
      agentBackend: truncate(input.agentBackend, 80),
      agentModel: truncate(input.agentModel, 160),
      modelSource: truncate(input.modelSource, 160),
      toolManifest: serializeJsonForStorage(input.toolManifest, 4000),
      toolCalls: serializeJsonForStorage(input.toolCalls),
      promptChars: input.promptText?.length,
      replyChars: input.replyTextRaw?.length ?? input.replyTextSanitized?.length,
      status: input.status,
      errorMessage: truncate(input.errorMessage, ERROR_LIMIT),
      elapsedMs: input.elapsedMs,
      firstTokenMs: input.firstTokenMs,
      inputTokens: input.usage?.inputTokens,
      outputTokens: input.usage?.outputTokens,
      thoughtTokens: input.usage?.thoughtTokens,
      cachedReadTokens: input.usage?.cachedReadTokens,
      cachedWriteTokens: input.usage?.cachedWriteTokens,
      totalTokens: input.usage?.totalTokens,
      contextWindowUsed: input.usage?.contextWindowUsed,
      contextWindowSize: input.usage?.contextWindowSize,
      costAmount: priced ? priced.amount : input.usage?.costAmount,
      costCurrency: priced ? priced.currency : truncate(input.usage?.costCurrency, 12),
      usageSource: input.usage?.source,
      usageRaw: serializeJsonForStorage(usageRawEnvelope, 2000),
      createdAt: new Date().toISOString(),
    });
    // W1: 每条 trace 即模型健康反馈（成败 + 首字延迟）。
    recordModelFeedback(input.agentModel, { ok: input.status === "success", firstTokenMs: input.firstTokenMs });
  } catch (error) {
    logger.warn("agent trace write failed:", error);
  }
}
