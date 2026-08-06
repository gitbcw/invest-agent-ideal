import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-user-assets-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "assets.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
mkdir(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const fixture = (async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const assets = await import("../src/services/user-assets.js");
  const workspace = await import("../src/lib/workspace.js");
  return { db, assets, workspace };
})();

const scopeA = { userId: "asset-user-a", projectId: "invest-agent", instanceId: "asset-instance-a" };
const scopeB = { userId: "asset-user-b", projectId: "invest-agent", instanceId: "asset-instance-b" };

test("initializes additive asset tables and remains idempotent", async () => {
  const { db } = await fixture;
  db.initDb();
  const tables = db.sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('user_assets','user_asset_versions','automation_task_asset_bindings') ORDER BY name",
  ).all() as Array<{ name: string }>;
  assert.deepEqual(tables.map((row) => row.name), ["automation_task_asset_bindings", "user_asset_versions", "user_assets"]);
  assert.ok(db.sqlite.prepare("SELECT key FROM schema_migrations WHERE key = 'user_asset_library_v1'").get());
});

test("creates, reads, versions, restores, renames and archives an asset", async () => {
  const { assets, workspace } = await fixture;
  const first = await assets.createUserAsset({
    ...scopeA,
    name: "复盘表",
    fileName: "review.csv",
    mimeType: "text/csv",
    bytes: Buffer.from("date,note\n2026-08-05,first\n"),
  });
  assert.equal(first.status, "active");
  assert.equal(first.currentVersion?.format, "csv");
  assert.match(first.currentVersion?.storagePath || "", /^assets\/asset_.+\/versions\/version_.+\/review\.csv$/);
  const rootPath = workspace.resolveWorkspacePath(scopeA.userId);
  assert.equal(readFileSync(path.join(rootPath, first.currentVersion!.storagePath), "utf8"), "date,note\n2026-08-05,first\n");

  const oldVersionId = first.currentVersionId!;
  const updated = await assets.uploadUserAssetVersion({
    ...scopeA,
    assetId: first.assetId,
    fileName: "review.csv",
    mimeType: "text/csv",
    bytes: Buffer.from("date,note\n2026-08-05,second\n"),
    expectedVersionId: oldVersionId,
    source: "conversation",
    conversationId: "conversation-1",
  });
  assert.notEqual(updated.currentVersionId, oldVersionId);
  assert.equal((await assets.readUserAssetVersion({ ...scopeA, assetId: first.assetId, versionId: oldVersionId })).bytes.toString(), "date,note\n2026-08-05,first\n");

  const restored = await assets.restoreUserAssetVersion({
    ...scopeA,
    assetId: first.assetId,
    versionId: oldVersionId,
    expectedVersionId: updated.currentVersionId,
  });
  assert.notEqual(restored.currentVersionId, oldVersionId);
  assert.equal(restored.currentVersion?.source, "restore");
  assert.equal(restored.currentVersion?.parentVersionId, oldVersionId);
  assert.equal((await assets.readCurrentUserAsset({ ...scopeA, assetId: first.assetId })).bytes.toString(), "date,note\n2026-08-05,first\n");
  assert.equal((await assets.listUserAssetVersions({ ...scopeA, assetId: first.assetId })).length, 3);

  const renamed = await assets.renameUserAsset({ ...scopeA, assetId: first.assetId, name: "已命名复盘表" });
  assert.equal(renamed.name, "已命名复盘表");
  const archived = await assets.archiveUserAsset({ ...scopeA, assetId: first.assetId });
  assert.equal(archived.status, "archived");
  await assert.rejects(
    () => assets.uploadUserAssetVersion({ ...scopeA, assetId: first.assetId, fileName: "review.csv", bytes: Buffer.from("a,b\n1,2\n") }),
    (error: unknown) => (error as { code?: string }).code === "ASSET_ARCHIVED",
  );
  await assert.rejects(
    () => assets.renameUserAsset({ ...scopeA, assetId: first.assetId, name: "归档后不应改名" }),
    (error: unknown) => (error as { code?: string }).code === "ASSET_ARCHIVED",
  );
  const lifecycle = (await fixture).db.sqlite.prepare(
    "SELECT COUNT(*) AS count FROM file_lifecycle_events WHERE entity_type = 'asset' AND entity_id = ?",
  ).get(first.assetId) as { count: number };
  assert.ok(lifecycle.count >= 4);
});

