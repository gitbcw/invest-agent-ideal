import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
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
