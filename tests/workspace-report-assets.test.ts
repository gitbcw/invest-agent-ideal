import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("reads only allowlisted report artifacts without following escaping symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "invest-agent-report-assets-"));
  process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
  process.env.DB_PATH = path.join(root, "runtime.db");
  process.env.NODE_ENV = "test";
  const { initDb } = await import("../src/db/index.js");
  initDb();
  const { registerTestProject } = await import("./helpers/mastra-project.js");
  const workspace = await registerTestProject({ userId: "mg", projectId: "invest-agent", instanceId: "mg" });
  const reportPath = path.join(workspace, "reports", "metrics", "flow.svg");
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  await writeFile(path.join(root, "secret.svg"), "not a report");
  await symlink(path.join(root, "secret.svg"), path.join(workspace, "reports", "metrics", "outside.svg"));

  try {
    const { readWorkspaceReportAsset, WorkspaceReportAssetError } = await import("../src/services/workspace-report-assets.js");
    const asset = await readWorkspaceReportAsset({ userId: "mg", projectId: "invest-agent", instanceId: "mg", relativePath: "reports/metrics/flow.svg" });
    assert.equal(asset.mimeType, "image/svg+xml");
    assert.equal(Buffer.from(asset.base64, "base64").toString(), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
    await assert.rejects(
      () => readWorkspaceReportAsset({ userId: "mg", projectId: "invest-agent", instanceId: "mg", relativePath: "reports/metrics/outside.svg" }),
      (error: unknown) => error instanceof WorkspaceReportAssetError && error.code === "REPORT_ASSET_INVALID_PATH",
    );
    await assert.rejects(
      () => readWorkspaceReportAsset({ userId: "mg", projectId: "invest-agent", instanceId: "mg", relativePath: "../secret.svg" }),
      (error: unknown) => error instanceof WorkspaceReportAssetError && error.code === "REPORT_ASSET_INVALID_PATH",
    );
  } finally {

  }
});
