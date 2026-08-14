import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("Mastra onboarding draft commit updates all imported projections without Workspace", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-mastra-onboarding-"));
  process.env.NODE_ENV = "test";
  process.env.DB_PATH = path.join(root, "target.db");
  process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
  process.env.MASTRA_PROJECT_ID = "invest-agent";
  try {
    const { initDb, sqlite } = await import("../src/db/index.js");
    const { applyMastraOnboardingDraftCommit } = await import("../src/services/onboarding.js");
    initDb();
    const now = "2026-08-13T08:00:00.000Z";
    sqlite.prepare("INSERT INTO mastra_portfolio_states (user_id,project_id,instance_id,portfolio_json,source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("alice", "invest-agent", "instance-a", JSON.stringify({ holdings: [], watchlist: [], accounts: [] }), "test", "test", null, "test", now, now);
    sqlite.prepare("INSERT INTO mastra_project_profiles (user_id,project_id,instance_id,profile_json,source_path,source_checksum,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("alice", "invest-agent", "instance-a", JSON.stringify({}), "test", "test", null, "test", now, now);
    sqlite.prepare("INSERT INTO mastra_runtime_preferences (user_id,project_id,instance_id,preferences_json,source_checksums_json,source_revision,migration_batch_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("alice", "invest-agent", "instance-a", JSON.stringify({ schedules: {}, notification: {}, watch: {}, onboardingState: {} }), "{}", null, "test", now, now);
    const state = await applyMastraOnboardingDraftCommit({
      userId: "alice", instanceId: "instance-a", now: "2026-08-13T09:00:00.000Z",
      steps: {
        portfolio: { holdings: [{ name: "招商银行", code: "600036" }], watchlist: [{ name: "贵州茅台", code: "600519" }] },
        style: { styleProfile: { style: "价值投资", riskPreference: "稳健" } },
        review_schedule: { reviewSchedule: { daily_review: { default_time: "20:00" } } },
        market_watch_schedule: { marketWatchSchedule: { default_windows: ["10:00"] } },
        notification: { notificationPreference: "active_watch" },
        watch_rules: { skip: true },
      },
    });
    assert.equal(state.status, "completed");
    const portfolio = JSON.parse(sqlite.prepare("SELECT portfolio_json AS value FROM mastra_portfolio_states WHERE user_id='alice' AND instance_id='instance-a'").get().value);
    const strategy = JSON.parse(sqlite.prepare("SELECT profile_json AS value FROM mastra_project_profiles WHERE user_id='alice' AND instance_id='instance-a'").get().value);
    const preferences = JSON.parse(sqlite.prepare("SELECT preferences_json AS value FROM mastra_runtime_preferences WHERE user_id='alice' AND instance_id='instance-a'").get().value);
    assert.equal(portfolio.holdings[0].code, "600036");
    assert.equal(strategy.profile.style, "价值投资");
    assert.equal(preferences.notification.preference.mode, "active_watch");
    assert.equal(preferences.onboardingState.status, "completed");
    // Product decision (2026-08-14): finishing onboarding makes the scope schedulable.
    assert.equal(preferences.schedulerActivation, "enabled");
    const { insertValidatedWatchRule, validateWatchRule } = await import("../src/services/watch-rules.js");
    const ruleInput = { userId: "alice", instanceId: "instance-a", stockCode: "600036", stockName: "招商银行", ruleType: "price_cross" as const, targetScope: "holding" as const, params: { operator: ">=", value: 50 }, source: { kind: "onboarding_draft", onboarding_draft_commit_key: "draft:1", onboarding_draft_rule_index: 0 } };
    const validated = await validateWatchRule(ruleInput);
    assert.ok(validated.ok && validated.normalized);
    sqlite.transaction(() => insertValidatedWatchRule(ruleInput, validated.normalized!))();
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM alert_rules WHERE user_id='alice' AND instance_id='instance-a'").get().count, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
