import type { UserContext } from "../lib/user-context.js";
import { createMastraAgent, type MastraAgentFactory, type MastraAgentFactoryOptions } from "./agent-factory.js";
import { createModelGateway, type MastraModelGateway, type ModelGatewayOptions } from "./model-gateway.js";
import {
  type MastraAgentLike,
  type MastraMessage,
  type MastraTokenUsage,
  type MastraToolCallSummary,
  type MastraTurnResult,
} from "./types.js";

export const DEFAULT_MASTRA_TURN_TIMEOUT_MS = 1_800_000;

export type MastraTurnErrorCode =
  | "MASTRA_TURN_BUSY"
  | "MASTRA_TURN_TIMEOUT"
  | "MASTRA_EMPTY_RESPONSE"
  | "MASTRA_TURN_ERROR";

export class MastraTurnError extends Error {
  constructor(
    message: string,
    readonly code: MastraTurnErrorCode,
    readonly conversationId?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MastraTurnError";
  }
}

export class MastraTurnBusyError extends MastraTurnError {
  constructor(conversationId: string) {
    super("MASTRA_TURN_BUSY:上一条消息仍在处理中", "MASTRA_TURN_BUSY", conversationId);
    this.name = "MastraTurnBusyError";
  }
}

export class MastraTurnTimeoutError extends MastraTurnError {
  readonly timeoutMs: number;

  constructor(conversationId: string, timeoutMs: number) {
    super(
      `MASTRA_TURN_TIMEOUT: Mastra turn 超时（${timeoutMs}ms）：conversationId=${conversationId}`,
      "MASTRA_TURN_TIMEOUT",
      conversationId,
    );
    this.name = "MastraTurnTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class MastraEmptyResponseError extends MastraTurnError {
  constructor(conversationId: string) {
    super(
      `MASTRA_EMPTY_RESPONSE: Mastra 未生成可展示的用户回复：conversationId=${conversationId}`,
      "MASTRA_EMPTY_RESPONSE",
      conversationId,
    );
    this.name = "MastraEmptyResponseError";
  }
}

export interface MastraTurnParams {
  conversationId: string;
  text: string;
  messageId?: string;
  timeoutMs?: number;
  cwd?: string;
  userContext?: UserContext;
  model?: string;
  /** Caller-owned prior messages. The adapter never reads or persists history. */
  history?: readonly MastraMessage[];
  /** Alias for history, useful when adapting an existing message list. */
  messages?: readonly MastraMessage[];
  /** External read-only MCP toolsets, resolved separately from service tools. */
  toolsets?: Record<string, unknown>;
}

export interface MastraTurnDependencies {
  agent?: MastraAgentLike;
  agentFactory?: MastraAgentFactory;
  /** Alias retained for simple test fakes. */
  createAgent?: MastraAgentFactory;
  gateway?: MastraModelGateway | ModelGatewayOptions;
  agentOptions?: Omit<MastraAgentFactoryOptions, "gateway" | "model" | "bindings">;
  now?: () => number;
  activeConversations?: Set<string>;
}

const activeConversations = new Set<string>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asFiniteInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function awaitValue<T>(value: T | PromiseLike<T> | undefined): Promise<T | undefined> {
  return value === undefined ? undefined : await value;
}

function tokenValue(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    const direct = asFiniteInt(value);
    if (direct !== undefined) return direct;
    if (isRecord(value)) {
      const nested = asFiniteInt(value.total) ?? asFiniteInt(value.count) ?? asFiniteInt(value.value);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii / 1.7));
}

