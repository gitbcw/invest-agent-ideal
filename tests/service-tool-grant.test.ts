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

test("weekly/monthly grant = reads + reviews.save (F2 controlled save)", () => {
  for (const taskType of ["scheduled-weekly-review", "scheduled-monthly-review"]) {
    const grant = resolveScheduledServiceGrant(taskType);
    assert.ok(grant.includes("reviews.save"), `${taskType} should have reviews.save`);
    // 仍不含 other-write
    for (const tool of grant) {
      assert.notEqual(classifyServiceTool(tool), "other-write", `${taskType} grant has other-write: ${tool}`);
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

test("R2: isScheduledTaskType recognizes any scheduled- prefix (fail closed)", () => {
  assert.ok(isScheduledTaskType("scheduled-market-watch"));
  assert.ok(isScheduledTaskType("scheduled-daily-review"));
  assert.ok(isScheduledTaskType("scheduled-weekly-review"));
  assert.ok(isScheduledTaskType("scheduled-monthly-review"));
  // R2: 未知 scheduled 类型也匹配（前缀级），走只读兜底而非全开
  assert.ok(isScheduledTaskType("scheduled-unknown-future-task"));
  assert.ok(isScheduledTaskType("scheduled-anything"));
  assert.ok(!isScheduledTaskType("interactive"));
  assert.ok(!isScheduledTaskType(undefined));
  assert.ok(!isScheduledTaskType("evaluation"));
});

// R2: 测试必须调用 resolveSessionMcpServers（不能只测 helper）
import { resolveSessionMcpServers } from "../src/acp/mcp-session-manifest.js";

test("R2: unknown scheduled taskType in resolveSessionMcpServers gets reads-only allowlist", () => {
  const { servers } = resolveSessionMcpServers({
    backendId: "codex",
    cwd: "/tmp/ws",
    userContext: { userId: "r2-test", conversationId: "scheduler:future-task:r2-test:inst", taskType: "scheduled-future-task" },
    env: { INVEST_AGENT_PROJECT_ROOT: "/tmp/proj", DB_PATH: "a.db" },
    taskType: "scheduled-future-task",
    sessionId: "r2-test",
  });
  // service-tools server 应该有 INVEST_AGENT_MCP_ALLOWED_TOOLS 且不含写工具
  const serviceServer = servers.find((s) => s.name === "invest-agent-service-tools");
  assert.ok(serviceServer, "service-tools assembled");
  const env = Object.fromEntries(serviceServer!.env.map((e) => [e.name, e.value]));
  const allowed = (env.INVEST_AGENT_MCP_ALLOWED_TOOLS || "").split(",").filter(Boolean);
  // 未知 scheduled 类型：只有 read 工具，无 reviews.save，无 other-write
  assert.ok(allowed.length > 0, "has explicit allowlist (not empty/full-open)");
  assert.ok(!allowed.includes("reviews.save"), "no final-action for unknown task");
  for (const tool of allowed) {
    assert.notEqual(classifyServiceTool(tool), "other-write", `unknown scheduled grant has other-write: ${tool}`);
  }
});

test("R2: interactive session without taskType still gets full tools (no regression)", () => {
  const { servers } = resolveSessionMcpServers({
    backendId: "codex",
    cwd: "/tmp/ws",
    userContext: { userId: "r2-test", conversationId: "interactive-conv" },
    env: { INVEST_AGENT_PROJECT_ROOT: "/tmp/proj", DB_PATH: "a.db" },
    taskType: "interactive",
    sessionId: "r2-interactive",
  });
  const serviceServer = servers.find((s) => s.name === "invest-agent-service-tools");
  assert.ok(serviceServer);
  const env = Object.fromEntries(serviceServer!.env.map((e) => [e.name, e.value]));
  // interactive: 无 allowlist = 全开（行为不变）
  assert.ok(!("INVEST_AGENT_MCP_ALLOWED_TOOLS" in env), "interactive has no allowlist (full open)");
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
