import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildMarketWatchTaskPrompt } from "../src/runtime/scheduled-tasks.js";

test("R4: market-watch prompt does not force named tools or forbid NO_PUSH", () => {
  const prompt = buildMarketWatchTaskPrompt({ userId: "user-a", instanceId: "instance-a" }, "scheduled_intraday_brief");
  // R4: 新 prompt 不含具体读工具名
  assert.doesNotMatch(prompt, /market(?:_watch)?\.(?:snapshot|quote|indices|kline|capital_flow|sector_theme|stock_info|calendar|health)/);
  // R4: 不强制"至少一个具名行情读取能力"
  assert.doesNotMatch(prompt, /至少一个.*具名行情读取能力/);
  // R4: 不禁止 NO_PUSH（NO_PUSH 由用户配置和服务工具决定）
  assert.doesNotMatch(prompt, /禁止输出 NO_PUSH/);
  // R4: 仍解释精确输出协议
  assert.match(prompt, /NO_PUSH/);
  // R4: 工具选择委托给 Mastra 可用的服务工具/MCP。
  assert.match(prompt, /工具选择.*自行决定|研究方法.*自行决定/);
  assert.doesNotMatch(prompt, /AGENTS\.md|Workspace|Skills|ACP|Codex|Hermes/i);
});

test("market-watch push body requires a WeChat-renderable Markdown brief", () => {
  const prompt = buildMarketWatchTaskPrompt({ userId: "user-a", instanceId: "instance-a" }, "scheduled_intraday_brief");
  assert.match(prompt, /只输出微信正文/);
  assert.match(prompt, /必须使用适合微信阅读且可由微信渲染的简洁 Markdown/);
  assert.match(prompt, /`\*\*重点\*\*`/);
  assert.match(prompt, /列表或短标题/);
  assert.match(prompt, /不要写成无格式的连续纯文本/);
});
