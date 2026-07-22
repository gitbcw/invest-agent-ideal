#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "invest-agent-offline-runtime-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(tempRoot, "test.db");
process.env.WORKSPACE_ROOT = path.join(tempRoot, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(tempRoot, "data");
process.env.INVEST_AGENT_SANDBOX_SECRET_FILE = path.join(tempRoot, ".sandbox-secret");
process.env.INVEST_AGENT_API_TOKEN = "offline-runtime-smoke-service-token-32-chars";
process.env.INVEST_AGENT_OFFLINE_MODE = "true";

let app;
let sqlite;

try {
  const dbModule = await import("../dist/db/index.js");
  sqlite = dbModule.sqlite;
  const { enqueuePushJob, getPushJob } = await import("../dist/services/push-queue.js");
  const { createServer } = await import("../dist/server.js");

  dbModule.initDb();
  const queued = await enqueuePushJob({
    userId: "offline-smoke-user",
    instanceId: "invest-agent-offline-smoke-user",
    source: "scheduler",
    message: "offline mode must not deliver this job",
  });

  app = await createServer();
  await new Promise((resolve) => setTimeout(resolve, 100));

  const untouched = await getPushJob(queued.id);
  assert.equal(untouched.status, "pending", "offline startup must not process due push jobs");
  assert.equal(untouched.attempts, 0, "offline startup must not attempt external delivery");

  console.log("[offline-runtime-smoke] ok");
} finally {
  await app?.close();
  sqlite?.close();
  await rm(tempRoot, { recursive: true, force: true });
}
