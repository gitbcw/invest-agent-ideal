import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import {
  ashareCalendarReport,
  ashareHolidayTableCoverage,
  beijingDateKey,
  isAshareTradingDay,
  isAshareTradingTime,
  resolveCalendarQueryInstant,
} from "../src/lib/market-calendar.js";

const bj = (iso: string) => new Date(iso);

describe("A-share market calendar", () => {
  test("uses Beijing date key", () => {
    assert.equal(beijingDateKey(bj("2026-06-24T01:35:00.000Z")), "2026-06-24");
  });

  test("keeps a +08 quote date on its Beijing trading date", () => {
    // Tencent quote times such as 20260723101030 are parsed as this instant.
    assert.equal(beijingDateKey(bj("2026-07-22T16:00:00.000Z")), "2026-07-23");
  });

  test("treats regular weekdays as trading days", () => {
    assert.equal(isAshareTradingDay(bj("2026-06-24T01:35:00.000Z")), true);
  });

  test("excludes weekends", () => {
    assert.equal(isAshareTradingDay(bj("2026-06-28T01:35:00.000Z")), false);
  });

  test("excludes 2026 SSE holiday closures", () => {
    assert.equal(isAshareTradingDay(bj("2026-02-23T01:35:00.000Z")), false);
    assert.equal(isAshareTradingDay(bj("2026-06-19T01:35:00.000Z")), false);
    assert.equal(isAshareTradingDay(bj("2026-10-07T01:35:00.000Z")), false);
  });

  test("reopens after holiday closures", () => {
    assert.equal(isAshareTradingDay(bj("2026-02-24T01:35:00.000Z")), true);
    assert.equal(isAshareTradingDay(bj("2026-06-22T01:35:00.000Z")), true);
    assert.equal(isAshareTradingDay(bj("2026-10-08T01:35:00.000Z")), true);
  });

  test("checks intraday trading windows", () => {
    assert.equal(isAshareTradingTime(bj("2026-06-24T01:05:00.000Z")), false);
    assert.equal(isAshareTradingTime(bj("2026-06-24T01:30:00.000Z")), true);
    assert.equal(isAshareTradingTime(bj("2026-06-24T03:31:00.000Z")), false);
    assert.equal(isAshareTradingTime(bj("2026-06-24T05:00:00.000Z")), true);
    assert.equal(isAshareTradingTime(bj("2026-06-24T07:01:00.000Z")), false);
  });

  test("uses the current instant when an explicit date is today in Beijing", () => {
    const now = bj("2026-07-28T13:25:00.000Z");
    const resolved = resolveCalendarQueryInstant("2026-07-28", now);
    assert.equal(resolved.toISOString(), now.toISOString());
    assert.equal(ashareCalendarReport(resolved).session, "post_market");
  });

  test("keeps historical date queries anchored to that date", () => {
    const now = bj("2026-07-28T13:25:00.000Z");
    const resolved = resolveCalendarQueryInstant("2026-07-27", now);
    assert.equal(beijingDateKey(resolved), "2026-07-27");
  });

  test("reports previous and next trading days", () => {
    const report = ashareCalendarReport(bj("2026-06-28T01:35:00.000Z"));
    assert.equal(report.isTradingDay, false);
    assert.equal(report.session, "closed");
    assert.equal(report.previousTradingDay, "2026-06-26");
    assert.equal(report.nextTradingDay, "2026-06-29");
  });

  test("holiday table coverage is derived from the closure table", () => {
    assert.deepEqual(ashareHolidayTableCoverage(), { firstYear: 2026, lastYear: 2026 });
  });

  test("calendar report warns loudly for dates outside table coverage", () => {
    // 2027-01-04 is a Monday beyond the closure table; classification fails
    // open by design, but the report must surface the uncovered year.
    const report = ashareCalendarReport(bj("2027-01-04T01:35:00.000Z"));
    assert.equal(report.isTradingDay, true);
    assert.ok(
      report.source.warnings.some((warning) =>
        warning.includes("calendar_holiday_table_uncovered_year_2027")
      )
    );
  });

  test("isAshareTradingDay warns once per uncovered year", () => {
    const originalWarn = console.warn;
    const calls: string[] = [];
    console.warn = (msg?: unknown) => {
      calls.push(String(msg));
    };
    try {
      isAshareTradingDay(bj("2028-01-03T01:35:00.000Z"));
      isAshareTradingDay(bj("2028-01-04T01:35:00.000Z"));
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(calls.filter((msg) => msg.includes("ashare holiday table")).length, 1);
  });
});
