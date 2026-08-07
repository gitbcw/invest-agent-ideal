import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-conversation-runs-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "runs.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
mkdir(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

test("interrupted conversation runs become failed or expired after restart recovery", async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const runs = await import("../src/services/conversation-task-runs.js");
  const scope = { userId: "run-user", projectId: "invest-agent", instanceId: "run-instance" };
  const fresh = runs.createConversationTaskRun({ ...scope, conversationId: "c1", requestId: "r1", channel: "web", executionBudgetMs: 60_000 });
  const expired = runs.createConversationTaskRun({ ...scope, conversationId: "c2", requestId: "r2", channel: "web", executionBudgetMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runs.recoverInterruptedConversationTaskRuns(), 2);
  assert.equal(runs.getConversationTaskRun({ ...scope, runId: fresh.runId })?.status, "failed");
  assert.equal(runs.getConversationTaskRun({ ...scope, runId: expired.runId })?.status, "expired");
});
