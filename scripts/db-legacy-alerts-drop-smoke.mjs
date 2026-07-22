#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function runInitDb(dbPath, runtimeDataRoot) {
  const moduleUrl = pathToFileURL(path.resolve("dist/db/index.js")).href;
  const source = `import { initDb, sqlite } from ${JSON.stringify(moduleUrl)}; initDb(); const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='alerts'").all(); const migrations = sqlite.prepare("SELECT key FROM schema_migrations WHERE key='drop_legacy_alerts_table_v1'").all(); console.log(JSON.stringify({ alertsTableCount: tables.length, migrationMarked: migrations.length }));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    env: {
      ...process.env,
      DB_PATH: dbPath,
      RUNTIME_DATA_ROOT: runtimeDataRoot,
      NODE_ENV: "test",
      INVEST_AGENT_API_TOKEN: "legacy-alerts-drop-token-0123456789",
    },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(result.stderr);
    throw new Error(`initDb subprocess failed (status=${result.status})`);
  }
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}

async function withTempDir(label, work) {
  const dir = await mkdtemp(path.join(os.tmpdir(), `invest-agent-legacy-alerts-${label}-`));
  try {
    await work(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await withTempDir("empty", async (dir) => {
  const dbPath = path.join(dir, "empty.db");
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE alerts (
      id INTEGER PRIMARY KEY,
      stock_code TEXT,
      indicator TEXT,
      threshold REAL,
      enabled INTEGER
    );
  `);
  seed.close();

  const result = runInitDb(dbPath, dir);
  assert.equal(result.alertsTableCount, 0, "empty alerts table should be dropped");
  assert.equal(result.migrationMarked, 1, "migration should be marked for empty case");
  const archiveDir = path.join(dir, "archive");
  assert.equal(existsSync(archiveDir) && readdirSync(archiveDir).length > 0, false, "empty alerts should not write archive");
});

await withTempDir("non-empty", async (dir) => {
  const dbPath = path.join(dir, "nonempty.db");
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE alerts (
      id INTEGER PRIMARY KEY,
      stock_code TEXT,
      indicator TEXT,
      threshold REAL,
      enabled INTEGER
    );
    INSERT INTO alerts (stock_code, indicator, threshold, enabled) VALUES
      ('000001', 'price_change', 5.0, 1),
      ('600000', 'volume_ratio', 2.5, 0);
  `);
  seed.close();

  const result = runInitDb(dbPath, dir);
  assert.equal(result.alertsTableCount, 0, "non-empty alerts table should still be dropped after archive");
  assert.equal(result.migrationMarked, 1, "migration should be marked after archiving");
  const archiveDir = path.join(dir, "archive");
  const archives = readdirSync(archiveDir);
  assert.equal(archives.length, 1, "exactly one archive file should be written");
  assert.match(archives[0], /^alerts-.*\.json$/, "archive file should match naming convention");
  const archivePath = path.join(archiveDir, archives[0]);
  const archived = JSON.parse(readFileSync(archivePath, "utf-8"));
  assert.equal(Array.isArray(archived), true);
  assert.equal(archived.length, 2, "both rows should be archived");
  assert.deepEqual(
    archived.map((r) => r.stock_code).sort(),
    ["000001", "600000"],
  );
});

console.log("[db-legacy-alerts-drop-smoke] ok");
