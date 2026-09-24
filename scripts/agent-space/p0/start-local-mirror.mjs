#!/usr/bin/env node
/** Start the production-snapshot mirror with no production writes or dispatches. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mirrorRoot = path.resolve(process.env.MIRROR_ROOT ?? path.join(REPO_ROOT, ".state", "production-mirror"));
if (!fs.existsSync(path.join(mirrorRoot, "mirror-manifest.json"))) throw new Error("缺少镜像；先运行 import-local-backup-mirror.mjs");
const manifest = JSON.parse(fs.readFileSync(path.join(mirrorRoot, "mirror-manifest.json"), "utf8"));
const userIds = manifest.users.map((u) => u.userId).join(",");
const shared = {
  DB_PATH: path.join(mirrorRoot, "runtime.db"), MASTRA_PROJECTS_ROOT: path.join(mirrorRoot, "projects"), RUNTIME_DATA_ROOT: path.join(mirrorRoot, "runtime"), WORKSPACE_ROOT: path.join(mirrorRoot, "workspaces"),
  INVEST_AGENT_OFFLINE_MODE: "true", WEIXIN_AUTO_START: "false", PLATFORM_WEIXIN_AUTO_START: "false", AGENT_SPACE_ASSEMBLY_MODE: `scope:${userIds}`,
  INVEST_AGENT_PORTAL_CONNECTOR_IN_OFFLINE_MODE: "true", PORTAL_CONNECTOR_AUTO_START: "true", PORTAL_RELAY_URL: "ws://127.0.0.1:3220", PORTAL_CONNECTOR_TOKEN: "mirror-connector-token", INVEST_AGENT_API_TOKEN: "mirror-api-token", PORT: "23670", HOST: "127.0.0.1",
};
const portal = { PORTAL_PORT: "3120", PORTAL_RELAY_PORT: "3220", PORTAL_RELAY_HOST: "127.0.0.1", PORTAL_DB_PATH: path.join(mirrorRoot, "portal.db"), PORTAL_JWT_SECRET: "mirror-local-jwt-secret", PORTAL_CONNECTOR_TOKEN: "mirror-connector-token", PORTAL_DEFAULT_ASSISTANT_ID: manifest.users[0].instanceId, PORTAL_DEFAULT_INSTANCE_ID: manifest.users[0].instanceId, PORTAL_DEFAULT_PROJECT_ID: "invest-agent" };
const children = [
  spawn("node", ["--import", "tsx", "src/index.ts"], { cwd: REPO_ROOT, env: { ...process.env, ...shared }, stdio: "inherit" }),
  spawn("node", ["--import", "tsx", "server.ts"], { cwd: path.join(REPO_ROOT, "apps", "portal"), env: { ...process.env, ...portal }, stdio: "inherit" }),
];
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  children.forEach((child) => child.kill("SIGINT"));
  process.exit(0);
};
process.on("SIGINT", stop); process.on("SIGTERM", stop);
console.log(`镜像运行中：http://127.0.0.1:3120；本地账号 mirror-<用户ID> / User@2026；用户：${userIds}`);
setInterval(() => {}, 1 << 30);
