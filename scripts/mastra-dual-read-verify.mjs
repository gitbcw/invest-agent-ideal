#!/usr/bin/env node

/** Compare backed-up source files with service-owned target projections. */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { parse } from "yaml";

const args = parseArgs(process.argv.slice(2));
const snapshotRoot = requiredAbsolute(args.workspaceSnapshot, "--workspace-snapshot");
const workspaceId = requiredId(args.workspaceId, "--workspace-id");
const targetDbPath = requiredAbsolute(args.targetDb, "--target-db");
const userId = requiredId(args.userId, "--user-id");
const instanceId = requiredId(args.instanceId, "--instance-id");
const projectId = args.projectId || "invest-agent";
await assertDirectory(snapshotRoot);
if (await isWithin(snapshotRoot, targetDbPath)) throw new Error("--target-db must be outside the snapshot source");

const sourceRoot = path.join(snapshotRoot, workspaceId);
const sourcePortfolioPath = path.join(sourceRoot, "config", "portfolio.yaml");
const sourcePortfolio = parse(await readFile(sourcePortfolioPath, "utf8"));
const sourceProjection = canonicalPortfolio(sourcePortfolio);
const db = new Database(targetDbPath, { readonly: true });
const targetRow = db.prepare("SELECT portfolio_json AS portfolioJson, source_revision AS sourceRevision FROM mastra_portfolio_states WHERE user_id = ? AND project_id = ? AND instance_id = ? LIMIT 1").get(userId, projectId, instanceId);
if (!targetRow) throw new Error("MASTRA_DUAL_READ_PROJECTION_NOT_FOUND: portfolio");
const targetProjection = canonicalPortfolio(JSON.parse(targetRow.portfolioJson));
const portfolioMatch = JSON.stringify(sourceProjection) === JSON.stringify(targetProjection);

const sourceDaily = await readSourceDaily(sourceRoot);
const targetDaily = db.prepare("SELECT business_key AS businessKey, payload_json AS payloadJson FROM mastra_review_memory_records WHERE user_id = ? AND project_id = ? AND instance_id = ? AND record_type = 'daily_plan'").all(userId, projectId, instanceId).map((row) => JSON.parse(row.payloadJson)).sort((a, b) => a.plan_date.localeCompare(b.plan_date));
const dailyMatch = JSON.stringify(sourceDaily) === JSON.stringify(targetDaily.sort((a, b) => a.plan_date.localeCompare(b.plan_date)));
const result = {
  ok: portfolioMatch && dailyMatch,
  scope: { userId, projectId, instanceId },
  portfolio: { match: portfolioMatch, sourceCount: sourceProjection.holdings.length + sourceProjection.watchlist.length + sourceProjection.stockPlans.length, targetCount: targetProjection.holdings.length + targetProjection.watchlist.length + targetProjection.stockPlans.length, sourceChecksum: sha256(JSON.stringify(sourceProjection)), targetChecksum: sha256(JSON.stringify(targetProjection)) },
  dailyPlans: { match: dailyMatch, sourceCount: sourceDaily.length, targetCount: targetDaily.length },
  sourceWriteAttempted: false,
  targetWriteAttempted: false,
};
db.close();
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 2;

function canonicalPortfolio(value) {
  const rows = (key) => Array.isArray(value?.[key]) ? value[key] : [];
  const normalize = (row) => Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)));
  return { cash: value?.cash ?? {}, holdings: rows("holdings").map(normalize), watchlist: rows("watchlist").map(normalize), stockPlans: (value?.stockPlans ?? value?.stock_plans ?? []).map(normalize), accounts: value?.accounts ?? [] };
}
async function readSourceDaily(root) {
  const dir = path.join(root, "plans", "daily");
  const entries = await (await import("node:fs/promises")).readdir(dir, { withFileTypes: true }).catch(() => []);
  const rows = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    const payload = parse(await readFile(path.join(dir, entry.name), "utf8"));
    rows.push(payload);
  }
  return rows.sort((a, b) => a.plan_date.localeCompare(b.plan_date));
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function requiredAbsolute(value, flag) { if (!value || !path.isAbsolute(value)) throw new Error(`${flag} must be absolute`); return path.resolve(value); }
function requiredId(value, flag) { if (!value || /[\\/\0]/.test(value)) throw new Error(`${flag} must be safe`); return value; }
async function assertDirectory(value) { const info = await lstat(value); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("snapshot root must be a real directory"); }
async function isWithin(root, candidate) { const realRoot = await realpath(root); const rel = path.relative(realRoot, path.resolve(candidate)); return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)); }
function parseArgs(argv) { const values = {}; for (let i = 0; i < argv.length; i += 2) values[argv[i]?.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[i + 1]; return values; }
