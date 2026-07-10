#!/usr/bin/env node
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  createWatchRule,
  deleteWatchRule,
  dryRunWatchRuleById,
  listWatchRuleCatalog,
  listWatchRules,
  validateWatchRule,
} from "../dist/services/watch-rules.js";
import { filterAndRecordAlerts } from "../dist/scheduler/alert-check.js";
import { db } from "../dist/db/index.js";
import { alertEvents, alertRules, alertSignalStates, indicatorResults } from "../dist/db/schema.js";

const USER_ID = "stage2-watch-rules-smoke";
const INSTANCE_ID = "stage2-watch-rules-smoke-instance";

async function cleanup() {
  await db.delete(alertRules).where(eq(alertRules.userId, USER_ID));
  await db.delete(alertEvents).where(eq(alertEvents.userId, USER_ID));
  await db.delete(alertSignalStates).where(eq(alertSignalStates.userId, USER_ID));
  await db.delete(indicatorResults).where(eq(indicatorResults.userId, USER_ID));
}

await cleanup();

try {
  const catalog = listWatchRuleCatalog();
  assert(catalog.some((item) => item.key === "price_cross"), "catalog includes price_cross");
  assert(catalog.some((item) => item.key === "ma_cross"), "catalog includes ma_cross");
  assert(catalog.some((item) => item.key === "macd_cross"), "catalog includes macd_cross");
  assert(catalog.some((item) => item.key === "kdj_cross"), "catalog includes kdj_cross");
  assert(catalog.some((item) => item.key === "rsi_threshold"), "catalog includes rsi_threshold");
  assert(catalog.some((item) => item.key === "boll_break"), "catalog includes boll_break");
  assert(catalog.some((item) => item.key === "wr_threshold"), "catalog includes wr_threshold");
  assert(catalog.some((item) => item.key === "volume_ratio"), "catalog includes volume_ratio");
  assert(catalog.some((item) => item.key === "near_plan_level"), "catalog includes near_plan_level");

  const invalid = await validateWatchRule({
    userId: USER_ID,
    instanceId: INSTANCE_ID,
    stockCode: "002460",
    stockName: "赣锋锂业",
    ruleType: "price_cross",
    targetScope: "holding",
    params: { operator: ">", value: -1 },
  });
  assert.equal(invalid.ok, false, "invalid rule rejected");

  const valid = await validateWatchRule({
    userId: USER_ID,
    instanceId: INSTANCE_ID,
    stockCode: "002460",
    stockName: "赣锋锂业",
    ruleType: "price_cross",
    targetScope: "holding",
    params: { operator: ">=", value: 1 },
    notification: { priority: "P0", push: true },
  });
  assert.equal(valid.ok, true, "valid rule accepted");

  const rule = await createWatchRule({
    userId: USER_ID,
    instanceId: INSTANCE_ID,
    stockCode: "002460",
    stockName: "赣锋锂业",
    ruleType: "price_cross",
    targetScope: "holding",
    params: { operator: ">=", value: 1 },
    notification: { priority: "P0", push: true },
    source: { kind: "smoke" },
  });
  assert.equal(rule.ruleType, "price_cross", "created rule has type");

  const macdRule = await createWatchRule({
    userId: USER_ID,
    instanceId: INSTANCE_ID,
    stockCode: "002460",
    stockName: "赣锋锂业",
    ruleType: "macd_cross",
    targetScope: "holding",
    params: { direction: "golden_cross" },
    notification: { priority: "P1", push: true },
    source: { kind: "smoke" },
  });
  assert.equal(macdRule.ruleType, "macd_cross", "created MACD rule has type");

  const extraRules = [];
  for (const input of [
    { ruleType: "kdj_cross", params: { direction: "golden_cross", threshold: 20 } },
    { ruleType: "rsi_threshold", params: { period: 6, direction: "below", threshold: 30 } },
    { ruleType: "boll_break", params: { period: 20, multiplier: 2, direction: "break_upper" } },
    { ruleType: "wr_threshold", params: { period: 14, direction: "above", threshold: 80 } },
    { ruleType: "volume_ratio", params: { period: 5, direction: "above", threshold: 1.5 } },
  ]) {
    const created = await createWatchRule({
      userId: USER_ID,
      instanceId: INSTANCE_ID,
      stockCode: "002460",
      stockName: "赣锋锂业",
      ruleType: input.ruleType,
      targetScope: "holding",
      params: input.params,
      notification: { priority: "P1", push: true },
      source: { kind: "smoke" },
    });
    assert.equal(created.ruleType, input.ruleType, `created ${input.ruleType} rule has type`);
    extraRules.push(created);
  }

  const listed = await listWatchRules(USER_ID, INSTANCE_ID);
  assert.equal(listed.length, 7, "list returns created rules");

  const dryRun = await dryRunWatchRuleById(rule.id, USER_ID, INSTANCE_ID);
  assert.equal(dryRun.ok, true, "dry-run returns ok");
  assert.equal(dryRun.rule.id, rule.id, "dry-run returns target rule");
  assert("currentPrice" in dryRun.facts || Array.isArray(dryRun.facts.warnings), "dry-run returns market facts or warnings");

  const macdDryRun = await dryRunWatchRuleById(macdRule.id, USER_ID, INSTANCE_ID);
  assert.equal(macdDryRun.ok, true, "MACD dry-run returns ok");
  assert.equal(macdDryRun.rule.id, macdRule.id, "MACD dry-run returns target rule");
  assert("difToday" in macdDryRun.facts || Array.isArray(macdDryRun.facts.warnings), "MACD dry-run returns indicator facts or warnings");

  for (const extra of extraRules) {
    const extraDryRun = await dryRunWatchRuleById(extra.id, USER_ID, INSTANCE_ID);
    assert.equal(extraDryRun.ok, true, `${extra.ruleType} dry-run returns ok`);
    assert.equal(extraDryRun.rule.id, extra.id, `${extra.ruleType} dry-run returns target rule`);
    assert(Object.keys(extraDryRun.facts).length > 0 || typeof extraDryRun.reason === "string", `${extra.ruleType} dry-run returns facts or reason`);
    assert.equal(await deleteWatchRule(extra.id, USER_ID, INSTANCE_ID), true, `delete ${extra.ruleType} returns true`);
  }

  assert.equal(await deleteWatchRule(macdRule.id, USER_ID, INSTANCE_ID), true, "delete MACD returns true");
  const removed = await deleteWatchRule(rule.id, USER_ID, INSTANCE_ID);
  assert.equal(removed, true, "delete returns true");

  const afterDelete = await listWatchRules(USER_ID, INSTANCE_ID);
  assert.equal(afterDelete.length, 0, "rule removed");

  const cooldownItem = {
    stockCode: "002460",
    stockName: "赣锋锂业",
    type: "price",
    signalKey: "002460:watch-rule:price-cross:<=:61.18",
    relationToPlan: "未找到预案",
    price: 55.78,
    priority: "P0",
    severity: "high",
    dedupe: { mode: "cooldown", minutes: 240 },
    message: "冷却回归测试",
  };
  const watchPolicy = {
    enabled: true,
    onlyPushOnException: false,
    defaultCheckWindows: [],
    exceptionRules: [],
    nonExceptionRules: [],
  };

  const first = await filterAndRecordAlerts(USER_ID, INSTANCE_ID, [cooldownItem], watchPolicy);
  assert.equal(first.length, 1, "first rule hit is recorded");

  const fiveMinutesLater = await filterAndRecordAlerts(USER_ID, INSTANCE_ID, [{ ...cooldownItem, price: 56.8 }], watchPolicy);
  assert.equal(fiveMinutesLater.length, 0, "cooldown suppresses a repeated hit even when price changes");

  await db.delete(alertEvents).where(eq(alertEvents.userId, USER_ID));
  const oldCreatedAt = new Date(Date.now() - 241 * 60 * 1000).toISOString();
  await db.insert(alertEvents).values({
    userId: USER_ID,
    instanceId: INSTANCE_ID,
    stockCode: cooldownItem.stockCode,
    stockName: cooldownItem.stockName,
    eventDate: oldCreatedAt.slice(0, 10),
    eventType: cooldownItem.type,
    signalKey: cooldownItem.signalKey,
    message: cooldownItem.message,
    relationToPlan: cooldownItem.relationToPlan,
    severity: cooldownItem.severity,
    price: cooldownItem.price,
    status: "pending",
    createdAt: oldCreatedAt,
  });
  const afterCooldown = await filterAndRecordAlerts(USER_ID, INSTANCE_ID, [cooldownItem], watchPolicy);
  assert.equal(afterCooldown.length, 1, "rule can trigger again after its configured cooldown");

  console.log("✓ stage2 watch-rules smoke passed");
} finally {
  await cleanup();
}
