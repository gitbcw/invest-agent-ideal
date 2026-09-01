import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-reviews-idem-"));
process.env.NODE_ENV = "test";
process.env.WORKSPACE_BACKEND = "mastra";
process.env.DB_PATH = path.join(root, "reviews.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "mastra-projects");
process.env.REVIEWS_ROOT = path.join(root, "reviews");
process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(root, ".sandbox-secret");
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

test("reviews.save retries rewrite the same decision/source memory rows instead of duplicating them", async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const { sqlite } = db;
  const { mastraWorkspaceRegistry } = await import("../src/mastra/workspace-registry.js");
  const { callServiceTool } = await import("../src/mcp/service-tools-core.js");

  const scope = {
    userId: "reviews-idem-user",
    projectId: "invest-agent",
    instanceId: "reviews-idem-instance",
  };
  const projectRoot = path.join(root, "mastra-projects", "invest-agent");
  await (await import("node:fs/promises")).mkdir(projectRoot, { recursive: true });
  await mastraWorkspaceRegistry.register({
    ...scope,
    projectRoot,
  });
  const context = {
    ...scope,
    conversationId: `scheduler:daily-review:${scope.userId}:${scope.instanceId}`,
    expectedReviewKind: "daily",
    expectedReviewKey: "2026-09-01",
  };

  const input = {
    kind: "daily",
    date: "2026-09-01",
    content: "# 日复盘｜2026年9月1日\n\n按计划执行。\n",
    pushBrief: "**日复盘已生成**。",
    decisionRecords: [
      { decision: "持有贵州茅台不动", reason: "估值仍在合理区间" },
      { decision: "五粮液减仓 10%", reason: "跌破 20 日线" },
    ],
    sourceEvents: [
      { event: "央行公开市场净投放", source: "财联社" },
    ],
  } as const;

  const countRows = () => (sqlite.prepare(
    "SELECT business_key AS key, payload_json AS payload FROM mastra_review_memory_records WHERE user_id=? AND project_id=? AND instance_id=?",
  ).all(scope.userId, scope.projectId, scope.instanceId) as Array<{ key: string; payload: string }>)
    .filter((row) => row.key.startsWith("decision:2026-09-01:") || row.key.startsWith("source-event:2026-09-01:"));

  const first = await callServiceTool("reviews.save", { ...input }, context) as { ok: boolean; decisionRecordCount: number };
  assert.equal(first.ok, true);
  assert.deepEqual(countRows().map((row) => row.key).sort(), [
    "decision:2026-09-01:0",
    "decision:2026-09-01:1",
    "source-event:2026-09-01:0",
  ]);

  // A retried task run with identical input must land on the exact same rows.
  const retry = await callServiceTool("reviews.save", { ...input }, context) as { ok: boolean };
  assert.equal(retry.ok, true);
  assert.deepEqual(countRows().map((row) => row.key).sort(), [
    "decision:2026-09-01:0",
    "decision:2026-09-01:1",
    "source-event:2026-09-01:0",
  ]);

  // A same-day resave with fewer records must not leave stale rows behind.
  const shrink = await callServiceTool("reviews.save", {
    ...input,
    decisionRecords: [input.decisionRecords[0]],
    sourceEvents: [],
  }, context) as { ok: boolean };
  assert.equal(shrink.ok, true);
  assert.deepEqual(countRows().map((row) => row.key).sort(), [
    "decision:2026-09-01:0",
  ]);
});
