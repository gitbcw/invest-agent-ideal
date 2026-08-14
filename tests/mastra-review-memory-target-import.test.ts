import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import test from "node:test";

const execFileAsync = promisify(execFile);
const mapScript = path.resolve("scripts/mastra-review-memory-mapping-dry-run.mjs");
const importScript = path.resolve("scripts/mastra-review-memory-target-import.mjs");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-review-memory-target-"));
  const snapshot = path.join(root, "snapshot");
  const workspace = path.join(snapshot, "alice");
  const mapping = path.join(root, "mapping.json");
  await mkdir(path.join(workspace, "plans/daily"), { recursive: true });
  await mkdir(path.join(workspace, "memory"), { recursive: true });
  await writeFile(path.join(workspace, "plans/daily/2026-08-01.yaml"), "plan_date: 2026-08-01\ngenerated_at: 2026-08-01T00:00:00Z\nsummary: keep\ncontent: body\ndata: {}\n");
  await writeFile(path.join(workspace, "memory/behavior_events.jsonl"), '{"event_type":"confirmed","at":"2026-08-01"}\n');
  await execFileAsync(process.execPath, [mapScript, "--workspace-snapshot", snapshot, "--workspace-id", "alice", "--user-id", "alice", "--instance-id", "invest-agent-alice", "--out", mapping]);
  return { root, snapshot, mapping };
}

test("review memory target import records plans and events, then replays", async () => {
  const { root, snapshot, mapping } = await fixture();
  const targetDb = path.join(root, "target", "target.db");
  const targetProject = path.join(root, "target", "project");
  try {
    const args = [importScript, "--mapping", mapping, "--target-db", targetDb, "--target-project-root", targetProject, "--batch-id", "batch-1", "--workspace-snapshot", snapshot];
    const first = JSON.parse((await execFileAsync(process.execPath, args)).stdout);
    const second = JSON.parse((await execFileAsync(process.execPath, args)).stdout);
    assert.equal(first.action, "inserted");
    assert.equal(second.action, "replayed");
    assert.equal(first.recordCount, 2);
    assert.equal(first.assetCount, 2);
    assert.equal(first.historyDoesNotCreateAutomationTasks, true);
    const db = new Database(targetDb, { readonly: true });
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM mastra_review_memory_records").get() as { count: number }).count, 2);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM user_asset_versions").get() as { count: number }).count, 2);
    db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review memory target import rejects source changes, target conflicts, and snapshot targets", async () => {
  const { root, snapshot, mapping } = await fixture();
  const targetDb = path.join(root, "target.db");
  const targetProject = path.join(root, "project");
  const args = [importScript, "--mapping", mapping, "--target-db", targetDb, "--target-project-root", targetProject, "--batch-id", "batch-1", "--workspace-snapshot", snapshot];
  try {
    await execFileAsync(process.execPath, args);
    const db = new Database(targetDb);
    db.prepare("UPDATE mastra_review_memory_records SET payload_json = ? WHERE record_type = 'daily_plan'").run("{\"tampered\":true}");
    db.close();
    await assert.rejects(execFileAsync(process.execPath, args), /MASTRA_REVIEW_MEMORY_IMPORT_CONFLICT/);
    await writeFile(path.join(snapshot, "alice/memory/behavior_events.jsonl"), '{"event_type":"changed"}\n');
    await assert.rejects(execFileAsync(process.execPath, [importScript, "--mapping", mapping, "--target-db", path.join(root, "other.db"), "--target-project-root", path.join(root, "other"), "--batch-id", "batch-2", "--workspace-snapshot", snapshot]), /MASTRA_REVIEW_MEMORY_SOURCE_CHANGED/);
    await assert.rejects(execFileAsync(process.execPath, [importScript, "--mapping", mapping, "--target-db", path.join(snapshot, "target.db"), "--target-project-root", path.join(root, "outside"), "--batch-id", "batch-3", "--workspace-snapshot", snapshot]), /--target-db must be outside/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
