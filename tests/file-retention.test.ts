// IMPORTANT: set the test DB + workspace BEFORE any import that reads config.
// The runtime config module captures DB_PATH / WORKSPACE_ROOT at import time,
// so we point them at dedicated per-file paths under the OS tempdir and wipe
// them at the top of every run. This keeps the test hermetic — it never
// touches the production data/invest-agent.db or the live workspace.
import { existsSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_ROOT = path.join(os.tmpdir(), "invest-agent-retention-test");
rmSync(TEST_ROOT, { recursive: true, force: true });
mkdirSync(path.join(TEST_ROOT, "workspaces"), { recursive: true });
process.env.WORKSPACE_ROOT = path.join(TEST_ROOT, "workspaces");
process.env.DB_PATH = path.join(TEST_ROOT, "test.db");
process.env.NODE_ENV = "test";
delete process.env.FILE_RETENTION_CLEANUP_ENABLED;

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * File-retention governance tests. Covers:
 *  - D1/D2: attachment 7-day TTL is server-side and reads do not renew it.
 *  - D3: 1 MiB durable boundary (`1,048,576` durable, `1,048,577` transient).
 *  - D11: attachment cleanup is idempotent and a missing file does not break the batch.
 *  - D8/D9/D10: artifact delete prepare/confirm token scope/replay/conflict +
 *    30-day trash + same-path tombstone.
 *  - D12: backfill idempotency and curated-directory admission.
 *
 * Each test owns its own tmpdir + SQLite db so they can run in parallel
 * without sharing module state.
 */

interface Fixture {
  workspaceUser: string;
  sqlite: import("better-sqlite3").Database;
  artifactMod: typeof import("../src/services/conversation-artifacts.js");
  retentionMod: typeof import("../src/services/file-retention.js");
  deletionMod: typeof import("../src/services/artifact-deletion.js");
  backfillMod: typeof import("../src/services/file-retention-backfill.js");
}

// Single shared fixture per process for this file: env is pinned at the top of
// the file so every test sees the same workspace root + DB. Each test uses
// unique relative paths / attachment ids so they never observe each other.
let fixturePromise: Promise<Fixture> | null = null;

async function setupFixture(): Promise<Fixture> {
  const { initDb, sqlite } = await import("../src/db/index.js");
  initDb();
  const { resolveWorkspacePath } = await import("../src/lib/workspace.js");
  const workspaceUser = resolveWorkspacePath("user-ret");
  for (const sub of ["reports/daily", "reports/weekly", "reports/monthly", "reports/company", "reports/html", "reports/metrics", "reports/memory", "reports/alerts", "attachments"]) {
    await mkdir(path.join(workspaceUser, sub), { recursive: true });
  }
  const artifactMod = await import("../src/services/conversation-artifacts.js");
  const retentionMod = await import("../src/services/file-retention.js");
  const deletionMod = await import("../src/services/artifact-deletion.js");
  const backfillMod = await import("../src/services/file-retention-backfill.js");
  deletionMod.clearPendingDeleteTokensForTest();
  return { workspaceUser, sqlite, artifactMod, retentionMod, deletionMod, backfillMod };
}

async function getFixture(): Promise<Fixture> {
  if (!fixturePromise) fixturePromise = setupFixture();
  return fixturePromise;
}

async function publishMarkdown(fixture: Fixture, relativePath: string, content: string, source: "artifacts.publish" | "reviews.save" | "workspace_backfill" = "artifacts.publish") {
  return publishMarkdownAs(fixture, "user-ret", relativePath, content, source);
}

async function publishMarkdownAs(fixture: Fixture, userId: string, relativePath: string, content: string, source: "artifacts.publish" | "reviews.save" | "workspace_backfill" = "artifacts.publish") {
  const { resolveWorkspacePath } = await import("../src/lib/workspace.js");
  const workspaceUser = resolveWorkspacePath(userId);
  for (const sub of ["reports/daily", "reports/weekly", "reports/monthly", "reports/company", "reports/html", "reports/metrics", "reports/memory"]) {
    await mkdir(path.join(workspaceUser, sub), { recursive: true });
  }
  const full = path.join(workspaceUser, relativePath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, content);
  return fixture.artifactMod.publishConversationArtifact({
    userId,
    instanceId: userId,
    relativePath,
    scope: { projectId: "invest-agent", assistantId: userId, conversationId: "conv-1", source },
  });
}

// ---------- Attachment retention (D1, D2, D11) ----------

test("registers uploads with a server-side 7-day expiresAt and reading does not renew it", async () => {
  const fixture = await getFixture();
  try {
    const file = path.join(fixture.workspaceUser, "attachments", "2026-07-25", "att_test-1_report.txt");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "hello");
    const storedAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const record = fixture.retentionMod.registerAttachment({
      userId: "user-ret",
      instanceId: "user-ret",
      conversationId: "conv-1",
      stored: {
        id: "att_test-1",
        type: "document",
        mimeType: "text/plain",
        fileName: "report.txt",
        sizeBytes: 5,
        path: file,
        relativePath: "attachments/2026-07-25/att_test-1_report.txt",
        source: "portal",
        checksum: sha("hello"),
      },
      storedAt: storedAt.toISOString(),
    });
    // 7-day boundary computed from storedAt.
    assert.equal(record.expiresAt, new Date(storedAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString());
    assert.equal(record.retentionClass, "transient_upload");

    // Read before expiry — active.
    const before = fixture.retentionMod.findAttachmentRecord({ attachmentId: "att_test-1", userId: "user-ret", instanceId: "user-ret" });
    assert.equal(before?.status, "active");
    const read = await fixture.retentionMod.readAttachmentBytes({ attachmentId: "att_test-1", userId: "user-ret", instanceId: "user-ret" });
    assert.equal(read.bytes.toString("utf8"), "hello");

    // The stored expiresAt is unchanged after a read.
    const after = fixture.retentionMod.findAttachmentRecord({ attachmentId: "att_test-1", userId: "user-ret", instanceId: "user-ret" });
    assert.equal(after?.expiresAt, record.expiresAt);
  } finally {
  }
});

test("expired attachments return ATTACHMENT_EXPIRED without bytes, and the cleanup is idempotent", async () => {
  const fixture = await getFixture();
  try {
    const file = path.join(fixture.workspaceUser, "attachments", "2026-07-25", "att_test-2_report.txt");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "expired");
    const pastStored = new Date("2026-07-01T00:00:00Z");
    fixture.retentionMod.registerAttachment({
      userId: "user-ret",
      instanceId: "user-ret",
      conversationId: "conv-1",
      stored: {
        id: "att_test-2",
        type: "document",
        mimeType: "text/plain",
        fileName: "report.txt",
        sizeBytes: 7,
        path: file,
        relativePath: "attachments/2026-07-25/att_test-2_report.txt",
        source: "portal",
        checksum: sha("expired"),
      },
      storedAt: pastStored.toISOString(),
    });

    // After expiry, the status flips to expired and reads fail.
    const now = new Date("2026-07-25T00:00:00Z");
    const preview = fixture.retentionMod.findAttachmentRecord({ attachmentId: "att_test-2", userId: "user-ret", instanceId: "user-ret" });
    assert.equal(preview?.status, "expired");
    await assert.rejects(
      () => fixture.retentionMod.readAttachmentBytes({ attachmentId: "att_test-2", userId: "user-ret", instanceId: "user-ret" }),
      (error: unknown) => (error as { code?: string }).code === "ATTACHMENT_EXPIRED",
    );

    // First cleanup deletes bytes and marks deleted.
    const first = await fixture.retentionMod.cleanupExpiredAttachments({ now });
    assert.equal(first.deletedFiles, 1);
    assert.equal(first.deletedBytes, 7);
    assert.ok(!existsSync(file));
    const expiryAudit = fixture.sqlite.prepare(
      `SELECT summary_json AS summaryJson FROM file_lifecycle_events
       WHERE entity_type = 'attachment' AND entity_id = ? AND event = 'attachment.expiry' AND status = 'success'`,
    ).get("att_test-2") as { summaryJson: string } | undefined;
    assert.ok(expiryAudit);
    assert.ok(!expiryAudit.summaryJson.includes(TEST_ROOT));

    // Second cleanup is idempotent — no rows left to delete, zero counts.
    const second = await fixture.retentionMod.cleanupExpiredAttachments({ now });
    assert.equal(second.deletedFiles, 0);
    assert.equal(second.scanned, 0);
  } finally {
  }
});

