import assert from "node:assert/strict";
import test from "node:test";
import { sendWeixinTextMessage } from "../src/channels/weixin-message-bridge.js";

const originalFetch = globalThis.fetch;

function mockFetch(body: string, status = 200, capture?: (request: RequestInit) => void) {
  globalThis.fetch = async (_input, init) => {
    capture?.(init ?? {});
    return new Response(body, { status });
  };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("WeChat send accepts an empty JSON response and forwards the context token", async () => {
  let sentBody = "";
  mockFetch("{}", 200, (request) => { sentBody = String(request.body || ""); });

  await sendWeixinTextMessage({
    baseUrl: "https://example.test",
    token: "token",
    to: "user",
    text: "hello",
    contextToken: "ctx",
  });

  assert.equal(JSON.parse(sentBody).msg.context_token, "ctx");
});

test("WeChat send rejects protocol and HTTP failures", async () => {
  for (const [body, status, pattern] of [
    ['{"ret":-2}', 200, /ret=-2/],
    ['{"errcode":40001,"errmsg":"bad token"}', 200, /errcode=40001/],
    ["bad gateway", 502, /502/],
  ] as const) {
    mockFetch(body, status);
    await assert.rejects(() => sendWeixinTextMessage({
      baseUrl: "https://example.test",
      token: "token",
      to: "user",
      text: "hello",
    }), pattern);
  }
});
