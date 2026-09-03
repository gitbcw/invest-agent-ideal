import assert from "node:assert/strict";
import { test } from "node:test";
import { USAGE_DAY_BUCKET_SQL, usageRange } from "../src/portal/usage-range.js";

test("usageRange 把裸日期解释为北京日历日的 UTC 边界", () => {
  const range = usageRange({ payload: { from: "2026-09-03", to: "2026-09-03" } });
  assert.equal(range.from, "2026-09-02T16:00:00.000Z");
  assert.equal(range.to, "2026-09-03T15:59:59.999Z");
});

test("usageRange 对完整时间戳原样透传", () => {
  const range = usageRange({ payload: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-03T10:00:00.500Z" } });
  assert.equal(range.from, "2026-09-01T00:00:00.000Z");
  assert.equal(range.to, "2026-09-03T10:00:00.500Z");
});

test("usageRange 缺省回退为北京近 30 天", () => {
  const range = usageRange({ payload: {} });
  assert.match(range.from, /^.{10}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const span = Date.parse(range.to) - Date.parse(range.from);
  assert.equal(span, 30 * 24 * 3600 * 1000 - 1);
});

test("usageRange 对形状合法但不存在的日期回退缺省而非抛错", () => {
  const range = usageRange({ payload: { from: "2026-13-99", to: "2026-13-99" } });
  const span = Date.parse(range.to) - Date.parse(range.from);
  assert.equal(span, 30 * 24 * 3600 * 1000 - 1);
});

test("按天分组 SQL 把 UTC created_at 归到北京日历日", async () => {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(":memory:");
  db.exec("CREATE TABLE agent_traces (created_at TEXT)");
  const insert = db.prepare("INSERT INTO agent_traces (created_at) VALUES (?)");
  // 北京 09-03 00:30 / 19:01 / 23:59:59 与 09-04 00:00
  insert.run("2026-09-02T16:30:00.000Z");
  insert.run("2026-09-03T11:01:25.123Z");
  insert.run("2026-09-03T15:59:59.999Z");
  insert.run("2026-09-03T16:00:00.000Z");
  const rows = db.prepare(`SELECT ${USAGE_DAY_BUCKET_SQL} AS day, COUNT(*) AS calls FROM agent_traces GROUP BY day ORDER BY day`).all() as Array<{ day: string; calls: number }>;
  assert.deepEqual(rows, [
    { day: "2026-09-03", calls: 3 },
    { day: "2026-09-04", calls: 1 },
  ]);
  db.close();
});
