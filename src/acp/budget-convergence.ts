/**
 * ACP capability probing and the service-owned external-tool budget state.
 *
 * ACP 0.16.1 has no standard method for revoking MCP tools during an active
 * prompt. The probe records that fact explicitly so callers can fail closed
 * instead of relying on a prompt instruction to stop the model.
 */

export const TOOL_BUDGET_EXHAUSTED_CODE = "TOOL_BUDGET_EXHAUSTED";
export const DEFAULT_ACP_BUDGET_CONVERGENCE_MS = 5_000;

export type AcpCapabilitySupport = "supported" | "unsupported" | "unknown";

export type AcpSynthesisStrategy = "same_turn" | "supplemental_session" | "terminal_only";

export interface AcpCapabilityProbe {
  protocolVersion: number | null;
  cancel: AcpCapabilitySupport;
  conversationContextReuse: AcpCapabilitySupport;
  sameTurnToolRevocation: AcpCapabilitySupport;
  supplementalSynthesis: AcpCapabilitySupport;
  synthesisStrategy: AcpSynthesisStrategy;
  evidence: string[];
}

type CapabilityConnection = {
  cancel?: unknown;
  newSession?: unknown;
  unstable_resumeSession?: unknown;
  extMethod?: unknown;
};

/**
 * Read only explicit, service-recognized capability markers. A session mode
 * or extension is not treated as a tool revocation guarantee unless the agent
 * advertises the MCP-disabled behavior in its metadata.
 */
export function probeAcpCapabilities(
  initializeResult: unknown,
  connection?: CapabilityConnection,
): AcpCapabilityProbe {
  const result = asRecord(initializeResult);
  const agentCapabilities = asRecord(result?.agentCapabilities);
  const meta = asRecord(agentCapabilities?._meta);
  const investMeta = asRecord(meta?.["invest-agent"] ?? meta?.investAgent);
  const budgetMeta = asRecord(
    investMeta?.budgetControl ??
      investMeta?.budget_control ??
      meta?.budgetControl ??
      meta?.budget_control,
  );
  const revocationMarker = firstBoolean([
    budgetMeta?.sameTurnToolRevocation,
    budgetMeta?.same_turn_tool_revocation,
    budgetMeta?.synthesisOnly,
    budgetMeta?.synthesis_only,
  ]);
  const supplementalMarker = firstBoolean([
    budgetMeta?.supplementalSynthesis,
    budgetMeta?.supplemental_synthesis,
  ]);
  const protocolVersion = typeof result?.protocolVersion === "number" && Number.isFinite(result.protocolVersion)
    ? result.protocolVersion
    : null;

  const evidence: string[] = [];
  const cancel: AcpCapabilitySupport = typeof connection?.cancel === "function" ? "supported" : "unknown";
  if (cancel === "supported") evidence.push("session/cancel method available");
  else evidence.push("session/cancel method was not exposed to the runtime");

  const conversationContextReuse: AcpCapabilitySupport = typeof connection?.newSession === "function"
    ? "supported"
    : "unknown";
  if (conversationContextReuse === "supported") evidence.push("session/new is available for open-session reuse");

  let sameTurnToolRevocation: AcpCapabilitySupport;
  if (revocationMarker === true) {
    sameTurnToolRevocation = "supported";
    evidence.push("agent metadata explicitly advertises same-turn MCP revocation");
  } else if (revocationMarker === false) {
    sameTurnToolRevocation = "unsupported";
    evidence.push("agent metadata explicitly denies same-turn MCP revocation");
  } else {
    sameTurnToolRevocation = "unsupported";
    evidence.push("ACP has no standard same-turn MCP revocation capability");
  }

  let supplementalSynthesis: AcpCapabilitySupport;
  if (supplementalMarker === true) {
    supplementalSynthesis = typeof connection?.unstable_resumeSession === "function"
      ? "supported"
      : "unknown";
    evidence.push(
      supplementalSynthesis === "supported"
        ? "agent metadata advertises supplemental synthesis and session resume is available"
        : "agent metadata advertises supplemental synthesis but session resume is unavailable",
    );
  } else if (supplementalMarker === false) {
    supplementalSynthesis = "unsupported";
    evidence.push("agent metadata explicitly denies supplemental synthesis");
  } else {
    supplementalSynthesis = "unsupported";
    evidence.push("no safe context-preserving supplemental synthesis capability advertised");
  }

  const synthesisStrategy: AcpSynthesisStrategy = sameTurnToolRevocation === "supported"
    ? "same_turn"
    : supplementalSynthesis === "supported"
      ? "supplemental_session"
      : "terminal_only";

  return {
    protocolVersion,
    cancel,
    conversationContextReuse,
    sameTurnToolRevocation,
    supplementalSynthesis,
    synthesisStrategy,
    evidence,
  };
}

