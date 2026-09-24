#!/usr/bin/env node
/** Create local-only Portal identities for every mirrored production user. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mirrorRoot = path.resolve(process.env.MIRROR_ROOT ?? path.join(REPO_ROOT, ".state", "production-mirror"));
const manifest = JSON.parse(fs.readFileSync(path.join(mirrorRoot, "mirror-manifest.json"), "utf8"));
const portalDb = path.join(mirrorRoot, "portal.db");
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const runtime = new Database(path.join(mirrorRoot, "runtime.db"), { readonly: true, fileMustExist: true });

for (const user of manifest.users) {
  const sourcePortalUser = runtime
    .prepare("SELECT id FROM portal_users WHERE username=? AND instance_id=?")
    .get(user.userId, user.instanceId);
  if (!sourcePortalUser) {
    console.log(`[mirror] skip ${user.userId}: no production Portal identity for ${user.instanceId}`);
    continue;
  }
  const result = spawnSync("node", ["--import", "tsx", "scripts/seed-local-mirror-user.ts"], {
    cwd: path.join(REPO_ROOT, "apps", "portal"),
    env: { ...process.env, PORTAL_DB_PATH: portalDb, MIRROR_USERNAME: `mirror-${user.userId}`, MIRROR_INSTANCE_ID: user.instanceId, MIRROR_DISPLAY_NAME: `${user.userId}（生产快照）` },
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  const imported = spawnSync("node", ["scripts/agent-space/p0/import-portal-presentation.mjs"], {
    cwd: REPO_ROOT,
    env: { ...process.env, P0_ROOT: mirrorRoot, P0_PRESENTATION_SOURCE: path.join(mirrorRoot, "runtime.db"), P0_PORTAL_DB: portalDb, P0_RUNTIME_USER_ID: user.userId, P0_USER_ID: user.userId, P0_INSTANCE_ID: user.instanceId, P0_SOURCE_PORTAL_USERNAME: user.userId, P0_TARGET_PORTAL_USERNAME: `mirror-${user.userId}` },
    stdio: "inherit",
  });
  if (imported.status !== 0) process.exit(imported.status ?? 1);
}
runtime.close();
