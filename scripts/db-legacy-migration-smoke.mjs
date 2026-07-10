#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = await mkdtemp(path.join(os.tmpdir(), "invest-agent-legacy-db-"));
const dbPath = path.join(dir, "legacy.db");
const legacy = new Database(dbPath);
legacy.exec(`
  CREATE TABLE alert_signal_states (
    signal_key TEXT NOT NULL,
    stock_code TEXT NOT NULL,
    stock_name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    last_price REAL,
    activated_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO alert_signal_states VALUES ('legacy-signal', '000001', 'legacy', 1, 10, '2026-01-01', '2026-01-01');
`);
legacy.close();

try {
  const moduleUrl = pathToFileURL(path.resolve("dist/db/index.js")).href;
  const source = `import { initDb, sqlite } from ${JSON.stringify(moduleUrl)}; initDb(); const columns = sqlite.prepare('PRAGMA table_info(alert_signal_states)').all(); const row = sqlite.prepare('SELECT user_id, instance_id, signal_key FROM alert_signal_states').get(); console.log(JSON.stringify({ columns: columns.map((x) => x.name), row }));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, DB_PATH: dbPath, NODE_ENV: "test", INVEST_AGENT_API_TOKEN: "legacy-migration-test-token" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout.trim().split("\n").at(-1);
  const migrated = JSON.parse(output);
  assert.equal(migrated.columns.includes("instance_id"), true);
  assert.deepEqual(migrated.row, { user_id: "primary", instance_id: "invest-agent-primary", signal_key: "legacy-signal" });
  console.log("[db-legacy-migration-smoke] ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}
