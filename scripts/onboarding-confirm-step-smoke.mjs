#!/usr/bin/env node
import assert from "node:assert/strict";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { registerSandboxRoutes } from "../dist/routes/sandbox.js";
import { createSandboxToken } from "../dist/lib/sandbox-context.js";
import { ensureWorkspace, resolveWorkspacePath } from "../dist/lib/workspace.js";
import { db, initDb } from "../dist/db/index.js";
import { alertRules, conversationMessages, conversationSessions } from "../dist/db/schema.js";
import { WorkspaceStore } from "../dist/lib/workspace-store.js";
import { callServiceTool } from "../dist/mcp/service-tools-core.js";

const USER_ID = "onboarding-confirm-step-smoke";
const INSTANCE_ID = "invest-agent-onboarding-confirm-step-smoke";
const CONVERSATION_ID = "onboarding-confirm-step-smoke-conversation";
const EXPECTED_WINDOWS = ["09:30", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00"];

initDb();
await ensureWorkspace({ userId: USER_ID, tenantId: USER_ID, projectId: "invest-agent" });
const store = new WorkspaceStore(USER_ID);
await store.writeOnboardingState({
  version: 1,
  status: "in_progress",
  current_step: "review_schedule",
  steps: {
    welcome: { done: true, completed_at: "2026-01-01T00:00:00.000Z" },
    portfolio: { done: true, completed_at: "2026-01-01T00:00:00.000Z" },
    style: { done: true, completed_at: "2026-01-01T00:00:00.000Z" },
    review_schedule: { done: false, completed_at: null },
    market_watch_schedule: { done: false, completed_at: null },
    notification: { done: false, completed_at: null },
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
  do_not_disturb: {
    enabled: true,
    allow_p0_override: true,
  },
});
await store.writeSchedules({
  timezone: "Asia/Shanghai",
  market_watch: {
    enabled: true,
    default_windows: ["09:55", "11:20", "14:30"],
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
await db.delete(conversationMessages).where(eq(conversationMessages.userId, USER_ID));
await db.delete(conversationSessions).where(eq(conversationSessions.userId, USER_ID));

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
  const invalidPortfolioResponse = await app.inject({
    method: "POST",
    url: "/api/sandbox/onboarding/confirm-portfolio",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      holdings: [{ name: "招商银行" }],
      watchlist: [{ name: "科创50ETF", code: "588000" }],
      summary: "缺少持仓代码的草案",
    },
  });

  assert.equal(invalidPortfolioResponse.statusCode, 400, invalidPortfolioResponse.body);
  const invalidPortfolioBody = invalidPortfolioResponse.json();
  assert.equal(invalidPortfolioBody.ok, false);
  assert.equal(invalidPortfolioBody.missingCodes[0].name, "招商银行");

  const portfolioResponse = await app.inject({
    method: "POST",
    url: "/api/sandbox/onboarding/confirm-portfolio",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      holdings: [{ name: "招商银行", code: "600036" }],
      watchlist: [{ name: "科创50ETF", code: "588000" }],
      summary: "用户确认持仓和观察仓草案",
    },
  });

  assert.equal(portfolioResponse.statusCode, 200, portfolioResponse.body);
  const portfolioBody = portfolioResponse.json();
  assert.equal(portfolioBody.ok, true);
  assert.equal(portfolioBody.holdings[0].code, "600036");
  assert.equal(portfolioBody.watchlist[0].code, "588000");

  await store.writeOnboardingState({
    version: 1,
    status: "in_progress",
    current_step: "review_schedule",
    steps: {
      welcome: { done: true, completed_at: "2026-01-01T00:00:00.000Z" },
      portfolio: { done: true, completed_at: "2026-01-01T00:00:00.000Z" },
      style: { done: true, completed_at: "2026-01-01T00:00:00.000Z" },
      review_schedule: { done: false, completed_at: null },
      market_watch_schedule: { done: false, completed_at: null },
      notification: { done: false, completed_at: null },
      watch_rules: { done: false, completed_at: null },
    },
    completed_at: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    notes: "",
  });

  const reviewResponse = await app.inject({
    method: "POST",
    url: "/api/sandbox/onboarding/confirm-step",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      step: "review_schedule",
      summary: "用户确认自定义复盘时间",
      daily_review_time: "18:30",
      weekly_review_time: "Saturday 10:00",
      monthly_review_time: "day_1 10:30",
    },
  });

  assert.equal(reviewResponse.statusCode, 200, reviewResponse.body);
  const reviewBody = reviewResponse.json();
  assert.equal(reviewBody.ok, true);
  assert.equal(reviewBody.state.current_step, "market_watch_schedule");
  assert.equal(reviewBody.state.steps.review_schedule.done, true);
  const reviewSchedules = await store.readSchedules();
  assert.equal(reviewSchedules?.daily_review?.default_time, "18:30");
  assert.equal(reviewSchedules?.weekly_review?.default_time, "Saturday 10:00");
  assert.equal(reviewSchedules?.monthly_review?.default_time, "day_1 10:30");

  await store.writeOnboardingState({
    version: 1,
    status: "in_progress",
    current_step: "style",
    steps: {
      welcome: { done: true, completed_at: "2026-01-01T00:00:00.000Z" },
      portfolio: { done: true, completed_at: "2026-01-01T00:00:00.000Z" },
      style: { done: false, completed_at: null },
      review_schedule: { done: false, completed_at: null },
      market_watch_schedule: { done: false, completed_at: null },
      notification: { done: false, completed_at: null },
      watch_rules: { done: false, completed_at: null },
    },
    completed_at: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    notes: "",
  });

  const prematureCompleteResponse = await app.inject({
    method: "POST",
    url: "/api/sandbox/onboarding/confirm-step",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      step: "style",
      summary: "用户确认风格，但模型误传 complete=true",
      complete: true,
    },
  });

  assert.equal(prematureCompleteResponse.statusCode, 200, prematureCompleteResponse.body);
  const prematureCompleteBody = prematureCompleteResponse.json();
  assert.equal(prematureCompleteBody.state.status, "in_progress", "complete=true must not complete onboarding before watch_rules");
  assert.equal(prematureCompleteBody.state.current_step, "review_schedule", "style confirmation should advance to review_schedule");

  await store.writeOnboardingState({
    version: 1,
    status: "in_progress",
    current_step: "style",
    steps: {
      welcome: { done: true, completed_at: "2026-01-01T00:00:00.000Z" },
      portfolio: { done: true, completed_at: "2026-01-01T00:00:00.000Z" },
      style: { done: false, completed_at: null },
      review_schedule: { done: false, completed_at: null },
      market_watch_schedule: { done: false, completed_at: null },
      notification: { done: false, completed_at: null },
      watch_rules: { done: false, completed_at: null },
    },
    completed_at: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    notes: "",
  });

  const now = new Date().toISOString();
  await db.insert(conversationSessions).values({
    userId: USER_ID,
    projectId: "invest-agent",
    instanceId: INSTANCE_ID,
    conversationId: CONVERSATION_ID,
    channel: "weixin-mobile",
    title: "onboarding confirm smoke",
    status: "active",
    lastMessageAt: now,
    messageCount: 1,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(conversationMessages).values({
    userId: USER_ID,
    projectId: "invest-agent",
    instanceId: INSTANCE_ID,
    conversationId: CONVERSATION_ID,
    channel: "weixin-mobile",
    role: "user",
    content: "我先选趋势辅助型",
    createdAt: now,
    updatedAt: now,
  });

  const guardedContext = {
    userId: USER_ID,
    instanceId: INSTANCE_ID,
    workspacePath: resolveWorkspacePath(USER_ID),
    conversationId: CONVERSATION_ID,
  };
  const guardedPayload = {
    step: "style",
    summary: "模型误把选择风格当成确认",
  };
  const guardedConfirmation = await callServiceTool(
    "confirmations.request",
    { operation: "onboarding.confirm_step", payload: guardedPayload },
    guardedContext
  );
  await assert.rejects(
    () => callServiceTool(
      "onboarding.confirm_step",
      {
        confirmedByUser: true,
        confirmationId: guardedConfirmation.confirmationId,
        ...guardedPayload,
      },
      guardedContext
    ),
    /predates the draft/,
    "MCP confirm_step must reject a selection message that predates the registered draft"
  );
  const guardedState = await store.readOnboardingState();
  assert.equal(guardedState.steps.style.done, false, "rejected MCP confirmation must not write style");

  await store.writeOnboardingState({
    version: 1,
    status: "in_progress",
    current_step: "review_schedule",
    steps: {
      welcome: { done: true, completed_at: "2026-01-01T00:00:00.000Z" },
      portfolio: { done: true, completed_at: "2026-01-01T00:00:00.000Z" },
      style: { done: true, completed_at: "2026-01-01T00:00:00.000Z" },
      review_schedule: { done: false, completed_at: null },
      market_watch_schedule: { done: false, completed_at: null },
      notification: { done: false, completed_at: null },
      watch_rules: { done: false, completed_at: null },
    },
    completed_at: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    notes: "",
  });

  const invalidScheduleResponse = await app.inject({
    method: "POST",
    url: "/api/sandbox/onboarding/confirm-step",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      step: "market_watch_schedule",
      summary: "错误格式盯盘时间",
      market_watch_windows: ["09:30_10:30"],
      push_mode: "every_check_brief",
    },
  });

  assert.equal(invalidScheduleResponse.statusCode, 400, invalidScheduleResponse.body);
  const invalidState = await store.readOnboardingState();
  const invalidSchedules = await store.readSchedules();
  assert.equal(invalidState.steps.market_watch_schedule.done, false, "invalid schedule request must not advance onboarding");
  assert.deepEqual(
    invalidSchedules?.market_watch?.default_windows,
    ["09:55", "11:20", "14:30"],
    "invalid schedule request must not rewrite schedules.yaml"
  );

  const scheduleResponse = await app.inject({
    method: "POST",
    url: "/api/sandbox/onboarding/confirm-step",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      step: "market_watch_schedule",
      summary: "用户确认高频盯盘并每次主动推送简报",
      market_watch_windows: EXPECTED_WINDOWS,
      push_mode: "every_check_brief",
    },
  });

  assert.equal(scheduleResponse.statusCode, 200, scheduleResponse.body);
  const scheduleBody = scheduleResponse.json();
  assert.equal(scheduleBody.ok, true);
  assert.equal(scheduleBody.state.status, "in_progress");
  assert.equal(scheduleBody.state.current_step, "notification");
  assert.equal(scheduleBody.state.steps.market_watch_schedule.done, true);

  const notificationResponse = await app.inject({
    method: "POST",
    url: "/api/sandbox/onboarding/confirm-step",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      step: "notification",
      summary: "确认通知策略，使用历史 notification 字段结构",
      notification: {
        mode: "active_watch",
        summary: "积极盯盘：按固定时间推送盘面简报，重大风险单独提醒。",
      },
    },
  });

  assert.equal(notificationResponse.statusCode, 200, notificationResponse.body);
  const notificationBody = notificationResponse.json();
  assert.equal(notificationBody.ok, true);
  assert.equal(notificationBody.state.status, "in_progress");
  assert.equal(notificationBody.state.current_step, "watch_rules");
  assert.equal(notificationBody.state.steps.notification.done, true);

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
  assert.equal(body.state.steps.market_watch_schedule.done, true);
  assert.equal(body.state.steps.watch_rules.done, true);

  const rules = await db.select().from(alertRules).where(eq(alertRules.userId, USER_ID));
  assert.equal(rules.length, 0, "confirm-step must not create watch rules");

  const state = await store.readOnboardingState();
  const watch = await store.readWatch();
  const schedules = await store.readSchedules();
  const notification = await store.readNotification();
  assert.equal(state.status, "completed");
  assert(Array.isArray(watch?.confirmed_watch_rule_summary), "watch summary written");
  assert.equal(notification?.preference?.mode, "active_watch");
  assert.equal(notification?.do_not_disturb?.enabled, false, "active watch should disable do-not-disturb mode");
  assert.deepEqual(
    schedules?.market_watch?.default_windows,
    EXPECTED_WINDOWS,
    "market-watch schedule windows must live in schedules.yaml"
  );
  assert.equal(schedules?.market_watch?.only_push_on_exception, false);
  assert.equal(schedules?.market_watch?.push_mode, "scheduled_intraday_brief");
  assert.equal(watch?.only_push_on_exception, false);
  assert.deepEqual(
    watch?.default_check_windows?.map((window) => window.time),
    ["09:55", "11:20", "14:30"],
    "confirm-step must not rewrite watch.yaml scheduling windows"
  );

  console.log(JSON.stringify({
    ok: true,
    workspace: resolveWorkspacePath(USER_ID),
    status: state.status,
    didCreateWatchRules: body.didCreateWatchRules,
    alertRuleCount: rules.length,
    portfolioCode: portfolioBody.holdings[0].code,
    scheduleWindows: schedules?.market_watch?.default_windows,
    notificationPreference: notification?.preference?.mode,
    pushMode: schedules?.market_watch?.push_mode,
    watchWindows: watch?.default_check_windows?.map((window) => window.time),
  }, null, 2));
} finally {
  await app.close();
  await db.delete(alertRules).where(eq(alertRules.userId, USER_ID));
}
