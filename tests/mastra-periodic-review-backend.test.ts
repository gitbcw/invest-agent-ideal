import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("Mastra periodic reviews are scope-bound service records", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-mastra-periodic-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(root, "target.db");
  process.env.WORKSPACE_BACKEND = "mastra";
  process.env.MASTRA_PROJECT_ID = "invest-agent";
  try {
    const { initDb, sqlite } = await import("../src/db/index.js");
    initDb();
    const { periodicReviewBackend } = await import("../src/lib/periodic-review-backend.js");
    await periodicReviewBackend.upsert("alice", "instance-a", {
      kind: "weekly", reportKey: "2026-08-09_weekly", generatedAt: "2026-08-10T00:00:00.000Z",
      summary: "summary", content: "# Weekly", data: { scheduled: true },
    });
    const saved = await periodicReviewBackend.get("alice", "instance-a", "weekly", "2026-08-09_weekly");
    assert.deepEqual(saved, {
      kind: "weekly", reportKey: "2026-08-09_weekly", generatedAt: "2026-08-10T00:00:00.000Z",
      summary: "summary", content: "# Weekly", data: { scheduled: true },
    });
    assert.equal(await periodicReviewBackend.get("alice", "instance-b", "weekly", "2026-08-09_weekly"), null);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM mastra_review_memory_records WHERE record_type = 'periodic_review'").get().count, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Mastra weekly/monthly reviews publish validated content without workspace files and update idempotently", async () => {
  const { initDb, sqlite } = await import("../src/db/index.js");
  initDb();
  const { registerTestProject } = await import("./helpers/mastra-project.js");
  const { saveSkillPeriodicReview } = await import("../src/handlers/review.js");
  const { listCuratedArtifactLibrary, readConversationArtifactPayload } = await import("../src/services/conversation-artifacts.js");

  const suffix = randomUUID();
  const scope = {
    userId: `periodic-publish-user-${suffix}`,
    projectId: "invest-agent",
    instanceId: `periodic-publish-instance-${suffix}`,
  };
  const projectRoot = await registerTestProject(scope);
  const weeklyKey = "2026-08-16_weekly";
  const monthlyKey = "2026-08";
  const publication = (kind: "weekly" | "monthly", key: string) => ({
    publication: { conversationId: `scheduler:${kind}-review:${scope.userId}:${scope.instanceId}`, scheduled: true },
    kind,
    reportKey: key,
  });

  const weekly = await saveSkillPeriodicReview({
    ...scope,
    kind: "weekly",
    reportKey: weeklyKey,
    content: "# Weekly v1\n",
    summary: "weekly v1",
    context: publication("weekly", weeklyKey),
  });
  const monthly = await saveSkillPeriodicReview({
    ...scope,
    kind: "monthly",
    reportKey: monthlyKey,
    content: "# Monthly v1\n",
    summary: "monthly v1",
    context: publication("monthly", monthlyKey),
  });

  assert.ok(weekly.artifact?.artifactId);
  assert.ok(monthly.artifact?.artifactId);
  assert.equal(weekly.filePath, `reports/weekly/${weeklyKey}.md`);
  assert.equal(monthly.filePath, `reports/monthly/${monthlyKey}.md`);
  await assert.rejects(() => stat(path.join(projectRoot, "reports", "weekly", `${weeklyKey}.md`)), /ENOENT/);
  await assert.rejects(() => stat(path.join(projectRoot, "reports", "monthly", `${monthlyKey}.md`)), /ENOENT/);

  const firstRead = await readConversationArtifactPayload({
    artifactId: weekly.artifact!.artifactId,
    userId: scope.userId,
    instanceId: scope.instanceId,
  });
  assert.equal(Buffer.from(firstRead.payload.base64, "base64").toString("utf8"), "# Weekly v1\n");

  // A user may independently own the same display path. The service-owned
  // artifact must not overwrite it or read it in place of its backing bytes.
  const userPath = path.join(projectRoot, "reports", "weekly", `${weeklyKey}.md`);
  await mkdir(path.dirname(userPath), { recursive: true });
  await writeFile(userPath, "# user-owned file\n", "utf8");

  const retry = await saveSkillPeriodicReview({
    ...scope,
    kind: "weekly",
    reportKey: weeklyKey,
    content: "# Weekly v2\n",
    summary: "weekly v2",
    context: publication("weekly", weeklyKey),
  });
  assert.equal(retry.artifact?.artifactId, weekly.artifact?.artifactId);
  assert.notEqual(retry.artifact?.versionId, weekly.artifact?.versionId);

  const secondRead = await readConversationArtifactPayload({
    artifactId: retry.artifact!.artifactId,
    userId: scope.userId,
    instanceId: scope.instanceId,
  });
  assert.equal(Buffer.from(secondRead.payload.base64, "base64").toString("utf8"), "# Weekly v2\n");
  assert.equal(await readFile(userPath, "utf8"), "# user-owned file\n");
  const mappingCount = sqlite.prepare(
    "SELECT COUNT(*) AS count FROM report_asset_mappings WHERE user_id = ? AND project_id = ? AND instance_id = ? AND report_id = ?",
  ).get(scope.userId, scope.projectId, scope.instanceId, weekly.artifact!.artifactId) as { count: number };
  assert.equal(mappingCount.count, 1, "same report key must keep one mapping");
  const current = sqlite.prepare(
    "SELECT current_version_id AS currentVersionId FROM user_assets WHERE asset_id = ?",
  ).get(retry.artifact!.assetId) as { currentVersionId: string };
  assert.equal(current.currentVersionId, retry.artifact!.versionId, "artifact must point at the current asset version");

  const library = await listCuratedArtifactLibrary({ ...scope });
  assert.deepEqual(
    library.items.map((item) => item.artifactId).sort(),
    [retry.artifact!.artifactId, monthly.artifact!.artifactId].sort(),
  );
});

test("Mastra periodic publisher failures expose a stable error", async () => {
  const { saveSkillPeriodicReview } = await import("../src/handlers/review.js");
  await assert.rejects(
    () => saveSkillPeriodicReview({
      userId: "periodic-publish-unregistered-user",
      instanceId: "periodic-publish-unregistered-instance",
      kind: "weekly",
      reportKey: "2026-08-23_weekly",
      content: "# cannot publish\n",
      context: { publication: { conversationId: "scheduler:weekly-review:unregistered", scheduled: true } },
    }),
    /REVIEW_ARTIFACT_PUBLISH_FAILED/,
  );
});
