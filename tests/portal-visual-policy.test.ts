import assert from "node:assert/strict";
import test from "node:test";

import { buildChannelContextInstruction } from "../src/acp/agent.js";

test("web channel teaches the proactive inline SVG selection policy", () => {
  const instruction = buildChannelContextInstruction("web") || "";
  assert.match(instruction, /看比读更划算时才给/);
  assert.match(instruction, /教学\/讲解\/介绍投资概念/);
  assert.match(instruction, /两个或以上对象或方案的比较/);
  assert.match(instruction, /纯词义解释、单一事实或简短行情问答/);
  assert.match(instruction, /只能使用下方的 `invest-svg` 内联图示/);
});

test("non-web channels do not receive the Portal visual policy", () => {
  assert.doesNotMatch(buildChannelContextInstruction("weixin-mobile") || "", /invest-svg/);
  assert.equal(buildChannelContextInstruction("api"), null);
});
