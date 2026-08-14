import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/mastra-review-memory-mapping-dry-run.mjs");

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-review-memory-map-"));
  const workspace = path.join(root, "snapshot", "alice");
  await mkdir(path.join(workspace, "plans/daily"), { recursive: true });
  await mkdir(path.join(workspace, "memory"), { recursive: true });
  await writeFile(path.join(workspace, "plans/daily/2026-08-01.yaml"), "plan_date: 2026-08-01\ngenerated_at: 2026-08-01T00:00:00Z\nsummary: keep\ncontent: text\ndata: { source: test }\n");
  await writeFile(path.join(workspace, "memory/behavior_events.jsonl"), '{"type":"template_init"}\n{"event_type":"action_confirmed","occurred_at":"2026-08-01T01:00:00Z","payload":{"code":"000001"}}\n');
  await writeFile(path.join(workspace, "memory/decisions.jsonl"), '{"type":"daily_viewpoint","date":"2026-08-01"}\n');
  await writeFile(path.join(workspace, "memory/method_changes.jsonl"), '{"type":"template_init"}\n{"candidate_id":"c1","status":"proposed","updated_at":"2026-08-01T00:00:00Z"}\n');
  await writeFile(path.join(workspace, "memory/review_viewpoints.jsonl"), "");
  await writeFile(path.join(workspace, "memory/change_log.jsonl"), '{"type":"template_init"}\n');
  await writeFile(path.join(workspace, "memory/source_events.jsonl"), '{"type":"template_init"}\n');
  await writeFile(path.join(workspace, "memory/audit_events.jsonl"), '{"type":"template_init"}\n');
  await writeFile(path.join(workspace, "memory/feedback.jsonl"), '{"type":"template_init"}\n');
  await writeFile(path.join(workspace, "memory/task_runs.jsonl"), '{"type":"template_init"}\n');
  return root;
}

test("review memory dry-run classifies daily state and event streams without creating tasks", async () => {
  const root = await fixture();
  try {
    const snapshot = path.join(root, "snapshot");
    const output = path.join(root, "mapping.json");
    await execFileAsync(process.execPath, [script, "--workspace-snapshot", snapshot, "--workspace-id", "alice", "--user-id", "alice", "--instance-id", "invest-agent-alice", "--out", output]);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.validation.dailyPlanCount, 1);
    assert.equal(report.validation.memoryLineCount, 10);
    assert.equal(report.validation.parseErrors, 0);
    assert.equal(report.mapping.dailyPlans.historyDoesNotCreateAutomationTasks, true);
    assert.equal(report.mapping.memory.find((entry: any) => entry.relativePath === "memory/method_changes.jsonl").disposition, "method_change_service_migration");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("review memory dry-run rejects bad dates, malformed JSONL and snapshot-local output", async () => {
  const root = await fixture();
  try {
    const snapshot = path.join(root, "snapshot");
    const source = path.join(snapshot, "alice");
    const output = path.join(root, "mapping.json");
    await writeFile(path.join(source, "plans/daily/2026-08-01.yaml"), "plan_date: 2026-08-02\ncontent: bad\ngenerated_at: now\n");
    await assert.rejects(execFileAsync(process.execPath, [script, "--workspace-snapshot", snapshot, "--workspace-id", "alice", "--user-id", "alice", "--instance-id", "invest-agent-alice", "--out", output]), /MASTRA_DAILY_PLAN_DATE_MISMATCH/);
    await writeFile(path.join(source, "plans/daily/2026-08-01.yaml"), "plan_date: 2026-08-01\ncontent: ok\ngenerated_at: now\n");
    await writeFile(path.join(source, "memory/decisions.jsonl"), "not json\n");
    await assert.rejects(execFileAsync(process.execPath, [script, "--workspace-snapshot", snapshot, "--workspace-id", "alice", "--user-id", "alice", "--instance-id", "invest-agent-alice", "--out", output]), /MASTRA_MEMORY_JSONL_PARSE_ERROR/);
    await writeFile(path.join(source, "memory/decisions.jsonl"), '{"type":"ok"}\n');
    await assert.rejects(execFileAsync(process.execPath, [script, "--workspace-snapshot", snapshot, "--workspace-id", "alice", "--user-id", "alice", "--instance-id", "invest-agent-alice", "--out", path.join(snapshot, "out.json")]), /--out must be outside/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
