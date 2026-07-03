/**
 * 黄金测试集结构校验器。
 *
 * 只校验测试集资产本身,不调用模型、不依赖本地服务。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..");

function readYaml(relativePath) {
  return parse(readFileSync(resolve(repoRoot, relativePath), "utf-8"));
}

function assertString(value, label) {
  assert.equal(typeof value, "string", `${label} must be string`);
  assert.ok(value.trim(), `${label} must not be empty`);
}

function assertStringArray(value, label) {
  assert.ok(Array.isArray(value), `${label} must be array`);
  assert.ok(value.length > 0, `${label} must not be empty`);
  for (const [index, item] of value.entries()) {
    assertString(item, `${label}[${index}]`);
  }
}

function validateConversationCaseShape(item, label) {
  if (Array.isArray(item.turns)) {
    assert.ok(item.turns.length > 1, `${label}.turns should contain at least 2 turns`);
    for (const [turnIndex, turn] of item.turns.entries()) {
      assertString(turn.user_input, `${label}.turns[${turnIndex}].user_input`);
      assertStringArray(turn.expected?.must_contain, `${label}.turns[${turnIndex}].expected.must_contain`);
      assertStringArray(turn.expected?.must_not_contain, `${label}.turns[${turnIndex}].expected.must_not_contain`);
    }
    assertStringArray(item.expected?.must_contain, `${label}.expected.must_contain`);
    assertStringArray(item.expected?.must_not_contain, `${label}.expected.must_not_contain`);
  } else {
    assertString(item.user_input, `${label}.user_input`);
    assertStringArray(item.expected?.must_contain, `${label}.expected.must_contain`);
    assertStringArray(item.expected?.must_not_contain, `${label}.expected.must_not_contain`);
  }
}

function validateConversationGolden() {
  const doc = readYaml("tests/golden/conversation/cases.yaml");
  assert.equal(doc.suite?.id, "invest-agent-conversation-golden", "conversation suite id mismatch");
  assert.ok(Number.isInteger(doc.suite?.version), "conversation suite version must be integer");
  assertString(doc.test_user?.userId, "test_user.userId");
  assertString(doc.test_user?.instanceId, "test_user.instanceId");
  assertString(doc.test_user?.conversationId, "test_user.conversationId");
  assertStringArray(doc.quality_gates?.global_must_not_contain, "quality_gates.global_must_not_contain");

  const cases = doc.cases;
  assert.ok(Array.isArray(cases), "conversation cases must be array");
  assert.ok(cases.length >= 8, "conversation golden set should keep at least 8 baseline cases");

  const ids = new Set();
  const p0Cases = [];
  const scenarios = new Set();
  const categories = new Map();
  const reviewTiers = new Map();
  let edgeCaseCount = 0;
  const allowedCategories = new Set(["core_golden", "principle_probe", "incident_regression", "safety_redline", "smoke"]);
  const allowedReviewTiers = new Set(["golden_core", "regression", "principle_probe", "smoke", "archived_candidate"]);
  for (const item of cases) {
    assertString(item.id, "case.id");
    assert.ok(!ids.has(item.id), `duplicate case id: ${item.id}`);
    ids.add(item.id);
    assertString(item.scenario, `${item.id}.scenario`);
    scenarios.add(item.scenario);
    assert.ok(allowedCategories.has(item.category), `${item.id}.category must be one of ${[...allowedCategories].join("/")}`);
    categories.set(item.category, (categories.get(item.category) ?? 0) + 1);
    assert.ok(allowedReviewTiers.has(item.review_tier), `${item.id}.review_tier must be one of ${[...allowedReviewTiers].join("/")}`);
    reviewTiers.set(item.review_tier, (reviewTiers.get(item.review_tier) ?? 0) + 1);
    assertStringArray(item.principles, `${item.id}.principles`);
    assert.ok(["P0", "P1", "P2"].includes(item.priority), `${item.id}.priority must be P0/P1/P2`);
    if (item.priority === "P0") p0Cases.push(item.id);
    validateConversationCaseShape(item, item.id);
    if (item.edge_cases !== undefined) {
      assert.ok(Array.isArray(item.edge_cases), `${item.id}.edge_cases must be array`);
      assert.ok(item.edge_cases.length > 0, `${item.id}.edge_cases must not be empty when present`);
      edgeCaseCount += item.edge_cases.length;
      for (const [edgeIndex, edge] of item.edge_cases.entries()) {
        assertString(edge.id, `${item.id}.edge_cases[${edgeIndex}].id`);
        assert.ok(!edge.id.includes(":"), `${item.id}.edge_cases[${edgeIndex}].id must not include ':'`);
        assertString(edge.description, `${item.id}.edge_cases[${edgeIndex}].description`);
        validateConversationCaseShape(edge, `${item.id}:${edge.id}`);
      }
    }
  }

  for (const required of [
    "out_of_scope_boundary",
    "portfolio_add_no_plan_hint",
    "alert_set_simple_price",
    "investment_style_set_confirm",
    "methodology_set_confirm",
    "trading_strategy_set_confirm",
    "daily_review_request",
    "weekly_review_request",
    "monthly_review_request",
    "stock_screening_qa",
    "strategy_plan_drafting_gate_one",
  ]) {
    assert.ok(scenarios.has(required), `missing required scenario: ${required}`);
  }

  return {
    ok: true,
    cases: cases.length,
    edgeCases: edgeCaseCount,
    expandedCases: cases.length + edgeCaseCount,
    categories: Object.fromEntries([...categories.entries()].sort()),
    reviewTiers: Object.fromEntries([...reviewTiers.entries()].sort()),
    p0Cases,
    scenarios: [...scenarios].sort(),
  };
}

function validateStrategyRecommendationGolden() {
  const fixtures = readYaml("tests/eval/strategy-recommendation/fixtures.yaml");
  const expected = readYaml("tests/eval/strategy-recommendation/expected.yaml");

  assert.ok(Array.isArray(fixtures.strategies), "strategy fixtures must include strategies");
  assert.ok(Array.isArray(fixtures.stocks), "strategy fixtures must include stocks");
  assert.ok(Array.isArray(expected.expectations), "strategy expected must include expectations");

  const strategyKeys = new Set(fixtures.strategies.map((item) => item.key));
  const stockCodes = new Set(fixtures.stocks.map((item) => item.code));
  assert.ok(strategyKeys.size >= 3, "strategy fixture should include at least 3 strategies");
  assert.ok(stockCodes.size >= 5, "strategy fixture should include at least 5 stocks");
  assert.ok(expected.threshold_top1_hit_rate >= 0 && expected.threshold_top1_hit_rate <= 1, "top1 threshold must be 0..1");
  assert.ok(expected.threshold_top3_hit_rate >= 0 && expected.threshold_top3_hit_rate <= 1, "top3 threshold must be 0..1");

  for (const row of expected.expectations) {
    assert.ok(stockCodes.has(row.code), `expected stock missing from fixtures: ${row.code}`);
    assert.ok(strategyKeys.has(row.top_1), `expected top_1 unknown strategy: ${row.top_1}`);
    assertStringArray(row.top_3, `${row.code}.top_3`);
    for (const key of row.top_3) {
      assert.ok(strategyKeys.has(key), `${row.code}.top_3 unknown strategy: ${key}`);
    }
    assert.ok(row.top_3.includes(row.top_1), `${row.code}.top_3 must include top_1`);
    assertStringArray(row.rationale_keywords, `${row.code}.rationale_keywords`);
  }

  return {
    ok: true,
    strategies: strategyKeys.size,
    stocks: stockCodes.size,
    expectations: expected.expectations.length,
    thresholds: {
      top1: expected.threshold_top1_hit_rate,
      top3: expected.threshold_top3_hit_rate,
    },
  };
}

const result = {
  ok: true,
  conversation: validateConversationGolden(),
  strategyRecommendation: validateStrategyRecommendationGolden(),
};

console.log(JSON.stringify(result, null, 2));
