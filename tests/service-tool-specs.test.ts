import assert from "node:assert/strict";
import test from "node:test";

import { ALL_SERVICE_TOOL_SPECS } from "../src/mastra/tools/tool-specs.js";
import { TOOL_SPECS as MASTRA_TOOL_SPECS } from "../src/mastra/tools/registry.js";

const MCP_EXCLUDED_TOOLS = new Set(["spreadsheet.create", "spreadsheet.transform"]);

test("service tool specs are the single source with unique ids", () => {
  const ids = ALL_SERVICE_TOOL_SPECS.map((spec) => spec.id);
  assert.equal(new Set(ids).size, ids.length, "tool ids must be unique");
  for (const spec of ALL_SERVICE_TOOL_SPECS) {
    assert.ok(spec.description.length > 0, `${spec.id} needs a description`);
    assert.ok(Object.keys(spec.inputSchema).length > 0 || spec.id.endsWith(".catalog") || spec.id.includes("draft.commit_status") || spec.id === "onboarding.draft.get" || spec.id.endsWith(".list") || spec.id.endsWith(".read") || spec.id === "portfolio.read" || spec.id === "watchlist.read" || spec.id === "plans.read",
      `${spec.id} schema shape unexpectedly empty`);
  }
});

test("Mastra tool face is a strict subset of the shared specs", () => {
  const allIds = new Set(ALL_SERVICE_TOOL_SPECS.map((spec) => spec.id));
  for (const spec of MASTRA_TOOL_SPECS) {
    assert.ok(allIds.has(spec.id), `registry tool ${spec.id} must come from tool-specs`);
  }
  assert.equal(new Set(MASTRA_TOOL_SPECS.map((s) => s.id)).size, MASTRA_TOOL_SPECS.length);
});

test("MCP face = shared specs minus the spreadsheet bridge pair", () => {
  const mcpFace = ALL_SERVICE_TOOL_SPECS.filter((spec) => !MCP_EXCLUDED_TOOLS.has(spec.id));
  assert.equal(mcpFace.length, ALL_SERVICE_TOOL_SPECS.length - 2);
  // The face the external MCP server has always exposed stays stable:
  // every pre-convergence MCP tool id must still be present.
  for (const required of ["research.news_search", "file.parse", "assets.list", "automation.list",
    "automation.get", "automation.create", "portfolio.read", "portfolio.apply_changes",
    "onboarding.confirm_portfolio", "onboarding.confirm_step", "onboarding.complete_watch_setup",
    "watchlist.add", "plans.set", "method_changes.propose", "method_changes.apply",
    "preferences.apply", "reviews.save", "artifacts.publish", "watch_rules.create",
    "confirmations.request", "conversation.history"]) {
    assert.ok(mcpFace.some((spec) => spec.id === required), `MCP face lost ${required}`);
  }
});

test("automation schedule and list filters agree on the monthly frequency (8-31 drift, do not regress)", () => {
  const create = ALL_SERVICE_TOOL_SPECS.find((spec) => spec.id === "automation.create");
  assert.ok(create);
  const schedule = create.inputSchema.schedule;
  assert.ok(schedule, "automation.create must define schedule");
  const monthlySchedule = schedule.safeParse?.({ frequency: "monthly", time: "09:00", timezone: "Asia/Shanghai", monthlyDay: 1 });
  assert.equal(monthlySchedule?.success, true, "automation.create schedule must accept monthly");

  const list = ALL_SERVICE_TOOL_SPECS.find((spec) => spec.id === "automation.list");
  assert.ok(list);
  const frequencies = list.inputSchema.frequencies;
  assert.ok(frequencies, "automation.list must define frequencies");
  const monthlyFilter = frequencies.safeParse?.(["monthly"]);
  assert.equal(monthlyFilter?.success, true, "automation.list frequencies must accept monthly");
});

test("write tools are not marked readOnly", () => {
  const writeTools = ALL_SERVICE_TOOL_SPECS.filter((spec) =>
    spec.annotations?.readOnlyHint === false || /^(watch_rules\.create|assets\.(rename|archive|delete)|automation\.(create|update|activate|pause)|assets\.version\.commit)/.test(spec.id)
  );
  assert.ok(writeTools.length >= 10, "expected the usual write tool set");
  for (const spec of writeTools) {
    assert.equal(spec.annotations?.readOnlyHint ?? true, false, `${spec.id} is a write tool and must not claim readOnlyHint`);
  }
});
