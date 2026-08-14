import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMastraAgent, type MastraAgentLike } from "../src/mastra/agent-factory.js";
import {
  createRegisteredMastraWorkspace,
  MastraWorkspaceRegistry,
  MastraWorkspaceScopeError,
  workspaceToolPolicy,
} from "../src/mastra/workspace-registry.js";

const alpha = { userId: "alpha", projectId: "invest-agent", instanceId: "invest-agent-alpha" };

test("scoped Workspace registry resolves only an explicitly registered matching scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-scoped-projects-"));
  const project = path.join(root, "alpha-project");
  await mkdir(project);
  try {
    const registry = new MastraWorkspaceRegistry(root);
    await registry.register({ ...alpha, projectRoot: project });
    const resolved = await registry.resolve(alpha);
    assert.ok(resolved);
    assert.equal(resolved.realProjectRoot, await realpath(project));
    assert.equal(await registry.resolve({ ...alpha, instanceId: "invest-agent-beta" }), undefined);
    assert.equal(await registry.resolve({ ...alpha, userId: "beta" }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service-only bootstrap creates a minimal clean project manifest without legacy runtime state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-scoped-projects-"));
  try {
    const registry = new MastraWorkspaceRegistry(root);
    const project = await registry.bootstrap(alpha);
    const manifest = JSON.parse(await readFile(path.join(project.projectRoot, ".agent-project", "manifest.json"), "utf8"));
    assert.deepEqual({
      schemaVersion: manifest.schemaVersion,
      userId: manifest.userId,
      projectId: manifest.projectId,
      instanceId: manifest.instanceId,
      migrationSource: manifest.migrationSource,
    }, { schemaVersion: 1, ...alpha, migrationSource: "none" });
    for (const directory of ["reports", "methods", "templates", "skills", "files", "tools", "data"]) {
      assert.ok((await import("node:fs")).existsSync(path.join(project.projectRoot, directory)));
    }
    assert.equal((await import("node:fs")).existsSync(path.join(project.projectRoot, ".codex")), false);
    assert.ok(await registry.resolve(alpha));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry recovers only its matching manifest after process-style restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-scoped-projects-"));
  try {
    const first = new MastraWorkspaceRegistry(root);
    const project = await first.bootstrap(alpha);
    const restarted = new MastraWorkspaceRegistry(root);
    const restored = await restarted.resolve(alpha);
    assert.equal(restored?.realProjectRoot, await realpath(project.projectRoot));
    assert.equal(await restarted.resolve({ ...alpha, instanceId: "different-instance" }), undefined);
    await writeFile(path.join(project.projectRoot, ".agent-project", "manifest.json"), "{}\n");
    const tampered = new MastraWorkspaceRegistry(root);
    assert.equal(await tampered.resolve(alpha), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scoped Workspace registry rejects roots outside or escaping the dedicated project root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-scoped-projects-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "mastra-scoped-outside-"));
  try {
    const registry = new MastraWorkspaceRegistry(root);
    await assert.rejects(
      registry.register({ ...alpha, projectRoot: outside }),
      (error: unknown) => error instanceof MastraWorkspaceScopeError && error.code === "MASTRA_WORKSPACE_ROOT_INVALID",
    );
    const link = path.join(root, "escape");
    await symlink(outside, link);
    await assert.rejects(
      registry.register({ ...alpha, projectRoot: link }),
      (error: unknown) => error instanceof MastraWorkspaceScopeError && error.code === "MASTRA_WORKSPACE_ROOT_INVALID",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("scoped Workspace has containment, private skills, no sandbox, and an explicit least-privilege tool policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-scoped-projects-"));
  const project = path.join(root, "alpha-project");
  await mkdir(path.join(project, "skills"), { recursive: true });
  try {
    const registry = new MastraWorkspaceRegistry(root);
    await registry.register({ ...alpha, projectRoot: project });
    let filesystemOptions: Record<string, unknown> | undefined;
    let workspaceOptions: Record<string, unknown> | undefined;
    class FakeFilesystem {
      constructor(options: Record<string, unknown>) { filesystemOptions = options; }
    }
    class FakeWorkspace {
      constructor(options: Record<string, unknown>) { workspaceOptions = options; }
    }
    const workspace = await createRegisteredMastraWorkspace({
      scope: alpha,
      registry,
      bindings: { Agent: class { stream() { return { text: "unused" }; } } as unknown as new () => MastraAgentLike, Workspace: FakeWorkspace, LocalFilesystem: FakeFilesystem },
    });
    assert.ok(workspace);
    assert.deepEqual(filesystemOptions && {
      basePath: filesystemOptions.basePath,
      contained: filesystemOptions.contained,
      allowedPaths: filesystemOptions.allowedPaths,
    }, { basePath: await realpath(project), contained: true, allowedPaths: [] });
    assert.deepEqual(workspaceOptions?.skills, ["skills"]);
    assert.equal("sandbox" in (workspaceOptions ?? {}), false);
    const tools = workspaceOptions?.tools as Record<string, Record<string, unknown>>;
    assert.equal(tools.enabled, false);
    assert.equal(tools.mastra_workspace_delete.enabled, false);
    assert.equal(tools.mastra_workspace_execute_command.enabled, false);
    assert.equal(tools.mastra_workspace_write_file.requireApproval, true);
    assert.equal(tools.mastra_workspace_write_file.requireReadBeforeWrite, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unregistered scope never constructs a Workspace and scoped agent factory forwards only the resolved object", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-scoped-projects-"));
  try {
    const registry = new MastraWorkspaceRegistry(root);
    let workspaceConstructed = false;
    const noWorkspace = await createRegisteredMastraWorkspace({
      scope: alpha,
      registry,
      bindings: {
        Agent: class { stream() { return { text: "unused" }; } } as unknown as new () => MastraAgentLike,
        Workspace: class { constructor() { workspaceConstructed = true; } },
        LocalFilesystem: class {},
      },
    });
    assert.equal(noWorkspace, undefined);
    assert.equal(workspaceConstructed, false);

    let received: Record<string, unknown> | undefined;
    class FakeAgent implements MastraAgentLike {
      constructor(options: Record<string, unknown>) { received = options; }
      stream() { return { text: "unused" }; }
    }
    const marker = { scope: "resolved-on-server" };
    await createMastraAgent({
      bindings: { Agent: FakeAgent },
      gateway: { baseUrl: "https://gateway.invalid/v1", apiKey: "test", defaultModel: "test" },
      workspace: marker,
    });
    assert.equal(received?.workspace, marker);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace policy never retains absolute or traversing paths in audit summaries", () => {
  const policy = workspaceToolPolicy(alpha) as { hooks: { beforeToolCall(context: { workspaceToolName: string; input: unknown }): void } };
  assert.doesNotThrow(() => policy.hooks.beforeToolCall({ workspaceToolName: "mastra_workspace_read_file", input: { path: "/secret" } }));
  assert.doesNotThrow(() => policy.hooks.beforeToolCall({ workspaceToolName: "mastra_workspace_read_file", input: { path: "../other-user" } }));
});
