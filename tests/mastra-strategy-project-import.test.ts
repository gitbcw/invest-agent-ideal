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
const script = path.resolve("scripts/mastra-strategy-project-import.mjs");

function report(checksum: string, methods: Record<string, unknown> = { buyRules: ["buy"], sellRules: [], rebalanceRules: [], riskRules: ["risk"], doNotDoRules: [], decisionBoundaries: { action_requires_user_confirmation: true }, notes: "keep", sourceRevision: "2026-08-02" }) {
  return {
    mode: "dry_run",
    source: { workspaceId: "alice", userId: "alice", instanceId: "invest-agent-alice", sourcePath: "config/strategy.yaml", sha256: checksum },
    mapping: { projectFile: { fields: methods } },
  };
}

test("strategy project import preserves methods and immutable YAML asset, then replays", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-strategy-project-"));
  const snapshot = path.join(root, "snapshot");
  const source = path.join(snapshot, "alice", "config", "strategy.yaml");
  const mapping = path.join(root, "mapping.json");
  const targetDb = path.join(root, "target", "target.db");
  const targetProject = path.join(root, "target", "project");
  const sourceBytes = Buffer.from("profile: {}\nbuy_rules:\n  - buy\n");
  try {
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, sourceBytes);
    await writeFile(mapping, JSON.stringify(report(sha256(sourceBytes))));
    const args = [script, "--mapping", mapping, "--target-db", targetDb, "--target-project-root", targetProject, "--batch-id", "batch-1", "--workspace-snapshot", snapshot];
    const first = JSON.parse((await execFileAsync(process.execPath, args)).stdout);
    const second = JSON.parse((await execFileAsync(process.execPath, args)).stdout);
    assert.equal(first.action, "inserted");
    assert.equal(second.action, "replayed");
    const methods = await readFile(path.join(targetProject, "methods/strategy-rules.md"), "utf8");
    assert.match(methods, /## Buy rules/);
    assert.match(methods, /- buy/);
    const asset = await readFile(path.join(targetProject, first.asset.path));
    assert.deepEqual(asset, sourceBytes);
    const db = new Database(targetDb, { readonly: true });
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM user_assets").get() as { count: number }).count, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM user_asset_versions").get() as { count: number }).count, 1);
    const row = db.prepare("SELECT checksum, storage_path AS storagePath FROM user_asset_versions").get() as { checksum: string; storagePath: string };
    assert.equal(row.checksum, sha256(sourceBytes));
    assert.equal(row.storagePath, first.asset.path);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strategy project import rejects changed same-scope content and source tampering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-strategy-project-"));
  const snapshot = path.join(root, "snapshot");
  const source = path.join(snapshot, "alice", "config", "strategy.yaml");
  const mapping = path.join(root, "mapping.json");
  const targetDb = path.join(root, "target.db");
  const targetProject = path.join(root, "project");
  const sourceBytes = Buffer.from("profile: {}\n");
  try {
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, sourceBytes);
    await writeFile(mapping, JSON.stringify(report(sha256(sourceBytes))));
    const args = [script, "--mapping", mapping, "--target-db", targetDb, "--target-project-root", targetProject, "--batch-id", "batch-1", "--workspace-snapshot", snapshot];
    await execFileAsync(process.execPath, args);
    await writeFile(mapping, JSON.stringify(report(sha256(sourceBytes), { buyRules: ["changed"], sellRules: [], rebalanceRules: [], riskRules: [], doNotDoRules: [], decisionBoundaries: {}, notes: "keep", sourceRevision: "2026-08-02" })));
    await assert.rejects(execFileAsync(process.execPath, args), /MASTRA_STRATEGY_PROJECT_IMPORT_CONFLICT/);
    await writeFile(source, Buffer.from("profile: {tampered: true}\n"));
    await assert.rejects(execFileAsync(process.execPath, [script, "--mapping", mapping, "--target-db", path.join(root, "other.db"), "--target-project-root", path.join(root, "other-project"), "--batch-id", "batch-2", "--workspace-snapshot", snapshot]), /MASTRA_STRATEGY_SOURCE_CHANGED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strategy project import rejects target project inside snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-strategy-project-"));
  const snapshot = path.join(root, "snapshot");
  const source = path.join(snapshot, "alice", "config", "strategy.yaml");
  const mapping = path.join(root, "mapping.json");
  try {
    await mkdir(path.dirname(source), { recursive: true });
    const bytes = Buffer.from("profile: {}\n");
    await writeFile(source, bytes);
    await writeFile(mapping, JSON.stringify(report(sha256(bytes))));
    await assert.rejects(execFileAsync(process.execPath, [script, "--mapping", mapping, "--target-db", path.join(root, "target.db"), "--target-project-root", path.join(snapshot, "target"), "--batch-id", "batch-1", "--workspace-snapshot", snapshot]), /--target-project-root must be outside/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
