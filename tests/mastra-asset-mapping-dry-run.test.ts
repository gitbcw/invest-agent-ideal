import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/mastra-asset-mapping-dry-run.mjs");
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

test("asset dry-run classifies library candidates, attachments and non-executable code", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-asset-map-"));
  const snapshot = path.join(root, "snapshot");
  const workspace = path.join(snapshot, "alice");
  const manifest = path.join(root, "manifest.json");
  const output = path.join(root, "mapping.json");
  try {
    await mkdir(path.join(workspace, "reports/daily"), { recursive: true });
    await mkdir(path.join(workspace, "attachments/2026-08-01"), { recursive: true });
    await mkdir(path.join(workspace, "deliveries"), { recursive: true });
    const files = { "reports/daily/report.md": "# report\n", "attachments/2026-08-01/image.png": "png-bytes", "deliveries/tool.py": "print(1)\n" };
    const entries = [{ sourcePath: ".codex/session.json", kind: "file", sizeBytes: 3, sha256: hash(Buffer.from("old")), disposition: "discard", rule: "legacy-runtime-state" }];
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    await writeFile(path.join(workspace, ".codex/session.json"), "old");
    for (const [relativePath, content] of Object.entries(files)) { await writeFile(path.join(workspace, relativePath), content); entries.push({ sourcePath: relativePath, kind: "file", sizeBytes: Buffer.byteLength(content), sha256: hash(Buffer.from(content)), disposition: relativePath.startsWith("attachments") ? "asset_version" : relativePath.startsWith("deliveries") ? "asset_version" : "project_file", rule: "test" }); }
    await writeFile(manifest, JSON.stringify({ source: { workspaceId: "alice", snapshotDigest: "digest", fileCount: entries.length }, summary: { unclassified: 0 }, entries }));
    await execFileAsync(process.execPath, [script, "--workspace-snapshot", snapshot, "--manifest", manifest, "--user-id", "alice", "--instance-id", "invest-agent-alice", "--out", output]);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.validation.fileCount, 3);
    assert.equal(report.validation.codeExecutionEnabled, false);
    assert.equal(report.entries.find((e: any) => e.sourcePath === "reports/daily/report.md").retentionClass, "durable_library_candidate");
    assert.equal(report.entries.find((e: any) => e.sourcePath.includes("attachments")).retentionClass, "reference_only");
    assert.equal(report.entries.find((e: any) => e.sourcePath.endsWith("tool.py")).retentionClass, "project_file_non_executable");
  } finally { await rm(root, { recursive: true, force: true }); }
});
