import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type * as ArtifactModuleType from "../src/services/conversation-artifacts.js";

type ArtifactModule = typeof ArtifactModuleType;

const VALID_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="50" height="50" fill="#10a37f"/></svg>`;

const VALID_MG_MARKDOWN = `# 2026-07-24 投资助手月度指标

## 持仓风险监控

- ZZLKP 主力控盘持续位于阈值上方
- 主力净流入近 5 日累计正向

## 下一步

1. 维持现持仓
2. 跟踪主力流入连续性
`;

interface TestContext {
  root: string;
  workspaceRoot: string;
  workspaceUserA: string;
  workspaceUserB: string;
  mod: ArtifactModule;
  sqlite: import("better-sqlite3").Database;
}

/**
 * All artifact tests share a single workspace + SQLite db. The artifact
 * module + config + sqlite handle are captured at module load time, so a
 * per-test reset would require cache busting which is fragile under tsx.
 * Sharing the workspace keeps the test fast and deterministic; each test
 * writes its own unique files so they don't observe each other's state.
 */
async function setupSharedFixture(): Promise<TestContext> {
  const root = await mkdtemp(path.join(os.tmpdir(), "invest-agent-artifacts-"));
  const workspaceRoot = path.join(root, "workspaces");
  const workspaceUserA = path.join(workspaceRoot, "user-a");
  const workspaceUserB = path.join(workspaceRoot, "user-b");
  await mkdir(path.join(workspaceUserA, "reports", "daily"), { recursive: true });
  await mkdir(path.join(workspaceUserA, "reports", "metrics"), { recursive: true });
  await mkdir(path.join(workspaceUserB, "reports", "daily"), { recursive: true });
  process.env.WORKSPACE_ROOT = workspaceRoot;
  process.env.DB_PATH = path.join(root, "test.db");
  process.env.NODE_ENV = "test";
  const { initDb, sqlite } = await import("../src/db/index.js");
  initDb();
  const mod = await import("../src/services/conversation-artifacts.js");
  return { root, workspaceRoot, workspaceUserA, workspaceUserB, mod, sqlite };
}

let ctxPromise: Promise<TestContext> | null = null;
async function getCtx(): Promise<TestContext> {
  if (!ctxPromise) ctxPromise = setupSharedFixture();
  return ctxPromise;
}

function expectErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    error.name === "ConversationArtifactError" &&
    (error as ArtifactModuleType.ConversationArtifactError).code === code
  );
}

test("publishes and reads a valid mg-shaped markdown report", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const target = path.join(workspaceUserA, "reports", "daily", "2026-07-24.md");
  await writeFile(target, VALID_MG_MARKDOWN);
  const record = await mod.publishConversationArtifact({
    userId: "user-a",
    instanceId: "user-a",
    relativePath: "reports/daily/2026-07-24.md",
    scope: { projectId: "invest-agent", assistantId: "user-a", conversationId: "conv-1" },
  });
  assert.equal(record.mimeType, "text/markdown");
  assert.equal(record.previewMode, "markdown");
  assert.equal(record.checksum && record.checksum.length, 64);
  const read = await mod.readConversationArtifactPayload({
    artifactId: record.artifactId,
    userId: "user-a",
    instanceId: "user-a",
  });
  assert.equal(read.payload.mimeType, "text/markdown");
  assert.equal(Buffer.from(read.payload.base64, "base64").toString("utf8"), VALID_MG_MARKDOWN);
});

test("publishes and reads a valid flow SVG artifact, preserving original bytes", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const target = path.join(workspaceUserA, "reports", "metrics", "flow.svg");
  await writeFile(target, VALID_SVG);
  const record = await mod.publishConversationArtifact({
    userId: "user-a",
    instanceId: "user-a",
    relativePath: "reports/metrics/flow.svg",
    scope: { projectId: "invest-agent", assistantId: "user-a" },
  });
  assert.equal(record.mimeType, "image/svg+xml");
  const read = await mod.readConversationArtifactPayload({
    artifactId: record.artifactId,
    userId: "user-a",
    instanceId: "user-a",
  });
  // The conservative scan accepts this SVG, so the runtime must NOT mutate
  // the bytes (no trimming, no attribute rewriting). The payload checksum
  // equals the workspace file checksum.
  assert.equal(read.payload.sanitized, false);
  const decoded = Buffer.from(read.payload.base64, "base64").toString("utf8");
  assert.equal(decoded, VALID_SVG);
  assert.equal(read.payload.checksum, record.checksum);
});

test("SVG artifact with leading/trailing whitespace and newlines preserves checksum", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const target = path.join(workspaceUserA, "reports", "metrics", "padded.svg");
  // Pretend an external tool wrote an SVG with surrounding whitespace and
  // newlines. The sanitizer used to trim these off, which broke the
  // workspace checksum contract; the fix preserves the bytes as long as
  // the conservative scan accepts them.
  const payload = `\n\n   <?xml version="1.0"?>\n  ${VALID_SVG}\n\n`;
  await writeFile(target, payload);
  const record = await mod.publishConversationArtifact({
    userId: "user-a",
    instanceId: "user-a",
    relativePath: "reports/metrics/padded.svg",
    scope: { projectId: "invest-agent", assistantId: "user-a" },
  });
  const read = await mod.readConversationArtifactPayload({
    artifactId: record.artifactId,
    userId: "user-a",
    instanceId: "user-a",
  });
  const decoded = Buffer.from(read.payload.base64, "base64").toString("utf8");
  assert.equal(decoded, payload);
  assert.equal(read.payload.checksum, record.checksum);
  // Explicit SHA-256 of the original bytes must match the record.
  const { createHash } = await import("node:crypto");
  const expected = createHash("sha256").update(Buffer.from(payload, "utf8")).digest("hex");
  assert.equal(read.payload.checksum, expected);
});

test("rejects cross-user artifact access", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const target = path.join(workspaceUserA, "reports", "daily", "secret.md");
  await writeFile(target, "user-a private data");
  const record = await mod.publishConversationArtifact({
    userId: "user-a",
    instanceId: "user-a",
    relativePath: "reports/daily/secret.md",
    scope: { projectId: "invest-agent", assistantId: "user-a" },
  });
  await assert.rejects(
    () => mod.readConversationArtifactPayload({ artifactId: record.artifactId, userId: "user-b", instanceId: "user-b" }),
    (error: unknown) => expectErrorCode(error, "ARTIFACT_SCOPE_MISMATCH"),
  );
});

test("rejects cross-instance artifact access for the same user", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const target = path.join(workspaceUserA, "reports", "daily", "scope-instance.md");
  await writeFile(target, "scoped to instance-a");
  const record = await mod.publishConversationArtifact({
    userId: "user-a",
    instanceId: "instance-a",
    relativePath: "reports/daily/scope-instance.md",
    scope: { projectId: "invest-agent", assistantId: "instance-a" },
  });
  await assert.rejects(
    () => mod.readConversationArtifactPayload({ artifactId: record.artifactId, userId: "user-a", instanceId: "instance-b" }),
    (error: unknown) => expectErrorCode(error, "ARTIFACT_SCOPE_MISMATCH"),
  );
});

test("rejects parent-directory traversal in relativePath", async () => {
  const { mod } = await getCtx();
  await assert.rejects(
    () => mod.publishConversationArtifact({
      userId: "user-a",
      instanceId: "user-a",
      relativePath: "reports/daily/../../etc/passwd",
      scope: { projectId: "invest-agent", assistantId: "user-a" },
    }),
    (error: unknown) => expectErrorCode(error, "ARTIFACT_INVALID_PATH"),
  );
  await assert.rejects(
    () => mod.publishLegacyPathArtifact({
      userId: "user-a",
      instanceId: "user-a",
      projectId: "invest-agent",
      assistantId: "user-a",
      relativePath: "../secret.md",
    }),
    (error: unknown) => expectErrorCode(error, "ARTIFACT_INVALID_PATH"),
  );
});

test("rejects absolute paths", async () => {
  const { mod } = await getCtx();
  await assert.rejects(
    () => mod.publishConversationArtifact({
      userId: "user-a",
      instanceId: "user-a",
      relativePath: "/etc/passwd",
      scope: { projectId: "invest-agent", assistantId: "user-a" },
    }),
    (error: unknown) => expectErrorCode(error, "ARTIFACT_INVALID_PATH"),
  );
  await assert.rejects(
    () => mod.publishConversationArtifact({
      userId: "user-a",
      instanceId: "user-a",
      relativePath: "reports/../reports/daily",
      scope: { projectId: "invest-agent", assistantId: "user-a" },
    }),
    (error: unknown) => expectErrorCode(error, "ARTIFACT_INVALID_PATH"),
  );
});

test("rejects symlinks that escape the reports directory", async () => {
  const { root, workspaceUserA, mod } = await getCtx();
  const outsideSecret = path.join(root, "secret.svg");
  await writeFile(outsideSecret, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  const symlinkTarget = path.join(workspaceUserA, "reports", "metrics", "escape.svg");
  await symlink(outsideSecret, symlinkTarget);
  await assert.rejects(
    () => mod.publishConversationArtifact({
      userId: "user-a",
      instanceId: "user-a",
      relativePath: "reports/metrics/escape.svg",
      scope: { projectId: "invest-agent", assistantId: "user-a" },
    }),
    (error: unknown) =>
      expectErrorCode(error, "ARTIFACT_INVALID_PATH") || expectErrorCode(error, "ARTIFACT_NOT_FOUND"),
  );
});

test("rejects dangerous SVG with embedded script", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const target = path.join(workspaceUserA, "reports", "metrics", "evil.svg");
  await writeFile(target, `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);
  await assert.rejects(
    () => mod.publishConversationArtifact({
      userId: "user-a",
      instanceId: "user-a",
      relativePath: "reports/metrics/evil.svg",
      scope: { projectId: "invest-agent", assistantId: "user-a" },
    }),
    (error: unknown) => expectErrorCode(error, "ARTIFACT_UNSAFE"),
  );
});

