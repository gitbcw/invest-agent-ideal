import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-user-assets-portal-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "assets.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
// E8: the mastra registry is the only storage root; isolate it per run.
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
mkdir(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const fixture = (async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  // E8: asset storage roots resolve to registered mastra project roots.
  const { registerTestProject } = await import("./helpers/mastra-project.js");
  const projectA = await registerTestProject({
    userId: "portal-asset-a",
    projectId: "invest-agent",
    instanceId: "portal-asset-instance-a",
  });
  await registerTestProject({
    userId: "portal-asset-b",
    projectId: "invest-agent",
    instanceId: "portal-asset-instance-b",
  });
  const connector = await import("../src/portal/connector.js");
  return { db, connector, projectA };
})();

const scopeA = {
  userId: "portal-asset-a",
  assistantId: "portal-asset-instance-a",
  instanceId: "portal-asset-instance-a",
  projectId: "invest-agent",
  connectorId: "test-asset-connector-a",
  displayName: "asset test",
};
const scopeB = { ...scopeA, userId: "portal-asset-b", assistantId: "portal-asset-instance-b", instanceId: "portal-asset-instance-b" };

function command(type: string, payload: Record<string, unknown> = {}) {
  return {
    protocolVersion: "2026-08-05",
    requestId: "asset-" + Math.random(),
    type,
    sentAt: new Date().toISOString(),
    payload,
  };
}

test("Portal asset commands expose upload/version/restore/archive/delete without paths", async () => {
  const { connector } = await fixture;
  const malicious = await connector.__test__.handleCommand(scopeA, command("asset.upload", {
    userId: scopeB.userId,
    projectId: scopeB.projectId,
    instanceId: scopeB.instanceId,
    name: "Portal 文档",
    fileName: "portal.md",
    mimeType: "text/markdown",
    base64: Buffer.from("# portal\n").toString("base64"),
  })) as any;
  assert.equal(malicious.ok, false);
  assert.equal(malicious.error.code, "INVALID_REQUEST");
  const uploaded = await connector.__test__.handleCommand(scopeA, command("asset.upload", {
    name: "Portal 文档",
    fileName: "portal.md",
    mimeType: "text/markdown",
    base64: Buffer.from("# portal\n").toString("base64"),
  })) as any;
  assert.equal(uploaded.ok, true);
  const asset = uploaded.data;
  assert.equal(asset.name, "Portal 文档");
  assert.equal("userId" in asset, false);
  assert.equal("storagePath" in asset.currentVersion, false);
  const firstVersionId = asset.currentVersionId;

  const listed = await connector.__test__.handleCommand(scopeA, command("asset.list")) as any;
  assert.equal(listed.ok, true);
  assert.equal(listed.data.items.some((item: any) => item.assetId === asset.assetId), true);

  const read = await connector.__test__.handleCommand(scopeA, command("asset.version.get", { assetId: asset.assetId })) as any;
  assert.equal(Buffer.from(read.data.base64, "base64").toString(), "# portal\n");
  assert.equal("storagePath" in read.data, false);
  const restored = await connector.__test__.handleCommand(scopeA, command("asset.restore_version", {
    assetId: asset.assetId,
    versionId: firstVersionId,
    expectedVersionId: firstVersionId,
  })) as any;
  assert.equal(restored.ok, true);
  assert.notEqual(restored.data.currentVersionId, firstVersionId);

  const renamed = await connector.__test__.handleCommand(scopeA, command("asset.rename", {
    assetId: asset.assetId,
    name: "Portal 文档（重命名）",
  })) as any;
  assert.equal(renamed.data.name, "Portal 文档（重命名）");
  const archived = await connector.__test__.handleCommand(scopeA, command("asset.archive", { assetId: asset.assetId })) as any;
  assert.equal(archived.data.status, "archived");

  const versions = await connector.__test__.handleCommand(scopeA, command("asset.versions.list", { assetId: asset.assetId })) as any;
  assert.equal(versions.data.items.length, 2);
  assert.equal(versions.data.items.some((item: any) => item.versionId === firstVersionId), true);

  const deleted = await connector.__test__.handleCommand(scopeA, command("asset.delete", { assetId: asset.assetId })) as any;
  assert.equal(deleted.ok, true);
  assert.equal(deleted.data.assetId, asset.assetId);
  assert.equal(deleted.data.deletedVersions, 2);
  assert.equal("storagePath" in deleted.data, false);
});

