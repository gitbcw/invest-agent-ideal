import { describe, test } from "node:test";
import * as assert from "node:assert/strict";
import { ashareCalendarReport, beijingDateKey, isAshareTradingDay, isAshareTradingTime } from "../src/lib/market-calendar.js";

const bj = (iso: string) => new Date(iso);

describe("A-share market calendar", () => {
  test("uses Beijing date key", () => {
    assert.equal(beijingDateKey(bj("2026-06-24T01:35:00.000Z")), "2026-06-24");
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

  test("reports previous and next trading days", () => {
    const report = ashareCalendarReport(bj("2026-06-28T01:35:00.000Z"));
    assert.equal(report.isTradingDay, false);
    assert.equal(report.session, "closed");
    assert.equal(report.previousTradingDay, "2026-06-26");
    assert.equal(report.nextTradingDay, "2026-06-29");
  });
});
