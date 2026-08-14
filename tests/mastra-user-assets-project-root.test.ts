import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = mkdtempSync(path.join(os.tmpdir(), "mastra-user-assets-project-root-"));
process.env.NODE_ENV = "test";
process.env.WORKSPACE_BACKEND = "mastra";
process.env.DB_PATH = path.join(root, "assets.db");
process.env.WORKSPACE_ROOT = path.join(root, "legacy-workspaces");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "mastra-projects");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

test("Mastra user assets use the registered project root and fail closed for another instance", async () => {
  const db = await import("../src/db/index.js");
  db.initDb();
  const { mastraWorkspaceRegistry } = await import("../src/mastra/workspace-registry.js");
  const assets = await import("../src/services/user-assets.js");
  const scope = { userId: "asset-user", projectId: "project-a", instanceId: "instance-a" };
  const projectRoot = path.join(root, "mastra-projects", "project-a");
  await mkdir(projectRoot, { recursive: true });
  await mastraWorkspaceRegistry.register({ ...scope, projectRoot });

  const saved = await assets.createUserAsset({
    ...scope,
    name: "Scoped file",
    fileName: "scoped.md",
    mimeType: "text/markdown",
    bytes: Buffer.from("# scoped\n"),
  });
  const storagePath = saved.currentVersion?.storagePath;
  assert.ok(storagePath);
  assert.equal((await readFile(path.join(projectRoot, storagePath!), "utf8")), "# scoped\n");

  await assert.rejects(
    () => assets.createUserAsset({
      ...scope,
      instanceId: "instance-b",
      name: "Wrong scope",
      fileName: "wrong.md",
      mimeType: "text/markdown",
      bytes: Buffer.from("wrong\n"),
    }),
    (error: unknown) => (error as { code?: string }).code === "MASTRA_PROJECT_SCOPE_UNAVAILABLE",
  );
  mastraWorkspaceRegistry.unregister(scope);
});
