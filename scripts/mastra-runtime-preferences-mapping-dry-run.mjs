#!/usr/bin/env node

/** Read scheduling/preferences YAMLs from a backup and emit a source-only mapping. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

const args = parseArgs(process.argv.slice(2));
const snapshotRoot = requiredAbsolute(args.workspaceSnapshot, "--workspace-snapshot");
const workspaceId = requiredId(args.workspaceId, "--workspace-id");
const userId = requiredId(args.userId, "--user-id");
const instanceId = requiredId(args.instanceId, "--instance-id");
const outputPath = requiredAbsolute(args.out, "--out");
const relativeFiles = ["config/schedules.yaml", "config/watch.yaml", "config/notification.yaml", "config/onboarding_state.yaml"];
await assertDirectory(snapshotRoot, "workspace snapshot root");
await assertOutputOutsideSnapshot(outputPath, snapshotRoot);

const sourceFiles = {};
for (const relativePath of relativeFiles) {
  const absolutePath = path.join(snapshotRoot, workspaceId, relativePath);
  await assertFile(absolutePath, relativePath);
  const raw = await readFile(absolutePath, "utf8");
  const value = parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${relativePath} must contain a mapping`);
  sourceFiles[relativePath] = { value, sha256: sha256(raw), bytes: Buffer.byteLength(raw) };
}

const schedules = sourceFiles["config/schedules.yaml"].value;
const watch = sourceFiles["config/watch.yaml"].value;
const notification = sourceFiles["config/notification.yaml"].value;
const onboarding = sourceFiles["config/onboarding_state.yaml"].value;
const preferences = {
  schedules,
  watch,
  notification,
  onboardingState: onboarding,
  sourceRevision: latestRevision([schedules.last_confirmed_at, watch.last_confirmed_at, notification.last_confirmed_at, onboarding.updated_at, onboarding.completed_at]),
  schedulerActivation: "disabled_until_target_cold_start_and_explicit_enable",
};
const sourceChecksums = Object.fromEntries(Object.entries(sourceFiles).map(([file, item]) => [file, item.sha256]));
const known = new Set(["config/schedules.yaml", "config/watch.yaml", "config/notification.yaml", "config/onboarding_state.yaml"]);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode: "dry_run",
  source: { workspaceId, userId, instanceId, files: Object.fromEntries(Object.entries(sourceFiles).map(([file, item]) => [file, { sha256: item.sha256, bytes: item.bytes }])) },
  mapping: {
    serviceMigration: {
      target: "mastra_runtime_preferences service-owned record",
      fields: preferences,
      sourceChecksums,
      idempotencyKey: `runtime-preferences:${sha256(JSON.stringify(preferences))}`,
      writePolicy: "later import only; scheduler remains disabled in target until cold-start verification",
    },
    retainedSourceFiles: [...known],
  },
  validation: { missingFiles: [], unmappedSourceFiles: [], sourceWriteAttempted: false, targetWriteAttempted: false, conflict: false },
};
await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ ok: true, outputPath, source: report.source, validation: report.validation, sourceRevision: preferences.sourceRevision }, null, 2));

function latestRevision(values) { return values.filter((value) => typeof value === "string" && value.length > 0).sort().at(-1) ?? null; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function requiredAbsolute(value, flag) { if (!value || !path.isAbsolute(value)) throw new Error(`${flag} must be an absolute path`); return path.resolve(value); }
function requiredId(value, flag) { if (!value || /[\\/\0]/.test(value)) throw new Error(`${flag} must be a safe identifier`); return value; }
async function assertFile(value, label) { const info = await lstat(value).catch(() => null); if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`); }
async function assertDirectory(value, label) { const info = await lstat(value).catch(() => null); if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`); }
async function assertOutputOutsideSnapshot(output, rootPath) { const root = await realpath(rootPath); const candidate = path.join(await realpath(path.dirname(output)), path.basename(output)); const relative = path.relative(root, candidate); if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("--out must be outside the workspace snapshot source"); }
function parseArgs(argv) { const values = {}; for (let index = 0; index < argv.length; index += 1) { const key = argv[index]; if (["--workspace-snapshot", "--workspace-id", "--user-id", "--instance-id", "--out"].includes(key)) values[key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = argv[++index]; } return values; }
