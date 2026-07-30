#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "invest-agent-platform-migration-"));
const dbPath = path.join(tempRoot, "platform.db");
const childSource = [
  "import { initDb, sqlite } from './dist/db/index.js';",
  "initDb();",
  "initDb();",
  "const tables = sqlite.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'platform_%' ORDER BY name\").all();",
  "const migration = sqlite.prepare(\"SELECT key FROM schema_migrations WHERE key='platform_auth_v1'\").all();",
  "const roles = sqlite.prepare(\"SELECT id, COUNT(*) AS n FROM platform_roles GROUP BY id ORDER BY id\").all();",
  "const users = sqlite.prepare(\"SELECT COUNT(*) AS n FROM platform_users\").get();",
  "console.log(JSON.stringify({ tables, migration, roles, users }));",
].join("");
const rollbackSource = [
  "import { initDb } from './dist/db/index.js';",
  "import { createServer } from './dist/server.js';",
  "initDb();",
  "const app = await createServer();",
  "const auth = { authorization: 'Bearer ' + process.env.INVEST_AGENT_API_TOKEN };",
  "const oldRoute = await app.inject({ method: 'GET', url: '/api/platform/instances', headers: auth });",
  "const newRoute = await app.inject({ method: 'GET', url: '/api/platform/partner/overview', headers: auth });",
  "const login = await app.inject({ method: 'POST', url: '/api/platform/auth/login', payload: { username: 'owner', password: 'migration-password-123456' } });",
  "const page = await app.inject({ method: 'GET', url: '/platform', remoteAddress: '203.0.113.10' });",
  "await app.close();",
  "console.log(JSON.stringify({ oldRoute: oldRoute.statusCode, newRoute: newRoute.statusCode, login: login.statusCode, page: page.statusCode, pageHasLoginShell: page.body.includes('运营看板登录') }));",
].join("");

try {
  const env = {
    ...process.env,
    NODE_ENV: "test",
    DB_PATH: dbPath,
    WORKSPACE_ROOT: path.join(tempRoot, "workspaces"),
    RUNTIME_DATA_ROOT: path.join(tempRoot, "runtime"),
    INVEST_AGENT_API_TOKEN: "platform-migration-smoke-token-at-least-32-characters",
    PLATFORM_BOOTSTRAP_USERNAME: "owner",
    PLATFORM_BOOTSTRAP_PASSWORD: "migration-password-123456",
    PLATFORM_ANONYMIZATION_SECRET: "platform-migration-anonymization-secret",
    INVEST_AGENT_OFFLINE_MODE: "true",
  };
  const first = spawnSync(process.execPath, ["-e", childSource], { cwd: process.cwd(), env, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const firstResult = JSON.parse(first.stdout.trim().split("\n").at(-1));
  assert.equal(firstResult.tables.length, 6);
  assert.equal(firstResult.migration.length, 1);
  assert.deepEqual(firstResult.roles, [{ id: "owner", n: 1 }, { id: "partner", n: 1 }]);
  assert.equal(firstResult.users.n, 1);

  const second = spawnSync(process.execPath, ["-e", childSource], { cwd: process.cwd(), env, encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  const secondResult = JSON.parse(second.stdout.trim().split("\n").at(-1));
  assert.deepEqual(secondResult, firstResult);

  const rollbackEnv = { ...env, PLATFORM_AUTH_ENABLED: "false" };
  const rollback = spawnSync(process.execPath, ["--input-type=module", "-e", rollbackSource], { cwd: process.cwd(), env: rollbackEnv, encoding: "utf8" });
  assert.equal(rollback.status, 0, rollback.stderr || rollback.stdout);
  const rollbackResult = JSON.parse(rollback.stdout.trim().split("\n").at(-1));
  assert.equal(rollbackResult.oldRoute, 200);
  assert.equal(rollbackResult.newRoute, 404);
  assert.equal(rollbackResult.login, 404);
  assert.equal(rollbackResult.page, 401);
  assert.equal(rollbackResult.pageHasLoginShell, true);

  console.log("[platform-partner-migration-smoke] ok", JSON.stringify({
    freshTables: firstResult.tables.length,
    migrationMarker: firstResult.migration.length,
    roleRows: firstResult.roles,
    ownerRows: firstResult.users.n,
    rollback: rollbackResult,
  }));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
