#!/usr/bin/env node
/**
 * T-537 P0: 启动单 scope 隔离本地验证环境（runtime + Portal）。
 *
 * 前置：先运行 pull-111-copy.mjs 生成 .state/agent-space-p0/ 隔离副本。
 *
 * 隔离要点：
 *   - runtime 用独立 DB / 容器根 / 数据根 / 端口 23660，scope 由 P0_USER_ID 指定；
 *   - INVEST_AGENT_OFFLINE_MODE=true 挡住一切外发（微信 push 返回失败记录、
 *     不触碰任何微信状态）；connector 显式放行以接通本地 Portal relay；
 *   - Portal 用独立 portal.db / 端口 3110 / relay 3210，测试身份 primary 绑定当前 scope；
 *   - 所有覆盖变量先 export 再起进程（dotenv 不覆盖已存在的 process.env），
 *     本地 .env 仅补模型网关等非路径配置。
 *
 * 用法:
 *   node scripts/agent-space/p0/start-isolated.mjs            # 前台运行，Ctrl-C 全停
 *   node scripts/agent-space/p0/start-isolated.mjs --seed     # 首次：先初始化 Portal 测试身份
 *   node scripts/agent-space/p0/start-isolated.mjs --runtime-only / --portal-only
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const P0_ROOT = path.resolve(process.env.P0_ROOT ?? path.join(REPO_ROOT, ".state", "agent-space-p0"));
const P0_USER_ID = process.env.P0_USER_ID ?? "111";
const P0_PROJECT_ID = process.env.P0_PROJECT_ID ?? "invest-agent";
const P0_INSTANCE_ID = process.env.P0_INSTANCE_ID ?? `invest-agent-${P0_USER_ID}`;
const P0_SCOPE_DIGEST = process.env.P0_SCOPE_DIGEST ?? createHash("sha256")
  .update(`${P0_USER_ID}\0${P0_PROJECT_ID}\0${P0_INSTANCE_ID}`)
  .digest("hex")
  .slice(0, 24);

export const P0_ENV = {
  // —— runtime ——
  PORT: "23660",
  HOST: "127.0.0.1",
  DB_PATH: path.join(P0_ROOT, "runtime.db"),
  MASTRA_PROJECTS_ROOT: path.join(P0_ROOT, "projects"),
  RUNTIME_DATA_ROOT: path.join(P0_ROOT, "runtime"),
  WORKSPACE_ROOT: path.join(P0_ROOT, "workspaces"),
  AGENT_SPACE_ASSEMBLY_MODE: `scope:${P0_USER_ID}`,
  INVEST_AGENT_OFFLINE_MODE: "true",
  INVEST_AGENT_PORTAL_CONNECTOR_IN_OFFLINE_MODE: "true",
  PORTAL_CONNECTOR_AUTO_START: "true",
  PORTAL_RELAY_URL: "ws://127.0.0.1:3210",
  PORTAL_CONNECTOR_TOKEN: "p0-isolated-connector-token",
  PORTAL_USER_ID: P0_USER_ID,
  PORTAL_INSTANCE_ID: P0_INSTANCE_ID,
  PORTAL_ASSISTANT_ID: P0_INSTANCE_ID,
  WEIXIN_AUTO_START: "false",
  PLATFORM_WEIXIN_AUTO_START: "false",
  INVEST_AGENT_API_TOKEN: "p0-isolated-api-token",
  PLATFORM_ANONYMIZATION_SECRET: "p0-isolated-anonymization-secret-32ch",
};

export const PORTAL_ENV = {
  PORTAL_PORT: "3110",
  PORTAL_RELAY_PORT: "3210",
  PORTAL_RELAY_HOST: "127.0.0.1",
  PORTAL_DB_PATH: path.join(P0_ROOT, "portal.db"),
  // A distinct secret per imported fixture invalidates stale browser sessions
  // when the same localhost port changes from one user scope to another.
  PORTAL_JWT_SECRET: process.env.P0_PORTAL_JWT_SECRET ?? "p0-isolated-jwt-secret",
  PORTAL_CONNECTOR_TOKEN: "p0-isolated-connector-token",
  PORTAL_DEFAULT_ASSISTANT_ID: P0_INSTANCE_ID,
  PORTAL_DEFAULT_INSTANCE_ID: P0_INSTANCE_ID,
  PORTAL_DEFAULT_PROJECT_ID: P0_PROJECT_ID,
};

function assertInputs() {
  const db = path.join(P0_ROOT, "runtime.db");
  const container = path.join(P0_ROOT, "projects", P0_SCOPE_DIGEST);
  if (!fs.existsSync(db)) throw new Error(`缺少隔离 DB：${db}（先导入当前 scope 副本）`);
  if (!fs.existsSync(container)) throw new Error(`缺少 ${P0_USER_ID} 容器：${container}`);
}

function seedPortal() {
  console.log(`[seed] 初始化隔离 Portal 测试身份（primary/User@2026 绑定 ${P0_INSTANCE_ID}）...`);
  const r = spawnSync("node", ["--import", "tsx", "scripts/seed.ts"], {
    cwd: path.join(REPO_ROOT, "apps", "portal"),
    env: { ...process.env, ...PORTAL_ENV },
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error("Portal seed 失败");
}

function importPortalPresentation() {
  const r = spawnSync("node", ["scripts/agent-space/p0/import-portal-presentation.mjs"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...P0_ENV },
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error("111 Portal 展示态导入失败");
}

const args = new Set(process.argv.slice(2));
const onlyRuntime = args.has("--runtime-only");
const onlyPortal = args.has("--portal-only");

try {
  assertInputs();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

if (args.has("--seed")) seedPortal();

const children = [];
function shutdown() {
  for (const c of children) {
    try { c.kill("SIGINT"); } catch { /* already gone */ }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (!onlyPortal) {
  console.log(`[runtime] 启动隔离 runtime：http://127.0.0.1:23660（offline 假投递，scope ${P0_USER_ID}）`);
  const runtime = spawn("node", ["--import", "tsx", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...P0_ENV },
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.push(runtime);
  runtime.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`[runtime] 退出码 ${code}`);
  });
}

if (!onlyRuntime) {
  const portalCwd = path.join(REPO_ROOT, "apps", "portal");
  const hasPortalDb = fs.existsSync(PORTAL_ENV.PORTAL_DB_PATH);
  if (!hasPortalDb) {
    console.log("[portal] 首次运行：初始化测试身份...");
    seedPortal();
  }
  console.log(`[portal] 导入 ${P0_USER_ID} 会话展示态（标签/置顶/归档/排序/重命名）...`);
  importPortalPresentation();
  console.log("[portal] 启动隔离 Portal：http://127.0.0.1:3110（relay :3210，登录 primary/User@2026）");
  const portal = spawn("node", ["--import", "tsx", "server.ts"], {
    cwd: portalCwd,
    env: { ...process.env, ...PORTAL_ENV },
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.push(portal);
  portal.on("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`[portal] 退出码 ${code}`);
  });
}

console.log("\n隔离环境运行中。Ctrl-C 停止全部进程。自检：node scripts/agent-space/p0/verify-isolated.mjs\n");
setInterval(() => { /* keep alive until signal */ }, 1 << 30);
