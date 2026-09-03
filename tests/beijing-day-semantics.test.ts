import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CREATED_AT_BEIJING_DAY_SQL, beijingDayOf } from "../src/lib/beijing-day.js";
import { beijingDateKey } from "../src/lib/market-calendar.js";

test("beijingDayOf 把 UTC ISO 时间戳与裸日期键统一归到北京日历日", () => {
  assert.equal(beijingDayOf("2026-09-02T16:30:00.000Z"), "2026-09-03");
  assert.equal(beijingDayOf("2026-09-03T15:59:59.999Z"), "2026-09-03");
  assert.equal(beijingDayOf("2026-09-03T16:00:00.000Z"), "2026-09-04");
  assert.equal(beijingDayOf("2026-09-03"), "2026-09-03");
  assert.equal(beijingDayOf("not-a-date"), null);
});

test("CREATED_AT_BEIJING_DAY_SQL 把 UTC created_at 归到北京日历日", async () => {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(":memory:");
  db.exec("CREATE TABLE agent_traces (created_at TEXT)");
  const insert = db.prepare("INSERT INTO agent_traces (created_at) VALUES (?)");
  // 北京 00:30 / 19:01 / 23:59:59 与次日 00:00
  insert.run("2026-09-02T16:30:00.000Z");
  insert.run("2026-09-03T11:01:25.123Z");
  insert.run("2026-09-03T15:59:59.999Z");
  insert.run("2026-09-03T16:00:00.000Z");
  const rows = db.prepare(`SELECT ${CREATED_AT_BEIJING_DAY_SQL} AS day, COUNT(*) AS calls FROM agent_traces GROUP BY day ORDER BY day`).all() as Array<{ day: string; calls: number }>;
  assert.deepEqual(rows, [
    { day: "2026-09-03", calls: 3 },
    { day: "2026-09-04", calls: 1 },
  ]);
  db.close();
});

test("agent-usage 按天分组归北京日历日（owner 成本视图口径）", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "invest-agent-usage-bj-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(root, "test.db");
  process.env.WORKSPACE_ROOT = path.join(root, "workspaces");

  try {
    const { initDb, sqlite } = await import("../src/db/index.js");
    await initDb();
    const todayBeijing = beijingDateKey();
    const nextDay = beijingDateKey(new Date(Date.now() + 24 * 3600 * 1000));
    // 与 trace.ts 落库格式一致：toISOString() 的 UTC 串。
    const utcIso = (beijingTime: string) => new Date(beijingTime).toISOString();
    const insert = sqlite.prepare(
      "INSERT INTO agent_traces (user_id, instance_id, conversation_id, channel, user_text, mode, status, agent_model, total_tokens, cost_amount, usage_source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // 北京今天 00:30（UTC 前一天 16:30）与 23:59:59 都应归今天；次日 00:00 归明天。
    insert.run("u-bj", "inst-bj", "conv-1", "portal", "hi", "chat", "success", "glm-5.3-flash", 100, 0.01, "actual", utcIso(`${todayBeijing}T00:30:00.000+08:00`));
    insert.run("u-bj", "inst-bj", "conv-2", "portal", "hi", "chat", "success", "glm-5.3-flash", 200, 0.02, "actual", utcIso(`${todayBeijing}T23:59:59.999+08:00`));
    insert.run("u-bj", "inst-bj", "conv-3", "portal", "hi", "chat", "success", "glm-5.3-flash", 300, 0.03, "actual", utcIso(`${nextDay}T00:00:00.000+08:00`));

    const { loadAgentUsageSummary } = await import("../src/services/agent-usage.js");
    const summary = loadAgentUsageSummary({
      instances: [{ instanceId: "inst-bj" }] as never,
      userId: "u-bj",
      instanceId: "inst-bj",
      days: 30,
      groupBy: "day",
    });
    assert.deepEqual(summary.groups.map((group) => ({ bucket: group.bucket, calls: group.calls })), [
      { bucket: nextDay, calls: 1 },
      { bucket: todayBeijing, calls: 2 },
    ]);
    assert.equal(summary.totals.calls, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
