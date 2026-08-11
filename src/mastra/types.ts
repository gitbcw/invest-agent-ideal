/**
 * Application-facing types for the stage 1 Mastra facade.
 *
 * These types deliberately live outside src/acp. The ACP implementation keeps
 * its historical backend union and budget semantics until a later migration
 * stage; the facade only needs to expose a structurally compatible turn result.
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
  /** Same source label used by the existing ACP trace serializer. */
  source: "acp-event";
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
}

/** A completed Mastra turn has the same observability fields as ACP. */
export interface MastraBudgetSnapshot {
  state: "completed";
  startedAt: number;
  toolCallsAfterExhaustion: 0;
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
