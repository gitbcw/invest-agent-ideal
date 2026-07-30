import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVICE_TOOL_CLASSIFICATION,
  classifyServiceTool,
  READ_TOOLS,
  OTHER_WRITE_TOOLS,
  FINAL_ACTION_TOOLS,
  resolveScheduledServiceGrant,
  isScheduledTaskType,
} from "../src/mcp/service-tool-classification.js";

// 实际注册的 43 个工具名（从 invest-agent-service-tools.ts registerJsonTool 提取）
const REGISTERED_TOOLS = [
  "market.snapshot", "market_watch.snapshot", "market.quote", "market.kline",
  "market.fundamentals", "market.indices", "market.capital_flow", "market.sector_theme",
  "market.calendar", "market.health", "market.stock_info", "market.resolve",
  "research.news_search", "research.web_search", "research.web_read",
  "portfolio.read", "watchlist.read", "plans.read", "conversation.history",
  "confirmations.pending", "watch_rules.catalog", "watch_rules.list",
  "watch_rules.validate", "watch_rules.dry_run",
  "reviews.save",
  "portfolio.apply_changes", "watchlist.add", "plans.set", "plans.watch_conditions",
  "method_changes.propose", "watch_rules.create",
  "confirmations.request", "artifacts.publish",
  "onboarding.confirm_portfolio", "onboarding.confirm_step", "onboarding.complete_watch_setup",
  "onboarding.draft.get", "onboarding.draft.upsert_step", "onboarding.draft.request_confirmation",
  "onboarding.draft.accept_step", "onboarding.draft.skip_watch_rules",
  "onboarding.draft.enqueue_commit", "onboarding.draft.commit_status",
];

// ─── 分类表完整性 ──────────────────────────────────────────────

test("classification table covers all 43 registered tools", () => {
  for (const tool of REGISTERED_TOOLS) {
    assert.ok(
      tool in SERVICE_TOOL_CLASSIFICATION,
      `${tool} missing from classification table`,
    );
  }
  assert.equal(Object.keys(SERVICE_TOOL_CLASSIFICATION).length, REGISTERED_TOOLS.length,
    "no extra entries in classification table");
});

test("read + final-action + other-write partition equals all tools", () => {
  const all = [...READ_TOOLS, ...FINAL_ACTION_TOOLS, ...OTHER_WRITE_TOOLS].sort();
  assert.equal(all.length, REGISTERED_TOOLS.length);
});

test("classifyServiceTool defaults unknown tools to other-write", () => {
  assert.equal(classifyServiceTool("nonexistent.tool"), "other-write");
});

// ─── grant 计算 ────────────────────────────────────────────────

test("market-watch grant = reads only, no write tools", () => {
  const grant = resolveScheduledServiceGrant("scheduled-market-watch");
  for (const tool of grant) {
    assert.equal(classifyServiceTool(tool), "read", `market-watch grant contains non-read tool: ${tool}`);
  }
  // 不含 reviews.save 或任何 other-write
  assert.ok(!grant.includes("reviews.save"));
  assert.ok(!grant.includes("portfolio.apply_changes"));
  assert.ok(!grant.includes("watch_rules.create"));
});

test("daily-review grant = reads + reviews.save", () => {
  const grant = resolveScheduledServiceGrant("scheduled-daily-review");
  assert.ok(grant.includes("reviews.save"));
  assert.ok(grant.includes("market.quote"));
  assert.ok(grant.includes("portfolio.read"));
  // 不含 other-write
  for (const tool of grant) {
    assert.notEqual(classifyServiceTool(tool), "other-write",
      `daily grant contains other-write tool: ${tool}`);
  }
});

test("weekly/monthly grant = reads only (F1; F2 will add final-action)", () => {
  for (const taskType of ["scheduled-weekly-review", "scheduled-monthly-review"]) {
    const grant = resolveScheduledServiceGrant(taskType);
    assert.ok(!grant.includes("reviews.save"), `${taskType} should not have reviews.save yet`);
    for (const tool of grant) {
      assert.equal(classifyServiceTool(tool), "read", `${taskType} grant has non-read: ${tool}`);
    }
  }
});

test("different final-actions produce different grants (session isolation)", () => {
  const marketWatch = resolveScheduledServiceGrant("scheduled-market-watch");
  const daily = resolveScheduledServiceGrant("scheduled-daily-review");
  // daily 多了 reviews.save
  assert.ok(daily.length > marketWatch.length);
  assert.deepEqual(
    daily.filter((t) => !marketWatch.includes(t)),
    ["reviews.save"],
  );
});

test("unknown scheduled taskType gets conservative reads-only grant", () => {
  const grant = resolveScheduledServiceGrant("scheduled-unknown-task");
  for (const tool of grant) {
    assert.equal(classifyServiceTool(tool), "read");
  }
  assert.ok(!grant.includes("reviews.save"));
});

test("isScheduledTaskType recognizes known task types", () => {
  assert.ok(isScheduledTaskType("scheduled-market-watch"));
  assert.ok(isScheduledTaskType("scheduled-daily-review"));
  assert.ok(isScheduledTaskType("scheduled-weekly-review"));
  assert.ok(isScheduledTaskType("scheduled-monthly-review"));
  assert.ok(!isScheduledTaskType("interactive"));
  assert.ok(!isScheduledTaskType(undefined));
  assert.ok(!isScheduledTaskType("scheduled-unknown"));
});

// ─── 无关写工具不出现在任何 scheduled grant ────────────────────

test("no scheduled grant exposes portfolio/watchlist/plan/onboarding mutations", () => {
  const dangerousTools = OTHER_WRITE_TOOLS;
  for (const taskType of [
    "scheduled-market-watch", "scheduled-daily-review",
    "scheduled-weekly-review", "scheduled-monthly-review",
  ]) {
    const grant = resolveScheduledServiceGrant(taskType);
    for (const danger of dangerousTools) {
      assert.ok(!grant.includes(danger),
        `${taskType} grant exposes dangerous tool: ${danger}`);
    }
  }
});
