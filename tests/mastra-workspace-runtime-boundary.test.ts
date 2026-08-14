import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as assert from "node:assert/strict";
import { buildAgentPromptContext } from "../src/runtime/prompt-context-builder.js";

test("Mastra prompt context does not write sandbox credentials into the user Workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mastra-workspace-boundary-"));
  try {
    await buildAgentPromptContext({
      userText: "test",
      includeContextPacket: false,
      userContext: {
        userId: "boundary-user",
        projectId: "invest-agent",
        instanceId: "invest-agent-boundary-user",
        channel: "api",
        workspacePath: root,
      },
    });
    assert.equal(existsSync(path.join(root, ".sandbox-token")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