test("Portal saves a conversation artifact to My Files", async () => {
  const { connector, projectA } = await fixture;
  const artifacts = await import("../src/services/conversation-artifacts.js");
  // E8: the conversation artifact file lives in the registered project root.
  const workspace = projectA;
  await mkdir(path.join(workspace, "deliveries"), { recursive: true });
  await writeFile(path.join(workspace, "deliveries", "saved-from-chat.csv"), "日期,运价\n");
  const artifact = await artifacts.publishConversationArtifact({
    userId: scopeA.userId,
    instanceId: scopeA.instanceId,
    relativePath: "deliveries/saved-from-chat.csv",
    scope: {
      projectId: scopeA.projectId,
      assistantId: scopeA.assistantId,
      conversationId: "conversation-save-test",
      source: "artifacts.publish",
    },
  });

  const saved = await connector.__test__.handleCommand(scopeA, command("asset.conversation.save", {
    artifactId: artifact.artifactId,
    idempotencyKey: `save-artifact:${artifact.artifactId}`,
  })) as any;
  assert.equal(saved.ok, true);
  assert.equal(saved.data.name, artifact.title);
  assert.equal(saved.data.currentVersion.source, "conversation");
});

test("Portal normalizes a CSV upload to XLSX and no longer exposes a conversion action", async () => {
  const { connector } = await fixture;
  const uploaded = await connector.__test__.handleCommand(scopeA, command("asset.upload", {
    name: "转换文件",
    fileName: "convert.csv",
    mimeType: "text/csv",
    base64: Buffer.from("name,value\n煤炭,700\n").toString("base64"),
  })) as any;
  const asset = uploaded.data;
  assert.equal(asset.currentVersion.format, "xlsx");
  assert.equal(asset.currentVersion.fileName, "convert.xlsx");
  await assert.rejects(
    () => connector.__test__.handleCommand(scopeA, command("asset.convert_to_xlsx", {
      assetId: asset.assetId,
      expectedVersionId: asset.currentVersionId,
      confirmed: true,
      idempotencyKey: "portal-convert-obsolete",
    })),
    (error: unknown) => (error as { code?: string }).code === "ASSET_UNSUPPORTED_FORMAT",
  );
});

test("Portal asset commands enforce registered connector scope", async () => {
  const { connector } = await fixture;
  const created = await connector.__test__.handleCommand(scopeA, command("asset.upload", {
    fileName: "private.md",
    base64: Buffer.from("# private\n").toString("base64"),
  })) as any;
  const assetId = created.data.assetId;
  const listed = await connector.__test__.handleCommand(scopeB, command("asset.list")) as any;
  assert.equal(listed.data.items.some((item: any) => item.assetId === assetId), false);
  await assert.rejects(
    () => connector.__test__.handleCommand(scopeB, command("asset.get", { assetId })),
    (error: unknown) => (error as { code?: string }).code === "ASSET_SCOPE_MISMATCH",
  );
  await assert.rejects(
    () => connector.__test__.handleCommand(scopeB, command("asset.version.get", { assetId })),
    (error: unknown) => (error as { code?: string }).code === "ASSET_SCOPE_MISMATCH",
  );
});

test("Portal asset list rejects an unknown status instead of defaulting to active", async () => {
  const { connector } = await fixture;
  const response = await connector.__test__.handleCommand(scopeA, command("asset.list", { status: "deleted" })) as any;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "INVALID_REQUEST");
});

test("Portal uploads preserve the requested folder for single and batch files", async () => {
  const { connector } = await fixture;
  const folder = await connector.__test__.handleCommand(scopeA, command("asset.folder.create", { name: `上传目录-${Date.now()}` })) as any;
  assert.equal(folder.ok, true);

  const single = await connector.__test__.handleCommand(scopeA, command("asset.upload", {
    fileName: "folder-single.md",
    folderId: folder.data.folderId,
    base64: Buffer.from("# single\n").toString("base64"),
  })) as any;
  assert.equal(single.ok, true);
  assert.equal(single.data.folderId, folder.data.folderId);

  const batch = await connector.__test__.handleCommand(scopeA, command("asset.upload", {
    files: [{
      fileName: "folder-batch.md",
      folderId: folder.data.folderId,
      base64: Buffer.from("# batch\n").toString("base64"),
    }],
  })) as any;
  assert.equal(batch.ok, true);
  assert.equal(batch.data.items[0].asset.folderId, folder.data.folderId);

  const listed = await connector.__test__.handleCommand(scopeA, command("asset.list", { folderId: folder.data.folderId })) as any;
  assert.deepEqual(new Set(listed.data.items.map((item: any) => item.assetId)), new Set([single.data.assetId, batch.data.items[0].asset.assetId]));
});

