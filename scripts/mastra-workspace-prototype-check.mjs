import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Agent } from "@mastra/core/agent";
import { RequestContext } from "@mastra/core/request-context";
import {
  LocalFilesystem,
  LocalSandbox,
  WORKSPACE_TOOLS,
  Workspace,
  createWorkspaceTools,
} from "@mastra/core/workspace";

const root = await mkdtemp(path.join(os.tmpdir(), "invest-agent-mastra-workspace-check-"));
const users = {
  alpha: path.join(root, "alpha"),
  beta: path.join(root, "beta"),
};

const contextFor = (userId) => {
  const context = new RequestContext();
  context.set("userId", userId);
  return context;
};

const userIdFrom = (requestContext) => requestContext?.get?.("userId");

async function seedUser(userId) {
  const userRoot = users[userId];
  await mkdir(path.join(userRoot, "skills", "private-method"), { recursive: true });
  await writeFile(path.join(userRoot, "private.txt"), `${userId}-private`);
  await writeFile(
    path.join(userRoot, "skills", "private-method", "SKILL.md"),
    `---\nname: private-method\ndescription: ${userId} private method\n---\nOnly ${userId} may use this method.\n`,
  );
}

for (const userId of Object.keys(users)) await seedUser(userId);

const workspaceFor = (userId) => {
  const userRoot = users[userId];
  if (!userRoot) throw new Error("unknown user scope");
  const isolation = LocalSandbox.detectIsolation();
  return new Workspace({
    id: `prototype-${userId}`,
    name: `Prototype ${userId}`,
    filesystem: new LocalFilesystem({ basePath: userRoot, contained: true }),
    sandbox: new LocalSandbox({
      workingDirectory: userRoot,
      isolation: isolation.available ? isolation.backend : "none",
      nativeSandbox: isolation.available ? { allowNetwork: false } : undefined,
    }),
    skills: ["skills"],
    tools: {
      [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: { enabled: false },
      [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: { requireApproval: true },
    },
  });
};

const workspaces = new Map();
const agent = new Agent({
  id: "workspace-prototype-agent",
  name: "Workspace Prototype Agent",
  model: { specificationVersion: "v1", provider: "test", modelId: "test" },
  workspace: ({ requestContext }) => {
    const userId = userIdFrom(requestContext);
    if (!userId || !users[userId]) throw new Error("missing or invalid user scope");
    const workspace = workspaceFor(userId);
    workspaces.set(userId, workspace);
    return workspace;
  },
});

const result = {
  package: "@mastra/core@1.57.0",
  checks: [],
  isolation: LocalSandbox.detectIsolation(),
};

try {
  const alphaContext = contextFor("alpha");
  const betaContext = contextFor("beta");
  const alphaWorkspace = await agent.getWorkspace({ requestContext: alphaContext });
  const betaWorkspace = await agent.getWorkspace({ requestContext: betaContext });
  assert.ok(alphaWorkspace);
  assert.ok(betaWorkspace);
  assert.equal(alphaWorkspace.filesystem.basePath, users.alpha);
  assert.equal(betaWorkspace.filesystem.basePath, users.beta);
  result.checks.push({ name: "dynamic per-user workspace binding", status: "pass" });

  await alphaWorkspace.filesystem.writeFile("created.txt", "alpha-created");
  assert.equal(await alphaWorkspace.filesystem.readFile("created.txt", { encoding: "utf8" }), "alpha-created");
  result.checks.push({ name: "workspace file read/write", status: "pass" });

  await assert.rejects(
    alphaWorkspace.filesystem.readFile("../beta/private.txt", { encoding: "utf8" }),
    (error) => error?.code === "EACCES",
  );
  result.checks.push({ name: "filesystem path traversal blocked", status: "pass" });

  const alphaSkill = await agent.getSkill("private-method", { requestContext: alphaContext });
  const betaSkill = await agent.getSkill("private-method", { requestContext: betaContext });
  assert.match(alphaSkill?.instructions ?? "", /Only alpha/);
  assert.match(betaSkill?.instructions ?? "", /Only beta/);
  assert.doesNotMatch(alphaSkill?.instructions ?? "", /Only beta/);
  assert.doesNotMatch(betaSkill?.instructions ?? "", /Only alpha/);
  result.checks.push({ name: "dynamic per-user skill isolation", status: "pass" });

  const alphaTools = await createWorkspaceTools(alphaWorkspace, { requestContext: alphaContext });
  assert.ok(alphaTools[WORKSPACE_TOOLS.FILESYSTEM.READ_FILE]);
  assert.ok(alphaTools[WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]);
  assert.ok(alphaTools[WORKSPACE_TOOLS.FILESYSTEM.LIST_FILES]);
  assert.ok(alphaTools[WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]);
  assert.equal(alphaTools[WORKSPACE_TOOLS.FILESYSTEM.DELETE], undefined);
  result.checks.push({ name: "workspace tools injected and delete disabled", status: "pass" });

  const commandResult = await alphaTools[WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND].execute(
    { command: "pwd" },
    { requestContext: alphaContext },
  );
  assert.equal(await realpath(String(commandResult).trim()), await realpath(users.alpha));
  result.checks.push({ name: "sandbox command runs in bound workspace", status: "pass" });

  if (result.isolation.available) {
    const escapeResult = await alphaWorkspace.sandbox.executeCommand("cat", ["../beta/private.txt"]);
    assert.equal(escapeResult.success, true);
    assert.match(escapeResult.stdout, /beta-private/);
    result.checks.push({
      name: "LocalSandbox sibling-directory access is not a multi-user security boundary",
      status: "observed",
      consequence: "Do not execute untrusted user code in a local user Workspace.",
    });
  } else {
    result.checks.push({ name: "LocalSandbox sibling-directory access", status: "skipped", reason: result.isolation.message });
  }

  const noScope = new RequestContext();
  await assert.rejects(agent.getWorkspace({ requestContext: noScope }), /missing or invalid user scope/);
  result.checks.push({ name: "missing scope fails closed", status: "pass" });
} finally {
  for (const workspace of workspaces.values()) await workspace.destroy();
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({ ...result, rootCleaned: true }, null, 2));
