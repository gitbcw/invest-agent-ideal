#!/usr/bin/env node

/**
 * Read one backed-up portfolio.yaml into a service-owned Mastra projection.
 * It only writes a mapping report outside the source snapshot.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

const args = parseArgs(process.argv.slice(2));
const snapshotRoot = requiredAbsolute(args.workspaceSnapshot, "--workspace-snapshot");
const workspaceId = requiredId(args.workspaceId, "--workspace-id");
const userId = requiredId(args.userId, "--user-id");
const instanceId = requiredId(args.instanceId, "--instance-id");
const outputPath = requiredAbsolute(args.out, "--out");
const sourcePath = path.join(snapshotRoot, workspaceId, "config", "portfolio.yaml");

await assertDirectory(snapshotRoot, "workspace snapshot root");
await assertOutputOutsideSnapshot(outputPath, snapshotRoot);
const raw = await readFile(sourcePath, "utf8");
const portfolio = parse(raw);
if (!portfolio || typeof portfolio !== "object" || Array.isArray(portfolio)) throw new Error("portfolio.yaml must contain a mapping");
const mapping = mapPortfolio(portfolio);
await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode: "dry_run",
  source: { workspaceId, sourcePath: "config/portfolio.yaml", sha256: sha256(raw), userId, instanceId },
  mapping,
  validation: {
    unmappedTopLevelFields: mapping.unknownTopLevelFields,
    duplicateCodes: mapping.duplicateCodes,
    sourceWriteAttempted: false,
    targetWriteAttempted: false,
    conflict: mapping.duplicateCodes.length > 0,
  },
};
if (report.validation.conflict) throw new Error(`MASTRA_PORTFOLIO_MAPPING_CONFLICT: duplicate codes ${mapping.duplicateCodes.join(", ")}`);
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ ok: true, outputPath, source: report.source, validation: report.validation, counts: mapping.counts }, null, 2));

function mapPortfolio(portfolio) {
  const holdings = arrayOfRecords(portfolio.holdings, "holdings");
  const watchlist = arrayOfRecords(portfolio.watchlist, "watchlist");
  const stockPlans = arrayOfRecords(portfolio.stock_plans, "stock_plans");
  const accounts = arrayOrDefault(portfolio.accounts, "accounts");
  assertCodeName(holdings, "holdings");
  assertCodeName(watchlist, "watchlist");
  assertCodeName(stockPlans, "stock_plans");
  const payload = {
    cash: portfolio.cash ?? {}, holdings, watchlist, stockPlans, accounts,
    sourceRevision: stringOrNull(portfolio.last_confirmed_at),
    sourceConfirmedBy: stringOrNull(portfolio.last_confirmed_by),
    sourceConfirmationId: stringOrNull(portfolio.last_confirmation_id),
  };
  const known = new Set(["cash", "holdings", "watchlist", "stock_plans", "accounts", "last_confirmed_at", "last_confirmed_by", "last_confirmation_id"]);
  const duplicates = [
    ...duplicatesIn(holdings, "holding"), ...duplicatesIn(watchlist, "watchlist"), ...duplicatesIn(stockPlans, "stock_plan"),
  ].sort();
  return {
    serviceMigration: {
      target: "mastra_portfolio_states service-owned record",
      fields: payload,
      idempotencyKey: `portfolio-state:${sha256(JSON.stringify(payload))}`,
      writePolicy: "later import only; same-scope target must exactly match source projection",
    },
    counts: { holdings: holdings.length, watchlist: watchlist.length, stockPlans: stockPlans.length, accounts: accounts.length },
    duplicateCodes: duplicates,
    unknownTopLevelFields: Object.keys(portfolio).filter((key) => !known.has(key)).sort(),
  };
}
function arrayOfRecords(value, label) { const rows = arrayOrDefault(value, label); for (const row of rows) { if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`portfolio.${label} entries must be objects`); } return rows; }
function arrayOrDefault(value, label) { if (value === undefined || value === null) return []; if (!Array.isArray(value)) throw new Error(`portfolio.${label} must be an array`); return value; }
function assertCodeName(rows, label) { for (const row of rows) { if (typeof row.code !== "string" || row.code.trim() === "") throw new Error(`portfolio.${label} entries require code`); if (typeof row.name !== "string" || row.name.trim() === "") throw new Error(`portfolio.${label} entries require name`); } }
function duplicatesIn(rows, label) { const seen = new Set(); const duplicates = new Set(); for (const row of rows) { const code = row.code.trim(); if (seen.has(code)) duplicates.add(`${label}:${code}`); seen.add(code); } return [...duplicates]; }
function stringOrNull(value) { if (value === undefined || value === null || value === "") return null; if (typeof value !== "string") throw new Error("portfolio source metadata must be a string"); return value; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function requiredAbsolute(value, flag) { if (!value || !path.isAbsolute(value)) throw new Error(`${flag} must be an absolute path`); return path.resolve(value); }
function requiredId(value, flag) { if (!value || /[\\/\0]/.test(value)) throw new Error(`${flag} must be a safe identifier`); return value; }
async function assertDirectory(value, label) { const info = await lstat(value).catch(() => null); if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`); }
async function assertOutputOutsideSnapshot(output, snapshotRoot) { const root = await realpath(snapshotRoot); const candidate = path.join(await realpath(path.dirname(output)), path.basename(output)); const relative = path.relative(root, candidate); if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("--out must be outside the workspace snapshot source"); }
function parseArgs(argv) { const values = {}; for (let index = 0; index < argv.length; index += 1) { const key = argv[index]; if (["--workspace-snapshot", "--workspace-id", "--user-id", "--instance-id", "--out"].includes(key)) values[key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = argv[++index]; } return values; }
