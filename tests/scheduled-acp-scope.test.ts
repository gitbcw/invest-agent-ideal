import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { buildScheduledAcpChatParams } from "../src/acp/scheduled-tasks.js";

describe("scheduled ACP MCP scope", () => {
  it("passes the exact scheduled user context into ACP session creation", () => {
    const userContext = {
      userId: "112",
      projectId: "invest-agent",
      instanceId: "invest-agent-112",
      channel: "api" as const,
      backend: "codex" as const,
      conversationId: "scheduler:daily-review:112:invest-agent-112",
      workspacePath: "/tmp/invest-agent-112",
    };
    const params = buildScheduledAcpChatParams({
      userContext,
      promptText: "publish",
      conversationId: userContext.conversationId,
      messageId: "message-1",
      mode: "scheduled-daily-review",
    });

    assert.equal(params.userContext, userContext);
    assert.equal(params.userContext.userId, "112");
    assert.equal(params.userContext.instanceId, "invest-agent-112");
    assert.equal(params.cwd, userContext.workspacePath);
  });
});