test("rejects SVG with onload handler", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const target = path.join(workspaceUserA, "reports", "metrics", "onload.svg");
  await writeFile(target, `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`);
  await assert.rejects(
    () => mod.publishConversationArtifact({
      userId: "user-a",
      instanceId: "user-a",
      relativePath: "reports/metrics/onload.svg",
      scope: { projectId: "invest-agent", assistantId: "user-a" },
    }),
    (error: unknown) => expectErrorCode(error, "ARTIFACT_UNSAFE"),
  );
});

test("rejects oversized files", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const target = path.join(workspaceUserA, "reports", "daily", "big.csv");
  const huge = "x".repeat(16 * 1024 * 1024);
  await writeFile(target, huge);
  await assert.rejects(
    () => mod.publishConversationArtifact({
      userId: "user-a",
      instanceId: "user-a",
      relativePath: "reports/daily/big.csv",
      scope: { projectId: "invest-agent", assistantId: "user-a" },
    }),
    (error: unknown) => expectErrorCode(error, "ARTIFACT_TOO_LARGE"),
  );
});

test("rejects checksum mismatch when file changes after publish", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const target = path.join(workspaceUserA, "reports", "daily", "changing.md");
  await writeFile(target, "original content");
  const record = await mod.publishConversationArtifact({
    userId: "user-a",
    instanceId: "user-a",
    relativePath: "reports/daily/changing.md",
    scope: { projectId: "invest-agent", assistantId: "user-a" },
  });
  await writeFile(target, "tampered content after publish");
  await assert.rejects(
    () => mod.readConversationArtifactPayload({ artifactId: record.artifactId, userId: "user-a", instanceId: "user-a" }),
    (error: unknown) => expectErrorCode(error, "ARTIFACT_UNSAFE"),
  );
});

