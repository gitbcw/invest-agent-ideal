import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-user-asset-legacy-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "assets.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
mkdir(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const scope = {
  userId: "legacy-format-user",
  projectId: "invest-agent",
  instanceId: "legacy-format-instance",
};

test("migrated yaml/jsonl asset versions list and read without ASSET_COMMIT_FAILED", async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const { registerTestProject } = await import("./helpers/mastra-project.js");
  const projectRoot = await registerTestProject(scope);
  const assets = await import("../src/services/user-assets.js");

  // Mimic the real-data migration: asset + version rows written directly with
  // legacy workspace-config formats, storage bytes on disk.
  const seed = [
    { assetId: "ast_legacy_yaml", versionId: "ver_legacy_yaml", fileName: "strategy.yaml", format: "yaml", mime: "text/yaml", bytes: "style: steady\n" },
    { assetId: "ast_legacy_jsonl", versionId: "ver_legacy_jsonl", fileName: "decisions.jsonl", format: "jsonl", mime: "application/jsonl", bytes: "{\"a\":1}\n" },
  ];
  for (const item of seed) {
    db.sqlite
      .prepare(
        `INSERT INTO user_assets (
           asset_id, user_id, project_id, instance_id, name, status, current_version_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      )
      .run(item.assetId, scope.userId, scope.projectId, scope.instanceId, item.fileName, item.versionId, "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
    const storagePath = `assets/${item.assetId}/versions/${item.versionId}/${item.fileName}`;
    db.sqlite
      .prepare(
        `INSERT INTO user_asset_versions (
           version_id, asset_id, user_id, project_id, instance_id, file_name, format, mime_type,
           version_number, size_bytes, checksum, storage_path, source, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'system', ?)`
      )
      .run(item.versionId, item.assetId, scope.userId, scope.projectId, scope.instanceId, item.fileName, item.format, item.mime, item.bytes.length, createHash("sha256").update(item.bytes).digest("hex"), storagePath, "2026-08-10T00:00:00.000Z");
    await mkdir(path.join(projectRoot, path.dirname(storagePath)), { recursive: true });
    await writeFile(path.join(projectRoot, storagePath), item.bytes);
  }

  // Regression: listUserAssets used to throw ASSET_COMMIT_FAILED "asset format
  // is corrupt" on the first legacy version row, failing the whole page.
  const listed = await assets.listUserAssets({ ...scope });
  assert.deepEqual(listed.map((asset) => asset.currentVersion?.format).sort(), ["jsonl", "yaml"]);

  const read = await assets.readCurrentUserAsset({ ...scope, assetId: "ast_legacy_yaml" });
  assert.equal(Buffer.from(read.bytes).toString(), "style: steady\n");
});

test("new yaml uploads take the normal validated path", async () => {
  const db = await import("../src/db/index.js");
  const assets = await import("../src/services/user-assets.js");
  const created = await assets.createUserAsset({
    ...scope,
    name: "method",
    fileName: "method.yaml",
    mimeType: "text/yaml",
    bytes: new TextEncoder().encode("rules:\n  - keep it simple\n"),
  });
  assert.equal(created.currentVersion?.format, "yaml");
  assert.equal(created.currentVersion?.mimeType, "text/yaml");
});

test("T-348: legacy CSV head converts to a standard XLSX version and replays idempotently", async () => {
  const db = await import("../src/db/index.js");
  const assets = await import("../src/services/user-assets.js");
  const { registerTestProject } = await import("./helpers/mastra-project.js");
  const projectRoot = await registerTestProject(scope);

  // Pre-normalization state: an active asset whose current version is CSV.
  const assetId = "ast_legacy_csv_t348";
  const versionId = "ver_legacy_csv_t348";
  const fileName = "行业复盘.csv";
  const csvBytes = Buffer.from("日期,序号,行业,领涨\n2026-08-21,1,通信,中兴\n", "utf8");
  db.sqlite
    .prepare(
      `INSERT INTO user_assets (
         asset_id, user_id, project_id, instance_id, name, status, current_version_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
    )
    .run(assetId, scope.userId, scope.projectId, scope.instanceId, fileName, versionId, "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
  const storagePath = `assets/${assetId}/versions/${versionId}/${fileName}`;
  db.sqlite
    .prepare(
      `INSERT INTO user_asset_versions (
         version_id, asset_id, user_id, project_id, instance_id, file_name, format, mime_type,
         version_number, size_bytes, checksum, storage_path, source, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'text/csv', 1, ?, ?, ?, 'system', ?)`
    )
    .run(versionId, assetId, scope.userId, scope.projectId, scope.instanceId, fileName, "csv", csvBytes.byteLength, createHash("sha256").update(csvBytes).digest("hex"), storagePath, "2026-08-10T00:00:00.000Z");
  await mkdir(path.join(projectRoot, path.dirname(storagePath)), { recursive: true });
  await writeFile(path.join(projectRoot, storagePath), csvBytes);

  const script = path.resolve("scripts/backfill-csv-assets-to-xlsx.mjs");
  const runBackfill = (args: string[] = [], envOverrides: NodeJS.ProcessEnv = {}) => execFile(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: path.resolve("."),
    env: { ...process.env, ...envOverrides },
    maxBuffer: 2 * 1024 * 1024,
  });

  // Dry-run must be usable against a production snapshot without triggering
  // initDb() migrations. A minimal read-only fixture proves it only selects
  // from the two tables required for candidate discovery.
  const dryRunDbPath = path.join(root, "assets-dry-run.db");
  const { default: Database } = await import("better-sqlite3");
  const dryRunDb = new Database(dryRunDbPath);
  dryRunDb.exec(`
    CREATE TABLE user_assets (
      asset_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL,
      instance_id TEXT NOT NULL, current_version_id TEXT, status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE user_asset_versions (
      version_id TEXT PRIMARY KEY, size_bytes INTEGER NOT NULL, format TEXT NOT NULL
    );
  `);
  dryRunDb.close();
  const readonlyInventory = await runBackfill(["--dry-run"], { DB_PATH: dryRunDbPath });
  assert.match(readonlyInventory.stdout, /mode=dry-run candidates=0/);
  const postInventoryDb = new Database(dryRunDbPath, { readonly: true });
  assert.equal(postInventoryDb.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get().count, 2);
  postInventoryDb.close();

  const dryRun = await runBackfill(["--dry-run"]);
  assert.match(dryRun.stdout, /mode=dry-run candidates=1/);
  assert.match(dryRun.stdout, /would convert asset=ast_legacy_csv_t348 bytes=\d+/);
  assert.doesNotMatch(`${dryRun.stdout}\n${dryRun.stderr}`, /legacy-format-user|行业复盘\.csv/);

  const applied = await runBackfill();
  assert.match(applied.stdout, /mode=apply candidates=1/);
  assert.match(applied.stdout, /converted asset=ast_legacy_csv_t348/);

  const replayed = await runBackfill();
  assert.match(replayed.stdout, /mode=apply candidates=0/);

  const converted = await assets.getUserAsset({ ...scope, assetId });
  assert.equal(converted.currentVersion?.format, "xlsx");
  assert.equal(converted.currentVersion?.fileName, "行业复盘.xlsx");
  const headBytes = await assets.readCurrentUserAsset({ ...scope, assetId });
  assert.equal(headBytes.descriptor.mimeType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.ok(headBytes.bytes.subarray(0, 2).toString("ascii") === "PK", "the new head must be a real XLSX (zip) container");

  // The original CSV version stays in provenance; the idempotency key replays
  // without appending another version.
  const provenance = await assets.listUserAssetVersions({ ...scope, assetId });
  assert.ok(provenance.some((version) => version.versionId === versionId && version.format === "csv"));
  const idempotencyKey = `csv-xlsx-backfill:${assetId}:${versionId}`;
  const replay = await assets.convertUserAssetCsvToXlsx({
    ...scope,
    assetId,
    expectedVersionId: versionId,
    confirmed: true,
    idempotencyKey,
  });
  assert.equal(replay.currentVersionId, converted.currentVersionId);
  assert.equal((await assets.listUserAssetVersions({ ...scope, assetId })).length, 2);
});