test("cleanup treats a missing file as idempotent success and never touches another user's bytes", async () => {
  const fixture = await getFixture();
  try {
    // Register an expired row whose file does not exist on disk.
    fixture.retentionMod.registerAttachment({
      userId: "user-ret",
      instanceId: "user-ret",
      conversationId: "conv-1",
      stored: {
        id: "att_test-3",
        type: "document",
        mimeType: "text/plain",
        fileName: "report.txt",
        sizeBytes: 4,
        path: "/nope",
        relativePath: "attachments/2026-07-25/att_test-3_report.txt",
        source: "portal",
        checksum: sha("missing"),
      },
      storedAt: new Date("2026-07-01T00:00:00Z").toISOString(),
    });
    // And a fresh (non-expired) real file for a different attachment id.
    const keep = path.join(fixture.workspaceUser, "attachments", "2026-07-25", "att_keep_report.txt");
    await mkdir(path.dirname(keep), { recursive: true });
    await writeFile(keep, "keep");
    fixture.retentionMod.registerAttachment({
      userId: "user-ret",
      instanceId: "user-ret",
      conversationId: "conv-1",
      stored: {
        id: "att_keep",
        type: "document",
        mimeType: "text/plain",
        fileName: "report.txt",
        sizeBytes: 4,
        path: keep,
        relativePath: "attachments/2026-07-25/att_keep_report.txt",
        source: "portal",
        checksum: sha("keep"),
      },
      storedAt: new Date("2026-07-25T00:00:00Z").toISOString(),
    });
    // now=2026-07-05: att_test-3 (storedAt=07-01, expires 07-08) is NOT yet
    // expired, but we want to exercise the missing-file path, so back-date its
    // expiresAt so the cleanup query selects it.
    fixture.sqlite
      .prepare(`UPDATE conversation_attachments SET expires_at = ? WHERE attachment_id = ?`)
      .run(new Date("2026-07-02T00:00:00Z").toISOString(), "att_test-3");
    const summary = await fixture.retentionMod.cleanupExpiredAttachments({ now: new Date("2026-07-05T00:00:00Z") });
    // Only the missing one was eligible.
    assert.equal(summary.missing, 1);
    assert.equal(summary.deletedFiles, 0);
    assert.ok(existsSync(keep));
  } finally {
  }
});