test("rejects extension masquerading: png extension with html body", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const target = path.join(workspaceUserA, "reports", "metrics", "fake.png");
  await writeFile(target, "<html><script>alert(1)</script></html>");
  await assert.rejects(
    () => mod.publishConversationArtifact({
      userId: "user-a",
      instanceId: "user-a",
      relativePath: "reports/metrics/fake.png",
      scope: { projectId: "invest-agent", assistantId: "user-a" },
    }),
    (error: unknown) => expectErrorCode(error, "ARTIFACT_UNSAFE"),
  );
});

test("rejects extension masquerading: md extension with PNG body", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const target = path.join(workspaceUserA, "reports", "daily", "fake.md");
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  await writeFile(target, pngBytes);
  await assert.rejects(
    () => mod.publishConversationArtifact({
      userId: "user-a",
      instanceId: "user-a",
      relativePath: "reports/daily/fake.md",
      scope: { projectId: "invest-agent", assistantId: "user-a" },
    }),
    (error: unknown) => expectErrorCode(error, "ARTIFACT_UNSAFE"),
  );
});

test("accepts valid PNG with matching magic bytes", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const target = path.join(workspaceUserA, "reports", "metrics", "real.png");
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  ]);
  await writeFile(target, pngBytes);
  const record = await mod.publishConversationArtifact({
    userId: "user-a",
    instanceId: "user-a",
    relativePath: "reports/metrics/real.png",
    scope: { projectId: "invest-agent", assistantId: "user-a" },
  });
  assert.equal(record.mimeType, "image/png");
});

