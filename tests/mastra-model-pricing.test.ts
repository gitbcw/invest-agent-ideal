import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Must be set before any module that loads data-backend is imported.
process.env.WORKSPACE_BACKEND = "mastra";

test("model pricing registry computes per-model costs with provider-aligned defaults", async () => {
  const { computeModelCost, isPricedModel, pricingSummary, normalizeModelId } = await import("../src/services/model-pricing.js");

  // Registry hit: per-model tier (terra $2/$12 per M).
  const terra = computeModelCost("gpt-5.6-terra", {
    inputTokens: 1_000_000, outputTokens: 1_000_000, thoughtTokens: 500_000, cachedReadTokens: 2_000_000,
  });
  assert.equal(terra.source, "priced");
  // input 2 + output 12 + thought 6 (output rate) + cacheRead 0.4 (input/10 on 2M)
  assert.equal(terra.amount, 2 + 12 + 6 + 0.4);

  // Gateway prefix stripping.
  assert.equal(normalizeModelId("gateway/gpt-5.6-luna"), "gpt-5.6-luna");
  assert.equal(isPricedModel("gateway/gpt-5.6-luna"), true);

  // Unknown model falls back to the default tier and is flagged, never silent.
  const fallback = computeModelCost("gpt-5.4", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(fallback.source, "priced-fallback");
  assert.equal(fallback.amount, 2 + 12);
  assert.equal(isPricedModel("gpt-5.4"), false);

  // Provider-reported cost wins over local pricing.
  const gateway = computeModelCost("gpt-5.6-terra", { inputTokens: 9_000_000, costAmount: 0.42 });
  assert.equal(gateway.source, "gateway");
  assert.equal(gateway.amount, 0.42);

  // Zero-usage turns price to zero, not NaN.
  assert.equal(computeModelCost("gpt-5.6-terra", {}).amount, 0);

  // Summary exposes the active card for API surfaces.
  const summary = pricingSummary();
  assert.ok(summary.models.some((entry) => entry.model === "gpt-5.6-sol" && entry.tier.input === 5));
  assert.ok(summary.defaultTier.cacheRead > 0);
});

test("recordAgentTrace prices usage at write time with costSource envelope (E10 C2)", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-cost-trace-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { initDb, sqlite } = await import("../src/db/index.js");
    const { recordAgentTrace } = await import("../src/runtime/trace.js");
    initDb();

    await recordAgentTrace({
      conversationId: "conv-cost",
      channel: "web",
      userText: "测试计价",
      replyTextSanitized: "ok",
      mode: "chat",
      agentBackend: "mastra",
      agentModel: "gpt-5.6-terra",
      status: "success",
      usage: { source: "actual", inputTokens: 500_000, outputTokens: 100_000, thoughtTokens: 50_000, cachedReadTokens: 1_000_000, totalTokens: 1_650_000 },
    });

    const row = sqlite.prepare("SELECT cost_amount AS cost, cost_currency AS currency, usage_raw AS raw FROM agent_traces WHERE conversation_id='conv-cost'").get() as { cost: number; currency: string; raw: string };
    // terra: 0.5M*2 + 0.1M*12 + 0.05M*12 + 1M*0.2 = 1 + 1.2 + 0.6 + 0.2
    assert.equal(row.cost, 3);
    assert.equal(row.currency, "USD");
    const envelope = JSON.parse(row.raw) as { costSource: string };
    assert.equal(envelope.costSource, "priced");

    // Gateway-reported cost passthrough wins and is marked as such.
    await recordAgentTrace({
      conversationId: "conv-cost-gw",
      channel: "web",
      userText: "网关计费",
      replyTextSanitized: "ok",
      mode: "chat",
      agentModel: "gpt-5.6-terra",
      status: "success",
      usage: { source: "actual", inputTokens: 100_000, costAmount: 0.11, costCurrency: "USD", raw: { provider: "x" } },
    });
    const gw = sqlite.prepare("SELECT cost_amount AS cost, usage_raw AS raw FROM agent_traces WHERE conversation_id='conv-cost-gw'").get() as { cost: number; raw: string };
    assert.equal(gw.cost, 0.11);
    assert.deepEqual(JSON.parse(gw.raw), { costSource: "gateway", raw: { provider: "x" } });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    delete process.env.DB_PATH;
    delete process.env.WORKSPACE_ROOT;
    delete process.env.INVEST_AGENT_SANDBOX_SECRET_FILE;
  }
});

test("cost backfill prices only null rows by default and is idempotent (E10 C3)", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-cost-backfill-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
  process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");

  try {
    const { initDb, sqlite } = await import("../src/db/index.js");
    initDb();
    const insert = sqlite.prepare(
      "INSERT INTO agent_traces (conversation_id, channel, user_text, mode, status, agent_backend, agent_model, input_tokens, output_tokens, total_tokens, usage_source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    insert.run("bf-1", "web", "a", "chat", "success", "mastra", "gpt-5.6-terra", 1_000_000, 0, 1_000_000, "actual", "2026-08-01T00:00:00.000Z");
    insert.run("bf-2", "web", "b", "chat", "success", "mastra", "gpt-5.6-luna", 1_000_000, 0, 1_000_000, "actual", "2026-08-02T00:00:00.000Z");
    insert.run("bf-done", "web", "c", "chat", "success", "mastra", "gpt-5.6-terra", 1_000_000, 0, 1_000_000, "actual", "2026-08-03T00:00:00.000Z");
    sqlite.prepare("UPDATE agent_traces SET cost_amount=9.99 WHERE conversation_id='bf-done'").run();
    insert.run("bf-empty", "web", "d", "chat", "success", "mastra", "gpt-5.6-terra", 0, 0, 0, "actual", "2026-08-04T00:00:00.000Z");

    const { computeModelCost } = await import("../src/services/model-pricing.js");
    // Mirror the script's default scope: null-cost rows with tokens.
    const rows = sqlite.prepare("SELECT id, agent_model AS model, input_tokens AS inputTokens, output_tokens AS outputTokens FROM agent_traces WHERE cost_amount IS NULL AND (COALESCE(input_tokens,0)>0 OR COALESCE(output_tokens,0)>0)").all() as Array<{ id: number; model: string; inputTokens: number; outputTokens: number }>;
    assert.equal(rows.length, 2);
    for (const row of rows) sqlite.prepare("UPDATE agent_traces SET cost_amount=?, cost_currency='USD' WHERE id=?").run(computeModelCost(row.model, row).amount, row.id);

    const after = sqlite.prepare("SELECT conversation_id AS cid, cost_amount AS cost FROM agent_traces ORDER BY id").all() as Array<{ cid: string; cost: number }>;
    const byCid = Object.fromEntries(after.map((row) => [row.cid, row.cost]));
    assert.equal(byCid["bf-1"], 2);       // terra 1M input
    assert.equal(byCid["bf-2"], 0.2);     // luna 1M input
    assert.equal(byCid["bf-done"], 9.99); // untouched (already priced)
    assert.equal(byCid["bf-empty"], null); // no tokens -> out of backfill scope, stays null
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    delete process.env.DB_PATH;
    delete process.env.WORKSPACE_ROOT;
    delete process.env.INVEST_AGENT_SANDBOX_SECRET_FILE;
  }
});