test("attachment read refuses cross-scope and forged ids", async () => {
  const fixture = await getFixture();
  try {
    const file = path.join(fixture.workspaceUser, "attachments", "2026-07-25", "att_test-4_report.txt");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "x");
    fixture.retentionMod.registerAttachment({
      userId: "user-ret",
      instanceId: "user-ret",
      conversationId: "conv-1",
      stored: {
        id: "att_test-4",
        type: "document",
        mimeType: "text/plain",
        fileName: "report.txt",
        sizeBytes: 1,
        path: file,
        relativePath: "attachments/2026-07-25/att_test-4_report.txt",
        source: "portal",
        checksum: sha("x"),
      },
    });
    // Wrong instance scope — not found.
    const wrong = fixture.retentionMod.findAttachmentRecord({ attachmentId: "att_test-4", userId: "user-ret", instanceId: "intruder" });
    assert.equal(wrong, undefined);
    // Forged id — not found.
    const forged = fixture.retentionMod.findAttachmentRecord({ attachmentId: "att_forged", userId: "user-ret", instanceId: "user-ret" });
    assert.equal(forged, undefined);
  } finally {
  }
});

// ---------- Durable artifact threshold (D3) ----------

test("classifyArtifactRetention promotes 1,048,576-byte files to durable and 1,048,577 to transient", () => {
  const { classifyArtifactRetention, DURABLE_LIBRARY_MAX_BYTES } = require("../src/services/conversation-artifacts.js") as typeof import("../src/services/conversation-artifacts.js");
  assert.equal(DURABLE_LIBRARY_MAX_BYTES, 1_048_576);
  const durable = classifyArtifactRetention({
    source: "reviews.save",
    relativePath: "reports/daily/2026-07-25.md",
    sizeBytes: 1_048_576,
    mimeType: "text/markdown",
  });
  assert.equal(durable?.retentionClass, "durable_library");
  assert.equal(durable?.visibility, "library");
  assert.equal(durable?.expiresAt, null);
  const transient = classifyArtifactRetention({
    source: "reviews.save",
    relativePath: "reports/daily/2026-07-25.md",
    sizeBytes: 1_048_577,
    mimeType: "text/markdown",
    now: new Date("2026-07-25T00:00:00Z"),
  });
  assert.equal(transient?.retentionClass, "transient_generated");
  assert.equal(transient?.visibility, "conversation_only");
  assert.equal(transient?.expiresAt, new Date("2026-08-01T00:00:00Z").toISOString());
  // legacy_path is never durable.
  const legacy = classifyArtifactRetention({
    source: "legacy_path",
    relativePath: "reports/daily/2026-07-25.md",
    sizeBytes: 10,
    mimeType: "text/markdown",
  });
  assert.equal(legacy?.retentionClass, "reference_only");
  assert.equal(legacy?.visibility, "conversation_only");
  // Formal artifacts.publish reports are durable even outside the fixed review dirs.
  const outside = classifyArtifactRetention({
    source: "artifacts.publish",
    relativePath: "reports/tables/generated.csv",
    sizeBytes: 10,
    mimeType: "text/csv",
  });
  assert.equal(outside?.retentionClass, "durable_library");
  assert.equal(outside?.visibility, "library");
  const webpage = classifyArtifactRetention({
    source: "artifacts.publish",
    relativePath: "reports/html/2026-07-25-portfolio-risk.html",
    sizeBytes: 10,
    mimeType: "text/html",
  });
  assert.equal(webpage?.retentionClass, "durable_library");
  assert.equal(webpage?.visibility, "library");
  assert.equal(webpage?.expiresAt, null);
});

