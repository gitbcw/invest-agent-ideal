import assert from "node:assert/strict";
import test from "node:test";
import { selectExecutionBackend } from "../src/mastra/backend-selection.js";

const context = { userId: "internal", instanceId: "instance-1" };

test("backend selection defaults to ACP", () => {
  assert.deepEqual(selectExecutionBackend(context, {}), { backend: "acp", reason: "default-acp" });
});

test("Mastra requires operator flag and internal allowlist", () => {
  assert.deepEqual(selectExecutionBackend(context, { INVEST_AGENT_MASTRA_ENABLED: "true" }), { backend: "acp", reason: "mastra-allowlist-required" });
  assert.equal(selectExecutionBackend(context, { INVEST_AGENT_MASTRA_ENABLED: "true", INVEST_AGENT_MASTRA_INTERNAL_USERS: "internal" }).backend, "mastra");
  assert.equal(selectExecutionBackend({ userId: "external", instanceId: "instance-1" }, { INVEST_AGENT_MASTRA_ENABLED: "true", INVEST_AGENT_MASTRA_INTERNAL_USERS: "internal" }).backend, "acp");
});

test("user-provided backend-like fields cannot influence policy", () => {
  const result = selectExecutionBackend({ ...context, userId: "internal", instanceId: "instance-1" }, { ACP_BACKEND: "mastra" });
  assert.equal(result.backend, "acp");
});
