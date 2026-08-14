#!/usr/bin/env node

// Non-production smoke for an already imported Mastra target. Every path is
// explicit so this command cannot fall back to a live database or workspace.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const targetDb = required(args.targetDb, "--target-db");
const projectRoot = required(args.projectRoot, "--project-root");
const projectsRoot = required(args.projectsRoot, "--projects-root");
const userId = requiredId(args.userId, "--user-id");
const projectId = requiredId(args.projectId || "invest-agent", "--project-id");
const instanceId = requiredId(args.instanceId, "--instance-id");
process.env.NODE_ENV = "test";
process.env.WORKSPACE_BACKEND = "mastra";
process.env.DB_PATH = targetDb;
process.env.MASTRA_PROJECTS_ROOT = projectsRoot;
process.env.WORKSPACE_ROOT = path.join(projectsRoot, "legacy-workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(projectsRoot, "runtime");

const { initDb, sqlite } = await import("../src/db/index.js");
initDb();
const { mastraWorkspaceRegistry } = await import("../src/mastra/workspace-registry.js");
const connector = await import("../src/portal/connector.js");
await mastraWorkspaceRegistry.register({ userId, projectId, instanceId, projectRoot });

const scope = { userId, projectId, instanceId, assistantId: instanceId, connectorId: "mastra-target-write-smoke", displayName: "isolated target" };
const command = (type, payload = {}) => ({ protocolVersion: "2026-08-05", requestId: `target-write-${Date.now()}-${Math.random()}`, type, sentAt: new Date().toISOString(), payload });

const forged = await connector.__test__.handleCommand(scope, command("asset.upload", {
  userId: "other-user",
  projectId,
  instanceId,
  name: "forged",
  fileName: "forged.md",
  mimeType: "text/markdown",
  base64: Buffer.from("must reject\n").toString("base64"),
}));
if (forged.ok !== false || forged.error?.code !== "INVALID_REQUEST") throw new Error("MAStra target scope override was accepted");

const uploaded = await connector.__test__.handleCommand(scope, command("asset.upload", {
  name: "target write smoke",
  fileName: "target-write-smoke.md",
  mimeType: "text/markdown",
  base64: Buffer.from("target write\n").toString("base64"),
}));
if (!uploaded.ok) throw new Error(`asset upload failed: ${JSON.stringify(uploaded)}`);
const asset = uploaded.data;
const version = sqlite.prepare("SELECT storage_path AS storagePath, checksum FROM user_asset_versions WHERE version_id = ?").get(asset.currentVersionId);
if (!version?.storagePath || !existsSync(path.join(projectRoot, version.storagePath))) throw new Error("uploaded asset was not committed inside target project root");
const bytes = await readFile(path.join(projectRoot, version.storagePath));
if (bytes.toString() !== "target write\n") throw new Error("uploaded asset bytes mismatch");

const automation = await connector.__test__.handleCommand(scope, command("automation.create", {
  name: "target automation smoke",
  schedule: { frequency: "daily", time: "07:30", timezone: "Asia/Shanghai" },
  sourceAsset: { fileName: "source.csv", mimeType: "text/csv", base64: Buffer.from("code,price\n600519,1500\n").toString("base64") },
}));
if (!automation.ok || automation.data?.status !== "paused") throw new Error(`automation create failed: ${JSON.stringify(automation)}`);
const task = automation.data;
for (const relativePath of [task.sourceAsset?.relativePath, task.workingAsset?.relativePath]) {
  if (!relativePath || !existsSync(path.join(projectRoot, relativePath))) throw new Error(`automation asset missing: ${relativePath}`);
}

console.log(JSON.stringify({
  ok: true,
  mode: "mastra_target_write_smoke",
  scope: { userId, projectId, instanceId },
  forgedScopeOverride: "rejected",
  uploadedAsset: { assetId: asset.assetId, versionId: asset.currentVersionId, bytes: bytes.length },
  automation: { taskId: task.taskId, status: task.status, sourceAsset: task.sourceAsset.assetId, workingAsset: task.workingAsset.assetId },
  projectRoot,
  noModelCall: true,
}, null, 2));

function required(value, flag) { if (!value || !path.isAbsolute(value)) throw new Error(`${flag} must be an absolute path`); return path.resolve(value); }
function requiredId(value, flag) { if (!value || /[\\/\0]/.test(value)) throw new Error(`${flag} must be a safe identifier`); return value; }
function parseArgs(argv) { const out = {}; for (let i = 0; i < argv.length; i += 1) { const key = argv[i]; if (["--target-db", "--project-root", "--projects-root", "--user-id", "--project-id", "--instance-id"].includes(key)) out[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i]; } return out; }
