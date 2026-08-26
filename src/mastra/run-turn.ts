import type { UserContext } from "../lib/user-context.js";
import { createMastraAgent, type MastraAgentFactory, type MastraAgentFactoryOptions } from "./agent-factory.js";
import { createMastraRequestContext } from "./bindings.js";
import { createModelGateway, gptReasoningEffort, isGptSeriesModel, type MastraModelGateway, type ModelGatewayOptions } from "./model-gateway.js";
import {
  type MastraAgentLike,
  type MastraMessage,
  type MastraTokenUsage,
  type MastraToolCallSummary,
  type MastraTurnResult,
} from "./types.js";

export const DEFAULT_MASTRA_TURN_TIMEOUT_MS = 1_800_000;
export const DEFAULT_MASTRA_MAX_STEPS = 20;

export type MastraTurnErrorCode =
  | "MASTRA_TURN_BUSY"
  | "MASTRA_TURN_TIMEOUT"
  | "MASTRA_FIRST_TOKEN_TIMEOUT"
  | "TASK_CANCELLED"
  | "MASTRA_EMPTY_RESPONSE"
  | "MASTRA_TURN_ERROR";

export class MastraTurnError extends Error {
  /** T-327 取证字段：失败轮次实际使用的模型与已发生的工具调用摘要。 */
  model?: string;
  toolCalls?: unknown[];
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
  /** W1-P3：首字看门狗——该窗口内没有任何首 token 则中止本轮（调用方可换模型重试）。 */
  firstTokenTimeoutMs?: number;
  cwd?: string;
  userContext?: UserContext;
  model?: string;
  /** Caller-owned prior messages. The adapter never reads or persists history. */
  history?: readonly MastraMessage[];
  /** Alias for history, useful when adapting an existing message list. */
  messages?: readonly MastraMessage[];
  /** External read-only MCP toolsets, resolved separately from service tools. */
  toolsets?: Record<string, unknown>;
  /** Caller-owned cancellation signal for the active turn. */
  signal?: AbortSignal;
  /** Server-owned values passed to Mastra dynamic resolvers and tools. */
  requestContext?: Record<string, unknown>;
  /** Server-owned upper bound; callers cannot exceed the runtime ceiling. */
  maxSteps?: number;
  /**
   * Inline images attached to this user turn. Mastra converts AI-SDK file
   * parts into OpenAI image_url data URLs, so vision-capable models actually
   * see the image instead of a text-encoded byte dump.
   */
  images?: ReadonlyArray<{ mimeType: string; base64: string }>;
  /** T-199 工作过程事件回调；缺省时零开销，事件为尽力而为投递。 */
  onProgress?: import("../runtime/protocol.js").AgentTurnProgressCallback;
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
  maxSteps?: number;
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

/** Map Mastra/AI SDK usage into the runtime token fields. */
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
  // Mastra >= 1.5x aggregates and stream chunks wrap the data in a `payload`
  // object ({ type: 'tool-call' | 'tool-result', payload: {...} }); read
  // through it when present so both shapes map to the same summary.
  const payload = isRecord(value.payload) ? value.payload : undefined;
  const source = payload ?? value;
  const toolCallId = stringValue(source.toolCallId) ?? stringValue(source.id);
  if (!toolCallId) return undefined;
  const startedAt = resolveTimestamp(source.startedAt ?? value.startedAt ?? source.startTime ?? source.timestamp ?? value.timestamp, fallbackStartedAt);
  const completedAtValue = source.completedAt ?? value.completedAt ?? source.endTime ?? value.endTime ?? source.finishedAt;
  const completedAt = completedAtValue === undefined ? undefined : resolveTimestamp(completedAtValue, fallbackStartedAt);
  const elapsedMs = asFiniteInt(source.elapsedMs ?? value.elapsedMs) ?? (
    completedAt && Date.parse(completedAt) >= Date.parse(startedAt)
      ? Date.parse(completedAt) - Date.parse(startedAt)
      : undefined
  );
  const input = source.input ?? source.args ?? source.arguments ?? source.rawInput;
  const output = source.output ?? source.result ?? source.rawOutput;
  const status = stringValue(value.status)
    ?? (source.isError === true ? "error" : source.isError === false ? "success" : undefined);
  return {
    source: "mastra-event",
    toolCallId,
    serverId: stringValue(source.serverId ?? value.serverId),
    toolName: stringValue(source.toolName) ?? stringValue(source.name),
    title: stringValue(source.title ?? value.title),
    kind: stringValue(source.kind ?? value.kind),
    status,
    startedAt,
    ...(completedAt ? { completedAt } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(input !== undefined ? { inputChars: safeSerializedSize(input) } : {}),
    ...(output !== undefined ? { outputChars: safeSerializedSize(output) } : {}),
    ...(errorExcerptOf(status, output) ? { errorExcerpt: errorExcerptOf(status, output) } : {}),
  };
}

/**
 * 失败结果的截断错误摘录。成功输出永不保留；错误文本剥离 base64 等大块内容，
 * 只留可诊断的消息字段——否则假成功（工具失败后模型按意图宣称成功）无法排查。
 */
function errorExcerptOf(status: string | undefined, output: unknown): string | undefined {
  // 流事件里的输出可能是 JSON 字符串；失败判定与字段提取都要先穿透。
  const normalized = typeof output === "string" && output.trim().startsWith("{")
    ? (() => { try { return JSON.parse(output); } catch { return output; } })()
    : output;
  const failed = status === "error" || (isRecord(normalized) && normalized.ok === false);
  if (!failed) return undefined;
  const fields = isRecord(normalized)
    ? [normalized.error, normalized.message, normalized.reason, normalized.hint]
    : [typeof normalized === "string" ? normalized : undefined];
  const text = fields.filter((item): item is string => typeof item === "string" && item.length > 0).join(" | ");
  if (!text) return "error without message";
  return text.replace(/[A-Za-z0-9+/=]{120,}/g, "<redacted>").slice(0, 300);
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

/**
 * Merge the aggregate `toolCalls` and `toolResults` of a Mastra model output
 * into one terminal-state summary per toolCallId: the call chunk contributes
 * the tool name and input size, the result chunk contributes the output size,
 * isError-derived status and completion time. Results without a matching call
 * (e.g. dynamic tools) are kept as standalone summaries.
 */
export function mergeMastraToolCallsAndResults(calls: unknown, results: unknown, now = new Date()): MastraToolCallSummary[] | undefined {
  const fallbackStartedAt = now.toISOString();
  const byId = new Map<string, MastraToolCallSummary>();
  for (const call of Array.isArray(calls) ? calls : []) {
    const mapped = mapOneToolCall(call, fallbackStartedAt);
    if (mapped) byId.set(mapped.toolCallId, mapped);
  }
  for (const result of Array.isArray(results) ? results : []) {
    const mapped = mapOneToolCall(result, fallbackStartedAt);
    if (!mapped) continue;
    // Mastra aggregate chunks carry no timestamps; a present result IS the
    // terminal state, so stamp completion at merge time.
    const stamped = mapped.status !== undefined && mapped.completedAt === undefined
      ? { ...mapped, completedAt: fallbackStartedAt }
      : mapped;
    const existing = byId.get(stamped.toolCallId);
    if (!existing) {
      byId.set(stamped.toolCallId, stamped);
      continue;
    }
    byId.set(stamped.toolCallId, {
      ...existing,
      toolName: existing.toolName ?? stamped.toolName,
      title: existing.title ?? stamped.title,
      kind: existing.kind ?? stamped.kind,
      status: stamped.status ?? existing.status,
      completedAt: stamped.completedAt ?? existing.completedAt,
      elapsedMs: stamped.elapsedMs ?? existing.elapsedMs,
      inputChars: existing.inputChars ?? stamped.inputChars,
      outputChars: stamped.outputChars ?? existing.outputChars,
    });
  }
  const merged = [...byId.values()];
  return merged.length > 0 ? merged : undefined;
}

/** Compatibility alias for the application-level mapper name. */
export const mapToolCalls = mapMastraToolCalls;

/** tool-error 流块里的 error 可能是 Error 实例；转成字符串后才可安全进入 JSON 取证。 */
function toolErrorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  try {
    const serialized = JSON.stringify(error);
    if (typeof serialized === "string" && serialized.length > 0) return serialized;
  } catch {
    // 序列化失败时退回 String()。
  }
  return String(error);
}

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

async function collectStream(value: unknown, onFirstText?: () => void, onChunk?: import("../runtime/protocol.js").AgentTurnProgressCallback, toolCallsSink?: unknown[]): Promise<{ text: string; usage?: unknown; toolCalls: unknown[]; firstTextAtMs?: number }> {
  const iterable = asAsyncIterable(value);
  if (!iterable) return { text: "", toolCalls: [] };
  const chunks: string[] = [];
  const toolCalls: unknown[] = [];
  const emittedToolCalls = new Set<string>();
  let usage: unknown;
  let firstTextAtMs: number | undefined;
  for await (const chunk of iterable) {
    const chunkText = textFromChunk(chunk);
    if (firstTextAtMs === undefined && chunkText) {
      firstTextAtMs = Date.now();
      onFirstText?.();
    }
    chunks.push(chunkText);
    if (isRecord(chunk)) {
      const type = typeof chunk.type === "string" ? chunk.type : "";
      // tool-error 是可恢复的工具执行失败：模型读到错误文本后可以自纠并继续。
      // 只有非工具类 error 块才是流级失败。8-19 的 ENOENT/429 硬崩死点就在
      // 这里——把 tool-error 误判为流级错误，单次工具失败就杀掉了整轮。
      if ((type === "error" || type.includes("error")) && !type.includes("tool")) {
        const errorValue = chunk.error ?? (isRecord(chunk.payload) ? chunk.payload.error : undefined);
        throw errorValue instanceof Error
          ? errorValue
          : new Error(typeof errorValue === "string" ? errorValue : "Mastra provider stream error");
      }
      if (type.includes("tool-call") || type.includes("tool_call")
        || type === "tool-result" || type === "tool-error"
        || type.startsWith("tool-input") || type.startsWith("tool-output")) {
        const payload = isRecord(chunk.payload) ? chunk.payload : chunk;
        // tool-error 的 error 可能是 Error 实例：转字符串后落 sink（JSON 取证不再是
        // {}），并同步映射为 output——错误摘录（errorExcerpt）从 output 提取。
        const errorText = payload.error !== undefined ? toolErrorText(payload.error) : undefined;
        const observed = type === "tool-error"
          ? { ...payload, isError: true, ...(errorText !== undefined ? { error: errorText, output: errorText } : {}) }
          : payload;
        toolCalls.push(observed);
        // T-327 取证 sink：流中途抛错时局部数组会丢，sink 让失败轮次也能留下已发生的调用。
        toolCallsSink?.push(observed);
        if (onChunk) {
          const summary = mapOneToolCall({
            ...observed,
            ...(type === "tool-result" ? { status: payload.status ?? "success" } : {}),
            ...(type === "tool-error" ? { status: "error" } : {}),
          }, new Date().toISOString());
          // 参数流式分片会对同一 toolCallId 产生多条 tool-input chunk；只发首条。
          if (summary?.toolCallId && !emittedToolCalls.has(summary.toolCallId)) {
            emittedToolCalls.add(summary.toolCallId);
            onChunk({
              kind: type === "tool-result" || type === "tool-error" || type.startsWith("tool-output") ? "tool_result" : "tool_call",
              at: summary.startedAt,
              seq: 0,
              toolCallId: summary.toolCallId,
              toolName: summary.toolName,
              status: summary.status,
              ...(summary.inputChars !== undefined ? { inputChars: summary.inputChars } : {}),
              ...(summary.outputChars !== undefined ? { outputChars: summary.outputChars } : {}),
              ...(summary.errorExcerpt ? { errorExcerpt: summary.errorExcerpt } : {}),
            });
          }
        }
      }
      if (type === "finish" || type.includes("usage")) {
        usage = chunk.usage ?? (isRecord(chunk.payload) ? chunk.payload.usage : undefined) ?? usage;
      }
    }
  }
  return { text: chunks.join(""), usage, toolCalls, ...(firstTextAtMs !== undefined ? { firstTextAtMs } : {}) };
}

async function resolveOutput(outputValue: unknown, promptText: string, startedAt: string, onFirstText?: () => void, onChunk?: import("../runtime/protocol.js").AgentTurnProgressCallback, toolCallsSink?: unknown[]): Promise<{
  text: string;
  usage?: unknown;
  toolCalls?: unknown;
  toolResults?: unknown;
  model?: string;
  firstTextAtMs?: number;
}> {
  const output = await outputValue;
  if (typeof output === "string") return { text: output };
  const directRecord = isRecord(output) ? output : undefined;
  // fullStream 优先：它携带 tool-call/tool-result/usage 事件，textStream 只有文本增量
  // （T-199 实时过程事件依赖 fullStream；聚合 toolCalls 字段要等轮结束才可用）。
  const stream = directRecord?.fullStream ?? directRecord?.textStream;
  const collected = stream === undefined ? { text: "", toolCalls: [] as unknown[] } : await collectStream(stream, onFirstText, onChunk, toolCallsSink);
  const directText = directRecord ? await awaitValue(directRecord.text as string | PromiseLike<string> | undefined) : undefined;
  const text = typeof directText === "string" ? directText : collected.text;
  const usage = directRecord ? await awaitValue(directRecord.usage) : undefined;
  const toolCalls = directRecord ? await awaitValue(directRecord.toolCalls) : undefined;
  const toolResults = directRecord ? await awaitValue(directRecord.toolResults) : undefined;
  const response = directRecord ? await awaitValue(directRecord.response) : undefined;
  const model = directRecord
    ? stringValue(directRecord.modelId)
      ?? (isRecord(response) ? stringValue(response.modelId) : undefined)
    : undefined;
  return {
    text,
    usage: usage ?? collected.usage,
    toolCalls: toolCalls ?? (collected.toolCalls.length > 0 ? collected.toolCalls : undefined),
    toolResults,
    model,
    ...(collected.firstTextAtMs !== undefined ? { firstTextAtMs: collected.firstTextAtMs } : {}),
  };
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_MASTRA_TURN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`MASTRA_TURN_TIMEOUT_INVALID: timeoutMs must be positive: ${timeoutMs}`);
  }
  return Math.round(timeoutMs);
}

