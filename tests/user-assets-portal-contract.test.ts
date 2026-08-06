import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-user-assets-portal-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "assets.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
mkdir(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const fixture = (async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const connector = await import("../src/portal/connector.js");
  return { db, connector };
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

test("Portal asset commands expose upload/version/restore/archive without paths", async () => {
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
