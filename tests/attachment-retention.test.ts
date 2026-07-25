import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * The legacy mtime-based sweep has been replaced by the authoritative
 * `conversation_attachments` table. These tests cover the public
 * `attachment-retention.ts` shim: with the cleanup gate disabled (the default)
 * it is a no-op; with `FILE_RETENTION_CLEANUP_ENABLED=true` it delegates to
 * the table-based implementation. The full lifecycle behaviour is exercised in
 * `tests/file-retention.test.ts`.
 */
test("attachment cleanup shim is a no-op when the cleanup gate is disabled", async () => {
  const previous = process.env.FILE_RETENTION_CLEANUP_ENABLED;
  delete process.env.FILE_RETENTION_CLEANUP_ENABLED;
  const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-attachments-"));
  try {
    const { cleanupExpiredAttachments } = await import("../src/services/attachment-retention.js");
    const file = path.join(root, "user-a", "attachments", "2026-07-25", "old.txt");
    await mkdir(path.dirname(file), { recursive: true });
    writeFileSync(file, "old");
    const result = await cleanupExpiredAttachments();
    assert.equal(result.skipped, true);
    assert.equal(existsSync(file), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (previous !== undefined) process.env.FILE_RETENTION_CLEANUP_ENABLED = previous;
  }
});