function normalizeMaxSteps(value: number | undefined): number {
  const maxSteps = value ?? DEFAULT_MASTRA_MAX_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 20) {
    throw new Error(`MASTRA_MAX_STEPS_INVALID: ${maxSteps}`);
  }
  return maxSteps;
}

function mapError(error: unknown, conversationId: string): MastraTurnError {
  if (error instanceof MastraTurnError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("TASK_CANCELLED") || message.includes("aborted") || message.includes("AbortError")) {
    return new MastraTurnError("TASK_CANCELLED", "TASK_CANCELLED", conversationId, { cause: error });
  }
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
 * Execute one turn through the Mastra-native runtime.
 */
export async function runMastraTurn(
  params: MastraTurnParams,
  dependencies: MastraTurnDependencies = {},
): Promise<MastraTurnResult> {
  const conversationId = params.conversationId;
  const active = dependencies.activeConversations ?? activeConversations;
  if (active.has(conversationId)) throw new MastraTurnBusyError(conversationId);
  active.add(conversationId);
  // T-199 工作过程事件：seq 严格递增，尽力而为投递，回调异常不得影响轮次。
  let progressSeq = 0;
  const emitProgress = params.onProgress
    ? (event: Omit<import("../runtime/protocol.js").AgentTurnProgressEvent, "seq">) => {
        try {
          params.onProgress?.({ ...event, seq: ++progressSeq, conversationId });
        } catch {
          // 进度回调失败静默——轮次结果才是权威。
        }
      }
    : undefined;
  emitProgress?.({ kind: "turn_start", at: new Date().toISOString() });
  let timer: NodeJS.Timeout | undefined;
  let abortFromExternal: (() => void) | undefined;
  let firstTokenTimedOut = false;
  let firstTokenWatchdog: NodeJS.Timeout | undefined;
  const clearFirstTokenWatchdog = () => {
    if (firstTokenWatchdog !== undefined) {
      clearTimeout(firstTokenWatchdog);
      firstTokenWatchdog = undefined;
    }
  };
  const firstTokenWindow = Number(params.firstTokenTimeoutMs);
  // T-327 取证：失败轮次也保留已发生的工具调用，随异常抛给调用方落 trace。
  const observedToolCalls: unknown[] = [];
  try {
    const startedAtMs = (dependencies.now ?? Date.now)();
    const timingStartedAtMs = Date.now();
    let agentFactoryMs = 0;
    let streamInvokeMs = 0;
    let outputCollectMs = 0;
    const startedAt = new Date(startedAtMs).toISOString();
    const timeoutMs = normalizeTimeout(params.timeoutMs);
    const maxSteps = normalizeMaxSteps(params.maxSteps ?? dependencies.maxSteps);
    const abortController = new AbortController();
    if (Number.isFinite(firstTokenWindow) && firstTokenWindow > 0) {
      firstTokenWatchdog = setTimeout(() => {
        firstTokenTimedOut = true;
        abortController.abort();
      }, firstTokenWindow);
    }
    const externalSignal = params.signal;
    abortFromExternal = () => abortController.abort(externalSignal?.reason);
    if (externalSignal) {
      if (externalSignal.aborted) {
        throw new MastraTurnError("TASK_CANCELLED", "TASK_CANCELLED", conversationId);
      }
      externalSignal.addEventListener("abort", abortFromExternal, { once: true });
    }
    const gateway = resolveGateway(dependencies.gateway);
    const factory = dependencies.agentFactory ?? dependencies.createAgent;
    let agent: MastraAgentLike;
    if (dependencies.agent) {
      agent = dependencies.agent;
    } else if (factory) {
      const factoryStartedAtMs = Date.now();
      agent = await factory({
        ...(dependencies.agentOptions ?? {}),
        ...(dependencies.gateway !== undefined ? { gateway: dependencies.gateway } : {}),
        ...(params.model !== undefined ? { model: params.model } : {}),
        maxSteps,
      });
      agentFactoryMs = Math.max(0, Date.now() - factoryStartedAtMs);
    } else {
      const factoryStartedAtMs = Date.now();
      agent = await createMastraAgent({
        ...(dependencies.agentOptions ?? {}),
        ...(dependencies.gateway !== undefined ? { gateway: dependencies.gateway } : {}),
        ...(params.model !== undefined ? { model: params.model } : {}),
        maxSteps,
      });
      agentFactoryMs = Math.max(0, Date.now() - factoryStartedAtMs);
    }

    const history = params.history ?? params.messages ?? [];
    const userContent: unknown = params.images && params.images.length > 0
      ? [
          { type: "text", text: params.text },
          ...params.images.map((image) => ({ type: "file", data: image.base64, mediaType: image.mimeType })),
        ]
      : params.text;
    const messages: MastraMessage[] = [
      ...history.map((message) => ({ ...message })),
      { role: "user", content: userContent },
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
      maxSteps,
    };
    if (params.requestContext && Object.keys(params.requestContext).length > 0) {
      streamOptions.requestContext = await createMastraRequestContext(params.requestContext);
    }
    if (params.toolsets && Object.keys(params.toolsets).length > 0) streamOptions.toolsets = params.toolsets;
    if (params.model && gateway) streamOptions.model = gateway.resolve(params.model);
    // GPT 系列默认思考深度（owner 2026-08-26）：gpt-* 轮次统一携带 reasoningEffort=high，
    // 命名空间键取模型描述符的 provider 前缀（默认 gateway），无 UI 入口、可用环境变量覆盖。
    const effectiveModel = params.model ?? gateway?.defaultModel;
    if (effectiveModel && isGptSeriesModel(effectiveModel) && gateway) {
      const providerName = gateway.resolve(effectiveModel).id.split("/")[0];
      streamOptions.providerOptions = { [providerName]: { reasoningEffort: gptReasoningEffort() } };
    }

    const streamStartedAtMs = Date.now();
    const streamPromise = Promise.resolve().then(() => agent.stream(messages, streamOptions));
    streamPromise.then(() => { streamInvokeMs = Math.max(0, Date.now() - streamStartedAtMs); }, () => { streamInvokeMs = Math.max(0, Date.now() - streamStartedAtMs); });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abortController.abort();
        reject(new MastraTurnTimeoutError(conversationId, timeoutMs));
      }, timeoutMs);
    });
    const output = await Promise.race([streamPromise, timeoutPromise]);
    const outputStartedAtMs = Date.now();
    const mapped = await Promise.race([
      resolveOutput(output, params.text, startedAt,
        () => {
          clearFirstTokenWatchdog();
          emitProgress?.({ kind: "first_token", at: new Date().toISOString() });
        },
        emitProgress
          ? (event) => {
              if (event.kind === "tool_call" || event.kind === "tool_result") emitProgress(event);
            }
          : undefined,
        observedToolCalls),
      timeoutPromise,
    ]);
    outputCollectMs = Math.max(0, Date.now() - outputStartedAtMs);
    const text = mapped.text.trim();
    if (!text) throw new MastraEmptyResponseError(conversationId);
    const toolCalls = mergeMastraToolCallsAndResults(mapped.toolCalls, mapped.toolResults, new Date(startedAtMs))
      ?? mapMastraToolCalls(mapped.toolCalls, new Date(startedAtMs));
    const model = mapped.model ?? params.model ?? gateway?.defaultModel;
    const firstTokenMs = mapped.firstTextAtMs !== undefined ? Math.max(0, mapped.firstTextAtMs - startedAtMs) : undefined;
    emitProgress?.({ kind: "turn_end", at: new Date().toISOString(), elapsedMs: Date.now() - startedAtMs, ...(model ? { message: model } : {}) });
    return {
      text,
      ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
      usage: mapMastraUsage(mapped.usage, params.text, text),
      budget: {
        state: "completed",
        startedAt: startedAtMs,
        toolCallsAfterExhaustion: 0,
        timing: {
          agentFactoryMs,
          streamInvokeMs,
          outputCollectMs,
          totalMs: Math.max(0, Date.now() - timingStartedAtMs),
          toolCallEvents: toolCalls?.length ?? 0,
        },
      },
      backendId: "mastra",
      ...(model ? { model } : {}),
      ...(toolCalls ? { toolCalls } : {}),
    };
  } catch (error) {
    const mapped = firstTokenTimedOut
      ? new MastraTurnError(
          `MASTRA_FIRST_TOKEN_TIMEOUT: 首字超时（${firstTokenWindow}ms）：conversationId=${conversationId}`,
          "MASTRA_FIRST_TOKEN_TIMEOUT",
          conversationId,
        )
      : mapError(error, conversationId);
    // T-327 取证：失败轮次带上实际模型与已观测到的工具调用（此前 error trace 全空）。
    mapped.model = params.model;
    if (observedToolCalls.length > 0) mapped.toolCalls = observedToolCalls;
    throw mapped;
  } finally {
    clearFirstTokenWatchdog();
    if (timer) clearTimeout(timer);
    if (params.signal && abortFromExternal) {
      params.signal.removeEventListener("abort", abortFromExternal);
    }
    active.delete(conversationId);
  }
}

;

/** 当前在途轮数（优雅排空观测用，W5）。 */
export function activeMastraTurnCount(): number {
  return activeConversations.size;
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
