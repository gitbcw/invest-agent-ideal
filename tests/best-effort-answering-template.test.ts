import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

async function templateFile(relativePath: string) {
  return readFile(path.resolve(relativePath), "utf8");
}

test("workspace template treats partial evidence as an answer boundary, not a stop signal", async () => {
  const agents = await templateFile("templates/workspace/AGENTS.md");
  const servicePolicy = await templateFile("templates/workspace/.codex/skills/service-capability-policy/SKILL.md");

  assert.match(agents, /数据缺口只限制受影响的子结论/);
  assert.match(agents, /“全部”“完整”“全市场”默认是目标范围/);
  assert.match(agents, /不要把内部能力申请.*发给用户/);
  assert.match(servicePolicy, /Complete every remaining subtask supported by trustworthy evidence/);
  assert.match(servicePolicy, /representative sample is never a full-market scan/);
});

test("workspace template writes available values into user-facing tables instead of repeating verification placeholders", async () => {
  const agents = await templateFile("templates/workspace/AGENTS.md");
  const qa = await templateFile("templates/workspace/skills/qa/prompt.md");

  for (const content of [agents, qa]) {
    assert.match(content, /已经取得的具体数值.*写入/);
    assert.match(content, /确实没有.*数值.*留空或填“—”/);
    assert.match(content, /不得用“待核验”“数据缺失”等状态词批量占满单元格/);
  }
});

test("capability extension separates the current answer from persistent capability work", async () => {
  const skill = await templateFile("templates/workspace/.codex/skills/capability-extension/SKILL.md");
  const protocol = await templateFile("templates/workspace/knowledge/capability_extension_protocol.md");

  assert.match(skill, /Make two independent decisions/);
  assert.match(skill, /before considering a capability gap response/);
  assert.doesNotMatch(skill, /Use exactly one of these outcomes/);
  assert.match(protocol, /两条独立判断/);
  assert.match(protocol, /不能互相替代/);
  assert.match(protocol, /普通分析只在末尾简要说明受影响范围/);
});

test("research workflows preserve scope and continue around missing fields", async () => {
  const files = [
    "templates/workspace/.codex/skills/observation-pool/SKILL.md",
    "templates/workspace/.codex/skills/daily-portfolio-review/SKILL.md",
    "templates/workspace/.codex/skills/weekly-portfolio-review/SKILL.md",
    "templates/workspace/.codex/skills/monthly-portfolio-review/SKILL.md",
    "templates/workspace/.codex/skills/core-company-fundamental-review/SKILL.md",
  ];

  for (const relativePath of files) {
    const content = await templateFile(relativePath);
    assert.match(content, /coverage|Coverage|覆盖|partial|部分/, relativePath);
  }
});
