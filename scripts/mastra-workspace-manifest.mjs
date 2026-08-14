#!/usr/bin/env node

/**
 * Create a read-only, source-relative classification manifest for one backed-up
 * Workspace. It never imports data and refuses to write inside the source.
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const snapshotRoot = requiredAbsolute(args.workspaceSnapshot, "--workspace-snapshot");
const workspaceId = requiredId(args.workspaceId, "--workspace-id");
const outputPath = requiredAbsolute(args.out, "--out");
const source = path.join(snapshotRoot, workspaceId);

await assertDirectory(snapshotRoot, "workspace snapshot root");
await assertDirectory(source, "selected workspace");
await assertOutputOutsideSnapshot(outputPath, snapshotRoot);
await mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });

const entries = [];
await collect(source, source, entries);
entries.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
const summary = summarize(entries);
if (summary.unclassified !== 0) throw new Error(`manifest contains ${summary.unclassified} unclassified paths`);

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: { workspaceId, snapshotDigest: digest(entries), fileCount: entries.length },
  summary,
  entries,
};
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ ok: true, workspaceId, outputPath, summary, snapshotDigest: manifest.source.snapshotDigest }, null, 2));

async function collect(root, current, entries) {
  for (const name of (await readdir(current)).sort()) {
    const candidate = path.join(current, name);
    const info = await lstat(candidate);
    const sourcePath = path.relative(root, candidate).split(path.sep).join("/");
    if (info.isDirectory() && !info.isSymbolicLink()) {
      await collect(root, candidate, entries);
      continue;
    }
    entries.push({
      sourcePath,
      kind: info.isSymbolicLink() ? "symlink" : "file",
      sizeBytes: info.size,
      sha256: info.isSymbolicLink() ? null : sha256(await readFile(candidate)),
      ...classify(sourcePath),
    });
  }
}

function classify(sourcePath) {
  const first = sourcePath.split("/")[0];
  if (sourcePath === "AGENTS.md") return decision("archive", "legacy-agent-instructions");
  if (first === ".codex" || first === ".agents" || first === ".state") return decision("discard", "legacy-runtime-state");
  if (first === ".invest-agent") return decision("archive", "legacy-workspace-compatibility");
  if (first === ".git") return decision("archive", "nested-git-provenance");
  if (sourcePath === "config/portfolio.yaml" || sourcePath === "config/schedules.yaml" || sourcePath === "config/watch.yaml"
    || sourcePath === "config/notification.yaml" || sourcePath === "config/onboarding_state.yaml") return decision("service_migration", "service-owned-business-state");
  if (sourcePath === "config/strategy.yaml") return decision("conflict", "split-profile-and-project-methods-required");
  if (first === "plans" || first === "memory") return decision("service_migration", "service-owned-state-or-event-input");
  if (first === "attachments" || first === "assets" || first === "deliveries") return decision("asset_version", "asset-library-import-input");
  if (first === "automations") return decision("automation_template", "automation-template-or-staging-input");
  if (first === "skills") return decision("project_file", "user-project-skill-review-required-before-loading");
  if (first === "reports" || first === "financials" || first === "knowledge" || first === "templates" || first === "schemas"
    || first === "docs" || first === "indicators" || first === "src" || first === "tests") return decision("project_file", "user-project-file");
  if (["README.md", "pyproject.toml", "requirements.txt"].includes(sourcePath)) return decision("project_file", "user-project-file");
  if (first === "config") return decision("project_file", "project-policy-or-template-file");
  return decision("project_file", "default-user-project-file");
}

function decision(disposition, rule) { return { disposition, rule }; }

function summarize(entries) {
  const byDisposition = {};
  const byRule = {};
  for (const entry of entries) {
    byDisposition[entry.disposition] = (byDisposition[entry.disposition] ?? 0) + 1;
    byRule[entry.rule] = (byRule[entry.rule] ?? 0) + 1;
  }
  return { byDisposition, byRule, unclassified: entries.filter((entry) => !entry.disposition).length };
}

function digest(entries) { return sha256(Buffer.from(entries.map((entry) => `${entry.sourcePath}\0${entry.kind}\0${entry.sizeBytes}\0${entry.sha256 ?? ""}\n`).join(""))); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function requiredAbsolute(value, flag) { if (!value || !path.isAbsolute(value)) throw new Error(`${flag} must be an absolute path`); return path.resolve(value); }
function requiredId(value, flag) { if (!value || /[\\/\0]/.test(value)) throw new Error(`${flag} must be a safe workspace identifier`); return value; }
async function assertDirectory(value, label) { const info = await lstat(value).catch(() => null); if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a non-symlink directory`); }
async function assertOutputOutsideSnapshot(output, snapshotRoot) {
  const root = await realpath(snapshotRoot);
  // macOS commonly exposes the same directory as /var and /private/var.
  // Canonicalize the existing parent before comparing an output that does not
  // yet exist, otherwise an in-snapshot write can look external.
  const candidate = path.join(await realpath(path.dirname(output)), path.basename(output));
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("--out must be outside the workspace snapshot source");
  }
}
function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (["--workspace-snapshot", "--workspace-id", "--out"].includes(key)) values[key.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = argv[++index];
  }
  return values;
}
