import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { runMastraTurn } from "../src/mastra/run-turn.js";
import { createMastraToolMap } from "../src/mastra/tools/mastra-tools.js";

test("real Mastra Agent completes a local OpenAI-compatible streaming turn", async () => {
  const server = http.createServer((request, response) => {
    let requestBody = "";
    request.on("data", (chunk: Buffer) => { requestBody += chunk.toString(); });
    request.on("end", () => {
      assert.equal(request.method, "POST");
      assert.ok(request.url?.endsWith("/chat/completions"));
      assert.ok(requestBody.includes("runtime-smoke"));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"id":"local","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{"content":"local mastra smoke"},"finish_reason":null}]}\n\n');
      response.write('data: {"id":"local","object":"chat.completion.chunk","created":1,"model":"test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n');
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const tools = await createMastraToolMap({ userId: "runtime-smoke", instanceId: "runtime-smoke" });
    const result = await runMastraTurn({ conversationId: "runtime-smoke", text: "runtime-smoke", timeoutMs: 5_000 }, {
      gateway: { provider: "openai", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-test-key", defaultModel: "test" },
      agentOptions: { tools },
    });
    assert.equal(result.text, "local mastra smoke");
    assert.equal(result.backendId, "mastra");
    assert.equal(result.usage.totalTokens, 7);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
