import assert from "node:assert/strict";
import { test } from "node:test";
import { usageRange } from "../src/portal/usage-range.js";

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
