#!/usr/bin/env node
/**
 * One-shot cleanup (2026-08-15): remove internal workspace config/state files
 * that the beta migration had imported as My Files assets.
 *
 * The migration turned legacy config (portfolio/strategy/schedules/watch/
 * notification/onboarding yaml), internal event streams (*.jsonl) and daily
 * review archives (date-named yaml) into user_assets rows. These are internal
 * state, not user documents — they must not appear in My Files. All content
 * is already carried by the authoritative stores:
 *   - config yaml  -> SQLite projections (portfolio, preferences, tasks) and
 *                     methods/strategy-rules.md in the project root
 *   - *.jsonl      -> mastra_review_memory_records (service_event rows)
 *   - date yamls   -> mastra_review_memory_records (daily_plan rows carry the
 *                     full content — verified before running this cleanup)
 *
 * Targets ONLY assets whose version format is yaml/jsonl with an internal
 * migration source. Two source generations exist: the beta migration wrote
 * source='system' (2026-08-15); the go-live six-domain importers write
 * source='workspace_migration' (mastra-*-target-import.mjs). Both are
 * internal state, both are cleanup targets.
 * Idempotent: re-running matches nothing after the first pass.
 *
 * Usage:
 *   node scripts/remove-migration-config-assets.mjs \
 *     [--db /home/claude/invest-agent-mastra/data/runtime.db] \
 *     [--projects-root /home/claude/invest-agent-mastra/data/projects] [--dry-run]
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : fallback;
};
const dbPath = flag("db", "/home/claude/invest-agent-mastra/data/runtime.db");
const projectsRoot = flag("projects-root", "/home/claude/invest-agent-mastra/data/projects");

const db = new Database(dbPath);
const assets = db.prepare(`
  SELECT DISTINCT a.asset_id, a.user_id, a.project_id, a.instance_id, v.storage_path
  FROM user_assets a
  JOIN user_asset_versions v ON v.asset_id = a.asset_id
  WHERE v.format IN ('yaml', 'jsonl') AND v.source IN ('system', 'workspace_migration')
`).all();
console.log(`匹配 ${assets.length} 个迁移内部资产${dryRun ? "（dry-run，不删除）" : ""}`);
for (const asset of assets) {
  console.log(`  ${asset.user_id} ${asset.storage_path}`);
}
if (dryRun) process.exit(0);

const remove = db.transaction(() => {
  let versions = 0;
  let heads = 0;
  for (const asset of assets) {
    versions += db.prepare("DELETE FROM user_asset_versions WHERE asset_id = ?").run(asset.asset_id).changes;
    heads += db.prepare("DELETE FROM user_assets WHERE asset_id = ?").run(asset.asset_id).changes;
    // storage_path is relative to the project digest root (assets/<asset_id>/...).
    // Digest mirrors src/mastra/workspace-registry.ts scopeDigest: sha256(user\0project\0instance)[:24].
    const digest = createHash("sha256")
      .update(`${asset.user_id}\u0000${asset.project_id}\u0000${asset.instance_id}`)
      .digest("hex").slice(0, 24);
    const storageDir = path.join(projectsRoot, digest, "assets", asset.asset_id);
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
  return { versions, heads };
});
const { versions, heads } = remove();
console.log(`已删除 ${heads} 个资产（${versions} 个版本）及其存储目录`);
db.close();
