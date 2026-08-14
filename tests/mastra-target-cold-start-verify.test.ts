import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/mastra-target-cold-start-verify.mjs");

test("composed target verifier validates projections, disabled scheduler and non-executable assets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-target-cold-start-"));
  const dbPath = path.join(root, "target.db");
  const project = path.join(root, "project");
  const assetPath = path.join(project, "assets/migrated/reports/report.md");
  try {
    await mkdir(path.dirname(assetPath), { recursive: true });
    await writeFile(assetPath, "report\n", { mode: 0o600 });
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE mastra_project_profiles (user_id TEXT, project_id TEXT, instance_id TEXT, profile_json TEXT, source_checksum TEXT);
      CREATE TABLE mastra_portfolio_states (user_id TEXT, project_id TEXT, instance_id TEXT, portfolio_json TEXT, source_checksum TEXT);
      CREATE TABLE mastra_runtime_preferences (user_id TEXT, project_id TEXT, instance_id TEXT, preferences_json TEXT, source_checksums_json TEXT, source_revision TEXT);
      CREATE TABLE mastra_review_memory_records (user_id TEXT, project_id TEXT, instance_id TEXT);
      CREATE TABLE mastra_workspace_asset_records (user_id TEXT, project_id TEXT, instance_id TEXT, source_path TEXT, checksum TEXT, target_path TEXT, executable INTEGER);
    `);
    const checksum = "1c4bb39f";
    db.prepare("INSERT INTO mastra_project_profiles VALUES (?,?,?,?,?)").run("alice", "invest-agent", "invest-agent-alice", "{}", "source");
    db.prepare("INSERT INTO mastra_portfolio_states VALUES (?,?,?,?,?)").run("alice", "invest-agent", "invest-agent-alice", "{}", "source");
    db.prepare("INSERT INTO mastra_runtime_preferences VALUES (?,?,?,?,?,?)").run("alice", "invest-agent", "invest-agent-alice", JSON.stringify({ schedulerActivation: "disabled_until_target_cold_start_and_explicit_enable" }), "{}", "revision");
    db.prepare("INSERT INTO mastra_review_memory_records VALUES (?,?,?)").run("alice", "invest-agent", "invest-agent-alice");
    db.prepare("INSERT INTO mastra_workspace_asset_records VALUES (?,?,?,?,?,?,?)").run("alice", "invest-agent", "invest-agent-alice", "reports/report.md", "", "assets/migrated/reports/report.md", 0);
    db.close();
    const { createHash } = await import("node:crypto");
    const actual = createHash("sha256").update("report\n").digest("hex");
    const writable = new Database(dbPath);
    writable.prepare("UPDATE mastra_workspace_asset_records SET checksum=?").run(actual);
    writable.close();
    const result = JSON.parse((await execFileAsync(process.execPath, [script, "--target-db", dbPath, "--target-project-root", project, "--user-id", "alice", "--instance-id", "invest-agent-alice"])).stdout);
    assert.equal(result.ok, true);
    assert.equal(result.projections.reviewMemoryRecords, 1);
    assert.equal(result.assets.executableRows, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
