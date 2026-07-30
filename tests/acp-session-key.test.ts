import assert from "node:assert/strict";
import test from "node:test";
import { computeAllowlistFingerprint } from "../src/acp/mcp-session-manifest.js";
import type { UserContext } from "../src/lib/user-context.js";

/**
 * WP3: 会话复用权限泄漏缺陷的回归门。
 *
 * sessionKey = conversationId::cwd::<allowlistFingerprint>。同一 conversation 不同
 * allowlist 必须产生不同 sessionKey,否则全量 session 会被只读阶段复用,导致写工具泄漏。
 * 这里测指纹函数:指纹不同 → sessionKey 不同 → 各自独立 session。
 */

function ctx(allowlist?: string[]): UserContext {
  return {
    userId: "user-a",
    conversationId: "scheduler:daily-review:user-a:inst-a",
    ...(allowlist ? { mcpAllowedTools: allowlist } : {}),
  };
}

test("no allowlist (full tools) produces empty fingerprint", () => {
  assert.equal(computeAllowlistFingerprint(ctx(), {}), "");
  assert.equal(computeAllowlistFingerprint(undefined, {}), "");
});

test("same allowlist produces same fingerprint regardless of order", () => {
  // order 不应影响指纹 (sorted),否则同一 allowlist 不同顺序会错误地不复用 session
  const fp1 = computeAllowlistFingerprint(ctx(["reviews.save", "market.quote"]), {});
  const fp2 = computeAllowlistFingerprint(ctx(["market.quote", "reviews.save"]), {});
  assert.equal(fp1, fp2);
  assert.ok(fp1.length > 0);
});

test("different allowlists produce different fingerprints (permission leak fix)", () => {
  // 核心回归门:全量 (无 allowlist) vs 只读阶段 (有 allowlist) 必须不同
  const fullFp = computeAllowlistFingerprint(ctx(), {});
  const readOnlyFp = computeAllowlistFingerprint(ctx(["market.quote", "market.kline"]), {});
  const writeOnlyFp = computeAllowlistFingerprint(ctx(["reviews.save"]), {});

  assert.notEqual(fullFp, readOnlyFp);
  assert.notEqual(fullFp, writeOnlyFp);
  assert.notEqual(readOnlyFp, writeOnlyFp);
});

test("scheduled publication target participates in session fingerprint", () => {
  const first = computeAllowlistFingerprint({
    ...ctx(["reviews.save"]),
    expectedReviewKind: "weekly",
    expectedReviewKey: "2026-07-27_weekly",
  }, {});
  const next = computeAllowlistFingerprint({
    ...ctx(["reviews.save"]),
    expectedReviewKind: "weekly",
    expectedReviewKey: "2026-08-03_weekly",
  }, {});
  assert.notEqual(first, next);
});

test("eval allowlist env produces same fingerprint as equivalent mcpAllowedTools", () => {
  // eval 路径通过 ACP_EVAL_MCP_ALLOWED_TOOLS env 表达 allowlist,
  // 应与 mcpAllowedTools 语义一致
  const viaContext = computeAllowlistFingerprint(ctx(["research.web_search", "research.web_read"]), {});
  const viaEnv = computeAllowlistFingerprint(undefined, {
    ACP_EVAL_MCP_ALLOWED_TOOLS: "research.web_read,research.web_search",
  });
  assert.equal(viaContext, viaEnv);
});

test("mcpAllowedTools takes precedence over eval env", () => {
  // 显式 mcpAllowedTools 应优先于 env (与 resolveAllowedTools 一致)
  const explicit = computeAllowlistFingerprint(ctx(["reviews.save"]), {
    ACP_EVAL_MCP_ALLOWED_TOOLS: "market.quote",
  });
  const expected = computeAllowlistFingerprint(ctx(["reviews.save"]), {});
  assert.equal(explicit, expected);
});

test("sessionKey composition: same conversation + different allowlist = different key", () => {
  // 模拟 chatWithUsage 的 sessionKey 计算
  const conversationId = "scheduler:daily-review:user-a:inst-a";
  const cwd = "/tmp/ws";
  function sessionKey(allowlist?: string[]) {
    const fp = computeAllowlistFingerprint(ctx(allowlist), {});
    return [conversationId, cwd, fp].filter((p) => p !== undefined && p !== "").join("::");
  }

  // 全量阶段 vs 发布阶段:必须不同 sessionKey (权限隔离)
  const fullKey = sessionKey(); // daily-review 全量
  const publishKey = sessionKey(["reviews.save"]); // publication probe 只允许 reviews.save
  assert.notEqual(fullKey, publishKey);

  // 同一 allowlist 多次运行:相同 (复用)
  assert.equal(sessionKey(["reviews.save"]), sessionKey(["reviews.save"]));

  // 全量 key 不含指纹段 (3 段), 发布 key 含指纹段 (4 段)
  assert.equal(fullKey.split("::").length, 2); // conversationId::cwd (fp 空被过滤)
  assert.equal(publishKey.split("::").length, 3); // conversationId::cwd::fp
});

test("interactive full-tools and scheduled read-only do not share session", () => {
  // interactive (无 allowlist) 和 scheduled market-watch (有 allowlist) 即使
  // 同一 conversationId (理论边界) 也不应复用 session
  const interactiveFp = computeAllowlistFingerprint(
    { userId: "u", conversationId: "shared" },
    {},
  );
  const scheduledFp = computeAllowlistFingerprint(
    { userId: "u", conversationId: "shared", mcpAllowedTools: ["market.quote"] },
    {},
  );
  assert.notEqual(interactiveFp, scheduledFp);
});
