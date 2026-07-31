import assert from "node:assert/strict";
import test from "node:test";
import { mutationResourceKeysForOperation } from "../src/services/mutation-resource-keys.js";

test("portfolio-backed writes share one physical resource lock", () => {
  for (const operation of ["portfolio.apply_changes", "watchlist.add", "watchlist.remove", "plans.set", "plans.watch_conditions", "plans.remove"]) {
    assert.deepEqual(mutationResourceKeysForOperation(operation, { stockCode: "600519" }), ["portfolio"]);
  }
});

test("onboarding locks only the core files affected by each step", () => {
  assert.deepEqual(mutationResourceKeysForOperation("onboarding.confirm_step", { step: "style" }), ["onboarding-state", "strategy"]);
  assert.deepEqual(mutationResourceKeysForOperation("onboarding.confirm_step", { step: "notification" }), ["onboarding-state", "notification", "schedules"]);
  assert.deepEqual(
    [...mutationResourceKeysForOperation("onboarding.draft.commit", undefined)].sort(),
    ["notification", "onboarding-state", "portfolio", "schedules", "strategy", "watch", "watch-rules"],
  );
});

test("review locks are date-scoped while unrelated research stays unlocked", () => {
  assert.deepEqual(mutationResourceKeysForOperation("reviews.save", { date: "2026-07-27" }), ["daily-review:2026-07-27"]);
  assert.deepEqual(
    mutationResourceKeysForOperation("reviews.save", { kind: "weekly", reportKey: "2026-07-27_weekly" }),
    ["weekly-review:2026-07-27_weekly"],
  );
  assert.deepEqual(
    mutationResourceKeysForOperation("reviews.save", { kind: "monthly", reportKey: "2026-07" }),
    ["monthly-review:2026-07"],
  );
  assert.deepEqual(mutationResourceKeysForOperation("research.web_search", { query: "600519" }), []);
});
