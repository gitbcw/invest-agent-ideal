#!/usr/bin/env node
/**
 * T-348 (2026-08-22 有康会): legacy CSV assets still download as CSV even
 * though every newly submitted table is normalized to XLSX. This one-time
 * idempotent backfill appends a converted XLSX version to every active asset
 * whose current version is CSV. Original CSV versions, asset ids, folder
 * positions and automation bindings are preserved (the conversion reuses
 * convertUserAssetCsvToXlsx, which only appends a new version).
 *
 * Usage: node --import tsx scripts/backfill-csv-assets-to-xlsx.mjs [--dry-run]
 * Re-runs are safe: each conversion carries a stable idempotency key and the
 * selection skips assets whose head is already XLSX.
 */
const dryRun = process.argv.includes("--dry-run");
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

let sqlite;
let convertUserAssetCsvToXlsx;
if (dryRun) {
  // A production inventory must not run initDb(): its compatibility migrations
  // can create tables or write migration markers before the SELECT begins.
  const { config } = await importAppModule("lib/config.js");
  const { default: Database } = await import("better-sqlite3");
  sqlite = new Database(config.db.path, { readonly: true, fileMustExist: true });
} else {
  const db = await importAppModule("db/index.js");
  db.initDb();
  sqlite = db.sqlite;
  ({ convertUserAssetCsvToXlsx } = await importAppModule("services/user-assets.js"));
}

try {
  const rows = sqlite.prepare(`
    SELECT a.asset_id AS assetId, a.user_id AS userId, a.project_id AS projectId,
           a.instance_id AS instanceId, a.current_version_id AS currentVersionId,
           v.size_bytes AS sizeBytes
    FROM user_assets a
    JOIN user_asset_versions v ON v.version_id = a.current_version_id
    WHERE v.format = 'csv' AND a.status = 'active'
    ORDER BY a.updated_at DESC
  `).all();

  console.log(`[csv-xlsx-backfill] mode=${dryRun ? "dry-run" : "apply"} candidates=${rows.length}`);
  let converted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (dryRun) {
        console.log(`  would convert asset=${row.assetId} bytes=${row.sizeBytes}`);
        continue;
      }
      await convertUserAssetCsvToXlsx({
        userId: row.userId,
        projectId: row.projectId,
        instanceId: row.instanceId,
        assetId: row.assetId,
        expectedVersionId: row.currentVersionId,
        confirmed: true,
        idempotencyKey: `csv-xlsx-backfill:${row.assetId}:${row.currentVersionId}`,
      });
      converted += 1;
      console.log(`  converted asset=${row.assetId}`);
    } catch (error) {
      // ASSET_VERSION_CONFLICT: another writer moved the head concurrently;
      // anything else is a data-level problem that must surface per asset,
      // never abort the whole sweep.
      failed += 1;
      console.error(`  FAILED asset=${row.assetId}: ${error.message}`);
    }
  }
  console.log(`[csv-xlsx-backfill] done converted=${converted} failed=${failed} remaining=${dryRun ? rows.length : failed}`);
  if (!dryRun && failed > 0) process.exitCode = 1;
} finally {
  if (dryRun) sqlite.close();
}
