import assert from "node:assert/strict";
import {
  createSandboxToken,
  verifySandboxToken,
} from "../dist/lib/sandbox-context.js";

const context = {
  userId: "sandbox-smoke-user",
  role: "user",
  channel: "weixin-mobile",
  backend: "hermes",
  conversationId: "sandbox-smoke-conversation",
  permissions: ["read:self", "write:self"],
};

const token = createSandboxToken(context, 60_000);
const verified = verifySandboxToken(token);

assert.equal(verified.userId, context.userId);
assert.equal(verified.role, context.role);
assert.equal(verified.channel, context.channel);
assert.deepEqual(verified.permissions, context.permissions);
assert.ok(verified.tokenId);
assert.ok(verified.expiresAt);

const tampered = `${token.slice(0, -1)}x`;
assert.throws(() => verifySandboxToken(tampered), /SANDBOX_TOKEN_INVALID/);

const expired = createSandboxToken(context, -1);
assert.throws(() => verifySandboxToken(expired), /SANDBOX_TOKEN_EXPIRED/);

console.log(JSON.stringify({
  ok: true,
  userId: verified.userId,
  role: verified.role,
  channel: verified.channel,
  permissions: verified.permissions,
  tokenId: verified.tokenId,
}));
