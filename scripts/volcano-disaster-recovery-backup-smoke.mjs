import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-dr-sqlite-"));
const sourcePath = path.join(root, "source.db");
const backupPath = path.join(root, "backup.db");

try {
  const source = new Database(sourcePath);
  source.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO items(value) VALUES ('one'), ('two')");
  source.pragma("journal_mode = WAL");
  source.prepare("INSERT INTO items(value) VALUES (?)").run("three");

  const output = execFileSync(process.execPath, [path.resolve("scripts/sqlite-online-backup.mjs"), sourcePath, backupPath], { encoding: "utf8" });
  assert.match(output, /"quickCheck":"ok"/);

  const backup = new Database(backupPath, { readonly: true });
  assert.equal(backup.pragma("quick_check", { simple: true }), "ok");
  assert.equal(backup.prepare("SELECT COUNT(*) AS count FROM items").get().count, 3);
  backup.close();
  source.close();
  console.log("volcano disaster-recovery SQLite backup smoke passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
