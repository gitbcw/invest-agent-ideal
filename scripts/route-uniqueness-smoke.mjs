#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "invest-agent-route-uniqueness-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(tempRoot, "test.db");
process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");
process.env.INVEST_AGENT_API_TOKEN = "route-uniqueness-smoke-service-token-32-chars";

let app;
let sqlite;

try {
  const dbModule = await import("../dist/db/index.js");
  sqlite = dbModule.sqlite;
  const { createServer } = await import("../dist/server.js");

  dbModule.initDb();
  app = await createServer();

  const inventory = ((app).routeInventory ?? []).filter((r) => r.method !== "HEAD");
  assert.ok(inventory.length > 0, "routeInventory should not be empty");

  const seen = new Map();
  const duplicates = [];
  for (const entry of inventory) {
    const key = `${entry.method} ${entry.url}`;
    const prev = seen.get(key);
    if (prev === undefined) {
      seen.set(key, 1);
    } else {
      seen.set(key, prev + 1);
      duplicates.push(key);
    }
  }
  assert.deepEqual(duplicates, [], `duplicate routes registered: ${duplicates.join(", ")}`);

  const watchRuleRoutes = inventory.filter(
    (r) => r.url === "/api/watch-rules" || r.url.startsWith("/api/watch-rules/"),
  );
  const expected = [
    "GET /api/watch-rules/catalog",
    "GET /api/watch-rules",
    "POST /api/watch-rules/validate",
    "POST /api/watch-rules",
    "PATCH /api/watch-rules/:id",
    "DELETE /api/watch-rules/:id",
    "POST /api/watch-rules/:id/dry-run",
    "GET /api/watch-rules/default-scope",
  ].sort();
  const actual = watchRuleRoutes.map((r) => `${r.method} ${r.url}`).sort();
  assert.deepEqual(actual, expected, "watch-rule HTTP adapter should expose canonical route set");

  for (const key of expected) {
    const [method, url] = key.split(" ");
    const count = inventory.filter((r) => r.method === method && r.url === url).length;
    assert.equal(count, 1, `${key} must be registered exactly once, got ${count}`);
  }

  const retiredRoutes = [
    "GET /api/sandbox/dashboard",
    "GET /api/weixin/status",
    "POST /api/weixin/connect/start",
    "POST /api/weixin/listener/start",
    "POST /api/weixin/connect/stop",
    "POST /api/weixin/push/test",
  ];
  const registeredKeys = new Set(inventory.map((r) => `${r.method} ${r.url}`));
  for (const retired of retiredRoutes) {
    assert.equal(registeredKeys.has(retired), false, `${retired} must remain retired`);
  }
  assert.equal(registeredKeys.has("GET /api/sandbox/snapshot"), true, "sandbox snapshot route must be registered");

  const { serviceApiToken } = await import("../dist/lib/service-auth.js");
  const adminWeixin = await app.inject({
    method: "GET",
    url: "/admin/weixin",
    headers: { authorization: `Bearer ${serviceApiToken}` },
  });
  assert.equal(adminWeixin.statusCode, 301);
  assert.equal(adminWeixin.headers.location, "/platform#instances");

  console.log("[route-uniqueness-smoke] ok");
} finally {
  await app?.close();
  sqlite?.close();
  await rm(tempRoot, { recursive: true, force: true });
}
