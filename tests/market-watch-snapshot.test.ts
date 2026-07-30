import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("market_watch.snapshot is scoped to the MCP user and instance", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-market-watch-snapshot-"));
  process.env.NODE_ENV = "test"; process.env.DB_PATH = path.join(root, "test.db"); process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
  try {
    const { db, initDb } = await import("../src/db/index.js"); const { marketWatchSnapshots, sandboxAuditLogs } = await import("../src/db/schema.js"); const { callServiceTool } = await import("../src/mcp/service-tools-core.js"); const { readMarketWatchFactsWereAudited } = await import("../src/acp/scheduled-tasks.js");
    initDb(); const now = new Date().toISOString(); const id = randomUUID();
    await db.insert(marketWatchSnapshots).values({ id, userId: "user-a", projectId: "invest-agent", instanceId: "instance-a", tradingDate: "2026-07-22", windowKey: "10:00", capturedAt: now, snapshotJson: JSON.stringify({ ok: true, updatedAt: now, holdings: [], watchlist: [], plans: [], indices: [], warnings: [] }), deltaJson: JSON.stringify({ materiallyChanged: true }), createdAt: now });
    const context = { userId: "user-a", instanceId: "instance-a", conversationId: "market-watch-snapshot-test" };
    assert.equal((await callServiceTool("market_watch.snapshot", {}, context) as any).result?.id, id);
    const [audit] = await db.select().from(sandboxAuditLogs);
    assert.equal(audit?.operation, "market_watch.snapshot");
    assert.equal(audit?.resourceId, id);
    assert.equal(await readMarketWatchFactsWereAudited(context), true);
    await db.update(sandboxAuditLogs).set({ operation: "market.health" });
    assert.equal(await readMarketWatchFactsWereAudited(context), false);
    assert.equal((await callServiceTool("market_watch.snapshot", {}, { userId: "user-a", instanceId: "instance-b" }) as any).result, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("market watch delta accepts legacy snapshots without newer collections", async () => {
  const { buildMarketWatchDelta } = await import("../src/services/market-watch-snapshot.js");
  const current = {
    ok: true as const,
    userId: "snapshot-compatibility-test",
    instanceId: "snapshot-compatibility-instance",
    updatedAt: "2026-07-23T01:30:00.000Z",
    holdings: [],
    watchlist: [],
    plans: [{ stockCode: "600000", stockName: "fixture", support: 10 }],
    indices: [],
    warnings: [],
  };
  const legacySnapshot = {
    ...current,
    updatedAt: "2026-07-23T01:00:00.000Z",
    plans: undefined,
    indices: undefined,
    warnings: undefined,
  };

  const delta = buildMarketWatchDelta(
    current,
    legacySnapshot as Parameters<typeof buildMarketWatchDelta>[1],
    "09:30",
  );
  assert.equal(delta.previousWindowKey, "09:30");
  assert.equal(delta.materiallyChanged, true);
  assert.deepEqual(delta.stockChanges.map((item) => [item.code, item.state]), [["600000", "added"]]);
  assert.deepEqual(delta.indexChanges, []);
  assert.equal(delta.warningsChanged, false);
});