test("accepts valid JPEG with matching magic bytes", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const target = path.join(workspaceUserA, "reports", "metrics", "real.jpg");
  const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  await writeFile(target, jpegBytes);
  const record = await mod.publishConversationArtifact({
    userId: "user-a",
    instanceId: "user-a",
    relativePath: "reports/metrics/real.jpg",
    scope: { projectId: "invest-agent", assistantId: "user-a" },
  });
  assert.equal(record.mimeType, "image/jpeg");
});

test("accepts valid WebP and valid PDF magic bytes", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const webpTarget = path.join(workspaceUserA, "reports", "metrics", "real.webp");
  await writeFile(webpTarget, Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c,
  ]));
  const webpRecord = await mod.publishConversationArtifact({
    userId: "user-a",
    instanceId: "user-a",
    relativePath: "reports/metrics/real.webp",
    scope: { projectId: "invest-agent", assistantId: "user-a" },
  });
  assert.equal(webpRecord.mimeType, "image/webp");

  const pdfTarget = path.join(workspaceUserA, "reports", "daily", "report.pdf");
  await writeFile(pdfTarget, Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n"));
  const pdfRecord = await mod.publishConversationArtifact({
    userId: "user-a",
    instanceId: "user-a",
    relativePath: "reports/daily/report.pdf",
    scope: { projectId: "invest-agent", assistantId: "user-a" },
  });
  assert.equal(pdfRecord.mimeType, "application/pdf");
});

test("artifact events table receives open success and failure rows", async () => {
  const { workspaceUserA, mod, sqlite } = await getCtx();
  const target = path.join(workspaceUserA, "reports", "daily", "audited.md");
  await writeFile(target, "audit me");
  const record = await mod.publishConversationArtifact({
    userId: "user-a",
    instanceId: "user-a",
    relativePath: "reports/daily/audited.md",
    scope: { projectId: "invest-agent", assistantId: "user-a" },
  });
  // Simulate the connector layer's open/success/failure telemetry flow.
  mod.logArtifactEvent({ artifactId: record.artifactId, userId: "user-a", instanceId: "user-a", event: "open" });
  mod.logArtifactEvent({ artifactId: record.artifactId, userId: "user-a", instanceId: "user-a", event: "success" });
  mod.logArtifactEvent({
    artifactId: "art_does_not_exist",
    userId: "user-a",
    instanceId: "user-a",
    event: "failure",
    status: "failure",
    reason: "ARTIFACT_NOT_FOUND",
  });
  const rows = sqlite
    .prepare("SELECT event FROM conversation_artifact_events WHERE artifact_id = ? ORDER BY created_at ASC")
    .all(record.artifactId) as Array<{ event: string }>;
  assert.ok(rows.some((row) => row.event === "open"));
  assert.ok(rows.some((row) => row.event === "success"));
  const failEvents = sqlite
    .prepare("SELECT event FROM conversation_artifact_events WHERE artifact_id = ? AND event = 'failure'")
    .all("art_does_not_exist") as Array<{ event: string }>;
  assert.equal(failEvents.length, 1);
});