export type AcpBudgetState = "open" | "budget_exhausted" | "synthesis_only" | "completed" | "terminal_failed";

export type AcpBudgetExhaustionType = "total_calls" | "identical_calls" | "unknown";

export interface AcpBudgetRunSnapshot {
  state: AcpBudgetState;
  startedAt: number;
  exhaustedAt?: number;
  exhaustionType?: AcpBudgetExhaustionType;
  convergenceDeadlineAt?: number;
  toolCallsAfterExhaustion: number;
}

export class AcpBudgetRun {
  private state: AcpBudgetState = "open";
  private exhaustedAt: number | undefined;
  private exhaustionType: AcpBudgetExhaustionType | undefined;
  private convergenceDeadlineAt: number | undefined;
  private toolCallsAfterExhaustion = 0;
  private readonly now: () => number;
  private readonly convergenceMs: number;
  private readonly startedAt: number;

  constructor(options: { now?: () => number; convergenceMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.convergenceMs = positiveBudget(options.convergenceMs, DEFAULT_ACP_BUDGET_CONVERGENCE_MS);
    this.startedAt = this.now();
  }

  markBudgetExhausted(type: AcpBudgetExhaustionType, now = this.now()): boolean {
    if (this.state !== "open") return false;
    this.state = "budget_exhausted";
    this.exhaustedAt = now;
    this.exhaustionType = type;
    this.convergenceDeadlineAt = now + this.convergenceMs;
    return true;
  }

  enterSynthesisOnly(): boolean {
    if (this.state !== "budget_exhausted") return false;
    this.state = "synthesis_only";
    return true;
  }

  recordToolCall(): void {
    if (this.state === "budget_exhausted" || this.state === "synthesis_only" || this.state === "terminal_failed") {
      this.toolCallsAfterExhaustion += 1;
    }
  }

  complete(): boolean {
    if (this.state === "terminal_failed") return false;
    this.state = "completed";
    return true;
  }

  terminalFail(): boolean {
    if (this.state === "completed") return false;
    this.state = "terminal_failed";
    return true;
  }

  isBudgetExhausted(): boolean {
    return this.state === "budget_exhausted" || this.state === "synthesis_only" || this.state === "terminal_failed";
  }

  isConvergenceExpired(now = this.now()): boolean {
    return this.isBudgetExhausted()
      && this.state !== "terminal_failed"
      && this.state !== "completed"
      && this.convergenceDeadlineAt !== undefined
      && now >= this.convergenceDeadlineAt;
  }

  snapshot(): AcpBudgetRunSnapshot {
    return {
      state: this.state,
      startedAt: this.startedAt,
      ...(this.exhaustedAt === undefined ? {} : { exhaustedAt: this.exhaustedAt }),
      ...(this.exhaustionType === undefined ? {} : { exhaustionType: this.exhaustionType }),
      ...(this.convergenceDeadlineAt === undefined ? {} : { convergenceDeadlineAt: this.convergenceDeadlineAt }),
      toolCallsAfterExhaustion: this.toolCallsAfterExhaustion,
    };
  }
}

export class AcpBudgetExhaustedError extends Error {
  readonly code = TOOL_BUDGET_EXHAUSTED_CODE;

  constructor(readonly budget: AcpBudgetRunSnapshot) {
    super(TOOL_BUDGET_EXHAUSTED_CODE);
    this.name = "AcpBudgetExhaustedError";
  }
}

/** Return the budget class encoded by an observer/MCP error payload. */
export function detectAcpBudgetExhaustion(value: unknown): AcpBudgetExhaustionType | null {
  const text = knownErrorText(value).toLowerCase();
  if (!text) return null;
  if (
    text.includes("mcp_tool_call_repeat_budget_exhausted")
    || text.includes("identical invocation budget")
    || text.includes("identical_calls")
  ) return "identical_calls";
  if (
    text.includes("mcp_tool_call_budget_exhausted")
    || text.includes("total external tool-call")
    || text.includes("total_calls")
  ) return "total_calls";
  return null;
}

function knownErrorText(value: unknown, depth = 0): string {
  if (depth > 3 || value === null || value === undefined) return "";
  if (typeof value === "string") return value.slice(0, 2_000);
  if (typeof value === "number") return value === -32001 ? "total external tool-call budget" : "";
  if (Array.isArray(value)) return value.map((item) => knownErrorText(item, depth + 1)).join(" ");
  if (typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return [
    record.code,
    record.errorCode,
    record.errorClass,
    record.message,
    record.error,
    record.data,
    record.content,
    record.rawOutput,
  ].map((item) => knownErrorText(item, depth + 1)).join(" ");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstBoolean(values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === "boolean");
}

function positiveBudget(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.round(Number(value)) : fallback;
}
