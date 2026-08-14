import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Mastra workspace-file compatibility reads only a registered complete project scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-workspace-file-compat-"));
  const previousBackend = process.env.WORKSPACE_BACKEND;
  const previousProjectsRoot = process.env.MASTRA_PROJECTS_ROOT;
  process.env.WORKSPACE_BACKEND = "mastra";
  process.env.MASTRA_PROJECTS_ROOT = root;
  const scope = { userId: "file-user", projectId: "project-a", instanceId: "instance-a" };
  const project = path.join(root, "project-a");
  try {
    await mkdir(path.join(project, "reports"), { recursive: true });
    await writeFile(path.join(project, "reports", "visible.md"), "scope A\n");
    const { mastraWorkspaceRegistry } = await import("../src/mastra/workspace-registry.js");
    const { listWorkspaceFiles, readWorkspaceFile, WorkspaceFileError } = await import("../src/services/workspace-files.js");
    const { __test__: connector } = await import("../src/portal/connector.js");
    await mastraWorkspaceRegistry.register({ ...scope, projectRoot: project });

    const listed = await listWorkspaceFiles(scope);
    assert.deepEqual(listed.items.map((item) => item.relativePath), ["reports/visible.md"]);
    const file = await readWorkspaceFile({ ...scope, relativePath: "reports/visible.md" });
    assert.equal(Buffer.from(file.base64, "base64").toString(), "scope A\n");

    const connectorScope = {
      ...scope,
      assistantId: scope.instanceId,
      connectorId: "test-connector",
      displayName: "test",
    };
    const listedFromConnector = await connector.handleCommand(connectorScope, {
      protocolVersion: "2026-08-05",
      requestId: "workspace-file-list",
      type: "workspace.file.list",
      sentAt: new Date().toISOString(),
      payload: {},
    });
    assert.equal(listedFromConnector.ok, true);
    assert.deepEqual((listedFromConnector.data as { items: { relativePath: string }[] }).items.map((item) => item.relativePath), ["reports/visible.md"]);

    await assert.rejects(
      () => listWorkspaceFiles({ ...scope, instanceId: "instance-b" }),
      (error: unknown) => error instanceof WorkspaceFileError && error.code === "WORKSPACE_FILE_SCOPE_UNAVAILABLE",
    );
    await assert.rejects(
      () => readWorkspaceFile({ userId: scope.userId, relativePath: "reports/visible.md" }),
      (error: unknown) => error instanceof WorkspaceFileError && error.code === "WORKSPACE_FILE_SCOPE_UNAVAILABLE",
    );
    mastraWorkspaceRegistry.unregister(scope);
  } finally {
    if (previousBackend === undefined) delete process.env.WORKSPACE_BACKEND;
    else process.env.WORKSPACE_BACKEND = previousBackend;
    if (previousProjectsRoot === undefined) delete process.env.MASTRA_PROJECTS_ROOT;
    else process.env.MASTRA_PROJECTS_ROOT = previousProjectsRoot;
    await rm(root, { recursive: true, force: true });
  }
});
