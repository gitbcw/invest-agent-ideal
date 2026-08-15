import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-user-asset-legacy-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "assets.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
mkdir(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const scope = {
  userId: "legacy-format-user",
  projectId: "invest-agent",
  instanceId: "legacy-format-instance",
};

test("migrated yaml/jsonl asset versions list and read without ASSET_COMMIT_FAILED", async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const { registerTestProject } = await import("./helpers/mastra-project.js");
  const projectRoot = await registerTestProject(scope);
  const assets = await import("../src/services/user-assets.js");

  // Mimic the real-data migration: asset + version rows written directly with
  // legacy workspace-config formats, storage bytes on disk.
  const seed = [
    { assetId: "ast_legacy_yaml", versionId: "ver_legacy_yaml", fileName: "strategy.yaml", format: "yaml", mime: "text/yaml", bytes: "style: steady\n" },
    { assetId: "ast_legacy_jsonl", versionId: "ver_legacy_jsonl", fileName: "decisions.jsonl", format: "jsonl", mime: "application/jsonl", bytes: "{\"a\":1}\n" },
  ];
  for (const item of seed) {
    db.sqlite
      .prepare(
        `INSERT INTO user_assets (
           asset_id, user_id, project_id, instance_id, name, status, current_version_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
      )
      .run(item.assetId, scope.userId, scope.projectId, scope.instanceId, item.fileName, item.versionId, "2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
    const storagePath = `assets/${item.assetId}/versions/${item.versionId}/${item.fileName}`;
    db.sqlite
      .prepare(
        `INSERT INTO user_asset_versions (
           version_id, asset_id, user_id, project_id, instance_id, file_name, format, mime_type,
           version_number, size_bytes, checksum, storage_path, source, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'system', ?)`
      )
      .run(item.versionId, item.assetId, scope.userId, scope.projectId, scope.instanceId, item.fileName, item.format, item.mime, item.bytes.length, createHash("sha256").update(item.bytes).digest("hex"), storagePath, "2026-08-10T00:00:00.000Z");
    await mkdir(path.join(projectRoot, path.dirname(storagePath)), { recursive: true });
    await writeFile(path.join(projectRoot, storagePath), item.bytes);
  }

  // Regression: listUserAssets used to throw ASSET_COMMIT_FAILED "asset format
  // is corrupt" on the first legacy version row, failing the whole page.
  const listed = await assets.listUserAssets({ ...scope });
  assert.deepEqual(listed.map((asset) => asset.currentVersion?.format).sort(), ["jsonl", "yaml"]);

  const read = await assets.readCurrentUserAsset({ ...scope, assetId: "ast_legacy_yaml" });
  assert.equal(Buffer.from(read.bytes).toString(), "style: steady\n");
});

test("new yaml uploads take the normal validated path", async () => {
  const db = await import("../src/db/index.js");
  const assets = await import("../src/services/user-assets.js");
  const created = await assets.createUserAsset({
    ...scope,
    name: "method",
    fileName: "method.yaml",
    mimeType: "text/yaml",
    bytes: new TextEncoder().encode("rules:\n  - keep it simple\n"),
  });
  assert.equal(created.currentVersion?.format, "yaml");
  assert.equal(created.currentVersion?.mimeType, "text/yaml");
});
