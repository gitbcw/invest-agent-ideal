import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AGENT_SPACE_ASSEMBLY_MODE_ENV, isAgentSpaceAssemblyModeEnabled } from "../src/runtime/agent-space-context.js";

const root = mkdtempSync(path.join(os.tmpdir(), "invest-agent-assembly-lock-"));
process.env.NODE_ENV = "test";
process.env.DB_PATH = path.join(root, "assembly-lock.db");
process.env.WORKSPACE_ROOT = path.join(root, "workspaces");
process.env.RUNTIME_DATA_ROOT = path.join(root, "runtime");
process.env.MASTRA_PROJECTS_ROOT = path.join(root, "projects");
mkdirSync(path.join(root, "workspaces"), { recursive: true });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

test("production locks assembly mode on — the legacy workspace entry cannot be reopened by config (T-534)", async () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevFlag = process.env[AGENT_SPACE_ASSEMBLY_MODE_ENV];
  process.env.NODE_ENV = "production";
  try {
    for (const flag of ["", "off", "0", "false", "scope:mg,dyk,111", "garbage"]) {
      process.env[AGENT_SPACE_ASSEMBLY_MODE_ENV] = flag;
      assert.equal(
        isAgentSpaceAssemblyModeEnabled("mg"),
        true,
        `production must force assembly on regardless of flag (${flag || "(empty)"})`,
      );
      assert.equal(
        isAgentSpaceAssemblyModeEnabled("not-in-any-scope"),
        true,
        "production must force assembly on even for users outside any scope list",
      );
    }
    process.env[AGENT_SPACE_ASSEMBLY_MODE_ENV] = "on";
    assert.equal(isAgentSpaceAssemblyModeEnabled("mg"), true);
  } finally {
    process.env.NODE_ENV = prevNodeEnv;
    if (prevFlag === undefined) delete process.env[AGENT_SPACE_ASSEMBLY_MODE_ENV];
    else process.env[AGENT_SPACE_ASSEMBLY_MODE_ENV] = prevFlag;
  }
});

test("non-production environments keep off/scope semantics for tests and mirrors", async () => {
  const prevFlag = process.env[AGENT_SPACE_ASSEMBLY_MODE_ENV];
  try {
    process.env[AGENT_SPACE_ASSEMBLY_MODE_ENV] = "off";
    assert.equal(isAgentSpaceAssemblyModeEnabled("mg"), false);
    delete process.env[AGENT_SPACE_ASSEMBLY_MODE_ENV];
    assert.equal(isAgentSpaceAssemblyModeEnabled("mg"), false);
    process.env[AGENT_SPACE_ASSEMBLY_MODE_ENV] = "scope:mg,dyk";
    assert.equal(isAgentSpaceAssemblyModeEnabled("mg"), true);
    assert.equal(isAgentSpaceAssemblyModeEnabled("dyk"), true);
    assert.equal(isAgentSpaceAssemblyModeEnabled("111"), false);
    process.env[AGENT_SPACE_ASSEMBLY_MODE_ENV] = "on";
    assert.equal(isAgentSpaceAssemblyModeEnabled("111"), true);
  } finally {
    if (prevFlag === undefined) delete process.env[AGENT_SPACE_ASSEMBLY_MODE_ENV];
    else process.env[AGENT_SPACE_ASSEMBLY_MODE_ENV] = prevFlag;
  }
});
