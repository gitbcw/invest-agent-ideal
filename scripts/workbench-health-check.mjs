#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const repoRoot = new URL("..", import.meta.url).pathname;
const baseUrl = process.env.BASE_URL || "http://localhost:22649";
const userId = process.env.USER_ID || "primary";
const instanceId = process.env.INSTANCE_ID || "invest-agent-primary";
const projectId = process.env.PROJECT_ID || "invest-agent";

async function request(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, options);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok || data.ok === false) {
    throw new Error(`${path} failed: ${res.status} ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data;
}

function postJson(path, body, headers = {}) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
}

function sqlite(sql) {
  const result = spawnSync("sqlite3", ["./data/invest-agent.db", sql], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `sqlite failed: ${sql}`);
  }
  return result.stdout.trim();
}

function assertTable(name) {
  const exists = sqlite(`select name from sqlite_master where type='table' and name='${name.replace(/'/g, "''")}';`);
  assert.equal(exists, name, `missing table ${name}`);
}

console.log("# Workbench Health Check");
console.log(`baseUrl: ${baseUrl}`);
console.log(`userId: ${userId}`);
console.log(`instanceId: ${instanceId}`);
console.log("");

const platform = await request("/api/platform/projects");
assert.equal(platform.ok, true);
assert.ok(Array.isArray(platform.projects), "platform projects must be an array");
assert.ok(platform.projects.length > 0, "platform projects must not be empty");
const project = platform.projects.find((item) => item.instanceId === instanceId || item.projectId === instanceId) || platform.projects[0];
assert.ok(project.projectType, "project summary must include projectType");
assert.ok(project.skillBundleId, "project summary must include skillBundleId");
assert.ok(project.auditSummary && typeof project.auditSummary === "object", "project summary must include auditSummary");
assert.ok(project.pushQueueSummary && typeof project.pushQueueSummary === "object", "project summary must include pushQueueSummary");

const dashboard = await request(`/api/dashboard?userId=${encodeURIComponent(userId)}&instanceId=${encodeURIComponent(instanceId)}`);
assert.ok(dashboard.summary, "dashboard must include summary");
assert.ok(Array.isArray(dashboard.recentPlans), "dashboard must include recentPlans");
assert.ok(Array.isArray(dashboard.recentEvents), "dashboard must include recentEvents");
assert.ok(Array.isArray(dashboard.recentConversations), "dashboard must include recentConversations");
assert.ok(Array.isArray(dashboard.reviewViewpoints), "dashboard must include reviewViewpoints");
assert.ok(Array.isArray(dashboard.openViewpoints), "dashboard must include openViewpoints");
assert.ok(Array.isArray(dashboard.dueViewpoints), "dashboard must include dueViewpoints");
assert.ok(typeof dashboard.summary.viewpointCount === "number", "dashboard summary must include viewpointCount");

const reviewContext = await postJson("/api/reviews/context", { userId, instanceId });
assert.equal(reviewContext.ok, true);
assert.ok(reviewContext.context?.date, "daily review context must include date");
assert.ok(Array.isArray(reviewContext.context?.holdings), "daily review context must include holdings array");
assert.ok(Array.isArray(reviewContext.context?.watchlist), "daily review context must include watchlist array");
assert.ok(Array.isArray(reviewContext.context?.alerts), "daily review context must include alerts array");

const weeklyContext = await postJson("/api/reviews/weekly-context", { userId, instanceId });
assert.equal(weeklyContext.ok, true);
assert.ok(weeklyContext.weekStart, "weekly context must include weekStart");
assert.ok(weeklyContext.context?.viewpointSummary, "weekly context must include viewpointSummary");

const monthlyContext = await postJson("/api/reviews/monthly-context", { userId, instanceId });
assert.equal(monthlyContext.ok, true);
assert.ok(monthlyContext.monthKey, "monthly context must include monthKey");
assert.ok(monthlyContext.context?.viewpointSummary, "monthly context must include viewpointSummary");

let sandboxMethodCandidates = null;
if (process.env.INVEST_AGENT_SANDBOX_SECRET) {
  const { createSandboxToken } = await import("../dist/lib/sandbox-context.js");
  const sandboxToken = createSandboxToken({
    userId,
    projectId,
    instanceId,
    projectType: "invest-agent",
    role: "user",
    channel: "api",
    backend: "codex",
    conversationId: "workbench-health-check",
    permissions: ["read:self", "review:self", "alert:self"],
  });
  const auth = { Authorization: `Bearer ${sandboxToken}` };
  const sandboxDashboard = await request("/api/sandbox/dashboard", { headers: auth });
  assert.equal(sandboxDashboard.ok, true);
  assert.ok(sandboxDashboard.summary, "sandbox dashboard must include summary");
  assert.ok(Array.isArray(sandboxDashboard.proposedMethodChanges), "sandbox dashboard must expose method candidates");

  const sandboxProfiles = await request("/api/sandbox/profiles", { headers: auth });
  assert.equal(sandboxProfiles.ok, true);
  assert.ok(Array.isArray(sandboxProfiles.methodChangeCandidates), "sandbox profiles must expose methodChangeCandidates");
  sandboxMethodCandidates = sandboxProfiles.methodChangeCandidates.length;
} else {
  console.log("Sandbox API check skipped: INVEST_AGENT_SANDBOX_SECRET is not set for both service and script.");
}

for (const table of [
  "daily_plans",
  "review_viewpoints",
  "method_change_candidates",
  "alerts",
  "alert_events",
  "codex_acp_traces",
  "sandbox_audit_logs",
  "push_jobs",
]) {
  assertTable(table);
}

console.log(JSON.stringify({
  ok: true,
  projectCount: platform.projects.length,
  selectedProject: project.instanceId || project.projectId,
  dashboardSummary: dashboard.summary,
  reviewDate: reviewContext.context.date,
  weekStart: weeklyContext.weekStart,
  monthKey: monthlyContext.monthKey,
  sandboxMethodCandidates,
}));
