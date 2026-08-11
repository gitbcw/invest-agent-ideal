import assert from "node:assert/strict";
import test from "node:test";
import { runMastraTurn } from "../src/mastra/run-turn.js";

test("ACP and Mastra fixture results preserve the same application contract", async () => {
  const acpFixture = {
    text: "fixture reply",
    usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7, source: "actual" as const },
    budget: { state: "completed" as const, toolCallsAfterExhaustion: 0 },
  };
  const mastra = await runMastraTurn({ conversationId: "parity-fixture", text: "fixture" }, {
    agent: {
      async stream() {
        return {
          text: Promise.resolve("fixture reply"),
          usage: Promise.resolve({ inputTokens: 4, outputTokens: 3, totalTokens: 7 }),
          response: Promise.resolve({ modelId: "fixture-model" }),
        };
      },
    },
  });

  assert.deepEqual(
    { text: mastra.text, usage: mastra.usage.totalTokens, budget: mastra.budget.state },
    { text: acpFixture.text, usage: acpFixture.usage.totalTokens, budget: acpFixture.budget.state },
  );
  assert.equal(mastra.backendId, "mastra");
});
