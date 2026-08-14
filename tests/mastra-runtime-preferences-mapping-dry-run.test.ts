import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/mastra-runtime-preferences-mapping-dry-run.mjs");

test("runtime preferences dry-run preserves all four config sources and keeps scheduler disabled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-runtime-preferences-"));
  const snapshot = path.join(root, "snapshot");
  const workspace = path.join(snapshot, "alice", "config");
  const output = path.join(root, "mapping.json");
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(workspace, "schedules.yaml"), "timezone: Asia/Shanghai\ndaily_review: { enabled: true, auto_run: true, default_time: '19:00' }\nlast_confirmed_at: 2026-08-02T00:00:00Z\n");
    await writeFile(path.join(workspace, "watch.yaml"), "mode: default\nonly_push_on_exception: false\ncustom_rules: []\nlast_confirmed_at: 2026-08-02T00:00:01Z\n");
    await writeFile(path.join(workspace, "notification.yaml"), "preference: { mode: active_watch }\ndo_not_disturb: { enabled: false }\nlast_confirmed_at: 2026-08-02T00:00:02Z\n");
    await writeFile(path.join(workspace, "onboarding_state.yaml"), "status: completed\nupdated_at: 2026-08-02T00:00:03Z\n");
    const before = await Promise.all(["schedules.yaml", "watch.yaml", "notification.yaml", "onboarding_state.yaml"].map((file) => readFile(path.join(workspace, file), "utf8")));
    await execFileAsync(process.execPath, [script, "--workspace-snapshot", snapshot, "--workspace-id", "alice", "--user-id", "alice", "--instance-id", "invest-agent-alice", "--out", output]);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(report.validation, { missingFiles: [], unmappedSourceFiles: [], sourceWriteAttempted: false, targetWriteAttempted: false, conflict: false });
    assert.equal(report.mapping.serviceMigration.fields.schedulerActivation, "disabled_until_target_cold_start_and_explicit_enable");
    assert.equal(Object.keys(report.mapping.serviceMigration.sourceChecksums).length, 4);
    assert.equal(report.mapping.serviceMigration.fields.schedules.daily_review.default_time, "19:00");
    assert.equal(report.mapping.serviceMigration.fields.notification.preference.mode, "active_watch");
    const after = await Promise.all(["schedules.yaml", "watch.yaml", "notification.yaml", "onboarding_state.yaml"].map((file) => readFile(path.join(workspace, file), "utf8")));
    assert.deepEqual(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime preferences dry-run rejects an output inside the complete snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-runtime-preferences-"));
  const snapshot = path.join(root, "snapshot");
  const workspace = path.join(snapshot, "alice", "config");
  try {
    await mkdir(workspace, { recursive: true });
    for (const [name, value] of [["schedules.yaml", "{}\n"], ["watch.yaml", "{}\n"], ["notification.yaml", "{}\n"], ["onboarding_state.yaml", "{}\n"]]) await writeFile(path.join(workspace, name), value);
    await assert.rejects(execFileAsync(process.execPath, [script, "--workspace-snapshot", snapshot, "--workspace-id", "alice", "--user-id", "alice", "--instance-id", "invest-agent-alice", "--out", path.join(snapshot, "out.json")]), /--out must be outside/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
