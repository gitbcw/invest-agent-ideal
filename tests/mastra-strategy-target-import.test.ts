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
const script = path.resolve("scripts/mastra-strategy-target-import.mjs");

function report(checksum = "source-checksum", style = "swing") {
  return {
    mode: "dry_run",
    source: { workspaceId: "alice", userId: "alice", instanceId: "invest-agent-alice", sourcePath: "config/strategy.yaml", sha256: checksum },
    mapping: { serviceMigration: { fields: { style, notes: style, markets: [], sourceRevision: "2026-08-02" }, idempotencyKey: `strategy-profile:${style}` } },
  };
}

test("strategy target import is scope-bound and idempotent without modifying the source snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-strategy-target-"));
  const snapshot = path.join(root, "snapshot");
  const mapping = path.join(root, "mapping.json");
  const targetDb = path.join(root, "target.db");
  try {
    await mkdir(path.join(snapshot, "alice/config"), { recursive: true });
    const source = Buffer.from("profile: {}\n");
    await writeFile(path.join(snapshot, "alice/config/strategy.yaml"), source);
    await writeFile(mapping, JSON.stringify(report(sha256(source))));
    const args = [script, "--mapping", mapping, "--target-db", targetDb, "--batch-id", "batch-1", "--workspace-snapshot", snapshot];
    const first = JSON.parse((await execFileAsync(process.execPath, args)).stdout);
    const second = JSON.parse((await execFileAsync(process.execPath, args)).stdout);
    assert.equal(first.action, "inserted");
    assert.equal(second.action, "replayed");
    assert.equal(second.count, 1);
    const db = new Database(targetDb, { readonly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM mastra_project_profiles").get().count, 1);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strategy target import rejects an existing conflicting same-scope projection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-strategy-target-"));
  const snapshot = path.join(root, "snapshot");
  const mapping = path.join(root, "mapping.json");
  const targetDb = path.join(root, "target.db");
  try {
    await mkdir(path.join(snapshot, "alice/config"), { recursive: true });
    const source = Buffer.from("profile: {}\n");
    await writeFile(path.join(snapshot, "alice/config/strategy.yaml"), source);
    await writeFile(mapping, JSON.stringify(report(sha256(source))));
    const args = [script, "--mapping", mapping, "--target-db", targetDb, "--batch-id", "batch-1", "--workspace-snapshot", snapshot];
    await execFileAsync(process.execPath, args);
    await writeFile(mapping, JSON.stringify(report(sha256(source), "value-changed")));
    await assert.rejects(execFileAsync(process.execPath, args), /MASTRA_PROFILE_IMPORT_CONFLICT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strategy target import refuses a target database within the snapshot root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-strategy-target-"));
  const snapshot = path.join(root, "snapshot");
  const mapping = path.join(root, "mapping.json");
  try {
    await mkdir(path.join(snapshot, "alice/config"), { recursive: true });
    const source = Buffer.from("profile: {}\n");
    await writeFile(path.join(snapshot, "alice/config/strategy.yaml"), source);
    await writeFile(mapping, JSON.stringify(report(sha256(source))));
    await assert.rejects(
      execFileAsync(process.execPath, [script, "--mapping", mapping, "--target-db", path.join(snapshot, "target.db"), "--batch-id", "batch-1", "--workspace-snapshot", snapshot]),
      /--target-db must be outside the workspace snapshot source/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function sha256(value: Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
