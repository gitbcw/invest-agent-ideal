import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sendWeixinTextMessage } from "../dist/channels/weixin-message-bridge.js";

function mockFetch(body, ok = true, status = 200) {
  globalThis.fetch = async () => ({
    ok,
    status,
    text: async () => body,
  });
}

mockFetch("{}");
await sendWeixinTextMessage({
  baseUrl: "https://example.test",
  token: "token",
  to: "user",
  text: "hello",
  contextToken: "ctx",
});

mockFetch('{"ret":-2}');
await assert.rejects(
  () => sendWeixinTextMessage({
    baseUrl: "https://example.test",
    token: "token",
    to: "user",
    text: "hello",
  }),
  /ret=-2/
);

mockFetch('{"errcode":40001,"errmsg":"bad token"}');
await assert.rejects(
  () => sendWeixinTextMessage({
    baseUrl: "https://example.test",
    token: "token",
    to: "user",
    text: "hello",
  }),
  /errcode=40001/
);

mockFetch("bad gateway", false, 502);
await assert.rejects(
  () => sendWeixinTextMessage({
    baseUrl: "https://example.test",
    token: "token",
    to: "user",
    text: "hello",
  }),
  /502/
);

const bridgeSource = readFileSync("src/channels/weixin-message-bridge.ts", "utf-8");
const mobileSource = readFileSync("src/channels/weixin-mobile.ts", "utf-8");
const patchSource = readFileSync("scripts/patch-weixin-agent-sdk.mjs", "utf-8");

assert.match(bridgeSource, /WEIXIN_TEXT_CHUNK_LIMIT[\s\S]*\|\| 2000/);
assert.match(mobileSource, /WEIXIN_TEXT_CHUNK_LIMIT[\s\S]*\|\| 2000/);
assert.match(patchSource, /contextToken,\\n\\t\\tmedia/);
assert.match(patchSource, /contextToken\?: string/);

console.log(JSON.stringify({
  ok: true,
  checks: [
    "empty JSON response is accepted",
    "ret=-2 is rejected",
    "errcode failure is rejected",
    "HTTP failure is rejected",
    "default WeChat chunk limit is 2000",
    "weixin-agent-sdk postinstall patch passes contextToken to agent.chat",
  ],
}, null, 2));
