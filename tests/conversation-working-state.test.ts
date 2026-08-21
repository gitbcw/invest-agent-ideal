import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONVERSATION_WORKING_STATE_MAX_BYTES,
  CONVERSATION_WORKING_STATE_PROMPT_MAX_BYTES,
  formatConversationWorkingStatePromptSlice,
  isConversationWorkingStateEnabled,
  projectCurrentDecisions,
  validateConversationWorkingState,
  type ConversationWorkingStateV1,
} from "../src/services/conversation-working-state.js";

function makeState(overrides: Partial<ConversationWorkingStateV1> = {}): ConversationWorkingStateV1 {
  return {
    version: 1,
    conversationId: "conversation-1",
    scope: { userId: "user-1", projectId: "invest-agent", instanceId: "instance-1" },
    throughMessageId: "assistant-2",
    throughCreatedAt: "2026-08-21T12:00:00.000Z",
    topics: [
      { id: "strategy", label: "Strategy", aliases: ["rules"], lastTouchedMessageId: "user-2" },
      { id: "review", label: "Review", aliases: [], lastTouchedMessageId: "user-4" },
    ],
    decisions: [
      {
        id: "decision-old",
        topicId: "strategy",
        entity: "buying",
        field: "fundamentalGate",
        value: "risk-assessment",
        state: "superseded",
        supersedes: [],
        sourceMessageIds: ["user-1"],
        confidence: "high",
      },
      {
        id: "decision-new",
        topicId: "strategy",
        entity: "buying",
        field: "fundamentalGate",
        value: "risk-assessment-only",
        state: "confirmed-in-conversation",
        supersedes: ["decision-old"],
        sourceMessageIds: ["user-2"],
        confidence: "high",
      },
    ],
    pendingQuestions: [
      { id: "question-1", topicId: "strategy", text: "Which strategy is active?", sourceMessageIds: ["user-2"] },
    ],
    authoritativeRefs: [],
    generatedAt: "2026-08-21T12:00:01.000Z",
    generatorVersion: "test-v1",
    sourceDigest: "sha256:test",
    ...overrides,
  };
}

test("validates a strict V1 state and rejects unknown keys", () => {
  const valid = validateConversationWorkingState(makeState(), {
    expectedConversationId: "conversation-1",
    expectedScope: { userId: "user-1", projectId: "invest-agent", instanceId: "instance-1" },
  });
  assert.equal(valid.valid, true);
  assert.ok(valid.bytes);

  const withUnknown = makeState() as ConversationWorkingStateV1 & { extra?: string };
  withUnknown.extra = "must be rejected";
  const invalid = validateConversationWorkingState(withUnknown);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.issues.some((issue) => issue.path === "$.extra"));
});

test("requires scoped references for authoritative decisions", () => {
  const invalid = validateConversationWorkingState(makeState({
    decisions: [{
      id: "authoritative-without-ref",
      topicId: "strategy",
      entity: "strategy",
      field: "status",
      value: "active",
      state: "authoritative",
      supersedes: [],
      sourceMessageIds: ["user-2"],
      confidence: "high",
    }],
  }));
  assert.equal(invalid.valid, false);
  assert.ok(invalid.issues.some((issue) => issue.path.endsWith("authorityRef")));
});

test("projects replacements and never revives superseded decisions", () => {
  const state = makeState();
  const current = projectCurrentDecisions(state.decisions);
  assert.deepEqual(current.map((decision) => decision.id), ["decision-new"]);
  assert.equal(current[0]?.value, "risk-assessment-only");
});

test("rejects two live values for the same decision field without supersession", () => {
  const state = makeState({
    decisions: [
      makeState().decisions[1],
      { ...makeState().decisions[1], id: "decision-other", supersedes: [], value: "different" },
    ],
  });
  const invalid = validateConversationWorkingState(state);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.issues.some((issue) => issue.message.includes("conflicts with current decision")));
});

test("requires superseded predecessors to carry a terminal state", () => {
  const base = makeState();
  const invalid = validateConversationWorkingState({
    ...base,
    decisions: [
      { ...base.decisions[0], state: "proposed" },
      base.decisions[1],
    ],
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.issues.some((issue) => issue.message.includes("must be marked superseded or rejected")));
});

test("enforces the UTF-8 snapshot cap", () => {
  const oversized = makeState({
    pendingQuestions: [{ id: "q", topicId: "review", text: "中".repeat(CONVERSATION_WORKING_STATE_MAX_BYTES), sourceMessageIds: ["u"] }],
  });
  const invalid = validateConversationWorkingState(oversized);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.bytes && invalid.bytes > CONVERSATION_WORKING_STATE_MAX_BYTES);
});

test("formats a bounded prompt slice with a do-not-revive marker", () => {
  const text = formatConversationWorkingStatePromptSlice(makeState(), { topicIds: ["strategy"] });
  assert.ok(text.includes("derived context, not authority"));
  assert.ok(text.includes("risk-assessment-only"));
  assert.ok(text.includes("risk-assessment\" [superseded; do not revive]"));
  assert.ok(new TextEncoder().encode(text).byteLength <= CONVERSATION_WORKING_STATE_PROMPT_MAX_BYTES);
});

test("selects relevant topics and clips prompt output by UTF-8 bytes", () => {
  const state = makeState({
    topics: [
      ...makeState().topics,
      { id: "other", label: "Other", aliases: [], lastTouchedMessageId: "user-8" },
    ],
    pendingQuestions: [{ id: "q", topicId: "other", text: "x".repeat(8000), sourceMessageIds: ["u"] }],
  });
  const text = formatConversationWorkingStatePromptSlice(state, { query: "other", maxBytes: 256 });
  assert.ok(text.includes("working state slice clipped"));
  assert.ok(new TextEncoder().encode(text).byteLength <= 256);
});

test("falls back to bounded current topics when a natural-language query has no exact label match", () => {
  const text = formatConversationWorkingStatePromptSlice(makeState(), { query: "请复述我们最终确认的规则" });
  assert.ok(text.includes("risk-assessment-only"));
  assert.ok(text.includes("decision-old") === false);
  assert.ok(new TextEncoder().encode(text).byteLength <= CONVERSATION_WORKING_STATE_PROMPT_MAX_BYTES);
});

test("never exceeds a prompt cap smaller than its clipping marker", () => {
  const text = formatConversationWorkingStatePromptSlice(makeState(), { maxBytes: 8 });
  assert.ok(new TextEncoder().encode(text).byteLength <= 8);
});

test("parses instance allowlist and wildcard", () => {
  assert.equal(isConversationWorkingStateEnabled("instance-1", { COHERENCE_STATE_INSTANCE_ALLOWLIST: "other, instance-1" }), true);
  assert.equal(isConversationWorkingStateEnabled("instance-1", { COHERENCE_STATE_INSTANCE_ALLOWLIST: " other , another " }), false);
  assert.equal(isConversationWorkingStateEnabled("instance-1", { COHERENCE_STATE_INSTANCE_ALLOWLIST: "*" }), true);
  assert.equal(isConversationWorkingStateEnabled("instance-1", {}), false);
});
