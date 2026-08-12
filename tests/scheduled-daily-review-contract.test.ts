import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildDailyReviewTaskPrompt } from "../src/runtime/scheduled-tasks.js";

test("scheduled daily review requires a Markdown WeChat push brief", () => {
  const prompt = buildDailyReviewTaskPrompt();

  assert.match(prompt, /pushBrief 会直接作为微信消息发送给用户/);
  assert.match(prompt, /必须使用适合微信阅读且可由微信渲染的简洁 Markdown/);
  assert.match(prompt, /`\*\*重点\*\*`/);
  assert.match(prompt, /列表或短标题/);
});