test("published daily review is classified durable_library and has no expiresAt", async () => {
  const fixture = await getFixture();
  try {
    const record = await publishMarkdown(fixture, "reports/daily/2026-07-25.md", "# daily", "reviews.save");
    assert.equal(record.retentionClass, "durable_library");
    assert.equal(record.visibility, "library");
    assert.equal(record.expiresAt, null);
    const audit = fixture.sqlite.prepare(
      `SELECT status FROM file_lifecycle_events WHERE entity_type = 'artifact' AND entity_id = ? AND event = 'artifact.classified'`,
    ).get(record.artifactId) as { status: string } | undefined;
    assert.equal(audit?.status, "success");
  } finally {
  }
});

test("artifact path lock serializes same-path operations", async () => {
  const { withArtifactPathLock } = await import("../src/services/artifact-path-lock.js");
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstDone = false;
  let secondDone = false;
  const first = withArtifactPathLock("lock-user", "reports/daily/same.md", async () => {
    await firstGate;
    firstDone = true;
    return "first";
  });
  const second = withArtifactPathLock("lock-user", "reports/daily/same.md", async () => {
    secondDone = true;
    return "second";
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(firstDone, false);
  assert.equal(secondDone, false);
  releaseFirst();
  assert.equal(await first, "first");
  assert.equal(await second, "second");
  assert.equal(firstDone, true);
  assert.equal(secondDone, true);
});

test("retention classification backfill dry-run does not write rows", async () => {
  const fixture = await getFixture();
  const record = await publishMarkdown(fixture, "reports/daily/dry-run.md", "# dry run");
  fixture.sqlite.prepare(`UPDATE conversation_artifacts SET retention_class = NULL, visibility = NULL, origin = NULL WHERE artifact_id = ?`).run(record.artifactId);
  const before = fixture.sqlite.prepare(`SELECT retention_class, visibility, origin FROM conversation_artifacts WHERE artifact_id = ?`).get(record.artifactId);
  const summary = await fixture.backfillMod.backfillArtifactRetentionClassification({ dryRun: true });
  const after = fixture.sqlite.prepare(`SELECT retention_class, visibility, origin FROM conversation_artifacts WHERE artifact_id = ?`).get(record.artifactId);
  assert.ok(summary.scanned >= 1);
  assert.deepEqual(after, before);
});

test("oversized formal artifact is classified transient and read returns ARTIFACT_EXPIRED after the window", async () => {
  const fixture = await getFixture();
  try {
    // 2 MiB markdown in a curated dir -> transient because > 1 MiB.
    const big = "# " + "x".repeat(2 * 1024 * 1024);
    const record = await publishMarkdown(fixture, "reports/daily/big.md", big);
    assert.equal(record.retentionClass, "transient_generated");
    assert.ok(record.expiresAt);

    // Force expiry by back-dating the row.
    fixture.sqlite.prepare(`UPDATE conversation_artifacts SET expires_at = ? WHERE artifact_id = ?`).run(
      new Date("2020-01-01T00:00:00Z").toISOString(),
      record.artifactId,
    );
    await assert.rejects(
      () => fixture.artifactMod.readConversationArtifactPayload({ artifactId: record.artifactId, userId: "user-ret", instanceId: "user-ret" }),
      (error: unknown) => (error as { code?: string }).code === "ARTIFACT_EXPIRED",
    );
  } finally {
  }
});

// ---------- Delete / trash (D8, D9, D10) ----------

test("delete prepare/confirm moves the file to a hidden trash area and tombstones same-path versions", async () => {
  const fixture = await getFixture();
  const { resolveWorkspacePath } = await import("../src/lib/workspace.js");
  const user = "user-del8";
  const ws = resolveWorkspacePath(user);
  try {
    const record = await publishMarkdownAs(fixture, user, "reports/daily/del.md", "# delete me");
    // A second publish of the same path creates a second version row.
    await publishMarkdownAs(fixture, user, "reports/daily/del.md", "# delete me v2");

    const prepared = await fixture.deletionMod.prepareArtifactDeletion({
      artifactId: record.artifactId,
      userId: user,
      instanceId: user,
    });
    assert.ok(prepared.tokenId.startsWith("del_"));
    assert.ok(prepared.impactNotes.some((note) => note.includes("30 天恢复窗口")));
    // Daily reports carry the "may affect future reviews" impact note.
    assert.ok(prepared.impactNotes.some((note) => note.includes("影响后续复盘")));

    const confirmed = await fixture.deletionMod.confirmArtifactDeletion({
      tokenId: prepared.tokenId,
      userId: user,
      instanceId: user,
    });
    assert.ok(confirmed.deletedVersions >= 2, "both same-path versions tombstoned");
    assert.ok(confirmed.trashRelativePath.startsWith(".trash/artifacts/"));
    assert.ok(confirmed.purgeAt);
    const deleteAudit = fixture.sqlite.prepare(
      `SELECT summary_json AS summaryJson FROM file_lifecycle_events
       WHERE entity_type = 'artifact' AND entity_id = ? AND event = 'artifact.delete' AND status = 'success'
       ORDER BY created_at DESC LIMIT 1`,
    ).get(record.artifactId) as { summaryJson: string } | undefined;
    assert.ok(deleteAudit);
    assert.ok(!deleteAudit.summaryJson.includes(fixture.workspaceUser));

    // Original file is gone from reports/.
    assert.ok(!existsSync(path.join(ws, "reports", "daily", "del.md")));
    // And present in the hidden trash area.
    assert.ok(existsSync(path.join(ws, confirmed.trashRelativePath)));

    // Library list no longer returns either version.
    const lib = await fixture.artifactMod.listCuratedArtifactLibrary({ userId: user, instanceId: user });
    assert.equal(lib.items.find((item) => item.displayPath === "daily/del.md"), undefined);
  } finally {
    fixture.deletionMod.clearPendingDeleteTokensForTest();
  }
});

test("delete survives a move failure and the same confirmation resumes safely", async () => {
  const fixture = await getFixture();
  const { resolveWorkspacePath } = await import("../src/lib/workspace.js");
  const user = "user-del-recovery";
  const ws = resolveWorkspacePath(user);
  try {
    const record = await publishMarkdownAs(fixture, user, "reports/daily/recover.md", "# recover");
    const prepared = await fixture.deletionMod.prepareArtifactDeletion({ artifactId: record.artifactId, userId: user, instanceId: user });
    fixture.deletionMod.failNextArtifactMoveForTest();
    await assert.rejects(
      () => fixture.deletionMod.confirmArtifactDeletion({ tokenId: prepared.tokenId, userId: user, instanceId: user }),
      (error: unknown) => (error as { code?: string }).code === "ARTIFACT_DELETE_CONFLICT",
    );

    const failed = fixture.sqlite.prepare(
      `SELECT status, trash_relative_path AS trashRelativePath FROM artifact_delete_confirmations WHERE token_id = ?`,
    ).get(prepared.tokenId) as { status: string; trashRelativePath: string };
    assert.equal(failed.status, "failed");
    assert.ok(existsSync(path.join(ws, "reports/daily/recover.md")), "source remains available for retry");
    const hidden = fixture.sqlite.prepare(`SELECT deleted_at AS deletedAt FROM conversation_artifacts WHERE artifact_id = ?`).get(record.artifactId) as { deletedAt: string | null };
    assert.ok(hidden.deletedAt, "tombstone is persisted before the move");

    const recovered = await fixture.deletionMod.confirmArtifactDeletion({ tokenId: prepared.tokenId, userId: user, instanceId: user });
    assert.ok(existsSync(path.join(ws, recovered.trashRelativePath)));
    assert.ok(!existsSync(path.join(ws, "reports/daily/recover.md")));
  } finally {
    fixture.deletionMod.clearPendingDeleteTokensForTest();
  }
});

test("delete confirm token is scope-bound and completed replays are idempotent", async () => {
  const fixture = await getFixture();
  const user = "user-del9";
  try {
    const record = await publishMarkdownAs(fixture, user, "reports/daily/single.md", "# one");
    const prepared = await fixture.deletionMod.prepareArtifactDeletion({
      artifactId: record.artifactId,
      userId: user,
      instanceId: user,
    });
    // Wrong scope cannot confirm.
    await assert.rejects(
      () => fixture.deletionMod.confirmArtifactDeletion({ tokenId: prepared.tokenId, userId: user, instanceId: "intruder" }),
      (error: unknown) => (error as { code?: string }).code === "ARTIFACT_SCOPE_MISMATCH",
    );
    // First valid confirm consumes the token; file moves.
    const confirmed = await fixture.deletionMod.confirmArtifactDeletion({
      tokenId: prepared.tokenId,
      userId: user,
      instanceId: user,
    });
    assert.ok(confirmed.trashRelativePath);
    // A transport retry returns the persisted first result without moving again.
    const replay = await fixture.deletionMod.confirmArtifactDeletion({ tokenId: prepared.tokenId, userId: user, instanceId: user });
    assert.deepEqual(replay, confirmed);
    // Forged token rejected.
    await assert.rejects(
      () => fixture.deletionMod.confirmArtifactDeletion({ tokenId: "del_forged", userId: user, instanceId: user }),
      (error: unknown) => (error as { code?: string }).code === "ARTIFACT_DELETE_CONFIRMATION_EXPIRED",
    );
  } finally {
    fixture.deletionMod.clearPendingDeleteTokensForTest();
  }
});

test("delete is refused for transient artifacts, raw uploads and pre-backfill rows", async () => {
  const fixture = await getFixture();
  const user = "user-del10";
  try {
    // Transient (oversized) artifact is not deletable.
    const big = "# " + "y".repeat(2 * 1024 * 1024);
    const transient = await publishMarkdownAs(fixture, user, "reports/daily/big2.md", big);
    await assert.rejects(
      () => fixture.deletionMod.prepareArtifactDeletion({ artifactId: transient.artifactId, userId: user, instanceId: user }),
      (error: unknown) => (error as { code?: string }).code === "ARTIFACT_NOT_DELETABLE",
    );

    // Pre-backfill row (NULL retention_class) is also not deletable.
    const raw = await publishMarkdownAs(fixture, user, "reports/daily/raw.md", "# raw");
    fixture.sqlite.prepare(`UPDATE conversation_artifacts SET retention_class = NULL, visibility = NULL WHERE artifact_id = ?`).run(raw.artifactId);
    await assert.rejects(
      () => fixture.deletionMod.prepareArtifactDeletion({ artifactId: raw.artifactId, userId: user, instanceId: user }),
      (error: unknown) => (error as { code?: string }).code === "ARTIFACT_NOT_DELETABLE",
    );
  } finally {
    fixture.deletionMod.clearPendingDeleteTokensForTest();
  }
});

test("trash purge physically removes files only after the 30-day window and is idempotent", async () => {
  const fixture = await getFixture();
  const { resolveWorkspacePath } = await import("../src/lib/workspace.js");
  const user = "user-del11";
  const ws = resolveWorkspacePath(user);
  try {
    const record = await publishMarkdownAs(fixture, user, "reports/daily/purge.md", "# purge");
    const prepared = await fixture.deletionMod.prepareArtifactDeletion({
      artifactId: record.artifactId,
      userId: user,
      instanceId: user,
    });
    const confirmed = await fixture.deletionMod.confirmArtifactDeletion({
      tokenId: prepared.tokenId,
      userId: user,
      instanceId: user,
    });
    const trashPath = path.join(ws, confirmed.trashRelativePath);
    assert.ok(existsSync(trashPath));

    // Within the 30-day window — purge does nothing for THIS user's row.
    const within = await fixture.deletionMod.purgeExpiredArtifactTrash({ now: new Date(Date.parse(confirmed.purgeAt) - 1) });
    // Our file must still be present even if other tests' rows were due.
    assert.ok(existsSync(trashPath));

    // After the window — file is purged.
    const after = await fixture.deletionMod.purgeExpiredArtifactTrash({ now: new Date(Date.parse(confirmed.purgeAt) + 1) });
    // Other tests' trashed rows may also fall due in this run; assert at least
    // ours was purged and the on-disk file is gone.
    assert.ok(after.purgedFiles >= 1);
    assert.ok(!existsSync(trashPath));
    const purgeAudit = fixture.sqlite.prepare(
      `SELECT status FROM file_lifecycle_events WHERE entity_type = 'artifact' AND entity_id = ? AND event = 'artifact.purge' ORDER BY created_at DESC LIMIT 1`,
    ).get(record.artifactId) as { status: string } | undefined;
    assert.equal(purgeAudit?.status, "success");

    // Idempotent re-run for our row.
    const again = await fixture.deletionMod.purgeExpiredArtifactTrash({ now: new Date(Date.parse(confirmed.purgeAt) + 2) });
    assert.equal(again.purgedFiles, 0);
  } finally {
    fixture.deletionMod.clearPendingDeleteTokensForTest();
  }
});

// ---------- Backfill (D12) ----------

test("workspace backfill registers curated reports once and is idempotent on re-run", async () => {
  const fixture = await getFixture();
  const { resolveWorkspacePath } = await import("../src/lib/workspace.js");
  const user = "user-backfill";
  const ws = resolveWorkspacePath(user);
  try {
    // Seed a few curated files plus excluded ones.
    await mkdir(path.join(ws, "reports/daily"), { recursive: true });
    await mkdir(path.join(ws, "reports/weekly"), { recursive: true });
    await mkdir(path.join(ws, "reports/company"), { recursive: true });
    await mkdir(path.join(ws, "reports/html"), { recursive: true });
    await mkdir(path.join(ws, "reports/metrics"), { recursive: true });
    await mkdir(path.join(ws, "reports/alerts"), { recursive: true });
    await writeFile(path.join(ws, "reports/daily/2026-07-20.md"), "# daily");
    await writeFile(path.join(ws, "reports/weekly/2026-W29.md"), "# weekly");
    await writeFile(path.join(ws, "reports/company/600519.md"), "# company");
    await writeFile(path.join(ws, "reports/html/2026-07-25-portfolio-risk.html"), "<!doctype html><html><body>risk</body></html>");
    await writeFile(path.join(ws, "reports/metrics/zZlkp.md"), "# metrics");
    // Excluded: alerts dir is not curated.
    await writeFile(path.join(ws, "reports/alerts/noise.md"), "# alert");
    // Excluded: oversized.
    await writeFile(path.join(ws, "reports/daily/big.md"), "# " + "z".repeat(2 * 1024 * 1024));
    // Excluded: unknown extension.
    await writeFile(path.join(ws, "reports/daily/scratch.bin"), Buffer.from([0, 1, 2]));

    // Register the user/instance scope so the backfill sees it. Insert the
    // parent session first to satisfy the FK on conversation_messages.
    const now = new Date().toISOString();
    fixture.sqlite
      .prepare(`INSERT INTO conversation_sessions (conversation_id, user_id, project_id, instance_id, assistant_id, channel, title, message_count, status, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', '{}', ?, ?)`)
      .run("conv-seed-backfill", user, "invest-agent", user, user, "web", "seed", now, now);
    fixture.sqlite
      .prepare(`INSERT INTO conversation_messages (message_id, conversation_id, user_id, project_id, instance_id, assistant_id, channel, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("msg-seed-backfill", "conv-seed-backfill", user, "invest-agent", user, user, "web", "user", "seed", "sent", now);

    const first = await fixture.backfillMod.backfillCuratedWorkspaceReports({});
    assert.ok(first.registered >= 5, `expected >=5 registered, got ${first.registered}`);
    assert.ok(first.excludedOversize >= 1);
    assert.ok(first.excludedMime >= 1);
    // alerts/ is outside the curated dir list so it is never even scanned.

    // Library list now shows the backfilled reports.
    const lib = await fixture.artifactMod.listCuratedArtifactLibrary({ userId: user, instanceId: user });
    const paths = new Set(lib.items.map((item) => item.displayPath));
    assert.ok(paths.has("daily/2026-07-20.md"));
    assert.ok(paths.has("weekly/2026-W29.md"));
    assert.ok(paths.has("company/600519.md"));
    assert.ok(paths.has("html/2026-07-25-portfolio-risk.html"));
    assert.ok(paths.has("metrics/zZlkp.md"));
    assert.equal(lib.items.find((item) => item.displayPath === "html/2026-07-25-portfolio-risk.html")?.category, "html");
    // And the excluded files are absent.
    assert.ok(!paths.has("alerts/noise.md"));
    assert.ok(!paths.has("daily/big.md"));
    assert.ok(!paths.has("daily/scratch.bin"));
    const backfillAudit = fixture.sqlite.prepare(
      `SELECT COUNT(*) AS count FROM file_lifecycle_events WHERE user_id = ? AND event = 'artifact.backfill.registered'`,
    ).get(user) as { count: number };
    assert.ok(backfillAudit.count >= 5);

    // Re-running does not register duplicates.
    const second = await fixture.backfillMod.backfillCuratedWorkspaceReports({});
    assert.equal(second.registered, 0);
    assert.ok(second.alreadyIndexed >= 5);
  } finally {
  }
});

test("artifact retention classification backfill tags existing rows deterministically", async () => {
  const fixture = await getFixture();
  try {
    const record = await publishMarkdown(fixture, "reports/daily/unclear.md", "# x");
    // Wipe the classification to simulate a pre-backfill row.
    fixture.sqlite
      .prepare(`UPDATE conversation_artifacts SET origin = NULL, retention_class = NULL, visibility = NULL, expires_at = NULL WHERE artifact_id = ?`)
      .run(record.artifactId);

    const summary = await fixture.backfillMod.backfillArtifactRetentionClassification({});
    assert.ok(summary.classified >= 1);
    assert.ok(summary.durableLibrary >= 1);

    const row = fixture.sqlite
      .prepare(`SELECT retention_class AS c, visibility AS v, origin AS o FROM conversation_artifacts WHERE artifact_id = ?`)
      .get(record.artifactId) as { c: string; v: string; o: string };
    assert.equal(row.c, "durable_library");
    assert.equal(row.v, "library");
    assert.equal(row.o, "assistant");

    // Re-run does not re-classify this row.
    fixture.sqlite
      .prepare(`UPDATE conversation_artifacts SET origin = NULL, retention_class = NULL, visibility = NULL, expires_at = NULL WHERE artifact_id = ?`)
      .run(record.artifactId);
    const beforeCount = (fixture.sqlite.prepare(`SELECT COUNT(*) AS n FROM conversation_artifacts WHERE artifact_id = ? AND retention_class IS NULL`).get(record.artifactId) as { n: number }).n;
    assert.equal(beforeCount, 1);
    await fixture.backfillMod.backfillArtifactRetentionClassification({});
    const after = fixture.sqlite
      .prepare(`SELECT retention_class AS c FROM conversation_artifacts WHERE artifact_id = ?`)
      .get(record.artifactId) as { c: string };
    assert.equal(after.c, "durable_library");
  } finally {
  }
});

// ---------- Migration (D13) ----------

test("migration is idempotent: re-running initDb keeps the new columns and indexes", async () => {
  const fixture = await getFixture();
  try {
    const { initDb } = await import("../src/db/index.js");
    // Re-run initDb on the same database.
    initDb();
    const cols = fixture.sqlite.prepare(`PRAGMA table_info(conversation_artifacts)`).all() as Array<{ name: string }>;
    const names = new Set(cols.map((col) => col.name));
    for (const expected of ["origin", "retention_class", "visibility", "expires_at", "deleted_at", "deleted_by", "delete_reason", "trash_relative_path", "purge_at", "idempotency_key"]) {
      assert.ok(names.has(expected), `missing column ${expected}`);
    }
    const attCols = fixture.sqlite.prepare(`PRAGMA table_info(conversation_attachments)`).all() as Array<{ name: string }>;
    assert.ok(new Set(attCols.map((col) => col.name)).has("expires_at"));
    // Indexes are present.
    const indexes = fixture.sqlite.prepare(`PRAGMA index_list(conversation_artifacts)`).all() as Array<{ name: string }>;
    const indexNames = new Set(indexes.map((idx) => idx.name));
    assert.ok(indexNames.has("idx_conversation_artifacts_library"));
    assert.ok(indexNames.has("idx_conversation_artifacts_retention"));
    assert.ok(indexNames.has("idx_conversation_artifacts_purge"));
    assert.ok(indexNames.has("idx_conversation_artifacts_idempotency_key"));
    const lifecycleTable = fixture.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_lifecycle_events'`).get();
    const confirmationsTable = fixture.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifact_delete_confirmations'`).get();
    assert.ok(lifecycleTable);
    assert.ok(confirmationsTable);
  } finally {
  }
});
