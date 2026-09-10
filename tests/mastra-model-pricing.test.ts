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

  // Registry hit: per-model tier (terra ¥1.0/¥6.0 per M; USD $2.5/$15 via gateway relay 0.4).
  const terra = computeModelCost("gpt-5.6-terra", {
    inputTokens: 1_000_000, outputTokens: 1_000_000, thoughtTokens: 500_000, cachedReadTokens: 2_000_000,
  });
  assert.equal(terra.source, "priced");
  assert.equal(terra.currency, "CNY");
  // input 1.0 + output 6.0 + thought 3.0 (output rate) + cacheRead 0.2 (input/10 on 2M)
  assert.equal(terra.amount, 1.0 + 6.0 + 3.0 + 0.2);

  // Gateway prefix stripping.
  assert.equal(normalizeModelId("gateway/gpt-5.6-luna"), "gpt-5.6-luna");
  assert.equal(isPricedModel("gateway/gpt-5.6-luna"), true);

  // Unknown model falls back to the default tier and is flagged, never silent.
  const fallback = computeModelCost("gpt-5.4", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(fallback.source, "priced-fallback");
  assert.equal(fallback.amount, 1.0 + 6.0);
  assert.equal(isPricedModel("gpt-5.4"), false);

  // Provider-reported cost wins over local pricing.
  const gateway = computeModelCost("gpt-5.6-terra", { inputTokens: 9_000_000, costAmount: 0.42 });
  assert.equal(gateway.source, "gateway");
  assert.equal(gateway.amount, 0.42);

  // Zero-usage turns price to zero, not NaN.
  assert.equal(computeModelCost("gpt-5.6-terra", {}).amount, 0);

  // Summary exposes the active card for API surfaces.
  const summary = pricingSummary();
  assert.ok(summary.models.some((entry) => entry.model === "gpt-5.6-sol" && entry.tier.input === 2.0));
  assert.ok(summary.models.some((entry) => entry.model === "gpt-5.5" && entry.tier.input === 2.0));
  assert.ok(summary.models.some((entry) => entry.model === "deepseek-flash" && entry.tier.input === 1));
  assert.ok(summary.defaultTier.cacheRead > 0);

  // DeepSeek 4.1 统一合并（owner 2026-09-10 二次裁决）：注册表只剩
  // deepseek-flash 一个条目，峰谷窗口仅工作日生效；旧 ID 全部经
  // MODEL_ALIASES 并轨按 deepseek-flash 计价（上游对旧名同样按 4.1 价实收），
  // 历史行金额以写入时落库为准、仅重算走本口径。
  // 工作日高峰（北京周二 2026-09-15 10:00 = UTC 02:00）：输入 ¥2/M。
  const ds41Peak = computeModelCost("deepseek-flash", { inputTokens: 1_000_000 }, { at: "2026-09-15T02:00:00.000Z" });
  assert.equal(ds41Peak.source, "priced");
  assert.equal(ds41Peak.amount, 2);
  // 周末同时段（北京周六 2026-09-19 10:00）：恒空闲价 ¥1/M。
  const ds41Weekend = computeModelCost("deepseek-flash", { inputTokens: 1_000_000 }, { at: "2026-09-19T02:00:00.000Z" });
  assert.equal(ds41Weekend.amount, 1);
  // 工作日晚间空闲（北京周二 20:00 = UTC 12:00）：输出 ¥4/M。
  const ds41OffPeak = computeModelCost("deepseek-flash", { outputTokens: 1_000_000 }, { at: "2026-09-15T12:00:00.000Z" });
  assert.equal(ds41OffPeak.amount, 4);
  // 生效前（北京 9-09 23:59）：走 tier 占位（=空闲价）。
  const ds41Before = computeModelCost("deepseek-flash", { inputTokens: 1_000_000 }, { at: "2026-09-09T15:59:00.000Z" });
  assert.equal(ds41Before.amount, 1);
  // 旧 ID 并轨：同一时刻与 deepseek-flash 同价、仍算入册（alias 命中）。
  assert.equal(isPricedModel("deepseek-v4-pro"), true);
  assert.equal(isPricedModel("deepseek-v4-flash-vision-exp"), true);
  assert.equal(computeModelCost("deepseek-v4-flash-vision-exp", { inputTokens: 1_000_000 }, { at: "2026-09-15T02:00:00.000Z" }).amount, 2);
  // 4.1 生效前的历史日期重算走 tier 占位（空闲价），不再按旧 v4 峰谷价。
  assert.equal(computeModelCost("deepseek-v4-pro", { outputTokens: 1_000_000 }, { at: "2026-08-20T06:30:00.000Z" }).amount, 4);
  // summary（费率徽标/connector models.state）只暴露一个 deepseek 条目。
  assert.equal(summary.models.filter((entry) => entry.model.startsWith("deepseek")).length, 1);
  assert.ok(summary.models.some((entry) => entry.model === "deepseek-flash" && entry.timeTiered && entry.timeTiered.peak.input === 2 && entry.timeTiered.weekdaysOnly === true));

  // glm-5.3-flash：owner 折算 2026-08-27（glm-5.3 牌价 1/10），单一价 ¥0.8/¥2.8、
  // 缓存命中显式 ¥0.2（不用 input/10 默认）。
  const glm = computeModelCost("glm-5.3-flash", { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedReadTokens: 1_000_000 });
  assert.equal(glm.source, "priced");
  assert.equal(glm.amount, 0.8 + 2.8 + 0.2);
  assert.ok(summary.models.some((entry) => entry.model === "glm-5.3-flash" && entry.tier.input === 0.8 && !entry.timeTiered));
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
    // terra: 0.5M*1.0 + 0.1M*6.0 + 0.05M*6.0 + 1M*0.1 = 0.5 + 0.6 + 0.3 + 0.1
    assert.equal(row.cost, 1.5);
    assert.equal(row.currency, "CNY");
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
      usage: { source: "actual", inputTokens: 100_000, costAmount: 0.11, raw: { provider: "x" } },
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
    for (const row of rows) sqlite.prepare("UPDATE agent_traces SET cost_amount=?, cost_currency='CNY' WHERE id=?").run(computeModelCost(row.model, row).amount, row.id);

    const after = sqlite.prepare("SELECT conversation_id AS cid, cost_amount AS cost FROM agent_traces ORDER BY id").all() as Array<{ cid: string; cost: number }>;
    const byCid = Object.fromEntries(after.map((row) => [row.cid, row.cost]));
    assert.equal(byCid["bf-1"], 1.0);     // terra 1M input (RMB, relay 0.4)
    assert.equal(byCid["bf-2"], 0.08);    // luna 1M input (RMB, relay 0.4)
    assert.equal(byCid["bf-done"], 9.99); // untouched (already priced)
    assert.equal(byCid["bf-empty"], null); // no tokens -> out of backfill scope, stays null
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    delete process.env.DB_PATH;
    delete process.env.WORKSPACE_ROOT;
    delete process.env.INVEST_AGENT_SANDBOX_SECRET_FILE;
  }
});
