#!/usr/bin/env node
/**
 * One-time idempotent cost backfill (E10 / cost-statistics-design.md §5):
 * price historical agent_traces rows that predate write-time pricing.
 *
 * Default: only rows with cost_amount IS NULL and non-zero tokens are priced.
 * --force: also re-price rows that already carry a cost (use when the owner
 * finalizes the rate card and history should be restated).
 * --dry-run: report only.
 *
 * Usage: node scripts/mastra-cost-backfill.mjs [--dry-run] [--force]
 */
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
process.env.WORKSPACE_BACKEND ??= "mastra";
// 本地仓库有 src/（tsx 直跑），服务器部署只有 dist/——按存在性回退。
async function importAppModule(relative) {
  for (const base of ["../src", "../dist"]) {
    try {
      return await import(new URL(`${base}/${relative}`, import.meta.url).href);
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error(`cannot resolve app module: ${relative}`);
}
const { initDb, sqlite } = await importAppModule("db/index.js");
initDb();
const { computeModelCost, isPricedModel } = await importAppModule("services/model-pricing.js");

const tokenFilter = "(COALESCE(input_tokens,0) > 0 OR COALESCE(output_tokens,0) > 0 OR COALESCE(thought_tokens,0) > 0)";
const rows = force
  ? sqlite.prepare(`SELECT id, agent_model AS model, input_tokens AS inputTokens, output_tokens AS outputTokens, thought_tokens AS thoughtTokens, cached_read_tokens AS cachedReadTokens, cached_write_tokens AS cachedWriteTokens, cost_amount AS costAmount FROM agent_traces WHERE ${tokenFilter} ORDER BY id`).all()
  : sqlite.prepare(`SELECT id, agent_model AS model, input_tokens AS inputTokens, output_tokens AS outputTokens, thought_tokens AS thoughtTokens, cached_read_tokens AS cachedReadTokens, cached_write_tokens AS cachedWriteTokens, cost_amount AS costAmount FROM agent_traces WHERE cost_amount IS NULL AND ${tokenFilter} ORDER BY id`).all();

const update = sqlite.prepare("UPDATE agent_traces SET cost_amount = ?, cost_currency = ? WHERE id = ?");
const report = { total: rows.length, priced: 0, fallback: 0, costByModel: new Map() };
for (const row of rows) {
  const cost = computeModelCost(row.model, row);
  const key = `${row.model || "unknown"}${cost.source === "priced-fallback" ? " (fallback)" : ""}`;
  const bucket = report.costByModel.get(key) ?? { rows: 0, cost: 0 };
  bucket.rows += 1;
  bucket.cost = Math.round((bucket.cost + cost.amount) * 1e6) / 1e6;
  report.costByModel.set(key, bucket);
  if (cost.source === "priced-fallback") report.fallback += 1;
  else report.priced += 1;
  if (!dryRun) update.run(cost.amount, cost.currency, row.id);
}

const grand = [...report.costByModel.values()].reduce((sum, bucket) => sum + bucket.cost, 0);
console.log(`[cost-backfill] mode=${dryRun ? "dry-run" : "apply"}${force ? " +force" : ""} rows=${report.total} priced=${report.priced} fallback=${report.fallback}`);
for (const [model, bucket] of [...report.costByModel.entries()].sort()) {
  console.log(`  ${model}: rows=${bucket.rows} cost=¥${bucket.cost.toFixed(4)}`);
}
console.log(`[cost-backfill] total=¥${grand.toFixed(4)}${report.fallback > 0 ? ` (fallback rows priced at the DEFAULT tier: ${report.fallback} — registry covers ${isPricedModel("gpt-5.6-terra") ? "known models only" : "no models"})` : ""}`);
