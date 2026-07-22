import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { rm, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

test("removes only expired workspace attachment files", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-attachments-"));
  try {
    const { cleanupExpiredAttachments } = await import("../src/services/attachment-retention.js");
    const attachments = path.join(root, "user-a", "attachments"); await mkdir(attachments, { recursive: true });
    const oldFile = path.join(attachments, "old.txt"); const freshFile = path.join(attachments, "fresh.txt"); const linked = path.join(attachments, "linked.txt");
    writeFileSync(oldFile, "old"); writeFileSync(freshFile, "fresh"); await symlink(freshFile, linked);
    utimesSync(oldFile, new Date(Date.now() - 5 * 86_400_000), new Date(Date.now() - 5 * 86_400_000));
    const result = await cleanupExpiredAttachments({ workspaceRoot: root, retentionDays: 3 });
    assert.equal(result.deletedFiles, 1); assert.equal(existsSync(oldFile), false); assert.equal(existsSync(freshFile), true); assert.equal(existsSync(linked), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