/** Map Mastra/AI SDK usage into the existing ACP token field names. */
export function mapMastraUsage(value: unknown, promptText = "", replyText = ""): MastraTokenUsage {
  const record = isRecord(value) ? value : {};
  const inputTokens = tokenValue(record, ["inputTokens", "promptTokens", "promptTokenCount", "inputTokenCount"]);
  const outputTokens = tokenValue(record, ["outputTokens", "completionTokens", "completionTokenCount", "outputTokenCount"]);
  const thoughtTokens = tokenValue(record, ["reasoningTokens", "thoughtTokens"]);
  const cachedReadTokens = tokenValue(record, ["cachedReadTokens", "cacheReadTokens", "cachedInputTokens"]);
  const cachedWriteTokens = tokenValue(record, ["cachedWriteTokens", "cacheWriteTokens", "cacheCreationInputTokens"]);
  const contextWindowUsed = tokenValue(record, ["contextWindowUsed", "used"]);
  const contextWindowSize = tokenValue(record, ["contextWindowSize", "size"]);
  const cost = isRecord(record.cost) ? record.cost : undefined;
  const costAmount = asFiniteNumber(record.costAmount) ?? asFiniteNumber(cost?.amount);
  const costCurrency = typeof record.costCurrency === "string"
    ? record.costCurrency
    : typeof cost?.currency === "string" ? cost.currency : undefined;
  const totalTokens = tokenValue(record, ["totalTokens", "totalTokenCount"])
    ?? (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);

  const hasActualUsage = [
    inputTokens,
    outputTokens,
    thoughtTokens,
    cachedReadTokens,
    cachedWriteTokens,
    totalTokens,
    contextWindowUsed,
    contextWindowSize,
    costAmount,
    costCurrency,
  ].some((entry) => entry !== undefined);
  if (!hasActualUsage) {
    const estimatedInput = estimateTokens(promptText);
    const estimatedOutput = estimateTokens(replyText);
    return {
      inputTokens: estimatedInput,
      outputTokens: estimatedOutput,
      totalTokens: estimatedInput + estimatedOutput,
      source: "estimated",
    };
  }
  return {
    inputTokens,
    outputTokens,
    thoughtTokens,
    cachedReadTokens,
    cachedWriteTokens,
    totalTokens,
    contextWindowUsed,
    contextWindowSize,
    costAmount,
    costCurrency,
    source: "actual",
  };
}

/** Compatibility alias for the application-level mapper name. */
export const mapUsage = mapMastraUsage;

function safeSerializedSize(value: unknown): number | undefined {
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveTimestamp(value: unknown, fallback: string): string {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return fallback;
}

function mapOneToolCall(value: unknown, fallbackStartedAt: string): MastraToolCallSummary | undefined {
  if (!isRecord(value)) return undefined;
  const toolCallId = stringValue(value.toolCallId) ?? stringValue(value.id);
  if (!toolCallId) return undefined;
  const startedAt = resolveTimestamp(value.startedAt ?? value.startTime ?? value.timestamp, fallbackStartedAt);
  const completedAtValue = value.completedAt ?? value.endTime ?? value.finishedAt;
  const completedAt = completedAtValue === undefined ? undefined : resolveTimestamp(completedAtValue, fallbackStartedAt);
  const elapsedMs = asFiniteInt(value.elapsedMs) ?? (
    completedAt && Date.parse(completedAt) >= Date.parse(startedAt)
      ? Date.parse(completedAt) - Date.parse(startedAt)
      : undefined
  );
  const input = value.input ?? value.args ?? value.arguments ?? value.rawInput;
  const output = value.output ?? value.result ?? value.rawOutput;
  return {
    source: "acp-event",
    toolCallId,
    serverId: stringValue(value.serverId),
    toolName: stringValue(value.toolName) ?? stringValue(value.name),
    title: stringValue(value.title),
    kind: stringValue(value.kind),
    status: stringValue(value.status),
    startedAt,
    ...(completedAt ? { completedAt } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(input !== undefined ? { inputChars: safeSerializedSize(input) } : {}),
    ...(output !== undefined ? { outputChars: safeSerializedSize(output) } : {}),
  };
}

/** Map Mastra tool-call chunks without retaining arguments or tool results. */
export function mapMastraToolCalls(value: unknown, now = new Date()): MastraToolCallSummary[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const fallbackStartedAt = now.toISOString();
  const mapped = value
    .map((call) => mapOneToolCall(call, fallbackStartedAt))
    .filter((call): call is MastraToolCallSummary => call !== undefined);
  return mapped.length > 0 ? mapped : undefined;
}

/** Compatibility alias for the application-level mapper name. */
export const mapToolCalls = mapMastraToolCalls;

function asAsyncIterable(value: unknown): AsyncIterable<unknown> | undefined {
  if (isRecord(value) && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function") {
    return value as unknown as AsyncIterable<unknown>;
  }
  if (isRecord(value) && typeof value.getReader === "function") {
    const reader = (value as { getReader: () => { read: () => Promise<{ done: boolean; value: unknown }>; releaseLock?: () => void } }).getReader();
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) return;
            yield item.value;
          }
        } finally {
          reader.releaseLock?.();
        }
      },
    };
  }
  return undefined;
}

