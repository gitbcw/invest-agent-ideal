#!/usr/bin/env node
/** 创建全新镜像用户（冷启动测试，2026-10-08）：runtime 实例 + mastra 项目
 * 注册 + portal 登录账号 + manifest 登记（供 start-local-mirror 的装配 scope）。
 * 不建 agent（冷启动自愈负责）、不播种框架/技能（保留真实的空启动状态）。 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const root = path.join(REPO_ROOT, ".state", "production-mirror");
const userId = process.env.NEW_USER_ID ?? "fresh";
const instanceId = `invest-agent-${userId}`;
process.env.DB_PATH = path.join(root, "runtime.db");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
const dbModule = await import("../../../src/db/index.ts");
(dbModule.default ?? dbModule).initDb();
const { sqlite } = dbModule.default ?? dbModule;

// 1) runtime：users + ai_projects（外键前置）+ ai_instances（connector 身份）
const now = new Date().toISOString();
sqlite.prepare("INSERT OR IGNORE INTO users (id, display_name, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)").run(userId, `${userId}（冷启动测试）`, now, now);
sqlite.prepare("INSERT OR IGNORE INTO ai_projects (id, name, type, status, created_at, updated_at) VALUES ('invest-agent', 'invest-agent', 'default', 'active', ?, ?)").run(now, now);
sqlite.prepare(`INSERT OR IGNORE INTO ai_instances (id, project_id, owner_user_id, name, status, created_at, updated_at)
  VALUES (?, 'invest-agent', ?, ?, 'active', ?, ?)`).run(instanceId, userId, `${userId}（冷启动测试）`, now, now);

// 2) mastra 项目注册（workspace/资产根）
const { mastraWorkspaceRegistry } = await import("../../../src/mastra/workspace-registry.ts");
const entry = await mastraWorkspaceRegistry.bootstrap({ userId, projectId: "invest-agent", instanceId });
if (!entry?.projectRoot) throw new Error("project bootstrap failed");
console.log("project:", entry.projectRoot);

// 3) manifest 登记（重启后自动进装配 scope）
const manifestPath = path.join(root, "mirror-manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (!manifest.users.some((u) => u.userId === userId)) {
  manifest.users.push({ userId, instanceId, projectId: "invest-agent" });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log("manifest: added", userId);
}

// 4) portal 账号（mirror-<id> / User@2026）
const result = spawnSync("node", ["--import", "tsx", "scripts/seed-local-mirror-user.ts"], {
  cwd: path.join(REPO_ROOT, "apps", "portal"),
  env: { ...process.env, PORTAL_DB_PATH: path.join(root, "portal.db"), MIRROR_USERNAME: `mirror-${userId}`, MIRROR_INSTANCE_ID: instanceId, MIRROR_DISPLAY_NAME: `${userId}（冷启动测试）` },
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(JSON.stringify({ userId, instanceId, login: `mirror-${userId}`, password: "User@2026" }));
sqlite.close();
