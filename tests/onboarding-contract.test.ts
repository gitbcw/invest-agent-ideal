import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspaceStore, OnboardingStateYaml } from "../src/lib/workspace-store.js";
import { applyConfirmedOnboardingStep, OnboardingContractError } from "../src/services/onboarding.js";

class MemoryOnboardingStore {
  state: OnboardingStateYaml;
  strategy: Record<string, any> = {};
  schedules: Record<string, any> = {};
  notification: Record<string, any> = {};
  watch: Record<string, any> = {};

  constructor(state: OnboardingStateYaml) {
    this.state = state;
  }

  async readOnboardingState() { return this.state; }
  async writeOnboardingState(value: OnboardingStateYaml) { this.state = value; }
  async readStrategy() { return this.strategy; }
  async writeStrategy(value: Record<string, any>) { this.strategy = value; }
  async readSchedules() { return this.schedules; }
  async writeSchedules(value: Record<string, any>) { this.schedules = value; }
  async readNotification() { return this.notification; }
  async writeNotification(value: Record<string, any>) { this.notification = value; }
  async readWatch() { return this.watch; }
  async writeWatch(value: Record<string, any>) { this.watch = value; }
}

function stateThrough(step: "portfolio" | "market_watch_schedule"): OnboardingStateYaml {
  const completed = step === "portfolio"
    ? ["welcome", "portfolio"]
    : ["welcome", "portfolio", "style", "review_schedule", "market_watch_schedule"];
  const steps = Object.fromEntries(
    ["welcome", "portfolio", "style", "review_schedule", "market_watch_schedule", "notification", "watch_rules"]
      .map((key) => [key, { done: completed.includes(key), completed_at: completed.includes(key) ? "2026-01-01T00:00:00.000Z" : null }])
  );
  return { version: 1, status: "in_progress", current_step: step === "portfolio" ? "style" : "notification", steps } as OnboardingStateYaml;
}

test("shared onboarding contract persists style before advancing", async () => {
  const memory = new MemoryOnboardingStore(stateThrough("portfolio"));
  const state = await applyConfirmedOnboardingStep({
    store: memory as unknown as WorkspaceStore,
    step: "style",
    body: { styleProfile: { style: "趋势辅助型", notes: "基本面为主，技术面辅助。" } },
  });

  assert.equal(memory.strategy.profile.style, "趋势辅助型");
  assert.ok(memory.strategy.last_confirmed_at);
  assert.equal(state.current_step, "review_schedule");
});
test("shared onboarding contract aligns active notification with market-watch scheduling", async () => {
  const memory = new MemoryOnboardingStore(stateThrough("market_watch_schedule"));
  memory.schedules = { market_watch: { default_windows: ["09:55", "11:20", "14:30"], only_push_on_exception: true, push_mode: "exception_only" } };

  const state = await applyConfirmedOnboardingStep({
    store: memory as unknown as WorkspaceStore,
    step: "notification",
    body: { notificationPreference: { mode: "active_watch" } },
  });

  assert.equal(memory.notification.preference.mode, "active_watch");
  assert.equal(memory.schedules.market_watch.only_push_on_exception, false);
  assert.equal(memory.schedules.market_watch.push_mode, "scheduled_intraday_brief");
  assert.equal(state.current_step, "watch_rules");
});

test("shared onboarding contract rejects skipped required steps", async () => {
  const memory = new MemoryOnboardingStore(stateThrough("portfolio"));

  await assert.rejects(
    () => applyConfirmedOnboardingStep({ store: memory as unknown as WorkspaceStore, step: "watch_rules" }),
    (error) => error instanceof OnboardingContractError && error.status === 409 && /style/.test(error.message),
  );
  assert.equal(memory.state.status, "in_progress");
  assert.notEqual(memory.state.current_step, "completed");
});
