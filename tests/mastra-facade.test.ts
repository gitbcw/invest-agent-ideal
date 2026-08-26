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

test("runMastraTurn creates a real server-side RequestContext for dynamic Mastra bindings", async () => {
  let requestContext: { get?(key: string): unknown } | undefined;
  const agent: MastraAgentLike = {
    stream(_messages, options) {
      requestContext = options?.requestContext as { get?(key: string): unknown };
      return { text: "ok" };
    },
  };
  const result = await runMastraTurn(
    { conversationId: "request-context", text: "test", requestContext: { userId: "alpha", instanceId: "instance-alpha" } },
    { agent },
  );
  assert.equal(result.text, "ok");
  assert.equal(requestContext?.get?.("userId"), "alpha");
  assert.equal(requestContext?.get?.("instanceId"), "instance-alpha");
});

test("runMastraTurn sends inline images as multimodal content parts", async () => {
  const seen: { messages?: unknown } = {};
  const agent: MastraAgentLike = {
    stream(messages) {
      seen.messages = messages;
      return { text: "ok" };
    },
  };
  const result = await runMastraTurn(
    {
      conversationId: "inline-images",
      text: "看图",
      images: [{ mimeType: "image/png", base64: "aW1n" }],
    },
    { agent },
  );
  assert.equal(result.text, "ok");
  const messages = seen.messages as Array<{ role: string; content: unknown }>;
  const last = messages[messages.length - 1];
  assert.equal(last.role, "user");
  const parts = last.content as Array<{ type: string; text?: string; data?: string; mediaType?: string }>;
  assert.ok(Array.isArray(parts), "user content should be a parts array when images are attached");
  assert.equal(parts[0].type, "text");
  assert.equal(parts[0].text, "看图");
  assert.equal(parts[1].type, "file");
  assert.equal(parts[1].data, "aW1n");
  assert.equal(parts[1].mediaType, "image/png");
});

test("runMastraTurn without images keeps plain string content", async () => {
  const seen: { messages?: unknown } = {};
  const agent: MastraAgentLike = {
    stream(messages) {
      seen.messages = messages;
      return { text: "ok" };
    },
  };
  await runMastraTurn({ conversationId: "plain-text", text: "hi" }, { agent });
  const messages = seen.messages as Array<{ role: string; content: unknown }>;
  assert.equal(messages[messages.length - 1].content, "hi");
});

test("GPT-series turns carry default reasoningEffort=high; non-GPT turns do not (owner 2026-08-26)", async () => {
  const gatewayOptions = { baseUrl: "https://gateway.invalid/v1", apiKey: "test-key" };
  const capture = () => {
    const seen: { providerOptions?: unknown; model?: unknown } = {};
    const agent: MastraAgentLike = {
      stream(_messages, options) {
        seen.providerOptions = options?.providerOptions;
        seen.model = options?.model;
        return { text: "ok" };
      },
    };
    return { agent, seen };
  };

  // gpt-* 轮：providerOptions 以 provider 前缀为命名空间携带 reasoningEffort=high。
  const gptRun = capture();
  await runMastraTurn(
    { conversationId: "gpt-effort", text: "test", model: "gpt-5.6-terra" },
    { agent: gptRun.agent, gateway: gatewayOptions },
  );
  assert.deepEqual(gptRun.seen.providerOptions, { gateway: { reasoningEffort: "high" } });

  // 非 GPT 轮：不携带 providerOptions。
  const domesticRun = capture();
  await runMastraTurn(
    { conversationId: "domestic-effort", text: "test", model: "deepseek-v4-flash-vision-exp" },
    { agent: domesticRun.agent, gateway: gatewayOptions },
  );
  assert.equal(domesticRun.seen.providerOptions, undefined);

  // 环境变量覆盖：MASTRA_GPT_REASONING_EFFORT 临时调整思考深度。
  const previous = process.env.MASTRA_GPT_REASONING_EFFORT;
  try {
    process.env.MASTRA_GPT_REASONING_EFFORT = "low";
    const overrideRun = capture();
    await runMastraTurn(
      { conversationId: "gpt-effort-override", text: "test", model: "gpt-5.6-luna" },
      { agent: overrideRun.agent, gateway: gatewayOptions },
    );
    assert.deepEqual(overrideRun.seen.providerOptions, { gateway: { reasoningEffort: "low" } });
  } finally {
    if (previous === undefined) delete process.env.MASTRA_GPT_REASONING_EFFORT;
    else process.env.MASTRA_GPT_REASONING_EFFORT = previous;
  }
});

test("Mastra model configuration is snapshotted per turn and changes only affect later agents", async () => {
  const previousModel = process.env.MASTRA_DEFAULT_MODEL;
  const captured: string[] = [];
  class FakeAgent implements MastraAgentLike {
    constructor(options: Record<string, unknown>) {
      captured.push(String((options.model as { id?: string })?.id));
    }
    stream() { return { text: "ok" }; }
  }
  const bindings: MastraBindings = { Agent: FakeAgent };
  try {
    process.env.MASTRA_DEFAULT_MODEL = "model-a";
    const first = await createMastraAgent({ bindings, gateway: { baseUrl: "https://gateway.invalid/v1", apiKey: "test" } });
    process.env.MASTRA_DEFAULT_MODEL = "model-b";
    const second = await createMastraAgent({ bindings, gateway: { baseUrl: "https://gateway.invalid/v1", apiKey: "test" } });
    await first.stream([], {});
    await second.stream([], {});
    assert.deepEqual(captured, ["gateway/model-a", "gateway/model-b"]);
  } finally {
    if (previousModel === undefined) delete process.env.MASTRA_DEFAULT_MODEL;
    else process.env.MASTRA_DEFAULT_MODEL = previousModel;
  }
});

