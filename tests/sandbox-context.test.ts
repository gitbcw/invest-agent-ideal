import assert from "node:assert/strict";
import test from "node:test";
import { createSandboxToken, verifySandboxToken } from "../src/lib/sandbox-context.js";

const context = {
  userId: "sandbox-test-user",
  projectId: "invest-agent",
  instanceId: "invest-agent-sandbox-test-user",
  role: "user" as const,
  channel: "weixin-mobile" as const,
  backend: "codex" as const,
  conversationId: "sandbox-test-conversation",
  permissions: ["read:self", "write:self"] as const,
};

test("sandbox tokens preserve scope and reject tampering or expiry", () => {
  const token = createSandboxToken({ ...context, permissions: [...context.permissions] }, 60_000);
  const verified = verifySandboxToken(token);

  assert.equal(verified.userId, context.userId);
  assert.equal(verified.projectId, context.projectId);
  assert.equal(verified.instanceId, context.instanceId);
  assert.equal(verified.conversationId, context.conversationId);
  assert.deepEqual(verified.permissions, context.permissions);
  assert.ok(verified.tokenId);
  assert.ok(verified.expiresAt);

  assert.throws(() => verifySandboxToken(`${token.slice(0, -1)}x`), /SANDBOX_TOKEN_INVALID/);
  const expired = createSandboxToken({ ...context, permissions: [...context.permissions] }, -1);
  assert.throws(() => verifySandboxToken(expired), /SANDBOX_TOKEN_EXPIRED/);
});
