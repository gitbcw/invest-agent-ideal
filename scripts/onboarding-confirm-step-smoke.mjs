#!/usr/bin/env node
import assert from "node:assert/strict";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { registerSandboxRoutes } from "../dist/routes/sandbox.js";
import { createSandboxToken } from "../dist/lib/sandbox-context.js";
import { ensureWorkspace, resolveWorkspacePath } from "../dist/lib/workspace.js";
import { db } from "../dist/db/index.js";
import { alertRules } from "../dist/db/schema.js";
import { WorkspaceStore } from "../dist/lib/workspace-store.js";

const USER_ID = "onboarding-confirm-step-smoke";
const INSTANCE_ID = "invest-agent-onboarding-confirm-step-smoke";
const EXPECTED_WINDOWS = ["09:30", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00"];

await ensureWorkspace({ userId: USER_ID, tenantId: USER_ID, projectId: "invest-agent" });
const store = new WorkspaceStore(USER_ID);
await store.writeOnboardingState({
  version: 1,
  status: "in_progress",
  current_step: "watch_rules",
  steps: {
    welcome: { done: true, completed_at: "2026-01-01T00:00:00.000Z" },
    portfolio: { done: true, completed_at: "2026-01-01T00:00:00.000Z" },
    style: { done: true, completed_at: "2026-01-01T00:00:00.000Z" },
    review_schedule: { done: true, completed_at: "2026-01-01T00:00:00.000Z" },
    notification: { done: true, completed_at: "2026-01-01T00:00:00.000Z" },
    watch_rules: { done: false, completed_at: null },
  },
  completed_at: null,
  updated_at: "2026-01-01T00:00:00.000Z",
  notes: "",
});
await store.writeNotification({
  user_mode: "working_professional",
  intraday_push: {
    enabled: true,
    trading_days_only: true,
    times: EXPECTED_WINDOWS,
    format: "简报",
  },
});
await store.writeSchedules({
  timezone: "Asia/Shanghai",
  market_watch: {
    enabled: true,
    default_windows: EXPECTED_WINDOWS,
    custom_frequency: null,
    only_push_on_exception: false,
  },
});
await store.writeWatch({
  mode: "default",
  only_push_on_exception: true,
  priority_policy: "P0 立即推送；P1 晚间汇总；P2 仅记录。详见 config/notification.yaml。",
  default_check_windows: [
    { name: "开盘后", time: "09:55", purpose: "检查核心持仓、观察仓和市场风格是否出现开盘异常。" },
    { name: "午盘前", time: "11:20", purpose: "检查风格切换、板块异动和持仓是否偏离日复盘判断。" },
    { name: "收盘前", time: "14:30", purpose: "检查是否触发买入区、减仓区或风险阈值。" },
  ],
  custom_rules: [],
});
await db.delete(alertRules).where(eq(alertRules.userId, USER_ID));

const app = Fastify({ logger: false });
registerSandboxRoutes(app);
await app.ready();

const token = createSandboxToken({
  userId: USER_ID,
  projectId: "invest-agent",
  instanceId: INSTANCE_ID,
  role: "user",
  channel: "weixin-mobile",
  backend: "codex",
  permissions: ["read:self", "write:self", "review:self", "alert:self", "push:self"],
});

try {
  const response = await app.inject({
    method: "POST",
    url: "/api/sandbox/onboarding/confirm-step",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      step: "watch_rules",
      summary: "确认默认盯盘策略",
    },
  });

  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.didCreateWatchRules, false);
  assert.equal(body.state.status, "completed");
  assert.equal(body.state.steps.watch_rules.done, true);

  const rules = await db.select().from(alertRules).where(eq(alertRules.userId, USER_ID));
  assert.equal(rules.length, 0, "confirm-step must not create watch rules");

  const state = await store.readOnboardingState();
  const watch = await store.readWatch();
  assert.equal(state.status, "completed");
  assert(Array.isArray(watch?.confirmed_watch_rule_summary), "watch summary written");
  assert.deepEqual(
    watch?.default_check_windows?.map((window) => window.time),
    EXPECTED_WINDOWS,
    "confirm-step must sync watch.yaml windows from confirmed intraday push settings"
  );

  console.log(JSON.stringify({
    ok: true,
    workspace: resolveWorkspacePath(USER_ID),
    status: state.status,
    didCreateWatchRules: body.didCreateWatchRules,
    alertRuleCount: rules.length,
    watchWindows: watch?.default_check_windows?.map((window) => window.time),
  }, null, 2));
} finally {
  await app.close();
  await db.delete(alertRules).where(eq(alertRules.userId, USER_ID));
}