function textFromChunk(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (!isRecord(chunk)) return "";
  const type = typeof chunk.type === "string" ? chunk.type : "";
  const payload = isRecord(chunk.payload) ? chunk.payload : undefined;
  const candidates = [
    chunk.text,
    chunk.delta,
    chunk.textDelta,
    chunk.content,
    payload?.text,
    payload?.delta,
    payload?.textDelta,
    payload?.content,
  ];
  if (type && !type.includes("text") && !type.includes("content") && !type.includes("delta")) return "";
  return candidates.find((candidate): candidate is string => typeof candidate === "string") ?? "";
}

async function collectStream(value: unknown): Promise<{ text: string; usage?: unknown; toolCalls: unknown[] }> {
  const iterable = asAsyncIterable(value);
  if (!iterable) return { text: "", toolCalls: [] };
  const chunks: string[] = [];
  const toolCalls: unknown[] = [];
  let usage: unknown;
  for await (const chunk of iterable) {
    chunks.push(textFromChunk(chunk));
    if (isRecord(chunk)) {
      const type = typeof chunk.type === "string" ? chunk.type : "";
      if (type === "error" || type.includes("error")) {
        const errorValue = chunk.error ?? (isRecord(chunk.payload) ? chunk.payload.error : undefined);
        throw errorValue instanceof Error
          ? errorValue
          : new Error(typeof errorValue === "string" ? errorValue : "Mastra provider stream error");
      }
      if (type.includes("tool-call") || type.includes("tool_call")) {
        const payload = isRecord(chunk.payload) ? chunk.payload : chunk;
        toolCalls.push(payload);
      }
      if (type === "finish" || type.includes("usage")) {
        usage = chunk.usage ?? (isRecord(chunk.payload) ? chunk.payload.usage : undefined) ?? usage;
      }
    }
  }
  return { text: chunks.join(""), usage, toolCalls };
}

async function resolveOutput(outputValue: unknown, promptText: string, startedAt: string): Promise<{
  text: string;
  usage?: unknown;
  toolCalls?: unknown;
  model?: string;
}> {
  const output = await outputValue;
  if (typeof output === "string") return { text: output };
  const directRecord = isRecord(output) ? output : undefined;
  const stream = directRecord?.textStream ?? directRecord?.fullStream;
  const collected = stream === undefined ? { text: "", toolCalls: [] as unknown[] } : await collectStream(stream);
  const directText = directRecord ? await awaitValue(directRecord.text as string | PromiseLike<string> | undefined) : undefined;
  const text = typeof directText === "string" ? directText : collected.text;
  const usage = directRecord ? await awaitValue(directRecord.usage) : undefined;
  const toolCalls = directRecord ? await awaitValue(directRecord.toolCalls) : undefined;
  const response = directRecord ? await awaitValue(directRecord.response) : undefined;
  const model = directRecord
    ? stringValue(directRecord.modelId)
      ?? (isRecord(response) ? stringValue(response.modelId) : undefined)
    : undefined;
  return {
    text,
    usage: usage ?? collected.usage,
    toolCalls: toolCalls ?? (collected.toolCalls.length > 0 ? collected.toolCalls : undefined),
    model,
  };
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_MASTRA_TURN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`MASTRA_TURN_TIMEOUT_INVALID: timeoutMs must be positive: ${timeoutMs}`);
  }
  return Math.round(timeoutMs);
}

