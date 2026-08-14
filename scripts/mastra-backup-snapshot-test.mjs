#!/usr/bin/env node

/**
 * Stage a production backup into a disposable tree for Mastra validation.
 * The backup source is never used as a writable runtime path.
 */
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, readlink, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const source = requiredPath(args.snapshot, "--snapshot");
const workspaceSource = args.workspaceSnapshot ? requiredPath(args.workspaceSnapshot, "--workspace-snapshot") : null;
const workspaceId = args.workspaceId || "mg";
const command = args.command;

await assertDirectory(source, "backup snapshot");
if (workspaceSource) await assertDirectory(workspaceSource, "workspace snapshot");
const sourceBefore = await treeDigest([source, ...(workspaceSource ? [workspaceSource] : [])]);

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "invest-agent-mastra-backup-"));
const runtimeRoot = path.join(tempRoot, "runtime");
const workspaceRoot = path.join(tempRoot, "workspaces");
const reviewsRoot = path.join(tempRoot, "reviews");
const dbPath = path.join(tempRoot, "invest-agent.db");
const portalDbPath = path.join(tempRoot, "portal.db");
const sourceRuntimeRoot = path.join(source, "runtime-data");
if (!(await exists(sourceRuntimeRoot))) throw new Error(`snapshot missing ${sourceRuntimeRoot}`);
await cp(sourceRuntimeRoot, runtimeRoot, { recursive: true, force: false, errorOnExist: true });
const runtimeDb = path.join(source, "databases", "runtime.db");
const portalDb = path.join(source, "databases", "portal.db");
if (!(await exists(runtimeDb))) throw new Error(`snapshot missing ${runtimeDb}`);
if (!(await exists(portalDb))) throw new Error(`snapshot missing ${portalDb}`);
await cp(runtimeDb, dbPath);
await cp(portalDb, portalDbPath);
if (workspaceSource) {
  const selected = path.join(workspaceSource, workspaceId);
  if (!(await exists(selected))) throw new Error(`workspace snapshot missing ${selected}`);
  await cp(selected, path.join(workspaceRoot, workspaceId), { recursive: true, force: false, errorOnExist: true });
}
for (const p of [runtimeRoot, workspaceRoot, reviewsRoot, dbPath, portalDbPath]) assertSafeRuntimePath(p, source, workspaceSource);
const env = {
  DB_PATH: dbPath,
  PORTAL_DB_PATH: portalDbPath,
  WORKSPACE_ROOT: workspaceRoot,
  RUNTIME_DATA_ROOT: runtimeRoot,
  REVIEWS_ROOT: reviewsRoot,
  BACKUP_SNAPSHOT_SOURCE: source,
  MAS_TRA_BACKUP_TEST_ROOT: tempRoot,
};
await writeFile(path.join(tempRoot, "environment.json"), JSON.stringify(env, null, 2) + "\n");
console.log(JSON.stringify({ ok: true, tempRoot, workspaceId, env, sourceDigest: sourceBefore }, null, 2));

let commandStatus = 0;
if (command?.length) {
  const { spawn } = await import("node:child_process");
  commandStatus = await new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { stdio: "inherit", env: { ...process.env, ...env } });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
const sourceAfter = await treeDigest([source, ...(workspaceSource ? [workspaceSource] : [])]);
if (sourceBefore !== sourceAfter) throw new Error("backup source changed during test; refusing success");
if (!args.keep) await rm(tempRoot, { recursive: true, force: true });
process.exitCode = commandStatus;

function parseArgs(argv) {
  const out = { command: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--") { out.command = argv.slice(i + 1); break; }
    if (a === "--keep") { out.keep = true; continue; }
    if (a === "--snapshot") out.snapshot = argv[++i];
    else if (a === "--workspace-snapshot") out.workspaceSnapshot = argv[++i];
    else if (a === "--workspace-id") out.workspaceId = argv[++i];
  }
  return out;
}
function requiredPath(value, flag) { if (!value || !path.isAbsolute(value)) throw new Error(`${flag} must be an absolute path`); return path.resolve(value); }
async function assertDirectory(p, label) { if (!(await exists(p)) || !(await stat(p)).isDirectory()) throw new Error(`${label} is not a directory: ${p}`); }
async function exists(p) { try { await stat(p); return true; } catch { return false; } }
function assertSafeRuntimePath(candidate, ...sources) { const c = path.resolve(candidate); for (const s of sources.filter(Boolean)) { const src = path.resolve(s); if (c === src || c.startsWith(src + path.sep)) throw new Error(`runtime path must not be inside backup source: ${c}`); } }
async function treeDigest(roots) { const h = createHash("sha256"); for (const root of roots) await digest(root, root, h); return h.digest("hex"); }
async function digest(root, current, h) { const info = await lstat(current); h.update(`${path.relative(root, current)}:${info.mode}:${info.size}:${info.mtimeMs}\n`); if (info.isSymbolicLink()) { h.update(`link:${await readlink(current)}\n`); return; } if (!info.isDirectory()) { h.update(await readFile(current)); return; } for (const entry of (await readdir(current)).sort()) await digest(root, path.join(current, entry), h); }
