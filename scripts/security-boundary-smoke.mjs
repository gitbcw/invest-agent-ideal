#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "invest-agent-security-smoke-"));
const workspace = path.join(tempRoot, "workspace");
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(tempRoot, "test.db");
process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");
process.env.INVEST_AGENT_API_TOKEN = "security-smoke-service-token-at-least-32-characters";

let app;
let sqlite;

try {
  const dbModule = await import("../dist/db/index.js");
  sqlite = dbModule.sqlite;
  const { createServer } = await import("../dist/server.js");
  const { serviceApiToken } = await import("../dist/lib/service-auth.js");
  const { storePortalAttachments, AttachmentStoreError } = await import("../dist/lib/attachment-store.js");
  const { ConversationScopeError, appendConversationMessage } = await import("../dist/services/conversation-log.js");
  const auth = { authorization: `Bearer ${serviceApiToken}` };

  dbModule.initDb();
  app = await createServer();

  const denied = await app.inject({ method: "GET", url: "/api/platform/instances" });
  assert.equal(denied.statusCode, 401);
  const deniedAcp = await app.inject({
    method: "POST",
    url: "/acp/message",
    payload: { id: "unauthorized", from: "attacker", timestamp: Date.now(), content: { type: "text", text: "test" } },
  });
  assert.equal(deniedAcp.statusCode, 401);
  const deniedChat = await app.inject({ method: "POST", url: "/api/chat", payload: { message: "test", workspacePath: "/tmp" } });
  assert.equal(deniedChat.statusCode, 401);
  const allowed = await app.inject({ method: "GET", url: "/api/platform/instances", headers: auth });
  assert.equal(allowed.statusCode, 200);
  const platformPage = await app.inject({ method: "GET", url: "/platform", remoteAddress: "127.0.0.1" });
  assert.equal(platformPage.statusCode, 200);
  const sessionCookie = platformPage.headers["set-cookie"]?.split(";")[0];
  assert.ok(sessionCookie);
  const sessionAllowed = await app.inject({ method: "GET", url: "/api/platform/instances", headers: { cookie: sessionCookie }, remoteAddress: "127.0.0.1" });
  assert.equal(sessionAllowed.statusCode, 200);
  const remotePlatform = await app.inject({ method: "GET", url: "/platform", remoteAddress: "203.0.113.10" });
  assert.equal(remotePlatform.statusCode, 401);
  assert.equal(remotePlatform.body.includes("经营看板登录"), true);
  assert.equal(remotePlatform.body.includes("用户助手"), false);
  assert.equal(remotePlatform.body.includes("日志审计"), false);
  const remoteSession = await app.inject({ method: "GET", url: "/api/platform/instances", headers: { cookie: sessionCookie }, remoteAddress: "203.0.113.10" });
  assert.equal(remoteSession.statusCode, 401);
  const basic = await app.inject({
    method: "GET",
    url: "/dashboard",
    headers: { authorization: `Basic ${Buffer.from(`invest-agent:${serviceApiToken}`).toString("base64")}` },
  });
  assert.equal(basic.statusCode, 301);
  assert.equal(basic.headers.location, "/platform");

  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(Object.hasOwn(JSON.parse(health.body), "pushQueue"), false);

  const scope = { userId: "security-a", projectId: "invest-agent", instanceId: "invest-agent-security-a", assistantId: "invest-agent-security-a" };
  appendConversationMessage({ scope, conversationId: "security-scope", channel: "web", role: "user", content: "first" });
  assert.throws(
    () => appendConversationMessage({
      scope: { ...scope, userId: "security-b", instanceId: "invest-agent-security-b", assistantId: "invest-agent-security-b" },
      conversationId: "security-scope",
      channel: "web",
      role: "user",
      content: "must not rebind",
    }),
    ConversationScopeError,
  );

  await assert.rejects(
    () => storePortalAttachments({
      workspacePath: workspace,
      attachments: [{ kind: "image", fileName: "blocked.png", mimeType: "image/png", downloadUrl: "https://example.com/object" }],
    }),
    (error) => error instanceof AttachmentStoreError && error.code === "ATTACHMENT_DOWNLOAD_URL_UNSAFE",
  );

  console.log("[security-boundary-smoke] ok");
} finally {
  await app?.close();
  sqlite?.close();
  await rm(tempRoot, { recursive: true, force: true });
}
