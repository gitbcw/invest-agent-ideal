#!/usr/bin/env node

/**
 * Inventory daily plans and JSONL review/memory data from a backup snapshot.
 * This is deliberately a read-only mapping stage: no reports become tasks and
 * no target database or project file is written.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

const args = parseArgs(process.argv.slice(2));
const snapshotRoot = requiredAbsolute(args.workspaceSnapshot, "--workspace-snapshot");
const workspaceId = requiredId(args.workspaceId, "--workspace-id");
const userId = requiredId(args.userId, "--user-id");
const instanceId = requiredId(args.instanceId, "--instance-id");
const outputPath = requiredAbsolute(args.out, "--out");
await assertDirectory(snapshotRoot, "workspace snapshot root");
await assertOutputOutsideSnapshot(outputPath, snapshotRoot);

const planDir = path.join(snapshotRoot, workspaceId, "plans", "daily");
const planEntries = [];
for (const file of (await readdir(planDir).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error))).filter((name) => /^\d{4}-\d{2}-\d{2}\.yaml$/.test(name)).sort()) {
  const relativePath = `plans/daily/${file}`;
  const absolutePath = path.join(snapshotRoot, workspaceId, relativePath);
  const raw = await readFile(absolutePath, "utf8");
  const value = parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${relativePath} must contain a mapping`);
  const date = file.slice(0, 10);
  if (value.plan_date !== date) throw new Error(`MASTRA_DAILY_PLAN_DATE_MISMATCH: ${relativePath}`);
  planEntries.push({ relativePath, planDate: date, sha256: sha256(raw), bytes: Buffer.byteLength(raw), keys: Object.keys(value), disposition: "service_state" });
}

const memoryDisposition = {
  "behavior_events.jsonl": "service_event",
  "decisions.jsonl": "service_event",
  "change_log.jsonl": "service_event",
  "source_events.jsonl": "service_event",
  "method_changes.jsonl": "method_change_service_migration",
  "review_viewpoints.jsonl": "review_viewpoint_service_state",
  "audit_events.jsonl": "archive_audit_source",
  "feedback.jsonl": "archive_feedback_source",
  "task_runs.jsonl": "archive_task_run_source",
};
const memoryEntries = [];
const memoryDir = path.join(snapshotRoot, workspaceId, "memory");
for (const file of Object.keys(memoryDisposition)) {
  const relativePath = `memory/${file}`;
  const absolutePath = path.join(snapshotRoot, workspaceId, relativePath);
  const raw = await readFile(absolutePath, "utf8").catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (raw === null) continue;
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const typeCounts = {};
  const keys = new Set();
  const ids = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    let value;
    try { value = JSON.parse(lines[index]); } catch { throw new Error(`MASTRA_MEMORY_JSONL_PARSE_ERROR: ${relativePath}:${index + 1}`); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`MASTRA_MEMORY_JSONL_RECORD_INVALID: ${relativePath}:${index + 1}`);
    for (const key of Object.keys(value)) keys.add(key);
    const type = String(value.event_type ?? value.type ?? value.category ?? "unknown");
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    const eventKey = sha256(`${relativePath}\0${index + 1}\0${lines[index]}`);
    if (ids.has(eventKey)) throw new Error(`MASTRA_MEMORY_DUPLICATE_SOURCE_KEY: ${relativePath}:${index + 1}`);
    ids.add(eventKey);
  }
  memoryEntries.push({ relativePath, disposition: memoryDisposition[file], lines: lines.length, sha256: sha256(raw), typeCounts, keys: [...keys].sort(), sourceKeysUnique: true });
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode: "dry_run",
  source: { workspaceId, userId, instanceId },
  mapping: {
    dailyPlans: { target: "service-owned daily plan state (upsert by plan_date)", entries: planEntries, historyDoesNotCreateAutomationTasks: true },
    memory: memoryEntries,
    userDecisionRequired: [],
  },
  validation: {
    dailyPlanCount: planEntries.length,
    memoryFileCount: memoryEntries.length,
    memoryLineCount: memoryEntries.reduce((sum, item) => sum + item.lines, 0),
    parseErrors: 0,
    sourceWriteAttempted: false,
    targetWriteAttempted: false,
    conflict: false,
    unclassified: 0,
  },
};
await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ ok: true, outputPath, source: report.source, validation: report.validation }, null, 2));

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function requiredAbsolute(value, flag) { if (!value || !path.isAbsolute(value)) throw new Error(`${flag} must be an absolute path`); return path.resolve(value); }
function requiredId(value, flag) { if (!value || /[\\/\0]/.test(value)) throw new Error(`${flag} must be a safe identifier`); return value; }
async function assertDirectory(value, label) { const info = await lstat(value).catch(() => null); if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`); }
async function assertOutputOutsideSnapshot(output, root) { const canonicalRoot = await realpath(root); const candidate = path.join(await realpath(path.dirname(output)), path.basename(output)); const relative = path.relative(canonicalRoot, candidate); if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("--out must be outside the workspace snapshot source"); }
function parseArgs(argv) { const values = {}; for (let index = 0; index < argv.length; index += 1) { const key = argv[index]; if (["--workspace-snapshot", "--workspace-id", "--user-id", "--instance-id", "--out"].includes(key)) values[key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = argv[++index]; } return values; }
