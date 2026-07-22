#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "invest-agent-investment-state-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(tempRoot, "test.db");
process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");
process.env.INVEST_AGENT_API_TOKEN = "investment-state-smoke-service-token-32-chars";

let app;
let sqlite;

function captureWorkspaceCreatedLogs() {
  const created = [];
  const original = console.log;
  const originalInfo = console.info;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const intercept = (chunk) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString();
    if (text.includes("workspace.created")) created.push(text.trim());
    return true;
  };
  process.stdout.write = intercept;
  return { created, restore: () => { process.stdout.write = originalStdoutWrite; } };
}

try {
  const dbModule = await import("../dist/db/index.js");
  sqlite = dbModule.sqlite;
  const { createServer } = await import("../dist/server.js");
  const { serviceApiToken } = await import("../dist/lib/service-auth.js");

  dbModule.initDb();
  app = await createServer();

  const auth = { authorization: `Bearer ${serviceApiToken}` };

  const missing = await app.inject({
    method: "GET",
    url: "/api/platform/instances/investment-state-smoke-missing/investment-state",
    headers: auth,
  });
  assert.equal(missing.statusCode, 404);

  const denied = await app.inject({
    method: "GET",
    url: "/api/platform/instances/investment-state-smoke-missing/investment-state",
  });
  assert.equal(denied.statusCode, 401);

  const { createInvestAgentInstance } = await import("../dist/platform/project-registry.js");
  const { dailyPlanBackend } = await import("../dist/lib/daily-plan-backend.js");

  const noWorkspace = await createInvestAgentInstance({
    userId: "investment-state-no-ws",
    displayName: "无 workspace smoke",
    instanceName: "investment-state-no-ws",
  });

  const tempWorkspaceRoot = process.env.WORKSPACE_ROOT;
  await rm(path.join(tempWorkspaceRoot, "investment-state-no-ws"), { recursive: true, force: true });

  const logInterceptor = captureWorkspaceCreatedLogs();
  const noWsResponse = await app.inject({
    method: "GET",
    url: `/api/platform/instances/${noWorkspace.instanceId}/investment-state`,
    headers: auth,
  });
  logInterceptor.restore();
  assert.equal(noWsResponse.statusCode, 200);
  const noWsBody = JSON.parse(noWsResponse.body);
  assert.equal(noWsBody.ok, true);
  assert.equal(noWsBody.workspaceReady, false);
  assert.equal(noWsBody.summary.holdingCount, 0);
  assert.equal(noWsBody.summary.watchlistCount, 0);
  assert.equal(noWsBody.summary.planCount, 0);
  assert.equal(noWsBody.summary.latestReviewDate, null);
  assert.equal(noWsBody.summary.openViewpointCount, 0);
  assert.deepEqual(noWsBody.holdings, []);
  assert.deepEqual(noWsBody.watchlist, []);
  assert.deepEqual(noWsBody.plans, []);
  assert.deepEqual(noWsBody.recentReviews, []);
  assert.deepEqual(noWsBody.viewpoints, []);
  assert.equal(logInterceptor.created.length, 0, "GET investment-state must not trigger workspace.created");

  const withWorkspace = await createInvestAgentInstance({
    userId: "investment-state-with-ws",
    displayName: "有 workspace smoke",
    instanceName: "investment-state-with-ws",
  });

  const today = new Date().toISOString().slice(0, 10);
  await dailyPlanBackend.upsert(withWorkspace.ownerUserId, withWorkspace.instanceId, {
    planDate: today,
    generatedAt: new Date().toISOString(),
    summary: "smoke 复盘摘要",
    content: "# smoke 复盘内容\n",
    data: { source: "smoke" },
  });

  const okResponse = await app.inject({
    method: "GET",
    url: `/api/platform/instances/${withWorkspace.instanceId}/investment-state`,
    headers: auth,
  });
  assert.equal(okResponse.statusCode, 200);
  const body = JSON.parse(okResponse.body);
  assert.equal(body.ok, true);
  assert.equal(body.workspaceReady, true);
  assert.equal(body.summary.latestReviewDate, today);
  assert.ok(Array.isArray(body.recentReviews));
  assert.ok(body.recentReviews.length >= 1, "should have at least one review artifact");
  const todayReview = body.recentReviews.find((r) => r.date === today);
  assert.ok(todayReview, "today's review artifact should be present");
  assert.equal(todayReview.summary, "smoke 复盘摘要");
  assert.ok(Array.isArray(body.viewpoints), "viewpoints should be an array separate from reviews");
  assert.equal(typeof body.summary.holdingCount, "number");
  assert.equal(typeof body.summary.watchlistCount, "number");
  assert.equal(typeof body.summary.planCount, "number");
  assert.equal(typeof body.summary.activeWatchRuleCount, "number");
  assert.equal(typeof body.summary.totalWatchRuleCount, "number");
  assert.equal(typeof body.summary.openViewpointCount, "number");
  assert.ok(Array.isArray(body.holdings));
  assert.ok(Array.isArray(body.watchlist));
  assert.ok(Array.isArray(body.plans));
  assert.equal(body.instance.instanceId, withWorkspace.instanceId);

  console.log("[platform-investment-state-smoke] ok", {
    noWorkspaceInstance: noWorkspace.instanceId,
    withWorkspaceInstance: withWorkspace.instanceId,
    workspaceReady: body.workspaceReady,
    latestReviewDate: body.summary.latestReviewDate,
    reviewCount: body.recentReviews.length,
    viewpointCount: body.viewpoints.length,
  });
} finally {
  await app?.close();
  sqlite?.close();
  await rm(tempRoot, { recursive: true, force: true });
}
