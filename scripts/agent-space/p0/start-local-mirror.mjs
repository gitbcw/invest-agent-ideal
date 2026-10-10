#!/usr/bin/env node
/** Start the production-snapshot mirror with no production writes or dispatches. */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { productionMcpEnv } from "./production-mcp-env.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mirrorRoot = path.resolve(process.env.MIRROR_ROOT ?? path.join(REPO_ROOT, ".state", "production-mirror"));
if (!fs.existsSync(path.join(mirrorRoot, "mirror-manifest.json"))) throw new Error("缺少镜像；先运行 import-local-backup-mirror.mjs");
const manifest = JSON.parse(fs.readFileSync(path.join(mirrorRoot, "mirror-manifest.json"), "utf8"));
const userIds = manifest.users.map((u) => u.userId).join(",");
// 2026-10-08：导入脚本会把 next_run_at 清空（防补跑），但调度器只扫非空行，
// 不重算则镜像内所有定时任务永久哑火——启动前先自愈一遍（幂等，只补空行）。
const recompute = spawnSync(
  process.execPath,
  ["--import", "tsx", path.join(path.dirname(fileURLToPath(import.meta.url)), "recompute-mirror-next-run.mjs")],
  { cwd: REPO_ROOT, encoding: "utf8" },
);
if (recompute.status !== 0) {
  console.error("next_run_at 重算失败（继续启动，定时任务可能不触发）：");
  console.error(recompute.stderr ?? recompute.stdout);
} else {
  process.stdout.write(recompute.stdout ?? "");
}
const shared = {
  ...productionMcpEnv(),
  INVEST_AGENT_AUTO_PREFERRED_MODEL: "glm-5.3-flash",
  DB_PATH: path.join(mirrorRoot, "runtime.db"), MASTRA_PROJECTS_ROOT: path.join(mirrorRoot, "projects"), RUNTIME_DATA_ROOT: path.join(mirrorRoot, "runtime"), WORKSPACE_ROOT: path.join(mirrorRoot, "workspaces"),
  // 2026-10-09：镜像内已支持用户自助扫码绑定微信，重启后项目通道监听必须自动恢复，否则绑定通道变哑。
  // T-590 修复（2026-10-10）：此前 AGENT_SPACE_ASSEMBLY_MODE 被写进上面同一行的 //
  // 注释里，实际从未生效——镜像一直跑 legacy 装配路径（demo 用户零 run_basis 实证）。
  INVEST_AGENT_OFFLINE_MODE: "false", WEIXIN_AUTO_START: "false", PLATFORM_WEIXIN_AUTO_START: "true",
  AGENT_SPACE_ASSEMBLY_MODE: `scope:${userIds}`,
  INVEST_AGENT_PORTAL_CONNECTOR_IN_OFFLINE_MODE: "true", PORTAL_CONNECTOR_AUTO_START: "true", PORTAL_RELAY_URL: "ws://127.0.0.1:3220", PORTAL_CONNECTOR_TOKEN: "mirror-connector-token", INVEST_AGENT_API_TOKEN: "mirror-api-token", PORT: "23670", HOST: "127.0.0.1",
};
const portal = { PORTAL_RUNTIME_URL: `http://127.0.0.1:${shared.PORT}`, PORTAL_RUNTIME_API_TOKEN: shared.INVEST_AGENT_API_TOKEN, PORTAL_PORT: "3120", PORTAL_RELAY_PORT: "3220", PORTAL_RELAY_HOST: "127.0.0.1", PORTAL_DB_PATH: path.join(mirrorRoot, "portal.db"), PORTAL_JWT_SECRET: "mirror-local-jwt-secret", PORTAL_CONNECTOR_TOKEN: "mirror-connector-token", PORTAL_DEFAULT_ASSISTANT_ID: manifest.users[0].instanceId, PORTAL_DEFAULT_INSTANCE_ID: manifest.users[0].instanceId, PORTAL_DEFAULT_PROJECT_ID: "invest-agent" };
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
