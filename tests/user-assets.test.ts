import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

test("deleting an asset removes its versions and releases storage", async () => {
  const { assets, workspace } = await fixture;
  const quota = await import("../src/services/user-storage-quota.js");
  const created = await assets.createUserAsset({
    ...scopeA,
    fileName: "delete-me.csv",
    mimeType: "text/csv",
    bytes: Buffer.from("week,value\n2026-W31,1\n"),
  });
  const firstPath = created.currentVersion!.storagePath;
  const updated = await assets.uploadUserAssetVersion({
    ...scopeA,
    assetId: created.assetId,
    fileName: "delete-me.csv",
    mimeType: "text/csv",
    bytes: Buffer.from("week,value\n2026-W32,2\n"),
    expectedVersionId: created.currentVersionId,
  });
  const secondPath = updated.currentVersion!.storagePath;
  const before = quota.getStorageUsage(scopeA).usedBytes;
  const deleted = await assets.deleteUserAsset({ ...scopeA, assetId: created.assetId });
  assert.equal(deleted.deletedVersions, 2);
  assert.equal(await assets.getUserAsset({ ...scopeA, assetId: created.assetId }), null);
  assert.ok(quota.getStorageUsage(scopeA).usedBytes < before);
  const rootPath = workspace.resolveWorkspacePath(scopeA.userId);
  assert.equal(existsSync(path.join(rootPath, firstPath)), false);
  assert.equal(existsSync(path.join(rootPath, secondPath)), false);
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

test("enforces the 10MB file boundary and exposes scope usage", async () => {
  const { assets } = await fixture;
  const scope = { userId: "quota-user", projectId: "quota-project", instanceId: "quota-instance" };
  await assert.rejects(
    () => assets.createUserAsset({ ...scope, fileName: "too-large.md", bytes: Buffer.alloc(10 * 1024 * 1024 + 1) }),
    (error: unknown) => (error as { code?: string }).code === "ASSET_TOO_LARGE",
  );
  await assets.createUserAsset({ ...scope, fileName: "small.md", bytes: Buffer.from("# small\n") });
  const quota = await import("../src/services/user-storage-quota.js");
  const usage = quota.getStorageUsage(scope);
  assert.equal(usage.limitBytes, 200 * 1024 * 1024);
  assert.equal(usage.usedBytes, 8);
  assert.equal(usage.reservedBytes, 0);
});

test("normalizes images only above 1MiB", async () => {
  const sharp = (await import("sharp")).default;
  const normalizer = await import("../src/services/image-normalization.js");
  const small = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).jpeg({ quality: 80 }).toBuffer();
  const smallResult = await normalizer.normalizeImageBytes("jpeg", small);
  assert.equal(Buffer.compare(small, smallResult.bytes), 0);
  const large = await sharp(randomBytes(2200 * 2200 * 3), { raw: { width: 2200, height: 2200, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
  const largeInput = large;
  const largeResult = await normalizer.normalizeImageBytes("jpeg", largeInput);
  assert.ok(largeResult.bytes.length <= 10 * 1024 * 1024);
  assert.notEqual(Buffer.compare(largeInput, largeResult.bytes), 0);
});

test("enforces the decoded 20MB upload request limit", async () => {
  const quota = await import("../src/services/user-storage-quota.js");
  quota.assertUploadRequestSize([10 * 1024 * 1024, 10 * 1024 * 1024]);
  assert.throws(() => quota.assertUploadRequestSize([10 * 1024 * 1024, 10 * 1024 * 1024, 1]), (error: unknown) => (error as { code?: string }).code === "UPLOAD_REQUEST_TOO_LARGE");
  assert.throws(() => quota.assertUploadRequestSize([10 * 1024 * 1024 + 1]), (error: unknown) => (error as { code?: string }).code === "ASSET_TOO_LARGE");
});

test("report mappings are scope-bound and do not double-count on refresh", async () => {
  const scope = { userId: "report-user", projectId: "report-project", instanceId: "report-instance" };
  const mappings = await import("../src/services/report-asset-mappings.js");
  const quota = await import("../src/services/user-storage-quota.js");
  const first = await mappings.registerReportAssetMapping({ ...scope, reportId: "daily-1", title: "日报", fileName: "daily.md", mimeType: "text/markdown", sizeBytes: 123, backingAssetId: null, backingVersionId: null });
  const second = await mappings.registerReportAssetMapping({ ...scope, reportId: "daily-1", title: "日报更新", fileName: "daily.md", mimeType: "text/markdown", sizeBytes: 123, backingAssetId: null, backingVersionId: null });
  assert.equal(first.mappingId, second.mappingId);
  assert.equal(quota.getStorageUsage(scope).usedBytes, 123);
  assert.equal(mappings.listReportAssetMappings({ ...scope, instanceId: "other-instance" }).length, 0);
});

test("report mapping charges only unbacked bytes and settles update deltas", async () => {
  const { assets } = await fixture;
  const mappings = await import("../src/services/report-asset-mappings.js");
  const quota = await import("../src/services/user-storage-quota.js");
  const scope = { userId: "report-charge-user", projectId: "report-charge-project", instanceId: "report-charge-instance" };

  // Unbacked mapping charges its full size.
  await mappings.registerReportAssetMapping({ ...scope, reportId: "r-1", title: "R1", fileName: "r1.md", mimeType: "text/markdown", sizeBytes: 1000, backingAssetId: null, backingVersionId: null });
  assert.equal(quota.getStorageUsage(scope).usedBytes, 1000);

  // Refreshing the same report with a larger size charges only the delta.
  await mappings.registerReportAssetMapping({ ...scope, reportId: "r-1", title: "R1", fileName: "r1.md", mimeType: "text/markdown", sizeBytes: 1500, backingAssetId: null, backingVersionId: null });
  assert.equal(quota.getStorageUsage(scope).usedBytes, 1500);
  // Re-registering the same size charges nothing (delta 0).
  await mappings.registerReportAssetMapping({ ...scope, reportId: "r-1", title: "R1", fileName: "r1.md", mimeType: "text/markdown", sizeBytes: 1500, backingAssetId: null, backingVersionId: null });
  assert.equal(quota.getStorageUsage(scope).usedBytes, 1500);
  assert.equal(quota.getStorageUsage(scope).reservedBytes, 0, "no reservation leaks after mapping updates");

  // A backed mapping is no-copy: its bytes are already counted by the version
  // row, so registering a mapping onto it charges nothing extra.
  const asset = await assets.createUserAsset({ ...scope, name: "backing", fileName: "backing.md", mimeType: "text/markdown", bytes: Buffer.from("# backing payload\n") });
  const beforeBacked = quota.getStorageUsage(scope).usedBytes;
  await mappings.registerReportAssetMapping({ ...scope, reportId: "r-backed", title: "Backed", fileName: "backing.md", mimeType: "text/markdown", sizeBytes: asset.currentVersion!.sizeBytes, backingAssetId: asset.assetId, backingVersionId: asset.currentVersion!.versionId });
  assert.equal(quota.getStorageUsage(scope).usedBytes, beforeBacked, "backed mapping must not copy or double-charge");
});

test("report mapping rejects negative size, over-limit writes and cross-scope backing", async () => {
  const { assets } = await fixture;
  const { db } = await fixture;
  const mappings = await import("../src/services/report-asset-mappings.js");
  const quota = await import("../src/services/user-storage-quota.js");
  const scope = { userId: "report-reject-user", projectId: "report-reject-project", instanceId: "report-reject-instance" };

  await assert.rejects(
    () => mappings.registerReportAssetMapping({ ...scope, reportId: "neg", title: "Neg", fileName: "neg.md", mimeType: "text/markdown", sizeBytes: -1, backingAssetId: null, backingVersionId: null }),
    (error: unknown) => (error as { code?: string }).code === "ASSET_INVALID_CONTENT",
  );
  assert.equal(quota.getStorageUsage(scope).usedBytes, 0);

  // Over-limit: fill the scope, then an unbacked mapping must be rejected and
  // leave neither a mapping nor a reservation.
  db.sqlite.prepare(INSERT_VERSION).run("v_repfilled", "a_repfilled", scope.userId, scope.projectId, scope.instanceId, 1, "full.md", "markdown", "text/markdown", 200 * 1024 * 1024, "checksum", "assets/full.md", "system", new Date().toISOString());
  await assert.rejects(
    () => mappings.registerReportAssetMapping({ ...scope, reportId: "over", title: "Over", fileName: "over.md", mimeType: "text/markdown", sizeBytes: 10, backingAssetId: null, backingVersionId: null }),
    (error: unknown) => (error as { code?: string }).code === "USER_STORAGE_QUOTA_EXCEEDED",
  );
  assert.equal(quota.getStorageUsage(scope).reservedBytes, 0, "rejected mapping must release its reservation");
  assert.equal(mappings.listReportAssetMappings(scope).length, 0, "rejected mapping must leave no row");

  // Cross-scope backing: a mapping may only back onto an asset in the same scope.
  const other = { userId: "other-user", projectId: "other-project", instanceId: "other-instance" };
  const foreignAsset = await assets.createUserAsset({ ...other, name: "foreign", fileName: "foreign.md", mimeType: "text/markdown", bytes: Buffer.from("# foreign\n") });
  await assert.rejects(
    () => mappings.registerReportAssetMapping({ ...scope, reportId: "xscope", title: "X", fileName: "x.md", mimeType: "text/markdown", sizeBytes: 5, backingAssetId: foreignAsset.assetId, backingVersionId: foreignAsset.currentVersion!.versionId }),
    (error: unknown) => (error as { code?: string }).code === "ASSET_SCOPE_MISMATCH",
  );
});

test("rejects a long-lived write once the scope quota is exhausted", async () => {
  const { db, assets } = await fixture;
  const scope = { userId: "full-user", projectId: "full-project", instanceId: "full-instance" };
  db.sqlite.prepare(`INSERT INTO user_asset_versions (version_id,asset_id,user_id,project_id,instance_id,version_number,file_name,format,mime_type,size_bytes,checksum,storage_path,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run("version_full", "asset_full", scope.userId, scope.projectId, scope.instanceId, 1, "full.md", "markdown", "text/markdown", 200 * 1024 * 1024, "checksum", "assets/full.md", "system", new Date().toISOString());
  await assert.rejects(
    () => assets.createUserAsset({ ...scope, fileName: "next.md", bytes: Buffer.from("# next\n") }),
    (error: unknown) => (error as { code?: string }).code === "USER_STORAGE_QUOTA_EXCEEDED",
  );
});

const INSERT_VERSION = `INSERT INTO user_asset_versions (version_id,asset_id,user_id,project_id,instance_id,version_number,file_name,format,mime_type,size_bytes,checksum,storage_path,source,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

test("reservation lifecycle holds bytes, commits idempotently and never double-applies", async () => {
  const { db } = await fixture;
  const quota = await import("../src/services/user-storage-quota.js");
  const scope = { userId: "res-user", projectId: "res-project", instanceId: "res-instance" };
  quota.resetStorageReservations(scope);
  const before = quota.getStorageUsage(scope);
  const token = quota.reserveStorage(scope, 4096);
  const mid = quota.getStorageUsage(scope);
  assert.equal(mid.reservedBytes, 4096);
  assert.equal(mid.availableBytes, before.availableBytes - 4096);
  // Success path: commit settles the reservation, dropping it from reserved.
  quota.commitStorageReservation(scope, token);
  assert.equal(quota.getStorageUsage(scope).reservedBytes, 0);
  // Commit/release are idempotent per token — repeating them cannot move bytes.
  quota.commitStorageReservation(scope, token);
  quota.releaseStorageReservation(scope, token);
  quota.releaseStorageReservation(scope, token);
  assert.equal(quota.getStorageUsage(scope).reservedBytes, 0);
  // A bogus token release is also a no-op (never negative, never affects others).
  quota.releaseStorageReservation(scope, "resv_does_not_exist");
  assert.equal(quota.getStorageUsage(scope).reservedBytes, 0);
  const settled = db.sqlite.prepare(`SELECT status FROM user_storage_reservations WHERE reservation_token = ?`).get(token) as { status: string };
  assert.equal(settled.status, "committed");
});

test("reservation failure path releases bytes and stays idempotent", async () => {
  const { db } = await fixture;
  const quota = await import("../src/services/user-storage-quota.js");
  const scope = { userId: "res-fail-user", projectId: "res-fail-project", instanceId: "res-fail-instance" };
  quota.resetStorageReservations(scope);
  const before = quota.getStorageUsage(scope);
  const token = quota.reserveStorage(scope, 2048);
  assert.equal(quota.getStorageUsage(scope).reservedBytes, 2048);
  quota.releaseStorageReservation(scope, token);
  const after = quota.getStorageUsage(scope);
  assert.equal(after.reservedBytes, 0);
  assert.equal(after.availableBytes, before.availableBytes);
  // Double release is a no-op.
  quota.releaseStorageReservation(scope, token);
  assert.equal(quota.getStorageUsage(scope).reservedBytes, 0);
  const settled = db.sqlite.prepare(`SELECT status FROM user_storage_reservations WHERE reservation_token = ?`).get(token) as { status: string };
  assert.equal(settled.status, "released");
});

test("reservation rejects an over-limit request and leaks nothing", async () => {
  const { db } = await fixture;
  const quota = await import("../src/services/user-storage-quota.js");
  const scope = { userId: "res-full", projectId: "res-full-project", instanceId: "res-full-instance" };
  db.sqlite.prepare(INSERT_VERSION).run("v_resfull", "a_resfull", scope.userId, scope.projectId, scope.instanceId, 1, "full.md", "markdown", "text/markdown", 200 * 1024 * 1024, "checksum", "assets/full.md", "system", new Date().toISOString());
  assert.throws(
    () => quota.reserveStorage(scope, 1),
    (error: unknown) => (error as { code?: string }).code === "USER_STORAGE_QUOTA_EXCEEDED",
  );
  // The throw must not have persisted a reservation row.
  assert.equal(quota.getStorageUsage(scope).reservedBytes, 0);
  assert.equal((db.sqlite.prepare(`SELECT COUNT(*) AS c FROM user_storage_reservations WHERE user_id = ?`).get(scope.userId) as { c: number }).c, 0);
});

test("expired active reservations are reclaimed while committed usage is preserved", async () => {
  const { db } = await fixture;
  const quota = await import("../src/services/user-storage-quota.js");
  const scope = { userId: "res-expire-user", projectId: "res-expire-project", instanceId: "res-expire-instance" };
  quota.resetStorageReservations(scope);
  const committed = quota.reserveStorage(scope, 512);
  quota.commitStorageReservation(scope, committed);
  const abandoned = quota.reserveStorage(scope, 1024);
  // Simulate a process crash: force the abandoned reservation past its lease.
  db.sqlite.prepare(`UPDATE user_storage_reservations SET expires_at = ? WHERE reservation_token = ?`)
    .run("2000-01-01T00:00:00.000Z", abandoned);
  // The expired active reservation no longer counts against reserved bytes...
  assert.equal(quota.getStorageUsage(scope).reservedBytes, 0);
  // ...and reclaiming it physically settles it without touching the committed one.
  const reclaimed = quota.reclaimExpiredStorageReservations(scope);
  assert.equal(reclaimed, 1);
  const statuses = db.sqlite.prepare(`SELECT reservation_token AS t, status AS s FROM user_storage_reservations WHERE user_id = ?`).all(scope.userId) as Array<{ t: string; s: string }>;
  const byToken = new Map(statuses.map((row) => [row.t, row.s]));
  assert.equal(byToken.get(committed), "committed");
  assert.equal(byToken.get(abandoned), "released");
  assert.equal(quota.getStorageUsage(scope).reservedBytes, 0);
});

test("two concurrent writes to a near-full scope cannot overshoot the quota", async () => {
  const { db, assets } = await fixture;
  const quota = await import("../src/services/user-storage-quota.js");
  const scope = { userId: "concur-user", projectId: "concur-project", instanceId: "concur-instance" };
  const small = Buffer.from("# concurrent\n");
  db.sqlite.prepare(INSERT_VERSION).run("v_concur_base", "a_concur_base", scope.userId, scope.projectId, scope.instanceId, 1, "base.md", "markdown", "text/markdown", 200 * 1024 * 1024 - small.length, "checksum", "assets/base.md", "system", new Date().toISOString());
  const results = await Promise.allSettled([
    assets.createUserAsset({ ...scope, fileName: "a.md", bytes: Buffer.from("# concurrent\n"), idempotencyKey: "concur-a" }),
    assets.createUserAsset({ ...scope, fileName: "b.md", bytes: Buffer.from("# concurrent\n"), idempotencyKey: "concur-b" }),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected" && ((r as PromiseRejectedResult).reason as { code?: string }).code === "USER_STORAGE_QUOTA_EXCEEDED");
  assert.equal(fulfilled.length, 1, "exactly one concurrent write should succeed");
  assert.equal(rejected.length, 1, "the other should be rejected for quota");
  const usage = quota.getStorageUsage(scope);
  assert.equal(usage.reservedBytes, 0, "no reservation should leak after concurrent writes");
  assert.equal(usage.usedBytes, 200 * 1024 * 1024, "scope must sit exactly at the limit");
});

test("a failed commit releases the reservation and leaves no version or staged file", async () => {
  const { db, assets } = await fixture;
  const quota = await import("../src/services/user-storage-quota.js");
  const scope = { userId: "rollback-user", projectId: "rollback-project", instanceId: "rollback-instance" };
  await assert.rejects(
    () => assets.createUserAsset({ ...scope, fileName: "auto.md", bytes: Buffer.from("# auto\n"), source: "automation" }),
    (error: unknown) => (error as { code?: string }).code === "ASSET_INVALID_CONTENT",
  );
  const usage = quota.getStorageUsage(scope);
  assert.equal(usage.reservedBytes, 0);
  assert.equal(usage.usedBytes, 0);
  const versions = db.sqlite.prepare("SELECT COUNT(*) AS c FROM user_asset_versions WHERE user_id = ?").get(scope.userId) as { c: number };
  assert.equal(versions.c, 0);
});

test("idempotent replay does not reserve or consume quota twice", async () => {
  const { assets } = await fixture;
  const quota = await import("../src/services/user-storage-quota.js");
  const scope = { userId: "replay-user", projectId: "replay-project", instanceId: "replay-instance" };
  const input = { ...scope, fileName: "replay.md", bytes: Buffer.from("# replay\n"), idempotencyKey: "replay-once" };
  const first = await assets.createUserAsset(input);
  const replay = await assets.createUserAsset(input);
  assert.equal(replay.assetId, first.assetId);
  const usage = quota.getStorageUsage(scope);
  assert.equal(usage.reservedBytes, 0);
  assert.equal(usage.usedBytes, first.currentVersion!.sizeBytes);
});

test("two concurrent createUserAsset calls with the same idempotency key both replay one asset", async () => {
  const { assets, db } = await fixture;
  const quota = await import("../src/services/user-storage-quota.js");
  const scope = { userId: "concur-key-user", projectId: "concur-key-project", instanceId: "concur-key-instance" };
  const input = {
    ...scope, name: "shared", fileName: "shared.md", mimeType: "text/markdown",
    bytes: Buffer.from("# shared\n"), idempotencyKey: "concur-same-key",
  };
  // Deterministic Promise.all: both calls race with the same key. The in-lock
  // recheck must make both resolve to the same asset, charging quota once and
  // never surfacing ASSET_COMMIT_FAILED from a unique-index violation.
  const [a, b] = await Promise.all([assets.createUserAsset(input), assets.createUserAsset(input)]);
  assert.equal(a.assetId, b.assetId);
  assert.equal(a.currentVersionId, b.currentVersionId);
  const usage = quota.getStorageUsage(scope);
  assert.equal(usage.usedBytes, a.currentVersion!.sizeBytes, "quota charged exactly once");
  assert.equal(usage.reservedBytes, 0, "no reservation leaks after concurrent same-key writes");
  const versions = db.sqlite.prepare(
    `SELECT COUNT(*) AS c FROM user_asset_versions WHERE user_id = ? AND project_id = ? AND instance_id = ? AND idempotency_key = ?`,
  ).get(scope.userId, scope.projectId, scope.instanceId, "concur-same-key") as { c: number };
  assert.equal(versions.c, 1, "exactly one version row for the shared key");
});

test("public quota and mapping entrypoints reject empty scope fields", async () => {
  const quota = await import("../src/services/user-storage-quota.js");
  const mappings = await import("../src/services/report-asset-mappings.js");
  const isInvalidScope = (error: unknown) => (error as { code?: string }).code === "ASSET_INVALID_SCOPE";
  assert.throws(() => quota.getStorageUsage({ userId: "", projectId: "p", instanceId: "i" }), isInvalidScope);
  assert.throws(() => quota.reserveStorage({ userId: "u", projectId: "  ", instanceId: "i" }, 10), isInvalidScope);
  assert.throws(() => quota.authoritativeUsedBytes({ userId: "u", projectId: "p", instanceId: "" }), isInvalidScope);
  assert.throws(() => quota.scopeStorageLockKey({ userId: "", projectId: "p", instanceId: "i" }), isInvalidScope);
  assert.throws(() => quota.reclaimExpiredStorageReservations({ userId: "u", projectId: "", instanceId: "i" }), isInvalidScope);
  await assert.rejects(
    () => mappings.registerReportAssetMapping({ userId: "  ", projectId: "p", instanceId: "i", reportId: "r", title: "t", fileName: "f.md", mimeType: "text/markdown", sizeBytes: 1, backingAssetId: null, backingVersionId: null }),
    isInvalidScope,
  );
  assert.throws(() => mappings.listReportAssetMappings({ userId: "u", projectId: "p", instanceId: "" }), isInvalidScope);
  assert.throws(() => mappings.getReportAssetMappingForRead({ userId: "", projectId: "p", instanceId: "i" }, "m"), isInvalidScope);
});

test("an automation finalize callback failure rolls back DB rows, staged file and reservation", async () => {
  const { db, assets, workspace } = await fixture;
  const quota = await import("../src/services/user-storage-quota.js");
  const scope = { userId: "finalize-user", projectId: "finalize-project", instanceId: "finalize-instance" };
  const taskId = "fin-task";
  const runId = "fin-run";
  const leaseToken = "lease-fin";
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  // Minimal running lease row so assertAutomationMutationLease passes; the run
  // is left untouched by the asset commit so we can observe it stays 'running'.
  db.sqlite.prepare(
    `INSERT INTO automation_task_runs
     (run_id,task_id,revision_id,user_id,project_id,instance_id,origin,idempotency_key,status,claimed_at,lease_token,lease_expires_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(runId, taskId, "rev-fin", scope.userId, scope.projectId, scope.instanceId, "manual", "fin-key", "running", now, leaseToken, future, now, now);

  const before = quota.getStorageUsage(scope);
  await assert.rejects(
    () => assets.createUserAsset({
      ...scope, name: "boom", fileName: "finalize-boom.md", mimeType: "text/markdown",
      bytes: Buffer.from("# finalize boom\n"), source: "automation", taskId, runId, leaseToken,
      finalizeRun: () => { throw new Error("finalize boom"); },
    }),
    (error: unknown) => (error as { code?: string }).code === "ASSET_COMMIT_FAILED",
  );

  assert.equal((db.sqlite.prepare(`SELECT COUNT(*) AS c FROM user_assets WHERE user_id = ?`).get(scope.userId) as { c: number }).c, 0);
  assert.equal((db.sqlite.prepare(`SELECT COUNT(*) AS c FROM user_asset_versions WHERE user_id = ?`).get(scope.userId) as { c: number }).c, 0);
  const after = quota.getStorageUsage(scope);
  assert.equal(after.reservedBytes, 0, "reservation must be released on finalize failure");
  assert.equal(after.usedBytes, before.usedBytes, "no committed bytes after rollback");
  // The staged file was removed: no orphan under the user's assets directory.
  const assetsDir = path.join(workspace.resolveWorkspacePath(scope.userId), "assets");
  const files = existsSync(assetsDir) ? readdirSync(assetsDir, { recursive: true }) as string[] : [];
  assert.ok(!files.some((file) => String(file).endsWith("finalize-boom.md")), "staged file must be removed on finalize failure");
  const run = db.sqlite.prepare(`SELECT status FROM automation_task_runs WHERE run_id = ?`).get(runId) as { status: string };
  assert.equal(run.status, "running", "the throwing finalize must not have finalized the run");
});
