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
    const { db, initDb } = await import("../src/db/index.js"); const { marketWatchSnapshots } = await import("../src/db/schema.js"); const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
    initDb(); const now = new Date().toISOString(); const id = randomUUID();
    await db.insert(marketWatchSnapshots).values({ id, userId: "user-a", projectId: "invest-agent", instanceId: "instance-a", tradingDate: "2026-07-22", windowKey: "10:00", capturedAt: now, snapshotJson: JSON.stringify({ ok: true, updatedAt: now, holdings: [], watchlist: [], plans: [], indices: [], warnings: [] }), deltaJson: JSON.stringify({ materiallyChanged: true }), createdAt: now });
    assert.equal((await callServiceTool("market_watch.snapshot", {}, { userId: "user-a", instanceId: "instance-a" }) as any).result?.id, id);
    assert.equal((await callServiceTool("market_watch.snapshot", {}, { userId: "user-a", instanceId: "instance-b" }) as any).result, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
