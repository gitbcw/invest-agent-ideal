import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-reviews-mirror-"));
process.env.NODE_ENV = "test";
process.env.WORKSPACE_BACKEND = "mastra";
process.env.DB_PATH = path.join(root, "reviews.db");
process.env.WORKSPACE_ROOT = path.join(root, "legacy-workspaces");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "mastra-projects");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.env.REVIEWS_ROOT = path.join(root, "reviews");
process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(root, ".sandbox-secret");
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

test("scheduled daily reviews.save mirrors the server-side report into the registered project root and publishes it (2026-08-19 T-325)", async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const { mastraWorkspaceRegistry } = await import("../src/mastra/workspace-registry.js");
  const { callServiceTool } = await import("../src/mcp/service-tools-core.js");

  const scope = { userId: "reviews-mirror-user", projectId: "invest-agent", instanceId: "invest-agent-reviews-mirror-user" };
  const projectRoot = path.join(root, "mastra-projects", "invest-agent");
  await mkdir(projectRoot, { recursive: true });
  await mastraWorkspaceRegistry.register({ ...scope, projectRoot });

  const context = {
    ...scope,
    conversationId: `scheduler:daily-review:${scope.userId}:${scope.instanceId}`,
    expectedReviewKind: "daily",
    expectedReviewKey: "2026-08-19",
  };

  const content = "# 日复盘｜2026年8月19日\n\n今日组合按计划执行，无新增动作。\n";
  const first = await callServiceTool("reviews.save", {
    kind: "daily",
    date: "2026-08-19",
    content,
    pushBrief: "**日复盘已生成**：今日无新增动作。",
  }, context) as { ok: boolean; artifact?: { artifactId: string } };
  assert.equal(first.ok, true);
  assert.ok(first.artifact?.artifactId, "the workspace-mirrored report must publish as an artifact instead of skipping");

  const workspaceReport = await readFile(path.join(projectRoot, "reports", "daily", "2026-08-19.md"), "utf8");
  const serverReport = await readFile(path.join(root, "reviews", scope.userId, "2026-08-19.md"), "utf8");
  assert.ok(workspaceReport.length > 0, "the workspace mirror must carry the saved report");
  assert.equal(workspaceReport, serverReport, "the workspace mirror must mirror the saved server-side report verbatim");

  // A same-day rerun must not fail or overwrite the already-mirrored report.
  const second = await callServiceTool("reviews.save", {
    kind: "daily",
    date: "2026-08-19",
    content: "# 日复盘｜2026年8月19日（重写）\n",
    pushBrief: "**日复盘已更新**。",
  }, context) as { ok: boolean; artifact?: { artifactId: string } };
  assert.equal(second.ok, true, "a same-day rerun must succeed");
  assert.ok(second.artifact?.artifactId, "the rerun must still publish the workspace report");
  const afterRerun = await readFile(path.join(projectRoot, "reports", "daily", "2026-08-19.md"), "utf8");
  assert.equal(afterRerun, workspaceReport, "the existing workspace mirror must never be overwritten");
});
