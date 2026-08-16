#!/usr/bin/env node
/**
 * Archive + reset historical cost statistics (2026-08-16 用户裁决).
 *
 * 换内核（Mastra）重述口径的一部分：旧计价（USD / 旧费率表）的历史成本
 * 数据先完整归档为 JSONL，再清空 live 表中的费用字段；随后用
 * mastra-cost-backfill.mjs --force 按当前人民币费率表全量重算。
 * token 原料（各 token 列）不属于"成本统计"，保留不动。
 *
 * 归档文件：data/archives/agent-trace-cost-<UTC时间戳>.jsonl
 * 幂等性：重复执行会再次归档（文件带时间戳不覆盖）并再次清空已空字段，无副作用。
 *
 * Usage: node scripts/mastra-cost-archive-reset.mjs [--dry-run]
 */
const dryRun = process.argv.includes("--dry-run");
process.env.WORKSPACE_BACKEND ??= "mastra";
const { mkdir, writeFile } = await import("node:fs/promises");
const path = await import("node:path");

// 本地仓库有 src/（tsx 直跑），服务器部署只有 dist/——按存在性回退。
async function importAppModule(relative) {
  const root = new URL(".", import.meta.url).pathname;
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

const COST_COLUMNS = `id, trace_id, user_id, instance_id, channel, agent_model AS model,
  input_tokens AS inputTokens, output_tokens AS outputTokens, thought_tokens AS thoughtTokens,
  cached_read_tokens AS cachedReadTokens, cached_write_tokens AS cachedWriteTokens, total_tokens AS totalTokens,
  cost_amount AS costAmount, cost_currency AS costCurrency, usage_source AS usageSource, created_at AS createdAt`;

const rows = sqlite.prepare(`SELECT ${COST_COLUMNS} FROM agent_traces ORDER BY id`).all();
const withCost = rows.filter((row) => row.costAmount !== null && row.costAmount !== undefined);
const archivedCost = withCost.reduce((sum, row) => sum + Number(row.costAmount || 0), 0);
const currencyBreakdown = new Map();
for (const row of withCost) {
  const key = row.costCurrency || "(null)";
  currencyBreakdown.set(key, (currencyBreakdown.get(key) || 0) + 1);
}

console.log(`[cost-archive-reset] mode=${dryRun ? "dry-run" : "apply"}`);
console.log(`  traces total=${rows.length} withCost=${withCost.length} archivedCost=${[...currencyBreakdown.entries()].map(([c, n]) => `${n}×${c}`).join(" ") || "-"} sum=${archivedCost.toFixed(4)}`);

if (dryRun) {
  console.log("[cost-archive-reset] dry-run: no archive written, no fields cleared");
  process.exit(0);
}

const archiveDir = path.resolve(process.cwd(), "data", "archives");
await mkdir(archiveDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const archivePath = path.join(archiveDir, `agent-trace-cost-${stamp}.jsonl`);
const body = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
await writeFile(archivePath, body, { mode: 0o600 });
console.log(`  archived → ${archivePath} (${body.length} bytes)`);

const cleared = sqlite.prepare("UPDATE agent_traces SET cost_amount = NULL, cost_currency = NULL WHERE cost_amount IS NOT NULL OR cost_currency IS NOT NULL").run();
console.log(`  cleared cost fields on ${cleared.changes} rows`);
console.log("[cost-archive-reset] done — now run: node scripts/mastra-cost-backfill.mjs --force");
