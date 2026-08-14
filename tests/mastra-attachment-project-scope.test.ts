import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "mastra-attachment-project-scope-"));
process.env.NODE_ENV = "test";
process.env.WORKSPACE_BACKEND = "mastra";
process.env.DB_PATH = path.join(root, "runtime.db");
process.env.WORKSPACE_ROOT = path.join(root, "legacy-workspaces");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

test("Mastra attachments require the complete project scope for metadata and bytes", async () => {
  const { initDb } = await import("../src/db/index.js");
  const { storePortalAttachment } = await import("../src/lib/attachment-store.js");
  const { mastraWorkspaceRegistry } = await import("../src/mastra/workspace-registry.js");
  const retention = await import("../src/services/file-retention.js");
  initDb();

  const scopeA = { userId: "attachment-user", projectId: "project-a", instanceId: "shared-instance" };
  const scopeB = { ...scopeA, projectId: "project-b" };
  const projectA = await mastraWorkspaceRegistry.bootstrap(scopeA);
  await mastraWorkspaceRegistry.bootstrap(scopeB);
  try {
    const stored = await storePortalAttachment({
      workspacePath: projectA.projectRoot,
      attachment: {
        kind: "document",
        fileName: "scope.txt",
        mimeType: "text/plain",
        base64: Buffer.from("project A only\n").toString("base64"),
      },
    });
    retention.registerAttachment({ ...scopeA, conversationId: "conversation-a", stored });

    const allowed = await retention.readAttachmentBytes({ attachmentId: stored.id, ...scopeA });
    assert.equal(allowed.bytes.toString(), "project A only\n");
    assert.equal(allowed.record.projectId, scopeA.projectId);
    assert.equal(await readFile(stored.path, "utf8"), "project A only\n");

    assert.equal(retention.findAttachmentRecord({ attachmentId: stored.id, ...scopeB }), undefined);
    await assert.rejects(
      () => retention.readAttachmentBytes({ attachmentId: stored.id, ...scopeB }),
      (error: unknown) => (error as { code?: string }).code === "ATTACHMENT_NOT_FOUND",
    );
  } finally {
    mastraWorkspaceRegistry.unregister(scopeA);
    mastraWorkspaceRegistry.unregister(scopeB);
  }
});
