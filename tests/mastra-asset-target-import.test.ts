import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import test from "node:test";

const execFileAsync = promisify(execFile);
const mapScript = path.resolve("scripts/mastra-asset-mapping-dry-run.mjs");
const importScript = path.resolve("scripts/mastra-asset-target-import.mjs");
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-asset-target-"));
  const snapshot = path.join(root, "snapshot");
  const workspace = path.join(snapshot, "alice");
  const manifest = path.join(root, "manifest.json");
  const mapping = path.join(root, "mapping.json");
  const contents = { "reports/daily/report.md": "# report\n", "deliveries/calculator.py": "print(1)\n" };
  const entries: Array<Record<string, unknown>> = [];
  for (const [relativePath, content] of Object.entries(contents)) {
    await mkdir(path.dirname(path.join(workspace, relativePath)), { recursive: true });
    await writeFile(path.join(workspace, relativePath), content);
    entries.push({ sourcePath: relativePath, kind: "file", sizeBytes: Buffer.byteLength(content), sha256: hash(Buffer.from(content)), disposition: relativePath.startsWith("deliveries/") ? "asset_version" : "project_file", rule: "test" });
  }
  await writeFile(manifest, JSON.stringify({ source: { workspaceId: "alice", snapshotDigest: "digest", fileCount: entries.length }, summary: { unclassified: 0 }, entries }));
  await execFileAsync(process.execPath, [mapScript, "--workspace-snapshot", snapshot, "--manifest", manifest, "--user-id", "alice", "--instance-id", "invest-agent-alice", "--out", mapping]);
  return { root, snapshot, mapping, contents };
}

test("asset target import copies bytes as non-executable records and replays", async () => {
  const { root, snapshot, mapping, contents } = await fixture();
  const targetDb = path.join(root, "target", "target.db");
  const targetProject = path.join(root, "target", "project");
  try {
    const args = [importScript, "--mapping", mapping, "--target-db", targetDb, "--target-project-root", targetProject, "--batch-id", "batch-1", "--workspace-snapshot", snapshot];
    const first = JSON.parse((await execFileAsync(process.execPath, args)).stdout);
    const second = JSON.parse((await execFileAsync(process.execPath, args)).stdout);
    assert.equal(first.action, "inserted");
    assert.equal(second.action, "replayed");
    assert.equal(first.codeExecutionEnabled, false);
    assert.equal(await readFile(path.join(targetProject, "assets/migrated/deliveries/calculator.py"), "utf8"), contents["deliveries/calculator.py"]);
    assert.equal((await stat(path.join(targetProject, "assets/migrated/deliveries/calculator.py"))).mode & 0o111, 0);
    const db = new Database(targetDb, { readonly: true });
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM mastra_workspace_asset_records").get() as { count: number }).count, 2);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM mastra_workspace_asset_records WHERE executable = 1").get() as { count: number }).count, 0);
    db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("asset target import fails closed for source changes, target conflicts, and snapshot targets", async () => {
  const { root, snapshot, mapping } = await fixture();
  const targetDb = path.join(root, "target.db");
  const targetProject = path.join(root, "project");
  const args = [importScript, "--mapping", mapping, "--target-db", targetDb, "--target-project-root", targetProject, "--batch-id", "batch-1", "--workspace-snapshot", snapshot];
  try {
    await execFileAsync(process.execPath, args);
    await writeFile(path.join(targetProject, "assets/migrated/reports/daily/report.md"), "tampered\n");
    await assert.rejects(execFileAsync(process.execPath, args), /MASTRA_ASSET_IMPORT_CONFLICT/);
    await writeFile(path.join(snapshot, "alice/reports/daily/report.md"), "source changed\n");
    await assert.rejects(execFileAsync(process.execPath, [importScript, "--mapping", mapping, "--target-db", path.join(root, "other.db"), "--target-project-root", path.join(root, "other"), "--batch-id", "batch-2", "--workspace-snapshot", snapshot]), /MASTRA_ASSET_SOURCE_CHANGED/);
    await assert.rejects(execFileAsync(process.execPath, [importScript, "--mapping", mapping, "--target-db", path.join(snapshot, "target.db"), "--target-project-root", path.join(root, "outside"), "--batch-id", "batch-3", "--workspace-snapshot", snapshot]), /--target-db must be outside/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
