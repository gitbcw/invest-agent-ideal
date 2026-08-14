import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("Mastra runtime preferences are scope-bound and workspace-free", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-mastra-preferences-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(root, "target.db");
  process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
  process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
  process.env.MASTRA_PROJECT_ID = "invest-agent";
  try {
    const { initDb, sqlite } = await import("../src/db/index.js");
    const { MastraUserPreferenceStore, applyUserPreferenceChange } = await import("../src/services/user-preferences.js");
    initDb();
    const first = new MastraUserPreferenceStore("alice", "instance-a");
    const second = new MastraUserPreferenceStore("alice", "instance-b");
    const result = await applyUserPreferenceChange(first, {
      reviewSchedule: { daily_review: { default_time: "20:00" } },
      notificationPreference: { mode: "active_watch" },
      confirmationId: "confirm-a",
    });
    assert.equal(result.revision, result.schedules.last_confirmed_at);
    assert.equal((await first.readSchedules()).daily_review?.default_time, "20:00");
    assert.equal((await first.readNotification()).preference?.mode, "active_watch");
    assert.deepEqual(await second.readSchedules(), {});
    assert.deepEqual(await second.readNotification(), {});
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM mastra_runtime_preferences WHERE user_id = ?").get("alice").count, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