test("enforces all three scope fields and hides cross-scope assets", async () => {
  const { assets } = await fixture;
  const created = await assets.createUserAsset({
    ...scopeA,
    fileName: "scope.md",
    mimeType: "text/markdown",
    bytes: Buffer.from("# private\n"),
  });
  assert.equal((await assets.listUserAssets(scopeB)).length, 0);
  await assert.rejects(
    () => assets.getUserAsset({ ...scopeB, assetId: created.assetId }).then((value) => {
      if (value) throw new Error("cross-scope asset was returned");
    }),
    (error: unknown) => (error as { code?: string }).code === "ASSET_SCOPE_MISMATCH",
  );
  await assert.rejects(
    () => assets.readCurrentUserAsset({ ...scopeA, projectId: "other-project", assetId: created.assetId }),
    (error: unknown) => (error as { code?: string }).code === "ASSET_SCOPE_MISMATCH",
  );
});

test("rejects unsafe names, MIME/content mismatch, symlinks and checksum tampering", async () => {
  const { assets, workspace } = await fixture;
  await assert.rejects(
    () => assets.createUserAsset({ ...scopeA, fileName: "../escape.csv", bytes: Buffer.from("a,b\n1,2\n") }),
    (error: unknown) => (error as { code?: string }).code === "ASSET_INVALID_NAME",
  );
  await assert.rejects(
    () => assets.createUserAsset({ ...scopeA, fileName: "bad.png", mimeType: "text/plain", bytes: Buffer.from("not png") }),
    (error: unknown) => (error as { code?: string }).code === "ASSET_MIME_MISMATCH",
  );
  await assert.rejects(
    () => assets.createUserAsset({ ...scopeA, fileName: "bad.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes: Buffer.from("not xlsx") }),
    (error: unknown) => (error as { code?: string }).code === "ASSET_INVALID_CONTENT",
  );

  const created = await assets.createUserAsset({ ...scopeA, fileName: "tamper.md", bytes: Buffer.from("# ok\n") });
  const filePath = path.join(workspace.resolveWorkspacePath(scopeA.userId), created.currentVersion!.storagePath);
  writeFileSync(filePath, "# changed\n");
  await assert.rejects(
    () => assets.readCurrentUserAsset({ ...scopeA, assetId: created.assetId }),
    (error: unknown) => (error as { code?: string }).code === "ASSET_CHECKSUM_MISMATCH",
  );

  const outside = path.join(root, "outside.txt");
  writeFileSync(outside, "outside");
  const linkPath = path.join(workspace.resolveWorkspacePath(scopeA.userId), "assets", "symlink.md");
  await mkdir(path.dirname(linkPath), { recursive: true });
  symlinkSync(outside, linkPath);
  assert.equal(existsSync(linkPath), true);
  const row = (await import("../src/db/index.js")).sqlite.prepare(
    "SELECT asset_id AS assetId, current_version_id AS versionId FROM user_assets WHERE name = 'tamper'",
  ).get() as { assetId: string; versionId: string };
  assert.ok(row.assetId && row.versionId);

  const symlinked = await assets.createUserAsset({ ...scopeA, fileName: "symlinked.md", bytes: Buffer.from("# safe\n") });
  const symlinkTarget = path.join(workspace.resolveWorkspacePath(scopeA.userId), symlinked.currentVersion!.storagePath);
  const outsideVersion = path.join(root, "outside-version.md");
  writeFileSync(outsideVersion, "# outside\n");
  unlinkSync(symlinkTarget);
  symlinkSync(outsideVersion, symlinkTarget);
  await assert.rejects(
    () => assets.readCurrentUserAsset({ ...scopeA, assetId: symlinked.assetId }),
    (error: unknown) => (error as { code?: string }).code === "ASSET_NOT_FOUND",
  );
});

test("idempotency replays the same asset and rejects stale version heads", async () => {
  const { assets } = await fixture;
  const input = {
    ...scopeB,
    fileName: "idempotent.md",
    bytes: Buffer.from("# once\n"),
    idempotencyKey: "asset-create-once",
  };
  const first = await assets.createUserAsset(input);
  const replay = await assets.createUserAsset(input);
  assert.equal(replay.assetId, first.assetId);
  await assert.rejects(
    () => assets.uploadUserAssetVersion({
      ...scopeB,
      assetId: first.assetId,
      fileName: "idempotent.md",
      bytes: Buffer.from("# stale\n"),
      expectedVersionId: "version-stale",
    }),
    (error: unknown) => (error as { code?: string }).code === "ASSET_VERSION_CONFLICT",
  );
});
