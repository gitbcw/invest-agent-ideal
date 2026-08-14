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
const script = path.resolve("scripts/mastra-portfolio-target-import.mjs");

function report(checksum: string, fields: Record<string, unknown> = { cash: {}, holdings: [{ name: "A", code: "000001", shares: 1 }], watchlist: [], stockPlans: [], accounts: [], sourceRevision: "2026-08-02", sourceConfirmedBy: "user", sourceConfirmationId: null }) {
  return {
    mode: "dry_run",
    source: { workspaceId: "alice", userId: "alice", instanceId: "invest-agent-alice", sourcePath: "config/portfolio.yaml", sha256: checksum },
    mapping: { serviceMigration: { fields, idempotencyKey: "portfolio-state:test" }, counts: { holdings: 1, watchlist: 0, stockPlans: 0, accounts: 0 } },
  };
}

test("portfolio target import preserves full state and YAML asset, then replays", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-portfolio-target-"));
  const snapshot = path.join(root, "snapshot");
  const source = path.join(snapshot, "alice", "config", "portfolio.yaml");
  const mapping = path.join(root, "mapping.json");
  const targetDb = path.join(root, "target", "target.db");
  const targetProject = path.join(root, "target", "project");
  const bytes = Buffer.from("holdings:\n  - { name: A, code: '000001', shares: 1 }\n");
  try {
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, bytes);
    await writeFile(mapping, JSON.stringify(report(sha256(bytes))));
    const args = [script, "--mapping", mapping, "--target-db", targetDb, "--target-project-root", targetProject, "--batch-id", "batch-1", "--workspace-snapshot", snapshot];
    const first = JSON.parse((await execFileAsync(process.execPath, args)).stdout);
    const second = JSON.parse((await execFileAsync(process.execPath, args)).stdout);
    assert.equal(first.action, "inserted");
    assert.equal(second.action, "replayed");
    assert.deepEqual(await readFile(path.join(targetProject, first.asset.path)), bytes);
    const db = new Database(targetDb, { readonly: true });
    const state = db.prepare("SELECT portfolio_json AS stateJson, source_checksum AS checksum FROM mastra_portfolio_states").get() as { stateJson: string; checksum: string };
    assert.equal(state.checksum, sha256(bytes));
    assert.equal(JSON.parse(state.stateJson).holdings[0].shares, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM user_asset_versions").get() as { count: number }).count, 1);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portfolio target import fails closed on scope conflict and source mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-portfolio-target-"));
  const snapshot = path.join(root, "snapshot");
  const source = path.join(snapshot, "alice", "config", "portfolio.yaml");
  const mapping = path.join(root, "mapping.json");
  const targetDb = path.join(root, "target.db");
  const targetProject = path.join(root, "project");
  const bytes = Buffer.from("holdings: []\n");
  try {
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, bytes);
    await writeFile(mapping, JSON.stringify(report(sha256(bytes))));
    const args = [script, "--mapping", mapping, "--target-db", targetDb, "--target-project-root", targetProject, "--batch-id", "batch-1", "--workspace-snapshot", snapshot];
    await execFileAsync(process.execPath, args);
    await writeFile(mapping, JSON.stringify(report(sha256(bytes), { cash: {}, holdings: [{ name: "Changed", code: "000002" }], watchlist: [], stockPlans: [], accounts: [], sourceRevision: null, sourceConfirmedBy: null, sourceConfirmationId: null })));
    await assert.rejects(execFileAsync(process.execPath, args), /MASTRA_PORTFOLIO_IMPORT_CONFLICT/);
    await writeFile(source, Buffer.from("holdings: [{ name: tampered, code: '000003' }]\n"));
    await assert.rejects(execFileAsync(process.execPath, [script, "--mapping", mapping, "--target-db", path.join(root, "other.db"), "--target-project-root", path.join(root, "other"), "--batch-id", "batch-2", "--workspace-snapshot", snapshot]), /MASTRA_PORTFOLIO_SOURCE_CHANGED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portfolio target import refuses any target within the source snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-portfolio-target-"));
  const snapshot = path.join(root, "snapshot");
  const source = path.join(snapshot, "alice", "config", "portfolio.yaml");
  const mapping = path.join(root, "mapping.json");
  const bytes = Buffer.from("holdings: []\n");
  try {
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, bytes);
    await writeFile(mapping, JSON.stringify(report(sha256(bytes))));
    await assert.rejects(execFileAsync(process.execPath, [script, "--mapping", mapping, "--target-db", path.join(root, "target.db"), "--target-project-root", path.join(snapshot, "project"), "--batch-id", "batch-1", "--workspace-snapshot", snapshot]), /--target-project-root must be outside/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function sha256(value: Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
