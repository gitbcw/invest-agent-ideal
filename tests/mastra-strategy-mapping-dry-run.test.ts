import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/mastra-strategy-mapping-dry-run.mjs");

test("strategy mapping dry-run separates service profile fields from retained project methods", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-strategy-map-"));
  const snapshot = path.join(root, "snapshot");
  const strategy = path.join(snapshot, "alice", "config", "strategy.yaml");
  const output = path.join(root, "strategy-map.json");
  try {
    await mkdir(path.dirname(strategy), { recursive: true });
    await writeFile(strategy, [
      "profile:", "  style: swing", "  markets: [CN]", "  user_mode: working_professional",
      "allocation: { max_single_position_weight: 0.2 }", "buy_rules: [trend]", "risk_rules: [stop]",
      "decision_boundaries: { action_requires_user_confirmation: true }", "notes: preserve me", "last_confirmed_at: 2026-08-02T11:31:39+08:00",
    ].join("\n"));
    const before = await readFile(strategy, "utf8");
    await execFileAsync(process.execPath, [script, "--workspace-snapshot", snapshot, "--workspace-id", "alice", "--user-id", "alice", "--instance-id", "invest-agent-alice", "--out", output]);
    assert.equal(await readFile(strategy, "utf8"), before);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.validation.conflict, false);
    assert.equal(report.validation.targetWriteAttempted, false);
    assert.equal(report.mapping.serviceMigration.fields.style, "swing");
    assert.deepEqual(report.mapping.serviceMigration.fields.markets, ["CN"]);
    assert.deepEqual(report.mapping.projectFile.fields.buyRules, ["trend"]);
    assert.equal(report.mapping.projectFile.fields.notes, "preserve me");
    assert.deepEqual(report.validation.unmappedTopLevelFields, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strategy mapping dry-run rejects output within the complete snapshot root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-strategy-map-"));
  const snapshot = path.join(root, "snapshot");
  try {
    await mkdir(path.join(snapshot, "alice", "config"), { recursive: true });
    await writeFile(path.join(snapshot, "alice", "config", "strategy.yaml"), "profile: {}\n");
    await assert.rejects(
      execFileAsync(process.execPath, [script, "--workspace-snapshot", snapshot, "--workspace-id", "alice", "--user-id", "alice", "--instance-id", "invest-agent-alice", "--out", path.join(snapshot, "map.json")]),
      /--out must be outside the workspace snapshot source/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
