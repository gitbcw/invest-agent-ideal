import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod/v4";
import { createInProcessToolset, summarizeToolCall } from "../src/mastra/tools/index.js";
import { TOOL_SPECS } from "../src/mastra/tools/registry.js";
import { SERVICE_TOOL_CLASSIFICATION } from "../src/mcp/service-tool-classification.js";
import { createMastraToolMap } from "../src/mastra/tools/mastra-tools.js";

const baseContext = { userId: "test-user", instanceId: "invest-agent-test", conversationId: "c1" };

function fakeCall(calls: Array<{ name: string; input: Record<string, unknown>; context: unknown }>) {
  return async (name: string, input: Record<string, unknown> | undefined, context: unknown) => {
    calls.push({ name, input: input ?? {}, context });
    return { ok: true, name };
  };
}

test("interactive tool executes through service core", async () => {
  const calls: Array<{ name: string; input: Record<string, unknown>; context: unknown }> = [];
  const tool = createInProcessToolset({ callServiceTool: fakeCall(calls) }).find((item) => item.id === "portfolio.read")!;
  const result = await tool.execute({}, baseContext);
  assert.deepEqual(result, { ok: true, name: "portfolio.read" });
  assert.equal(calls.length, 1);
});

test("explicit interactive allowlist rejects an unlisted write before service core", async () => {
  const calls: unknown[] = [];
  const tool = createInProcessToolset({ callServiceTool: fakeCall(calls as never) }).find((item) => item.id === "portfolio.apply_changes")!;
  const result = await tool.execute({}, { ...baseContext, mcpAllowedTools: ["portfolio.read"] });
  assert.equal((result as { error: string }).error, "scope_denied");
  assert.equal(calls.length, 0);
});

test("scheduled read-only grant rejects writes", async () => {
  const calls: unknown[] = [];
  const tool = createInProcessToolset({ callServiceTool: fakeCall(calls as never) }).find((item) => item.id === "watchlist.add")!;
  const result = await tool.execute({}, { ...baseContext, taskType: "scheduled-market-watch" });
  assert.equal((result as { error: string }).error, "scope_denied");
  assert.equal(calls.length, 0);
});

test("daily, weekly and monthly scheduled reviews expose reviews.save", async () => {
  for (const taskType of ["scheduled-daily-review", "scheduled-weekly-review", "scheduled-monthly-review"]) {
    const calls: Array<{ name: string; input: Record<string, unknown>; context: unknown }> = [];
    const tool = createInProcessToolset({ callServiceTool: fakeCall(calls) }).find((item) => item.id === "reviews.save")!;
    const result = await tool.execute({ content: "review", confirmedByUser: true }, { ...baseContext, taskType });
    assert.deepEqual(result, { ok: true, name: "reviews.save" }, taskType);
    assert.equal(calls.length, 1, taskType);
  }
});

test("unknown scheduled task fails closed to read-only", async () => {
  const calls: unknown[] = [];
  const tool = createInProcessToolset({ callServiceTool: fakeCall(calls as never) }).find((item) => item.id === "reviews.save")!;
  const result = await tool.execute({ content: "review", confirmedByUser: true }, { ...baseContext, taskType: "scheduled-future" });
  assert.equal((result as { error: string }).error, "scope_denied");
  assert.equal(calls.length, 0);
});

test("unknown or missing context fails closed", async () => {
  const calls: unknown[] = [];
  const tool = createInProcessToolset({ callServiceTool: fakeCall(calls as never) }).find((item) => item.id === "portfolio.read")!;
  assert.equal((await tool.execute({}, undefined) as { error: string }).error, "scope_denied");
  assert.equal((await tool.execute({}, { userId: "only-user" }) as { error: string }).error, "scope_denied");
  assert.equal(calls.length, 0);
});

test("registry has schema parity with current service classification", () => {
  const ids = new Set(TOOL_SPECS.map((spec) => spec.id));
  assert.equal(ids.size, 45);
  assert.deepEqual([...ids].sort(), Object.keys(SERVICE_TOOL_CLASSIFICATION).sort());
  assert.ok(ids.has("assets.version.commit"));
  assert.ok(ids.has("automation.create"));
  assert.ok(ids.has("research.web_read"));
  assert.ok(ids.has("spreadsheet.create"));
  const portfolio = TOOL_SPECS.find((spec) => spec.id === "portfolio.apply_changes")!;
  assert.ok(z.object(portfolio.inputSchema).safeParse({}).success === false);
});

test("unclassified custom tool is rejected even for interactive context", async () => {
  const calls: unknown[] = [];
  const custom = { id: "future.unsafe", description: "", inputSchema: {} } as const;
  const tool = createInProcessToolset({ specs: [custom], callServiceTool: fakeCall(calls as never) })[0];
  const result = await tool.execute({}, baseContext);
  assert.equal((result as { error: string }).error, "scope_denied");
  assert.equal(calls.length, 0);
});

test("tool summaries contain sizes only, never raw input or output", () => {
  const token = "super-secret-token";
  const summary = summarizeToolCall("assets.version.commit", { base64: token }, { token });
  assert.equal(summary.toolName, "assets.version.commit");
  assert.equal("base64" in summary, false);
  assert.equal(JSON.stringify(summary).includes(token), false);
});

test("Mastra map is constructed through the official createTool binding", async () => {
  const created: Array<Record<string, unknown>> = [];
  const tools = await createMastraToolMap(baseContext, {
    Agent: class { stream() { throw new Error("not used"); } },
    createTool: (options) => { created.push(options); return options; },
  });
  assert.equal(Object.keys(tools).length, 45);
  assert.equal(created.length, 45);
  assert.equal(created[0].id, "market_watch.snapshot");
});
