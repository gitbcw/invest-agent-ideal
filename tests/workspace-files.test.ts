import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("workspace file browser lists user project files but excludes secrets and runtime directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "invest-agent-workspace-files-"));
  process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
  process.env.DB_PATH = path.join(root, "runtime.db");
  process.env.NODE_ENV = "test";
  const { initDb } = await import("../src/db/index.js");
  initDb();
  const { registerTestProject } = await import("./helpers/mastra-project.js");
  const workspace = await registerTestProject({ userId: "files-user", projectId: "invest-agent", instanceId: "files-user" });
  await mkdir(path.join(workspace, ".codex/skills/demo"), { recursive: true });
  await mkdir(path.join(workspace, "reports/daily"), { recursive: true });
  await mkdir(path.join(workspace, "node_modules/pkg"), { recursive: true });
  await writeFile(path.join(workspace, "AGENTS.md"), "rules\n");
  await writeFile(path.join(workspace, "analysis.py"), "print('ok')\n");
  await writeFile(path.join(workspace, "settings.toml"), "mode = \"test\"\n");
  await writeFile(path.join(workspace, "config.yaml"), "mode: test\n");
  await writeFile(path.join(workspace, "config.yml"), "enabled: true\n");
  await writeFile(path.join(workspace, "Makefile"), "all:\n\t@echo ok\n");
  await writeFile(path.join(workspace, "preview.html"), "<h1>Preview</h1>\n");
  await writeFile(path.join(workspace, "chart.png"), "png fixture\n");
  await writeFile(path.join(workspace, ".codex/skills/demo/SKILL.md"), "skill\n");
  await writeFile(path.join(workspace, "reports/daily/today.md"), "report\n");
  await writeFile(path.join(workspace, ".env"), "SECRET=do-not-list\n");
  await writeFile(path.join(workspace, "run.log"), "do-not-list\n");
  await writeFile(path.join(workspace, "node_modules/pkg/index.js"), "do-not-list\n");
  await symlink(path.join(workspace, "reports/daily/today.md"), path.join(workspace, "reports/daily/internal-link.md"));
  await writeFile(path.join(root, "outside.txt"), "outside\n");
  await symlink(path.join(root, "outside.txt"), path.join(workspace, "reports/daily/outside.txt"));

  try {
    const { listWorkspaceFiles, readWorkspaceFile, WorkspaceFileError } = await import("../src/services/workspace-files.js");
    const result = await listWorkspaceFiles({ userId: "files-user", projectId: "invest-agent", instanceId: "files-user" });
    const paths = result.items.map((item) => item.relativePath);
    assert.deepEqual(paths, ["AGENTS.md", "chart.png", "config.yaml", "config.yml", "preview.html", "reports/daily/today.md"]);
    assert.equal(result.items.find((item) => item.relativePath === "preview.html")?.previewMode, "html");
    assert.equal(result.items.find((item) => item.relativePath === "chart.png")?.previewMode, "image");
    assert.equal(result.items.find((item) => item.relativePath === "config.yaml")?.mimeType, "application/yaml");
    assert.equal(result.items.find((item) => item.relativePath === "config.yaml")?.previewMode, "text");
    const file = await readWorkspaceFile({ userId: "files-user", projectId: "invest-agent", instanceId: "files-user", relativePath: "reports/daily/today.md" });
    assert.equal(Buffer.from(file.base64, "base64").toString(), "report\n");
    assert.equal(file.checksum.length, 64);
    const yamlFile = await readWorkspaceFile({ userId: "files-user", projectId: "invest-agent", instanceId: "files-user", relativePath: "config.yml" });
    assert.equal(Buffer.from(yamlFile.base64, "base64").toString(), "enabled: true\n");
    await assert.rejects(
      () => readWorkspaceFile({ userId: "files-user", projectId: "invest-agent", instanceId: "files-user", relativePath: "../outside.txt" }),
      (error: unknown) => error instanceof WorkspaceFileError && error.code === "WORKSPACE_FILE_INVALID_PATH",
    );
    await assert.rejects(
      () => readWorkspaceFile({ userId: "files-user", projectId: "invest-agent", instanceId: "files-user", relativePath: ".env" }),
      (error: unknown) => error instanceof WorkspaceFileError && error.code === "WORKSPACE_FILE_FORBIDDEN",
    );
    await assert.rejects(
      () => readWorkspaceFile({ userId: "files-user", projectId: "invest-agent", instanceId: "files-user", relativePath: ".codex/skills/demo/SKILL.md" }),
      (error: unknown) => error instanceof WorkspaceFileError && error.code === "WORKSPACE_FILE_FORBIDDEN",
    );
    await assert.rejects(
      () => readWorkspaceFile({ userId: "files-user", projectId: "invest-agent", instanceId: "files-user", relativePath: "analysis.py" }),
      (error: unknown) => error instanceof WorkspaceFileError && error.code === "WORKSPACE_FILE_FORBIDDEN",
    );
    await assert.rejects(
      () => readWorkspaceFile({ userId: "files-user", projectId: "invest-agent", instanceId: "files-user", relativePath: "reports/daily/outside.txt" }),
      (error: unknown) => error instanceof WorkspaceFileError && error.code === "WORKSPACE_FILE_FORBIDDEN",
    );
    await assert.rejects(
      () => readWorkspaceFile({ userId: "files-user", projectId: "invest-agent", instanceId: "files-user", relativePath: "reports/daily/internal-link.md" }),
      (error: unknown) => error instanceof WorkspaceFileError && error.code === "WORKSPACE_FILE_FORBIDDEN",
    );
  } finally {

  }
});
