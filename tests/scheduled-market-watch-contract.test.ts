import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildMarketWatchTaskPrompt } from "../src/acp/scheduled-tasks.js";

test("R4: market-watch prompt does not force named tools or forbid NO_PUSH", () => {
  const prompt = buildMarketWatchTaskPrompt({ userId: "user-a", instanceId: "instance-a" }, "scheduled_intraday_brief");
  // R4: 新 prompt 不含具体读工具名
  assert.doesNotMatch(prompt, /market(?:_watch)?\.(?:snapshot|quote|indices|kline|capital_flow|sector_theme|stock_info|calendar|health)/);
  // R4: 不强制"至少一个具名行情读取能力"
  assert.doesNotMatch(prompt, /至少一个.*具名行情读取能力/);
  // R4: 不禁止 NO_PUSH（NO_PUSH 由 ACP/Skills/通知策略决定）
  assert.doesNotMatch(prompt, /禁止输出 NO_PUSH/);
  // R4: 仍解释精确输出协议
  assert.match(prompt, /NO_PUSH/);
  // R4: 仍委托工具选择给 ACP/Skills
  assert.match(prompt, /工具选择.*自行决定|研究方法.*自行决定/);
});
