#!/usr/bin/env node

/** Classify user-visible snapshot files without copying or promoting them. */
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const snapshotRoot = requiredAbsolute(args.workspaceSnapshot, "--workspace-snapshot");
const manifestPath = requiredAbsolute(args.manifest, "--manifest");
const outputPath = requiredAbsolute(args.out, "--out");
const userId = requiredId(args.userId, "--user-id");
const instanceId = requiredId(args.instanceId, "--instance-id");
const projectId = args.projectId ? requiredId(args.projectId, "--project-id") : "invest-agent";
await assertDirectory(snapshotRoot, "workspace snapshot root");
await assertFile(manifestPath, "workspace manifest");
await assertOutputOutsideSnapshot(outputPath, snapshotRoot);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest?.source?.workspaceId === undefined || !Array.isArray(manifest.entries) || manifest.summary?.unclassified !== 0) throw new Error("manifest must be complete and classified");

const entries = [];
for (const entry of manifest.entries) {
  if (entry.kind !== "file") continue;
  // Structured service migrations and legacy discard/archive entries have
  // their own ownership or are intentionally excluded. Do not copy them into
  // the generic asset ledger (especially .codex/.state runtime artifacts).
  if (entry.disposition !== "asset_version" && entry.disposition !== "project_file") continue;
  const sourcePath = entry.sourcePath;
  const root = sourcePath.split("/")[0];
  const ext = path.posix.extname(sourcePath).toLowerCase();
  const mimeType = mimeFor(ext);
  const supportedLibrary = new Set(["text/markdown", "text/html", "text/plain", "text/csv", "application/json", "application/pdf", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "image/png", "image/jpeg", "image/webp", "image/svg+xml"]).has(mimeType);
  const curatedReport = root === "reports" && ["daily", "weekly", "monthly", "company", "html", "metrics", "memory"].includes(sourcePath.split("/")[1]);
  const isAttachment = root === "attachments";
  const isCode = [".py", ".js", ".ts", ".sh", ".zip"].includes(ext);
  let disposition = entry.disposition;
  let retentionClass = "project_file";
  let libraryEligible = false;
  if (isAttachment) { disposition = "asset_version"; retentionClass = "reference_only"; }
  else if (root === "deliveries") { disposition = "asset_version"; retentionClass = supportedLibrary && !isCode ? "durable_library_candidate" : "project_file_non_executable"; libraryEligible = supportedLibrary && !isCode; }
  else if (entry.disposition === "asset_version" || curatedReport) { disposition = "asset_version"; retentionClass = supportedLibrary && !isCode ? "durable_library_candidate" : "reference_only"; libraryEligible = supportedLibrary && !isCode; }
  else if (entry.disposition === "project_file") { disposition = "project_file"; retentionClass = isCode ? "project_file_non_executable" : "project_file"; }
  const raw = await readFile(path.join(snapshotRoot, manifest.source.workspaceId, sourcePath));
  if (sha256(raw) !== entry.sha256) throw new Error(`MASTRA_ASSET_SOURCE_CHANGED: ${sourcePath}`);
  entries.push({ sourcePath, disposition, retentionClass, mimeType, sizeBytes: raw.length, sha256: entry.sha256, libraryEligible, executable: false, targetPath: `assets/migrated/${sourcePath}` });
}
const summary = {};
for (const entry of entries) summary[entry.retentionClass] = (summary[entry.retentionClass] ?? 0) + 1;
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), mode: "dry_run", source: { workspaceId: manifest.source.workspaceId, userId, projectId, instanceId, manifestDigest: manifest.source.snapshotDigest }, entries, summary, validation: { fileCount: entries.length, sourceWriteAttempted: false, targetWriteAttempted: false, conflict: false, unclassified: 0, codeExecutionEnabled: false } };
await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ ok: true, outputPath, summary, validation: report.validation }, null, 2));

function mimeFor(ext) { return { ".md": "text/markdown", ".html": "text/html", ".htm": "text/html", ".txt": "text/plain", ".json": "application/json", ".csv": "text/csv", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".py": "text/x-python", ".js": "text/javascript", ".ts": "text/typescript", ".sh": "application/x-sh", ".zip": "application/zip", ".yaml": "application/yaml", ".yml": "application/yaml" }[ext] ?? "application/octet-stream"; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function requiredAbsolute(value, flag) { if (!value || !path.isAbsolute(value)) throw new Error(`${flag} must be an absolute path`); return path.resolve(value); }
function requiredId(value, flag) { if (!value || /[\\/\0]/.test(value)) throw new Error(`${flag} must be a safe identifier`); return value; }
async function assertFile(value, label) { const info = await lstat(value).catch(() => null); if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label} must be a regular file`); }
async function assertDirectory(value, label) { const info = await lstat(value).catch(() => null); if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`); }
async function assertOutputOutsideSnapshot(output, root) { const canonicalRoot = await realpath(root); const candidate = path.join(await realpath(path.dirname(output)), path.basename(output)); const relative = path.relative(canonicalRoot, candidate); if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("--out must be outside the workspace snapshot source"); }
function parseArgs(argv) { const values = {}; for (let index = 0; index < argv.length; index += 1) { const key = argv[index]; if (["--workspace-snapshot", "--manifest", "--out", "--user-id", "--instance-id", "--project-id"].includes(key)) values[key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = argv[++index]; } return values; }
