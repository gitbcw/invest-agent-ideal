#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "invest-agent-platform-browser-"));
process.env.NODE_ENV = "test";
process.env.PORT = "22657";
process.env.DB_PATH = path.join(tempRoot, "platform.db");
process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(tempRoot, "runtime");
process.env.INVEST_AGENT_API_TOKEN = "platform-browser-fixture-service-token-at-least-32-characters";
process.env.PLATFORM_BOOTSTRAP_USERNAME = "owner-fixture";
process.env.PLATFORM_BOOTSTRAP_PASSWORD = "owner-fixture-password-123456";
process.env.PLATFORM_ANONYMIZATION_SECRET = "platform-browser-fixture-anonymization-secret";
process.env.PLATFORM_WEIXIN_AUTO_START = "false";
process.env.INVEST_AGENT_OFFLINE_MODE = "true";

const dbModule = await import("../dist/db/index.js");
const { createServer } = await import("../dist/server.js");
const { hashPlatformPassword } = await import("../dist/lib/platform-password.js");
dbModule.initDb();
const now = new Date().toISOString();
const partnerId = "platform-browser-partner";
dbModule.sqlite.prepare(
  "INSERT INTO platform_users (id, username, display_name, password_hash, status, must_change_password, failed_login_count, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', 0, 0, ?, ?)",
).run(partnerId, "partner-fixture", "Partner Fixture", hashPlatformPassword("partner-fixture-password-123456"), now, now);
dbModule.sqlite.prepare(
  "INSERT INTO platform_user_roles (platform_user_id, role_id, created_at) VALUES (?, 'partner', ?)",
).run(partnerId, now);

const app = await createServer();
await app.listen({ port: 22657, host: "0.0.0.0" });
console.log("platform partner browser fixture listening on 22657");

const shutdown = async () => {
  await app.close();
  await rm(tempRoot, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
