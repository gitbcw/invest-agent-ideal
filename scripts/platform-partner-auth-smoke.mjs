#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "invest-agent-platform-auth-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(tempRoot, "platform.db");
process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(tempRoot, "runtime");
process.env.INVEST_AGENT_API_TOKEN = "platform-auth-smoke-service-token-at-least-32-characters";
process.env.PLATFORM_BOOTSTRAP_USERNAME = "owner";
process.env.PLATFORM_BOOTSTRAP_PASSWORD = "owner-password-123456";
process.env.PLATFORM_ANONYMIZATION_SECRET = "platform-auth-smoke-anonymization-secret";
process.env.PLATFORM_WEIXIN_AUTO_START = "false";
process.env.INVEST_AGENT_OFFLINE_MODE = "true";

let app;
try {
  const dbModule = await import("../dist/db/index.js");
  const { createServer } = await import("../dist/server.js");
  const { hashPlatformPassword } = await import("../dist/lib/platform-password.js");

  dbModule.initDb();
  const now = new Date().toISOString();
  const partnerId = "platform-partner-smoke";
  dbModule.sqlite.prepare(
    "INSERT INTO platform_users (id, username, display_name, password_hash, status, must_change_password, failed_login_count, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', 0, 0, ?, ?)"
  ).run(partnerId, "partner-smoke", "Partner Smoke", hashPlatformPassword("partner-password-123456"), now, now);
  dbModule.sqlite.prepare(
    "INSERT INTO platform_user_roles (platform_user_id, role_id, created_at) VALUES (?, 'partner', ?)"
  ).run(partnerId, now);

  app = await createServer();

  const unauthenticated = await app.inject({
    method: "GET",
    url: "/api/platform/partner/overview",
    remoteAddress: "203.0.113.10",
  });
  assert.equal(unauthenticated.statusCode, 401);

  const partnerLogin = await app.inject({
    method: "POST",
    url: "/api/platform/auth/login",
    remoteAddress: "203.0.113.10",
    payload: { username: "partner-smoke", password: "partner-password-123456" },
  });
  assert.equal(partnerLogin.statusCode, 200, partnerLogin.body);
  const partnerCookie = partnerLogin.headers["set-cookie"]?.split(";")[0];
  assert.ok(partnerCookie);

  const overview = await app.inject({
    method: "GET",
    url: "/api/platform/partner/overview",
    remoteAddress: "203.0.113.10",
    headers: { cookie: partnerCookie },
  });
  assert.equal(overview.statusCode, 200, overview.body);
  const overviewBody = JSON.parse(overview.body);
  const overviewText = JSON.stringify(overviewBody);
  for (const forbidden of ["userText", "promptText", "replyTextRaw", "costAmount", "workspacePath", "stockCode", "externalUserId"]) {
    assert.equal(overviewText.includes(forbidden), false, "overview leaked " + forbidden);
  }

  const customers = await app.inject({
    method: "GET",
    url: "/api/platform/partner/customers?userId=primary&instanceId=invest-agent-primary",
    remoteAddress: "203.0.113.10",
    headers: { cookie: partnerCookie },
  });
  assert.equal(customers.statusCode, 200, customers.body);
  const customerBody = JSON.parse(customers.body);
  assert.ok(Array.isArray(customerBody.customers));
  assert.ok(customerBody.customers.every((item) => typeof item.customerKey === "string" && item.customerKey.startsWith("cus_")));
  const customerText = JSON.stringify(customerBody);
  for (const forbidden of ["userId", "instanceId", "externalAccountId", "costAmount", "stockCode", "workspace", "promptText", "replyTextRaw"]) {
    assert.equal(customerText.includes(forbidden), false, "customers leaked " + forbidden);
  }
  const quality = await app.inject({
    method: "GET",
    url: "/api/platform/partner/quality",
    remoteAddress: "203.0.113.10",
    headers: { cookie: partnerCookie },
  });
  assert.equal(quality.statusCode, 200, quality.body);
  assert.equal(JSON.stringify(JSON.parse(quality.body)).includes("costAmount"), false);
  const runtimeHealth = await app.inject({
    method: "GET",
    url: "/api/platform/partner/runtime-health",
    remoteAddress: "203.0.113.10",
    headers: { cookie: partnerCookie },
  });
  assert.equal(runtimeHealth.statusCode, 200, runtimeHealth.body);
  if (customerBody.customers[0]) {
    const operations = await app.inject({
      method: "GET",
      url: "/api/platform/partner/customers/" + customerBody.customers[0].customerKey + "/operations",
      remoteAddress: "203.0.113.10",
      headers: { cookie: partnerCookie },
    });
    assert.equal(operations.statusCode, 200, operations.body);
    const operationsText = JSON.stringify(JSON.parse(operations.body));
    for (const forbidden of ["userId", "instanceId", "externalAccountId", "costAmount", "stockCode", "workspace", "promptText", "replyTextRaw"]) {
      assert.equal(operationsText.includes(forbidden), false, "operations leaked " + forbidden);
    }
  }

  // Partner 现可读成本总览（v2 契约：仅大盘，不按客户拆），单独验证 200。
  const costRead = await app.inject({ method: "GET", url: "/api/platform/audit/usage", remoteAddress: "203.0.113.10", headers: { cookie: partnerCookie } });
  assert.equal(costRead.statusCode, 200, "partner should read cost overview");

  const partnerDeniedRequests = [
    { method: "GET", url: "/api/platform/audit?userId=primary" },
    { method: "GET", url: "/api/platform/instances?userId=primary" },
    { method: "GET", url: "/api/platform/instances/invest-agent-primary/investment-state" },
    { method: "GET", url: "/api/platform/rule-alerts" },
    { method: "POST", url: "/api/platform/instances", payload: { userId: "attacker", displayName: "attacker" } },
    { method: "GET", url: "/api/platform/source-quality" },
    { method: "POST", url: "/api/platform/instances/invest-agent-primary/portal/credential" },
    { method: "DELETE", url: "/api/platform/instances/invest-agent-primary" },
    { method: "POST", url: "/api/platform/instances/invest-agent-primary/reset-test", payload: { confirm: "RESET_DEFAULT_TEST_INSTANCE" } },
    { method: "GET", url: "/api/platform/instances/invest-agent-primary/weixin/status" },
    { method: "POST", url: "/api/platform/instances/invest-agent-primary/weixin/connect/start" },
    { method: "POST", url: "/api/platform/instances/invest-agent-primary/weixin/listener/start" },
    { method: "POST", url: "/api/platform/instances/invest-agent-primary/weixin/connect/stop" },
    { method: "POST", url: "/api/platform/instances/invest-agent-primary/weixin/push/test", payload: { message: "should not send" } },
    { method: "POST", url: "/api/platform/instances/invest-agent-primary/workspace/ensure" },
  ];
  for (const request of partnerDeniedRequests) {
    const denied = await app.inject({ ...request, remoteAddress: "203.0.113.10", headers: { cookie: partnerCookie } });
    assert.equal(denied.statusCode, 403, request.method + " " + request.url + " should be denied");
  }

  const ownerLogin = await app.inject({
    method: "POST",
    url: "/api/platform/auth/login",
    remoteAddress: "203.0.113.10",
    payload: { username: "owner", password: "owner-password-123456" },
  });
  assert.equal(ownerLogin.statusCode, 200, ownerLogin.body);
  const ownerCookie = ownerLogin.headers["set-cookie"]?.split(";")[0];
  assert.ok(ownerCookie);

  const ownerMustChange = await app.inject({
    method: "GET",
    url: "/api/platform/audit?userId=primary",
    remoteAddress: "203.0.113.10",
    headers: { cookie: ownerCookie },
  });
  assert.equal(ownerMustChange.statusCode, 428);
  const ownerPasswordChange = await app.inject({
    method: "POST",
    url: "/api/platform/auth/password",
    remoteAddress: "203.0.113.10",
    headers: { cookie: ownerCookie },
    payload: { currentPassword: "owner-password-123456", newPassword: "owner-password-654321" },
  });
  assert.equal(ownerPasswordChange.statusCode, 200, ownerPasswordChange.body);

  const ownerAudit = await app.inject({
    method: "GET",
    url: "/api/platform/audit?userId=primary",
    remoteAddress: "203.0.113.10",
    headers: { cookie: ownerCookie },
  });
  assert.equal(ownerAudit.statusCode, 200, ownerAudit.body);

  const deniedAudit = dbModule.sqlite.prepare(
    "SELECT action, route, permission, status FROM platform_admin_audit_logs WHERE status = 'denied' AND permission IS NOT NULL ORDER BY created_at DESC LIMIT 1"
  ).get();
  assert.equal(deniedAudit?.status, "denied");
  assert.ok(String(deniedAudit.route).startsWith("/api/platform/"));
  const allowedAudit = dbModule.sqlite.prepare(
    "SELECT action, route, permission, status FROM platform_admin_audit_logs WHERE status = 'allowed' AND route = '/api/platform/audit' ORDER BY created_at DESC LIMIT 1"
  ).get();
  assert.equal(allowedAudit?.status, "allowed");

  const tableNames = dbModule.sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('platform_users', 'platform_roles', 'platform_user_roles', 'platform_sessions', 'platform_login_events', 'platform_admin_audit_logs')"
  ).all();
  assert.equal(tableNames.length, 6);

  const logout = await app.inject({
    method: "POST",
    url: "/api/platform/auth/logout",
    remoteAddress: "203.0.113.10",
    headers: { cookie: partnerCookie },
  });
  assert.equal(logout.statusCode, 200, logout.body);
  const afterLogout = await app.inject({
    method: "GET",
    url: "/api/platform/partner/overview",
    remoteAddress: "203.0.113.10",
    headers: { cookie: partnerCookie },
  });
  assert.equal(afterLogout.statusCode, 401);

  console.log("[platform-partner-auth-smoke] ok", JSON.stringify({
    unauthenticated: unauthenticated.statusCode,
    partnerOverview: overview.statusCode,
    partnerQuality: quality.statusCode,
    partnerRuntimeHealth: runtimeHealth.statusCode,
    partnerDenied: partnerDeniedRequests.length,
    ownerAudit: ownerAudit.statusCode,
    ownerMustChange: ownerMustChange.statusCode,
    auditDenied: deniedAudit,
    auditAllowed: allowedAudit,
    authTables: tableNames.length,
    afterLogout: afterLogout.statusCode,
  }));
} finally {
  if (app) await app.close();
  await rm(tempRoot, { recursive: true, force: true });
}
