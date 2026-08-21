import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger.js";
import { runMastraTurn } from "../mastra/run-turn.js";
import {
  isConversationWorkingStateEnabled,
  validateConversationWorkingState,
  type ConversationWorkingStateV1,
} from "./conversation-working-state.js";
import {
  loadConversationWorkingStateTranscript,
  loadLatestConversationWorkingState,
  persistConversationWorkingStateCheckpoint,
  normalizeConversationWorkingStateScope,
  workingStateSourceDigest,
  type ConversationWorkingStateScope,
} from "./conversation-working-state-store.js";

const GENERATOR_VERSION = "conversation-working-state-reducer-v1";
const DEFAULT_REDUCER_TIMEOUT_MS = 45_000;
const reducerTails = new Map<string, Promise<void>>();

type ReducerBody = Pick<
  ConversationWorkingStateV1,
  "topics" | "decisions" | "pendingQuestions" | "authoritativeRefs"
>;

function normalizeReducerBody(value: unknown): ReducerBody {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const topics = Array.isArray(body.topics) ? body.topics.map((item) => {
    const topic = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return { ...topic, aliases: Array.isArray(topic.aliases) ? topic.aliases : [] };
  }) : [];
  const decisions = Array.isArray(body.decisions) ? body.decisions.map((item) => {
    const decision = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const confidence = decision.confidence === "high" || decision.confidence === "medium" || decision.confidence === "low"
      ? decision.confidence
      : "medium";
    const rawState = decision.state;
    const state = rawState === "confirmed" || rawState === "active" || rawState === "current" || rawState === "authoritative"
      ? "confirmed-in-conversation"
      : rawState;
    const safeDecision = { ...decision };
    delete safeDecision.authorityRef;
    return {
      ...safeDecision,
      state,
      confidence,
      supersedes: Array.isArray(decision.supersedes) ? decision.supersedes : [],
      sourceMessageIds: Array.isArray(decision.sourceMessageIds) ? decision.sourceMessageIds : [],
    };
  }) as Array<Record<string, unknown>> : [];
  const latestByKey = new Map<string, number>();
  decisions.forEach((decision, index) => {
    const state = decision.state;
    if (state === "superseded" || state === "rejected") return;
    const key = `${decision.topicId}\0${decision.entity}\0${decision.field}`;
    const previousIndex = latestByKey.get(key);
    if (previousIndex !== undefined) {
      const previous = decisions[previousIndex];
      previous.state = "superseded";
      const previousId = typeof previous.id === "string" ? previous.id : undefined;
      if (previousId && !(decision.supersedes as unknown[]).includes(previousId)) {
        decision.supersedes = [...decision.supersedes as unknown[], previousId];
      }
    }
    latestByKey.set(key, index);
  });
  const pendingQuestions = Array.isArray(body.pendingQuestions) ? body.pendingQuestions.map((item) => {
    const question = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return { ...question, sourceMessageIds: Array.isArray(question.sourceMessageIds) ? question.sourceMessageIds : [] };
  }) : [];
  return {
    topics: topics as ReducerBody["topics"],
    decisions: decisions as unknown as ReducerBody["decisions"],
    pendingQuestions: pendingQuestions as ReducerBody["pendingQuestions"],
    // This reducer sees conversation text only. Service-verified references
    // must be supplied by a future deterministic evidence adapter.
    authoritativeRefs: [],
  };
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  const first = unfenced.indexOf("{");
  const last = unfenced.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("coherence reducer returned no JSON object");
  return JSON.parse(unfenced.slice(first, last + 1));
}

function reducerPrompt(input: {
  previous?: ConversationWorkingStateV1;
  transcript: Array<{ messageId: string; role: string; content: string; createdAt: string }>;
}): string {
  return [
    "Maintain a compact working-state checkpoint for one investment-assistant conversation.",
    "Return exactly one JSON object with keys: topics, decisions, pendingQuestions, authoritativeRefs. No markdown or explanation.",
    "Preserve still-current decisions from previousState. Apply transcript changes chronologically.",
    "When a later message modifies, deletes, rejects, renames, or replaces a value, mark the old decision superseded/rejected and set the new decision.supersedes to the old id.",
    "A natural-language confirmation is at most confirmed-in-conversation. Never emit authoritative decisions or authoritativeRefs; this reducer has no service-verified evidence channel.",
    "Do not invent investment facts. Keep only decisions needed for future logical continuity. Use stable short ASCII ids. Values must be JSON. Source message ids must come from the transcript or previous state.",
    "Every topic has id,label,aliases,lastTouchedMessageId. Every decision has id,topicId,entity,field,value,state,supersedes,sourceMessageIds,confidence.",
    "Every pending question has id,topicId,text,sourceMessageIds. authoritativeRefs is normally empty unless actual execution evidence is explicit.",
    `previousState=${JSON.stringify(input.previous ?? null)}`,
    `transcript=${JSON.stringify(input.transcript)}`,
  ].join("\n");
}

