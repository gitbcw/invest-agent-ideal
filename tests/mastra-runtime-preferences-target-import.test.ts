import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import test from "node:test";

const execFileAsync = promisify(execFile);
const mapScript = path.resolve("scripts/mastra-runtime-preferences-mapping-dry-run.mjs");
const importScript = path.resolve("scripts/mastra-runtime-preferences-target-import.mjs");
const files = ["schedules.yaml", "watch.yaml", "notification.yaml", "onboarding_state.yaml"];
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

test("runtime preferences target import registers all source assets and replays", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-runtime-preferences-target-"));
  const snapshot = path.join(root, "snapshot");
  const config = path.join(snapshot, "alice", "config");
  const mapping = path.join(root, "mapping.json");
  const targetDb = path.join(root, "target", "target.db");
  const targetProject = path.join(root, "target", "project");
  try {
    await mkdir(config, { recursive: true });
    for (const file of files) await writeFile(path.join(config, file), `${file}: true\n`);
    await execFileAsync(process.execPath, [mapScript, "--workspace-snapshot", snapshot, "--workspace-id", "alice", "--user-id", "alice", "--instance-id", "invest-agent-alice", "--out", mapping]);
    const args = [importScript, "--mapping", mapping, "--target-db", targetDb, "--target-project-root", targetProject, "--batch-id", "batch-1", "--workspace-snapshot", snapshot];
    const first = JSON.parse((await execFileAsync(process.execPath, args)).stdout);
    const second = JSON.parse((await execFileAsync(process.execPath, args)).stdout);
    assert.equal(first.action, "inserted");
    assert.equal(second.action, "replayed");
    assert.equal(first.assetCount, 4);
    const db = new Database(targetDb, { readonly: true });
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM mastra_runtime_preferences").get() as { count: number }).count, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM user_asset_versions").get() as { count: number }).count, 4);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime preferences target import rejects source mutation and target inside snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-runtime-preferences-target-"));
  const snapshot = path.join(root, "snapshot");
  const config = path.join(snapshot, "alice", "config");
  const mapping = path.join(root, "mapping.json");
  try {
    await mkdir(config, { recursive: true });
    for (const file of files) await writeFile(path.join(config, file), `${file}: true\n`);
    await execFileAsync(process.execPath, [mapScript, "--workspace-snapshot", snapshot, "--workspace-id", "alice", "--user-id", "alice", "--instance-id", "invest-agent-alice", "--out", mapping]);
    await writeFile(path.join(config, "watch.yaml"), "watch: changed\n");
    await assert.rejects(execFileAsync(process.execPath, [importScript, "--mapping", mapping, "--target-db", path.join(root, "other.db"), "--target-project-root", path.join(root, "other"), "--batch-id", "batch-2", "--workspace-snapshot", snapshot]), /MASTRA_RUNTIME_PREFERENCES_SOURCE_CHANGED/);
    await writeFile(path.join(config, "watch.yaml"), "watch.yaml: true\n");
    await assert.rejects(execFileAsync(process.execPath, [importScript, "--mapping", mapping, "--target-db", path.join(root, "target.db"), "--target-project-root", path.join(snapshot, "target"), "--batch-id", "batch-3", "--workspace-snapshot", snapshot]), /--target-project-root must be outside/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
