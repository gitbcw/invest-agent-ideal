import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Must be set before any module that loads data-backend is imported.
process.env.WORKSPACE_BACKEND = "mastra";

test("weekly review behavior stats aggregate mastra service-owned sources", async () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "invest-agent-mastra-behavior-stats-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(tempRoot, "test.db");
  process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");

  try {
    const { initDb, sqlite } = await import("../src/db/index.js");
    const { buildWeeklyReviewContext } = await import("../src/handlers/review.js");

    initDb();
    const userId = "behavior-user";
    const instanceId = "invest-agent-behavior-user";
    const projectId = "invest-agent";

    // Two in-range trade actions written through the real backend path, one out
    // of range, and one decision-shaped service_event without an action marker.
    const { portfolioBackend } = await import("../src/lib/data-backend.js");
    await portfolioBackend.recordTradeAction({ userId, instanceId, code: "600519", action: "buy", price: 1700, quantity: 100, createdAt: "2026-08-11T09:40:00.000Z" });
    await portfolioBackend.recordTradeAction({ userId, instanceId, code: "300750", action: "sell", price: 230, quantity: 200, createdAt: "2026-08-12T15:00:00.000Z" });
    await portfolioBackend.recordTradeAction({ userId, instanceId, code: "000001", action: "buy", price: 10, quantity: 0, createdAt: "2026-07-15T09:40:00.000Z" });
    const now = "2026-08-13T19:00:00.000Z";
    sqlite.prepare("INSERT INTO mastra_review_memory_records (record_id,user_id,project_id,instance_id,record_type,business_key,payload_json,source_path,source_checksum,migration_batch_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("decision-1", userId, projectId, instanceId, "service_event", "decision:2026-08-12:0", JSON.stringify({ decision: "hold", recorded_at: now }), "service-owned://reviews", "service:x", "service-owned", now);

    // Three conversation turns in range (user+assistant pairs), one out of range.
    const insertTurn = (role: string, createdAt: string, conversationId: string) =>
      sqlite.prepare("INSERT INTO chat_history (user_id,instance_id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?,?)")
        .run(userId, instanceId, conversationId, role, "text", createdAt);
    insertTurn("user", "2026-08-10T09:00:00.000Z", "c1");
    insertTurn("assistant", "2026-08-10T09:01:00.000Z", "c1");
    insertTurn("user", "2026-08-12T10:00:00.000Z", "c2");
    insertTurn("assistant", "2026-08-12T10:01:00.000Z", "c2");
    insertTurn("user", "2026-08-13T11:00:00.000Z", "c3");
    insertTurn("assistant", "2026-08-13T11:01:00.000Z", "c3");
    insertTurn("user", "2026-07-20T09:00:00.000Z", "c0");

    // 2026-08-13 is a Thursday; the weekly range is Monday-so-far
    // (2026-08-10 .. 2026-08-13), which covers everything above except the
    // July rows.
    const context = await buildWeeklyReviewContext({ userId, instanceId, date: "2026-08-13" });
    const stats = context.behaviorStats;
    assert.equal(stats.available, true);
    assert.equal(stats.actionConfirmedCount, 2, "in-range trade actions only");
    assert.equal(stats.conversationTurnCount, 3, "user rows in range count as turns");
    assert.equal(stats.outOfScopeCount, 0);
    assert.deepEqual(
      stats.recentActions.map((item) => item.code),
      ["600519", "300750"],
    );
    assert.equal(stats.recentActions[0].price, 1700);
    assert.equal(stats.recentActions[1].action, "sell");
    assert.equal(stats.rangeStart, "2026-08-10");
    assert.equal(stats.rangeEnd, "2026-08-13");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