export async function refreshConversationWorkingState(input: {
  conversationId: string;
  scope: ConversationWorkingStateScope;
  model?: string;
  runTurn?: typeof runMastraTurn;
}): Promise<{ status: "disabled" | "noop" | "updated" | "degraded"; state?: ConversationWorkingStateV1; error?: string; latencyMs?: number }> {
  if (!isConversationWorkingStateEnabled(input.scope.instanceId)) return { status: "disabled" };
  const startedAt = Date.now();
  try {
    const previous = loadLatestConversationWorkingState({ conversationId: input.conversationId, scope: input.scope });
    if (previous.status === "scope_mismatch") return { status: "degraded", error: "scope mismatch" };
    const transcript = loadConversationWorkingStateTranscript({
      conversationId: input.conversationId,
      scope: normalizeConversationWorkingStateScope(input.scope),
      afterMessageId: previous.state?.throughMessageId,
    });
    const target = [...transcript].reverse().find((message) => message.role === "assistant");
    if (!target) return { status: "noop", state: previous.state, latencyMs: Date.now() - startedAt };
    const throughIndex = transcript.findIndex((message) => message.messageId === target.messageId);
    const source = transcript.slice(0, throughIndex + 1);
    if (source.length === 0) return { status: "noop", state: previous.state, latencyMs: Date.now() - startedAt };
    const result = await (input.runTurn ?? runMastraTurn)({
      conversationId: `coherence-reducer:${input.conversationId}:${randomUUID()}`,
      text: reducerPrompt({ previous: previous.state, transcript: source }),
      ...(input.model ? { model: input.model } : {}),
      timeoutMs: Number(process.env.COHERENCE_STATE_REDUCER_TIMEOUT_MS) || DEFAULT_REDUCER_TIMEOUT_MS,
      maxSteps: 1,
    }, {
      agentOptions: {
        name: "Conversation Working State Reducer",
        instructions: "You are a conversation state reducer. Never call tools. Return strict JSON only and follow the user-provided state schema exactly.",
        tools: {},
      },
      maxSteps: 1,
    });
    const body = normalizeReducerBody(extractJsonObject(result.text));
    const state: ConversationWorkingStateV1 = {
      version: 1,
      conversationId: input.conversationId,
      scope: normalizeConversationWorkingStateScope(input.scope),
      throughMessageId: target.messageId,
      throughCreatedAt: target.createdAt,
      topics: body.topics,
      decisions: body.decisions,
      pendingQuestions: body.pendingQuestions,
      authoritativeRefs: body.authoritativeRefs,
      generatedAt: new Date().toISOString(),
      generatorVersion: GENERATOR_VERSION,
      sourceDigest: workingStateSourceDigest({
        previousDigest: previous.state?.sourceDigest,
        messages: source,
      }),
    };
    const validation = validateConversationWorkingState(state, {
      expectedConversationId: input.conversationId,
      expectedScope: normalizeConversationWorkingStateScope(input.scope),
    });
    if (!validation.valid || !validation.state) {
      throw new Error(validation.issues.slice(0, 3).map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    }
    const persisted = persistConversationWorkingStateCheckpoint({
      assistantMessageId: target.messageId,
      conversationId: input.conversationId,
      scope: input.scope,
      state: validation.state,
    });
    if (!persisted) throw new Error("checkpoint target disappeared before persistence");
    return { status: "updated", state: persisted, latencyMs: Date.now() - startedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`conversation working state reducer degraded conversationId=${input.conversationId}: ${message}`);
    return { status: "degraded", error: message, latencyMs: Date.now() - startedAt };
  }
}

export function scheduleConversationWorkingStateRefresh(input: {
  conversationId: string;
  scope: ConversationWorkingStateScope;
  model?: string;
}): void {
  if (!isConversationWorkingStateEnabled(input.scope.instanceId)) return;
  const key = `${input.scope.userId}\0${input.scope.projectId}\0${input.scope.instanceId}\0${input.conversationId}`;
  const previous = reducerTails.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => refreshConversationWorkingState(input))
    .then(() => undefined);
  reducerTails.set(key, next);
  void next.finally(() => {
    if (reducerTails.get(key) === next) reducerTails.delete(key);
  });
}