test("Portal folder rename/delete enforce scoped empty-folder contract", async () => {
  const { connector } = await fixture;
  const rootFolder = await connector.__test__.handleCommand(scopeA, command("asset.folder.create", { name: `Portal folder root ${Date.now()}` })) as any;
  const siblingFolder = await connector.__test__.handleCommand(scopeA, command("asset.folder.create", { name: `Portal folder sibling ${Date.now()}` })) as any;
  const childFolder = await connector.__test__.handleCommand(scopeA, command("asset.folder.create", {
    name: "Portal child",
    parentFolderId: rootFolder.data.folderId,
  })) as any;

  const renamed = await connector.__test__.handleCommand(scopeA, command("asset.folder.rename", {
    folderId: rootFolder.data.folderId,
    name: "Portal folder root renamed",
  })) as any;
  assert.equal(renamed.ok, true);
  assert.equal(renamed.data.folderId, rootFolder.data.folderId);
  assert.equal(renamed.data.name, "Portal folder root renamed");

  await assert.rejects(
    () => connector.__test__.handleCommand(scopeA, command("asset.folder.rename", {
      folderId: siblingFolder.data.folderId,
      name: "PORTAL FOLDER ROOT RENAMED",
    })),
    (error: unknown) => (error as { code?: string }).code === "ASSET_FOLDER_NAME_CONFLICT",
  );
  await assert.rejects(
    () => connector.__test__.handleCommand(scopeB, command("asset.folder.rename", {
      folderId: rootFolder.data.folderId,
      name: "cross-scope",
    })),
    (error: unknown) => (error as { code?: string }).code === "ASSET_SCOPE_MISMATCH",
  );

  const uploaded = await connector.__test__.handleCommand(scopeA, command("asset.upload", {
    fileName: "non-empty-folder.md",
    folderId: childFolder.data.folderId,
    base64: Buffer.from("# folder\n").toString("base64"),
  })) as any;
  assert.equal(uploaded.ok, true);
  await assert.rejects(
    () => connector.__test__.handleCommand(scopeA, command("asset.folder.delete", { folderId: childFolder.data.folderId })),
    (error: unknown) => (error as { code?: string }).code === "ASSET_FOLDER_NOT_EMPTY",
  );

  const deletedAsset = await connector.__test__.handleCommand(scopeA, command("asset.delete", { assetId: uploaded.data.assetId })) as any;
  assert.equal(deletedAsset.ok, true);
  const deletedChild = await connector.__test__.handleCommand(scopeA, command("asset.folder.delete", { folderId: childFolder.data.folderId })) as any;
  assert.deepEqual(deletedChild.data, { folderId: childFolder.data.folderId });
  await assert.rejects(
    () => connector.__test__.handleCommand(scopeB, command("asset.folder.delete", { folderId: rootFolder.data.folderId })),
    (error: unknown) => (error as { code?: string }).code === "ASSET_SCOPE_MISMATCH",
  );
  const deletedRoot = await connector.__test__.handleCommand(scopeA, command("asset.folder.delete", { folderId: rootFolder.data.folderId })) as any;
  assert.deepEqual(deletedRoot.data, { folderId: rootFolder.data.folderId });
  const deletedSibling = await connector.__test__.handleCommand(scopeA, command("asset.folder.delete", { folderId: siblingFolder.data.folderId })) as any;
  assert.deepEqual(deletedSibling.data, { folderId: siblingFolder.data.folderId });
});

