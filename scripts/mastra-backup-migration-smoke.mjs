#!/usr/bin/env node

import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const snapshotArg = process.argv[2];
const workspaceSnapshotArg = process.argv[3];
const snapshot = path.resolve(snapshotArg || "");
const workspaceSnapshot = path.resolve(workspaceSnapshotArg || "");
const workspaceId = process.argv[4] || "mg";
if (!snapshotArg || !workspaceSnapshotArg || !path.isAbsolute(snapshot) || !path.isAbsolute(workspaceSnapshot)) {
  throw new Error("usage: mastra-backup-migration-smoke <snapshot> <workspace-snapshot> [workspace-id]");
}
const sourceDigest = await digestRoots([snapshot, workspaceSnapshot]);
const root = await mkdtemp(path.join(os.tmpdir(), "invest-agent-mastra-migration-"));
const sourceRoot = path.join(root, "source");
const targetRoot = path.join(root, "target");
try {
  await cp(snapshot, sourceRoot, { recursive: true });
  await cp(snapshot, targetRoot, { recursive: true });
  await cp(path.join(workspaceSnapshot, workspaceId), path.join(sourceRoot, "workspaces", workspaceId), { recursive: true });
  await cp(path.join(workspaceSnapshot, workspaceId), path.join(targetRoot, "workspaces", workspaceId), { recursive: true });
  const sourceDb = new Database(path.join(sourceRoot, "databases", "runtime.db"), { readonly: true });
  const targetDbPath = path.join(targetRoot, "databases", "runtime.db");
  const targetDb = new Database(targetDbPath);
  targetDb.pragma("foreign_keys = ON");
  const tables = ["users", "ai_instances", "conversation_sessions", "conversation_messages", "agent_traces", "portfolio", "watchlist", "stock_plans"];
  const counts = Object.fromEntries(tables.map((table) => [table, {
    source: sourceDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
    target: targetDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
  }]));
  for (const [table, value] of Object.entries(counts)) {
    if (value.source !== value.target) throw new Error(`count mismatch for ${table}`);
  }
  const targetWorkspace = path.join(targetRoot, "workspaces", workspaceId);
  if (!(await exists(targetWorkspace))) throw new Error(`target workspace missing: ${targetWorkspace}`);
  const marker = path.join(targetWorkspace, ".invest-agent", `migration-smoke-${Date.now()}.json`);
  await writeFile(marker, JSON.stringify({ source: "backup-snapshot", workspaceId, at: new Date().toISOString() }) + "\n");
  targetDb.close();
  sourceDb.close();
  const afterDigest = await digestRoots([snapshot, workspaceSnapshot]);
  if (sourceDigest !== afterDigest) throw new Error("backup source changed during migration smoke");
  console.log(JSON.stringify({ ok: true, workspaceId, counts, sourceUnchanged: true, targetRoot }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}

async function exists(p) { try { await stat(p); return true; } catch { return false; } }
async function digestRoots(roots) { const hash = createHash("sha256"); for (const root of roots) await digest(root, root, hash); return hash.digest("hex"); }
async function digest(root, current, hash) { const info = await lstat(current); hash.update(`${path.relative(root, current)}:${info.mode}:${info.size}:${info.mtimeMs}\n`); if (info.isSymbolicLink()) return; if (!info.isDirectory()) { hash.update(await readFile(current)); return; } for (const entry of (await readdir(current)).sort()) await digest(root, path.join(current, entry), hash); }
