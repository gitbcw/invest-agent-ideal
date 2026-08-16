/**
 * Application-facing types for the stage 1 Mastra facade.
 *
 * These types define the native Mastra execution contract.
 */

export type MastraBackendId = "mastra";

export interface MastraTokenUsage {
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
  source: "actual" | "estimated";
  /** Provider-specific details are intentionally omitted by default. */
  raw?: unknown;
}

export interface MastraToolCallSummary {
  /** Event source recorded by the Mastra runtime. */
  source: "mastra-event";
  toolCallId: string;
  serverId?: string;
  toolName?: string;
  title?: string;
  kind?: string;
  status?: string;
  startedAt: string;
  completedAt?: string;
  elapsedMs?: number;
  inputChars?: number;
  outputChars?: number;
  /** 仅失败结果保留的截断错误摘录（不含入参/成功输出），用于排查假成功。 */
  errorExcerpt?: string;
}

/** A completed Mastra turn carries bounded observability fields. */
export interface MastraBudgetSnapshot {
  state: "completed";
  startedAt: number;
  toolCallsAfterExhaustion: 0;
  timing?: {
    agentFactoryMs: number;
    streamInvokeMs: number;
    outputCollectMs: number;
    totalMs: number;
    toolCallEvents: number;
  };
}

export interface MastraTurnResult {
  text: string;
  usage: MastraTokenUsage;
  budget: MastraBudgetSnapshot;
  backendId: MastraBackendId;
  model?: string;
  modelLabel?: string;
  mcpManifest?: unknown;
  toolCalls?: MastraToolCallSummary[];
}

export type MastraMessageRole = "system" | "user" | "assistant" | "tool";

export interface MastraMessage {
  role: MastraMessageRole;
  content: unknown;
  [key: string]: unknown;
}

export interface MastraAgentLike {
  stream(
    messages: readonly MastraMessage[],
    options?: Record<string, unknown>,
  ): MastraStreamOutput | PromiseLike<MastraStreamOutput>;
}

/**
 * The subset of MastraModelOutput consumed by this facade. Keeping this local
 * avoids importing ESM declaration files into the Node16 CommonJS build.
 */
export interface MastraStreamOutput {
  text?: unknown;
  textStream?: unknown;
  fullStream?: unknown;
  usage?: unknown;
  toolCalls?: unknown;
  response?: unknown;
  modelId?: unknown;
  [key: string]: unknown;
}
