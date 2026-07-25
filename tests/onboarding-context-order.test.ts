import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

test("onboarding context gates drafts behind completed state", async () => {
  const agents = await readFile(path.resolve("templates/workspace/AGENTS.md"), "utf8");
  const skill = await readFile(path.resolve("templates/workspace/.codex/skills/investment-onboarding/SKILL.md"), "utf8");

  assert.match(agents, /先读取 `config\/onboarding_state\.yaml`/);
  assert.match(agents, /status.*completed.*普通持仓查询、复盘/);
  assert.match(agents, /普通投资请求不得创建、修改或恢复 onboarding draft/);
  assert.match(skill, /Read `config\/onboarding_state\.yaml` first/);
  assert.match(skill, /If `status` is `completed`, stop onboarding/);
  assert.match(skill, /Never create an onboarding draft while answering an ordinary investment request/);
  assert.ok(skill.indexOf("Read `config/onboarding_state.yaml` first") < skill.indexOf("call `onboarding.draft.get`"));
});