test("Portal batch upload validates every payload before writes and returns per-file results", async () => {
  const { connector } = await fixture;
  const before = await connector.__test__.handleCommand(scopeA, command("asset.list")) as any;
  const malformed = await connector.__test__.handleCommand(scopeA, command("asset.upload", {
    files: [
      { fileName: "valid.md", mimeType: "text/markdown", base64: Buffer.from("# valid\n").toString("base64") },
      { fileName: "broken.md", mimeType: "text/markdown", base64: "not base64!" },
    ],
  })) as any;
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error.code, "INVALID_REQUEST");
  const afterMalformed = await connector.__test__.handleCommand(scopeA, command("asset.list")) as any;
  assert.equal(afterMalformed.data.items.length, before.data.items.length, "malformed batch must not partially write");

  const uploaded = await connector.__test__.handleCommand(scopeA, command("asset.upload", {
    files: [
      { fileName: "batch-a.md", mimeType: "text/markdown", base64: Buffer.from("# a\n").toString("base64"), idempotencyKey: "batch-a" },
      { fileName: "batch-b.md", mimeType: "text/markdown", base64: Buffer.from("# b\n").toString("base64"), idempotencyKey: "batch-b" },
    ],
  })) as any;
  assert.equal(uploaded.ok, true);
  assert.equal(uploaded.data.items.length, 2);
  assert.equal(uploaded.data.items.every((item: any) => item.ok), true);
});

test("Portal batch upload applies decoded 10MB file and 20MB aggregate limits before writes", async () => {
  const { connector } = await fixture;
  await assert.rejects(
    () => connector.__test__.handleCommand(scopeA, command("asset.upload", {
      files: [{ fileName: "too-large.md", mimeType: "text/markdown", base64: Buffer.alloc(10 * 1024 * 1024 + 1, 65).toString("base64") }],
    })),
    (error: unknown) => (error as { code?: string }).code === "ASSET_TOO_LARGE",
  );

  const tenMiB = Buffer.alloc(10 * 1024 * 1024, 66).toString("base64");
  await assert.rejects(
    () => connector.__test__.handleCommand(scopeA, command("asset.upload", {
      files: [
        { fileName: "request-a.md", mimeType: "text/markdown", base64: tenMiB },
        { fileName: "request-b.md", mimeType: "text/markdown", base64: tenMiB },
        { fileName: "request-c.md", mimeType: "text/markdown", base64: Buffer.from("x").toString("base64") },
      ],
    })),
    (error: unknown) => (error as { code?: string }).code === "UPLOAD_REQUEST_TOO_LARGE",
  );
});

test("report mappings open their same-scope backing asset without copying bytes", async () => {
  const { connector } = await fixture;
  const uploaded = await connector.__test__.handleCommand(scopeA, command("asset.upload", {
    fileName: "mapped-report.md",
    mimeType: "text/markdown",
    base64: Buffer.from("# backed report\n").toString("base64"),
    idempotencyKey: "backed-report",
  })) as any;
  const mappings = await import("../src/services/report-asset-mappings.js");
  const mapping = await mappings.registerReportAssetMapping({
    userId: scopeA.userId,
    projectId: scopeA.projectId,
    instanceId: scopeA.instanceId,
    reportId: "backed-portal-report",
    title: "Backed portal report",
    fileName: "mapped-report.md",
    mimeType: "text/markdown",
    sizeBytes: uploaded.data.currentVersion.sizeBytes,
    backingAssetId: uploaded.data.assetId,
    backingVersionId: uploaded.data.currentVersionId,
  });
  const response = await connector.__test__.handleCommand(scopeA, command("report.mapping.get", { mappingId: mapping.mappingId })) as any;
  assert.equal(response.ok, true);
  const folder = await connector.__test__.handleCommand(scopeA, command("asset.folder.create", { name: `报告目录-${Date.now()}` })) as any;
  await connector.__test__.handleCommand(scopeA, command("asset.move", { assetId: uploaded.data.assetId, folderId: folder.data.folderId }));
  const rootListing = await connector.__test__.handleCommand(scopeA, command("asset.list", { folderId: null })) as any;
  assert.equal(rootListing.data.catalog.some((item: any) => item.reportMappingId === mapping.mappingId), false);
  const folderListing = await connector.__test__.handleCommand(scopeA, command("asset.list", { folderId: folder.data.folderId })) as any;
  assert.equal(folderListing.data.catalog.some((item: any) => item.reportMappingId === mapping.mappingId), true);
  assert.equal(Buffer.from(response.data.base64, "base64").toString(), "# backed report\n");
  assert.equal(response.data.sizeBytes, uploaded.data.currentVersion.sizeBytes);
});