test("Mastra turns continue after tool steps within the server-owned step budget", async () => {
  let factoryOptions: Record<string, unknown> | undefined;
  const agent = {
    stream(_messages: unknown, options?: Record<string, unknown>) {
      assert.equal(options?.maxSteps, 20);
      return { text: Promise.resolve("final after tool") };
    },
  } satisfies MastraAgentLike;
  const result = await runMastraTurn({ conversationId: "max-steps", text: "use a tool", maxSteps: 20 }, {
    agentFactory: async (options) => {
      factoryOptions = options as Record<string, unknown>;
      return agent;
    },
  });
  assert.equal(result.text, "final after tool");
  assert.equal(factoryOptions?.maxSteps, 20);
  assert.ok(result.budget.timing);
  assert.equal(typeof result.budget.timing?.totalMs, "number");
  assert.equal(result.budget.timing?.toolCallEvents, 0);
});

test("Mastra maxSteps is bounded and rejects unsafe caller values", async () => {
  await assert.rejects(
    () => runMastraTurn({ conversationId: "max-steps-invalid", text: "test", maxSteps: 21 }, { agent: { stream: () => ({ text: "ok" }) } }),
    /MASTRA_MAX_STEPS_INVALID/,
  );
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

test("failed turns carry the attempt model and tool calls observed before the error (T-327 forensics)", async () => {
  const runner = createMastraTurnRunner();
  await assert.rejects(
    runner({ conversationId: "forensics-turn", text: "复盘今日持仓", model: "gpt-5.6-sol" }, {
      agent: {
        stream: async () => ({
          fullStream: (async function* () {
            yield { type: "tool-call", payload: { toolCallId: "call-1", toolName: "get_fund_flows", args: { start: "20260812" } } };
            yield { type: "error", error: "stream died mid-turn" };
          })(),
        }),
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof MastraTurnError);
      assert.equal(error.model, "gpt-5.6-sol");
      assert.ok(Array.isArray(error.toolCalls), "tool calls observed before the error must survive on the error");
      assert.ok((error.toolCalls as Array<{ toolName?: string }>).some((call) => call.toolName === "get_fund_flows"));
      return true;
    },
  );
});

test("tool-error chunks are recoverable tool events and no longer kill the turn (T-328)", async () => {
  const runner = createMastraTurnRunner();
  const result = await runner(
    { conversationId: "tool-error-recoverable", text: "读一下昨天的报告" },
    {
      agent: {
        stream: async () => ({
          fullStream: (async function* () {
            yield { type: "tool-call", payload: { toolCallId: "call-enoent", toolName: "mastra_workspace_read_file", args: { path: "migrated/reports/2026-08-19.md" } } };
            // 8-19 实锤形态：幻觉路径 ENOENT → 工具异常以 tool-error 流块回流。
            yield {
              type: "tool-error",
              payload: {
                toolCallId: "call-enoent",
                toolName: "mastra_workspace_read_file",
                args: { path: "migrated/reports/2026-08-19.md" },
                error: new Error("TOOL_EXECUTION_FAILED: ENOENT: no such file or directory"),
              },
            };
            // 模型读到错误后自纠并继续输出——整轮必须活下来。
            yield { type: "text-delta", text: "该路径不存在，我改用 list 定位实际报告目录后继续。" };
          })(),
        }),
      },
    },
  );
  assert.equal(result.text, "该路径不存在，我改用 list 定位实际报告目录后继续。");
  const errored = result.toolCalls?.find((call) => call.status === "error");
  assert.ok(errored, "end-of-turn tool call summary must include the errored call");
  assert.equal(errored?.toolName, "mastra_workspace_read_file");
  assert.match(errored?.errorExcerpt ?? "", /ENOENT/, "error excerpt must carry the real tool error text");
});

test("tool-error events survive verbatim on the forensics sink (T-328)", async () => {
  const runner = createMastraTurnRunner();
  await assert.rejects(
    runner({ conversationId: "tool-error-then-stream-death", text: "复盘" }, {
      agent: {
        stream: async () => ({
          fullStream: (async function* () {
            yield { type: "tool-error", payload: { toolCallId: "call-429", toolName: "get_stock_profile", args: { symbol: "600519" }, error: new Error("HTTP 429") } };
            yield { type: "error", error: "gateway gave up" };
          })(),
        }),
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof MastraTurnError);
      const observed = (error as { toolCalls?: Array<Record<string, unknown>> }).toolCalls ?? [];
      const errored = observed.find((call) => call.toolName === "get_stock_profile");
      assert.ok(errored, "tool-error before a stream death must survive on the forensics sink");
      assert.equal(typeof errored?.error, "string", "Error instances must be stringified for JSON forensics");
      assert.match(String(errored?.error), /429/);
      return true;
    },
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
