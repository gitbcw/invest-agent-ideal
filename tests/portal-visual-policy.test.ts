import assert from "node:assert/strict";
import test from "node:test";

import { buildChannelContextInstruction } from "../src/acp/agent.js";

test("web channel teaches the proactive inline SVG selection policy", () => {
  const instruction = buildChannelContextInstruction("web") || "";
  assert.match(instruction, /看比读更划算时才给/);
  assert.match(instruction, /教学\/讲解\/介绍投资概念/);
  assert.match(instruction, /两个或以上对象或方案的比较/);
  assert.match(instruction, /默认最多一张/);
  assert.match(instruction, /只有用户明确要求多图、两张图或分别画图/);
  assert.match(instruction, /复杂话题本身不是生成第二张图的理由/);
  assert.match(instruction, /纯词义解释、单一事实或简短行情问答/);
  assert.match(instruction, /数据行不超过 7 条且列不超过 5 列/);
  assert.match(instruction, /超过 7 条数据行或超过 5 列/);
  assert.match(instruction, /Excel（\.xlsx）文件到 `deliveries\/` 下/);
  assert.match(instruction, /表头不计入 7 条数据行/);
  assert.match(instruction, /冻结表头、筛选和适合阅读的列宽/);
  assert.doesNotMatch(instruction, /UTF-8 CSV 文件到 `reports\/` 下/);
  assert.match(instruction, /只能使用下方的 `invest-svg` 内联图示/);
  assert.match(instruction, /最多 2 张/);
  assert.match(instruction, /用户明确要求发送、提供链接或下载某个文件/);
  assert.match(instruction, /本轮实际新建或生成了文件/);
  assert.match(instruction, /本轮实际修改了用户 Workspace 中的文件/);
  assert.match(instruction, /仅仅读取、引用、提到/);
  assert.match(instruction, /按文件路径去重/);
  assert.doesNotMatch(instruction, /复杂话题可用 2-3 张/);
  assert.doesNotMatch(instruction, /最多 3 张/);
});

test("non-web channels do not receive the Portal visual policy", () => {
  assert.doesNotMatch(buildChannelContextInstruction("weixin-mobile") || "", /invest-svg/);
  assert.equal(buildChannelContextInstruction("api"), null);
});
