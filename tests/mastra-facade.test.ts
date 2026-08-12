import assert from "node:assert/strict";
import test from "node:test";

import {
  MastraEmptyResponseError,
  MastraTurnError,
  MastraTurnBusyError,
  MastraTurnTimeoutError,
  createMastraTurnRunner,
  createMastraAgent,
  mapMastraUsage,
  runMastraTurn,
  type MastraAgentLike,
  type MastraBindings,
} from "../src/mastra/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("Mastra factory resolves a gateway model through injected bindings without Memory", async () => {
  let receivedOptions: Record<string, unknown> | undefined;
  class FakeAgent implements MastraAgentLike {
    constructor(options: Record<string, unknown>) {
      receivedOptions = options;
    }

    stream() {
      return { text: "unused" };
    }
  }
  const bindings: MastraBindings = { Agent: FakeAgent };

  const agent = await createMastraAgent({
    bindings,
    gateway: {
      baseUrl: "https://gateway.invalid/v1",
      apiKey: "test-key",
      defaultModel: "fake-model",
    },
    agentId: "fake-agent",
    name: "Fake Agent",
  });

  assert.ok(agent instanceof FakeAgent);
  assert.deepEqual(receivedOptions, {
    id: "fake-agent",
    name: "Fake Agent",
    instructions: "You are an investment decision assistant.",
    model: {
      id: "gateway/fake-model",
      url: "https://gateway.invalid/v1",
      apiKey: "test-key",
    },
  });
  assert.equal("memory" in (receivedOptions ?? {}), false);
});

test("runMastraTurn maps text, usage, model, tool calls, and caller-owned history", async () => {
  const seen: { messages?: unknown; options?: Record<string, unknown> } = {};
  const agent: MastraAgentLike = {
    stream(messages, options) {
      seen.messages = messages;
      seen.options = options;
      return {
        text: Promise.resolve("  answer from fake  "),
        usage: Promise.resolve({
          inputTokens: 11,
          outputTokens: 7,
          reasoningTokens: 2,
          cachedInputTokens: 3,
          totalTokens: 18,
        }),
        toolCalls: Promise.resolve([{
          toolCallId: "call-1",
          toolName: "market.quote",
          status: "completed",
          input: { code: "600000" },
          output: { price: 12.3 },
        }]),
        response: Promise.resolve({ modelId: "gateway/fake-model" }),
      };
    },
  };
  const history = [{ role: "assistant" as const, content: "prior answer" }];

  const result = await runMastraTurn(
    {
      conversationId: "conversation-1",
      messageId: "message-1",
      text: "new question",
      history,
      model: "fake-model",
    },
    {
      agent,
      gateway: {
        baseUrl: "https://gateway.invalid/v1",
        apiKey: "test-key",
        defaultModel: "default-model",
      },
      now: () => 1_700_000_000_000,
    },
  );

  assert.equal(result.text, "answer from fake");
  assert.equal(result.backendId, "mastra");
  assert.equal(result.model, "gateway/fake-model");
  assert.deepEqual(result.usage, {
    inputTokens: 11,
    outputTokens: 7,
    thoughtTokens: 2,
    cachedReadTokens: 3,
    cachedWriteTokens: undefined,
    totalTokens: 18,
    contextWindowUsed: undefined,
    contextWindowSize: undefined,
    costAmount: undefined,
    costCurrency: undefined,
    source: "actual",
  });
  assert.deepEqual(result.toolCalls, [{
    source: "mastra-event",
    toolCallId: "call-1",
    toolName: "market.quote",
    status: "completed",
    startedAt: "2023-11-14T22:13:20.000Z",
    inputChars: 17,
    outputChars: 14,
    serverId: undefined,
    title: undefined,
    kind: undefined,
  }]);
  assert.deepEqual(history, [{ role: "assistant", content: "prior answer" }]);
  assert.deepEqual(seen.messages, [
    { role: "assistant", content: "prior answer" },
    { role: "user", content: "new question" },
  ]);
  assert.ok(seen.options?.abortSignal instanceof AbortSignal);
  assert.equal((seen.options?.metadata as { conversationId: string }).conversationId, "conversation-1");
});

test("runMastraTurn estimates usage when the provider omits usage", async () => {
  const usage = mapMastraUsage(undefined, "hello", "world");
  assert.deepEqual(usage, {
    inputTokens: 2,
    outputTokens: 2,
    totalTokens: 4,
    source: "estimated",
  });
});

test("runMastraTurn maps provider errors to a stable error code", async () => {
  const agent: MastraAgentLike = {
    stream() {
      throw new Error("provider unavailable");
    },
  };

  await assert.rejects(
    runMastraTurn({ conversationId: "error-conversation", text: "question" }, { agent }),
    (error: unknown) => {
      assert.equal((error as { code: string }).code, "MASTRA_TURN_ERROR");
      assert.match(String((error as Error).message), /provider unavailable/);
      return true;
    },
  );
});

test("runMastraTurn preserves provider stream error chunks instead of misclassifying them as empty", async () => {
  const runner = createMastraTurnRunner();
  await assert.rejects(
    runner({ conversationId: "stream-provider-error", text: "hello" }, {
      agent: { stream: async () => ({ fullStream: (async function* () { yield { type: "error", error: "upstream unauthorized" }; })() }) },
    }),
    (error: unknown) => error instanceof MastraTurnError
      && error.code === "MASTRA_TURN_ERROR"
      && error.message.includes("upstream unauthorized"),
  );
});

test("runMastraTurn rejects an empty text response", async () => {
  const agent: MastraAgentLike = {
    stream: async () => ({ text: " \n\t" }),
  };

  await assert.rejects(
    runMastraTurn({ conversationId: "empty-conversation", text: "question" }, { agent }),
    (error: unknown) => {
      assert.ok(error instanceof MastraEmptyResponseError);
      assert.equal((error as { code: string }).code, "MASTRA_EMPTY_RESPONSE");
      return true;
    },
  );
});

test("runMastraTurn aborts a hanging stream and maps timeout", async () => {
  let aborted = false;
  const agent: MastraAgentLike = {
    stream(_messages, options) {
      const signal = options?.abortSignal as AbortSignal;
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => undefined);
    },
  };

  await assert.rejects(
    runMastraTurn({ conversationId: "timeout-conversation", text: "question", timeoutMs: 15 }, { agent }),
    (error: unknown) => {
      assert.ok(error instanceof MastraTurnTimeoutError);
      assert.equal((error as { code: string }).code, "MASTRA_TURN_TIMEOUT");
      return true;
    },
  );
  assert.equal(aborted, true);
});

test("runMastraTurn rejects a concurrent turn for the same conversation", async () => {
  const output = deferred<string>();
  const agent: MastraAgentLike = {
    stream: async () => ({ text: output.promise }),
  };
  const first = runMastraTurn({ conversationId: "busy-conversation", text: "first" }, { agent });
  await new Promise<void>((resolve) => setImmediate(resolve));

  await assert.rejects(
    runMastraTurn({ conversationId: "busy-conversation", text: "second" }, { agent }),
    (error: unknown) => {
      assert.ok(error instanceof MastraTurnBusyError);
      assert.equal((error as { code: string }).code, "MASTRA_TURN_BUSY");
      return true;
    },
  );
  output.resolve("first response");
  await first;
});
