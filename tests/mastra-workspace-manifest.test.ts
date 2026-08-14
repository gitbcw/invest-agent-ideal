import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = path.resolve("scripts/mastra-workspace-manifest.mjs");

test("workspace manifest classifies every source file without writing the snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-workspace-manifest-"));
  const source = path.join(root, "snapshot");
  const workspace = path.join(source, "alice");
  const output = path.join(root, "manifest.json");
  try {
    await mkdir(path.join(workspace, ".codex"), { recursive: true });
    await mkdir(path.join(workspace, "config"), { recursive: true });
    await mkdir(path.join(workspace, "reports"), { recursive: true });
    await mkdir(path.join(workspace, "assets"), { recursive: true });
    await writeFile(path.join(workspace, ".codex", "state.sqlite"), "legacy");
    await writeFile(path.join(workspace, "config", "portfolio.yaml"), "holdings: []\n");
    await writeFile(path.join(workspace, "config", "strategy.yaml"), "profile: {}\n");
    await writeFile(path.join(workspace, "reports", "daily.md"), "# report\n");
    await writeFile(path.join(workspace, "assets", "sample.bin"), "bytes");
    await symlink(path.join(workspace, "reports", "daily.md"), path.join(workspace, "report-link"));
    const before = await readFile(path.join(workspace, "reports", "daily.md"), "utf8");
    await execFileAsync(process.execPath, [script, "--workspace-snapshot", source, "--workspace-id", "alice", "--out", output]);
    assert.equal(await readFile(path.join(workspace, "reports", "daily.md"), "utf8"), before);
    const manifest = JSON.parse(await readFile(output, "utf8"));
    assert.equal(manifest.summary.unclassified, 0);
    assert.equal(manifest.entries.find((entry: { sourcePath: string }) => entry.sourcePath === ".codex/state.sqlite").disposition, "discard");
    assert.equal(manifest.entries.find((entry: { sourcePath: string }) => entry.sourcePath === "config/portfolio.yaml").disposition, "service_migration");
    assert.equal(manifest.entries.find((entry: { sourcePath: string }) => entry.sourcePath === "config/strategy.yaml").disposition, "conflict");
    assert.equal(manifest.entries.find((entry: { sourcePath: string }) => entry.sourcePath === "report-link").kind, "symlink");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace manifest refuses an output path inside its snapshot source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-workspace-manifest-"));
  const source = path.join(root, "snapshot");
  try {
    await mkdir(path.join(source, "alice"), { recursive: true });
    await assert.rejects(
      execFileAsync(process.execPath, [script, "--workspace-snapshot", source, "--workspace-id", "alice", "--out", path.join(source, "manifest.json")]),
      /--out must be outside the workspace snapshot source/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
