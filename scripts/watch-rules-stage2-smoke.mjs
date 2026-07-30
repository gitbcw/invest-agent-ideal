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
  // WP8: 8 类非价格规则已退役删除,catalog 只剩 price_cross
  assert(catalog.some((item) => item.key === "price_cross"), "catalog includes price_cross");
  assert.equal(catalog.length, 1, "catalog only has price_cross after deprecation cleanup");

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

  const listed = await listWatchRules(USER_ID, INSTANCE_ID);
  assert.equal(listed.length, 1, "list returns created rule");

  const dryRun = await dryRunWatchRuleById(rule.id, USER_ID, INSTANCE_ID);
  assert.equal(dryRun.ok, true, "dry-run returns ok");
  assert.equal(dryRun.rule.id, rule.id, "dry-run returns target rule");
  assert("currentPrice" in dryRun.facts || Array.isArray(dryRun.facts.warnings), "dry-run returns market facts or warnings");

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