function mapError(error: unknown, conversationId: string): MastraTurnError {
  if (error instanceof MastraTurnError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new MastraTurnError(
    `MASTRA_TURN_ERROR: ${message || "Mastra agent execution failed"}`,
    "MASTRA_TURN_ERROR",
    conversationId,
    { cause: error },
  );
}

function resolveGateway(value: MastraTurnDependencies["gateway"]): MastraModelGateway | undefined {
  if (!value) return undefined;
  if (typeof (value as MastraModelGateway).resolve === "function") return value as MastraModelGateway;
  return createModelGateway(value as ModelGatewayOptions);
}

/**
 * Execute one turn behind the Mastra seam. This function is intentionally
 * unreachable from current ACP request callers; stage 2 can wire it in after
 * the result and security contracts have been reviewed.
 */
export async function runMastraTurn(
  params: MastraTurnParams,
  dependencies: MastraTurnDependencies = {},
): Promise<MastraTurnResult> {
  const conversationId = params.conversationId;
  const active = dependencies.activeConversations ?? activeConversations;
  if (active.has(conversationId)) throw new MastraTurnBusyError(conversationId);
  active.add(conversationId);
  let timer: NodeJS.Timeout | undefined;
  try {
    const startedAtMs = (dependencies.now ?? Date.now)();
    const startedAt = new Date(startedAtMs).toISOString();
    const timeoutMs = normalizeTimeout(params.timeoutMs);
    const abortController = new AbortController();
    const gateway = resolveGateway(dependencies.gateway);
    const factory = dependencies.agentFactory ?? dependencies.createAgent;
    let agent: MastraAgentLike;
    if (dependencies.agent) {
      agent = dependencies.agent;
    } else if (factory) {
      agent = await factory({
        ...(dependencies.agentOptions ?? {}),
        ...(dependencies.gateway !== undefined ? { gateway: dependencies.gateway } : {}),
        ...(params.model !== undefined ? { model: params.model } : {}),
      });
    } else {
      agent = await createMastraAgent({
        ...(dependencies.agentOptions ?? {}),
        ...(dependencies.gateway !== undefined ? { gateway: dependencies.gateway } : {}),
        ...(params.model !== undefined ? { model: params.model } : {}),
      });
    }

    const history = params.history ?? params.messages ?? [];
    const messages: MastraMessage[] = [
      ...history.map((message) => ({ ...message })),
      { role: "user", content: params.text },
    ];
    const streamOptions: Record<string, unknown> = {
      abortSignal: abortController.signal,
      signal: abortController.signal,
      metadata: {
        conversationId,
        ...(params.messageId ? { messageId: params.messageId } : {}),
        ...(params.cwd ? { cwd: params.cwd } : {}),
        ...(params.userContext ? { userContext: params.userContext } : {}),
      },
    };
    if (params.toolsets && Object.keys(params.toolsets).length > 0) streamOptions.toolsets = params.toolsets;
    if (params.model && gateway) streamOptions.model = gateway.resolve(params.model);

    const streamPromise = Promise.resolve().then(() => agent.stream(messages, streamOptions));
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abortController.abort();
        reject(new MastraTurnTimeoutError(conversationId, timeoutMs));
      }, timeoutMs);
    });
    const output = await Promise.race([streamPromise, timeoutPromise]);
    const mapped = await Promise.race([
      resolveOutput(output, params.text, startedAt),
      timeoutPromise,
    ]);
    const text = mapped.text.trim();
    if (!text) throw new MastraEmptyResponseError(conversationId);
    const toolCalls = mapMastraToolCalls(mapped.toolCalls, new Date(startedAtMs));
    const model = mapped.model ?? params.model ?? gateway?.defaultModel;
    return {
      text,
      usage: mapMastraUsage(mapped.usage, params.text, text),
      budget: {
        state: "completed",
        startedAt: startedAtMs,
        toolCallsAfterExhaustion: 0,
      },
      backendId: "mastra",
      ...(model ? { model } : {}),
      ...(toolCalls ? { toolCalls } : {}),
    };
  } catch (error) {
    throw mapError(error, conversationId);
  } finally {
    if (timer) clearTimeout(timer);
    active.delete(conversationId);
  }
}

/** Create a runner with isolated busy state, useful for deterministic tests. */
export function createMastraTurnRunner(defaultDependencies: MastraTurnDependencies = {}) {
  const isolatedActiveConversations = new Set<string>();
  return (params: MastraTurnParams, dependencies: MastraTurnDependencies = {}) =>
    runMastraTurn(params, {
      ...defaultDependencies,
      ...dependencies,
      activeConversations: dependencies.activeConversations ?? isolatedActiveConversations,
    });
}