test("artifacts bind to the exact turn that published them, not to whichever reply finishes next", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const conversationId = "conv-overlap";
  const userId = "user-a";
  const instanceId = "user-a";

  // Each turn publishes its own artifact. The MCP tool sees the
  // current_turn_id via the `conversation_turn_active` table.
  const turnA = "portal-turn-a";
  const turnB = "portal-turn-b";

  const targetA = path.join(workspaceUserA, "reports", "daily", "turn-a.md");
  const targetB = path.join(workspaceUserA, "reports", "daily", "turn-b.md");
  await writeFile(targetA, "turn A content");
  await writeFile(targetB, "turn B content");

  const { markTurnStart, markTurnEnd } = await import("../src/services/conversation-turns.js");

  // Turn A starts, publishes its artifact, then "ends".
  markTurnStart({ userId, instanceId, conversationId, turnId: turnA });
  const recordA = await mod.publishConversationArtifact({
    userId,
    instanceId,
    relativePath: "reports/daily/turn-a.md",
    scope: { projectId: "invest-agent", assistantId: userId, conversationId },
  });
  markTurnEnd({ userId, instanceId, conversationId, turnId: turnA });

  // Turn B starts next, publishes its own artifact, then "ends". If we
  // were still using `message_id IS NULL` as the join key, attaching
  // turn B's reply first would silently steal turn A's artifact.
  markTurnStart({ userId, instanceId, conversationId, turnId: turnB });
  const recordB = await mod.publishConversationArtifact({
    userId,
    instanceId,
    relativePath: "reports/daily/turn-b.md",
    scope: { projectId: "invest-agent", assistantId: userId, conversationId },
  });
  markTurnEnd({ userId, instanceId, conversationId, turnId: turnB });

  assert.equal(recordA.turnId, turnA);
  assert.equal(recordB.turnId, turnB);

  // Assistant message for turn B finishes first. With turn-keyed
  // attachment, only record B can attach to it.
  const msgB = "msg-assistant-b";
  mod.bindArtifactsToAssistantMessageForTest?.({
    userId,
    instanceId,
    conversationId,
    assistantMessageId: msgB,
    turnId: turnB,
  });

  const turnBArtifacts = mod.findArtifactsForTurn({ userId, instanceId, conversationId, turnId: turnB });
  assert.equal(turnBArtifacts.length, 1);
  assert.equal(turnBArtifacts[0].artifactId, recordB.artifactId);

  // recordA is still unattached (its message_id should remain NULL until
  // turn A's assistant message is processed).
  const stillPending = mod.findArtifactsForTurn({ userId, instanceId, conversationId, turnId: turnA });
  assert.equal(stillPending.length, 1);
  assert.equal(stillPending[0].artifactId, recordA.artifactId);
  assert.equal(stillPending[0].messageId, null);

  // Turn A's assistant message now finishes; record A attaches cleanly
  // even though record B already attached to msgB.
  const msgA = "msg-assistant-a";
  mod.bindArtifactsToAssistantMessageForTest?.({
    userId,
    instanceId,
    conversationId,
    assistantMessageId: msgA,
    turnId: turnA,
  });
  const msgAArtifacts = mod.findArtifactsForMessage({ userId, instanceId, conversationId, messageId: msgA });
  assert.equal(msgAArtifacts.length, 1);
  assert.equal(msgAArtifacts[0].artifactId, recordA.artifactId);

  const msgBArtifacts = mod.findArtifactsForMessage({ userId, instanceId, conversationId, messageId: msgB });
  assert.equal(msgBArtifacts.length, 1);
  assert.equal(msgBArtifacts[0].artifactId, recordB.artifactId);
});

test("artifact published outside of any active turn stays unbound to a message", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const conversationId = "conv-no-turn";
  const userId = "user-a";
  const instanceId = "user-a";

  const target = path.join(workspaceUserA, "reports", "daily", "no-turn.md");
  await writeFile(target, "no active turn content");

  // No markTurnStart call — simulates a legacy path publish from the
  // Portal that happens outside of any ACP turn.
  const record = await mod.publishConversationArtifact({
    userId,
    instanceId,
    relativePath: "reports/daily/no-turn.md",
    scope: { projectId: "invest-agent", assistantId: userId, conversationId },
  });
  assert.equal(record.turnId, null);
});

test("overlapping conversation turns are serialized before active-turn markers are set", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const conversationId = "conv-serialized-overlap";
  const userId = "user-a";
  const instanceId = "user-a";
  const targetA = path.join(workspaceUserA, "reports", "daily", "serialized-a.md");
  const targetB = path.join(workspaceUserA, "reports", "daily", "serialized-b.md");
  await writeFile(targetA, "serialized A");
  await writeFile(targetB, "serialized B");

  const { withConversationChatLock } = await import("../src/services/conversation-log.js");
  const { markTurnStart, markTurnEnd } = await import("../src/services/conversation-turns.js");
  const scope = { userId, instanceId, conversationId };
  let firstPublished = false;
  const first = withConversationChatLock(scope, async () => {
    markTurnStart({ ...scope, turnId: "serialized-turn-a" });
    const record = await mod.publishConversationArtifact({
      userId,
      instanceId,
      relativePath: "reports/daily/serialized-a.md",
      scope: { projectId: "invest-agent", assistantId: userId, conversationId },
    });
    firstPublished = true;
    await new Promise((resolve) => setTimeout(resolve, 15));
    markTurnEnd({ ...scope, turnId: "serialized-turn-a" });
    return record;
  });
  const second = withConversationChatLock(scope, async () => {
    assert.equal(firstPublished, true);
    markTurnStart({ ...scope, turnId: "serialized-turn-b" });
    const record = await mod.publishConversationArtifact({
      userId,
      instanceId,
      relativePath: "reports/daily/serialized-b.md",
      scope: { projectId: "invest-agent", assistantId: userId, conversationId },
    });
    markTurnEnd({ ...scope, turnId: "serialized-turn-b" });
    return record;
  });

  const [recordA, recordB] = await Promise.all([first, second]);
  assert.equal(recordA.turnId, "serialized-turn-a");
  assert.equal(recordB.turnId, "serialized-turn-b");
});
