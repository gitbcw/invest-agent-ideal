import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { periodicReviewBackend, validateReportKey } from "../src/lib/periodic-review-backend.js";
import { assertScheduledReviewTarget, serviceToolContextFromEnv } from "../src/mcp/service-tools-core.js";

/**
 * F2/R1: 周/月复盘受控保存测试。
 * R1: reportKey 严格校验 + 路径逃逸防护 + yaml 库往返。
 */

const TEST_USER = "r1-test-user";
const TEST_INSTANCE = "r1-test-instance";

// ─── R1: reportKey 校验 ────────────────────────────────────────

test("R1: validateReportKey accepts valid weekly key (YYYY-MM-DD_weekly)", () => {
  assert.equal(validateReportKey("weekly", "2026-07-28_weekly"), null);
});

test("R1: validateReportKey accepts valid monthly key (YYYY-MM)", () => {
  assert.equal(validateReportKey("monthly", "2026-07"), null);
});

test("R1: validateReportKey rejects path traversal attempts", () => {
  const attacks = [
    "../../AGENTS",
    "..\\..\\AGENTS",
    "../daily/x",
    "/etc/passwd",
    ".hidden",
    "key/with/slash",
    "key\\with\\backslash",
  ];
  for (const attack of attacks) {
    const err = validateReportKey("weekly", attack);
    assert.ok(err, `should reject: ${attack}`);
  }
});

test("R1: validateReportKey rejects wrong format for kind", () => {
  // weekly 格式不对
  assert.ok(validateReportKey("weekly", "2026-07"));
  assert.ok(validateReportKey("weekly", "2026-W30_weekly")); // 旧格式不再接受
  // monthly 格式不对
  assert.ok(validateReportKey("monthly", "2026-07-28_weekly"));
  assert.ok(validateReportKey("monthly", "2026-07-28"));
});

test("R1: validateReportKey rejects empty or control chars", () => {
  assert.ok(validateReportKey("weekly", ""));
  assert.ok(validateReportKey("weekly", "2026-07-2\x008_weekly"));
});

test("scheduled reviews.save is bound to the service-provided kind and report key", () => {
  const context = serviceToolContextFromEnv({
    INVEST_AGENT_MCP_USER_ID: TEST_USER,
    INVEST_AGENT_MCP_INSTANCE_ID: TEST_INSTANCE,
    INVEST_AGENT_MCP_EXPECTED_REVIEW_KIND: "weekly",
    INVEST_AGENT_MCP_EXPECTED_REVIEW_KEY: "2026-07-28_weekly",
  });
  assert.doesNotThrow(() => assertScheduledReviewTarget(context, "weekly", "2026-07-28_weekly"));
  assert.throws(() => assertScheduledReviewTarget(context, "monthly", "2026-07"), /target mismatch/);
  assert.throws(() => assertScheduledReviewTarget(context, "weekly", "2026-07-21_weekly"), /target mismatch/);
  assert.throws(
    () => assertScheduledReviewTarget({ userId: TEST_USER, instanceId: TEST_INSTANCE }, "weekly", "2026-07-28_weekly"),
    /missing service-enforced publication target/,
  );
});

// ─── R1: backend upsert 拒绝非法 key ──────────────────────────

test("R1: backend upsert throws on invalid reportKey", async () => {
  await assert.rejects(
    () => periodicReviewBackend.upsert(TEST_USER, TEST_INSTANCE, {
      kind: "weekly", reportKey: "../../evil", generatedAt: "t", summary: "x", content: "x", data: null,
    }),
    /forbidden path characters|path escapes|must match/,
  );
});

test("R1: backend get returns null for invalid reportKey", async () => {
  const result = await periodicReviewBackend.get(TEST_USER, TEST_INSTANCE, "weekly", "../../evil");
  assert.equal(result, null);
});

// ─── yaml 库往返（多行 Markdown / 冒号 / 井号 / Unicode）────────

test("R1: yaml round-trip preserves multiline markdown, colons, hashes, unicode", async () => {
  const content = "# 周复盘\n\n## 重点\n\n- 价格：100.5\n- 风险#1：高\n\n贵州茅台";
  await periodicReviewBackend.upsert(TEST_USER, TEST_INSTANCE, {
    kind: "weekly", reportKey: "2026-07-28_weekly",
    generatedAt: "2026-07-30T12:00:00.000Z",
    summary: "本周：重点观察",
    content,
    data: { source: "skill", context: { publication: { conversationId: "conv-1", scheduled: true } } },
  });
  const read = await periodicReviewBackend.get(TEST_USER, TEST_INSTANCE, "weekly", "2026-07-28_weekly");
  assert.ok(read);
  assert.equal(read!.content, content);
  assert.equal(read!.summary, "本周：重点观察");
  const data = read!.data as { context?: { publication?: { conversationId?: string } } };
  assert.equal(data.context?.publication?.conversationId, "conv-1");

  await rm(`data/test-workspaces/${TEST_USER}`, { recursive: true, force: true }).catch(() => {});
});

test("R1: monthly backend round-trip", async () => {
  await periodicReviewBackend.upsert(TEST_USER, TEST_INSTANCE, {
    kind: "monthly", reportKey: "2026-07",
    generatedAt: "2026-07-30T12:00:00.000Z",
    summary: "月度总结", content: "月复盘内容",
    data: { source: "skill" },
  });
  const read = await periodicReviewBackend.get(TEST_USER, TEST_INSTANCE, "monthly", "2026-07");
  assert.ok(read);
  assert.equal(read!.kind, "monthly");
  assert.equal(read!.reportKey, "2026-07");
  assert.equal(read!.content, "月复盘内容");

  await rm(`data/test-workspaces/${TEST_USER}`, { recursive: true, force: true }).catch(() => {});
});

test("R1: backend get returns null for missing reportKey", async () => {
  const read = await periodicReviewBackend.get(TEST_USER, TEST_INSTANCE, "monthly", "1900-01");
  assert.equal(read, null);
});

// ─── scheduledCompletion 前缀（F2 保留）────────────────────────

test("scheduledCompletion prefix check covers weekly/monthly", () => {
  const prefixes = [
    "scheduler:daily-review:user:instance",
    "scheduler:weekly-review:user:instance",
    "scheduler:monthly-review:user:instance",
  ];
  for (const convId of prefixes) {
    const isScheduled =
      convId.startsWith("scheduler:daily-review:") ||
      convId.startsWith("scheduler:weekly-review:") ||
      convId.startsWith("scheduler:monthly-review:");
    assert.ok(isScheduled, `${convId} should be recognized as scheduled`);
  }
});

// ─── htmlReport 校验（scheduled 周/月复盘强制）────────────────────

const HTML_TEST_USER = "html-review-test-user";
const HTML_TEST_INSTANCE = "html-review-test-instance";
const HTML_WEEKLY_KEY = "2026-07-28_weekly";

function scheduledWeeklyContext() {
  return {
    userId: HTML_TEST_USER,
    instanceId: HTML_TEST_INSTANCE,
    conversationId: `scheduler:weekly-review:${HTML_TEST_USER}:${HTML_TEST_INSTANCE}`,
    expectedReviewKind: "weekly" as const,
    expectedReviewKey: HTML_WEEKLY_KEY,
  };
}

const baseWeeklyInput = {
  kind: "weekly",
  reportKey: HTML_WEEKLY_KEY,
  content: "# 周复盘\n\n正文",
  pushBrief: "**本周要点**\n\n- 示例简报",
};

test("scheduled weekly reviews.save rejects missing htmlReport", async () => {
  const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
  await assert.rejects(
    () => callServiceTool("reviews.save", { ...baseWeeklyInput }, scheduledWeeklyContext()),
    /REVIEW_HTML_REPORT_REQUIRED/,
  );
});

test("scheduled monthly reviews.save rejects missing htmlReport", async () => {
  const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
  await assert.rejects(
    () => callServiceTool("reviews.save", { ...baseWeeklyInput, kind: "monthly", reportKey: "2026-07" }, {
      ...scheduledWeeklyContext(),
      conversationId: `scheduler:monthly-review:${HTML_TEST_USER}:${HTML_TEST_INSTANCE}`,
      expectedReviewKind: "monthly",
      expectedReviewKey: "2026-07",
    }),
    /REVIEW_HTML_REPORT_REQUIRED/,
  );
});

test("scheduled weekly reviews.save rejects unsafe htmlReport", async () => {
  const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
  const unsafePayloads = [
    "<html><body><script>alert(1)</script></body></html>",
    '<html><body><a href="javascript:alert(1)">x</a></body></html>',
    '<html><body><img src="https://evil.example.com/x.png"></body></html>',
    "<html><style>@import url(fonts)</style><body>x</body></html>",
    "<html><body><iframe srcdoc='x'></iframe></body></html>",
  ];
  for (const htmlReport of unsafePayloads) {
    await assert.rejects(
      () => callServiceTool("reviews.save", { ...baseWeeklyInput, htmlReport }, scheduledWeeklyContext()),
      /REVIEW_HTML_REPORT_INVALID/,
      `should reject: ${htmlReport.slice(0, 40)}`,
    );
  }
});

test("scheduled weekly reviews.save rejects empty or oversized htmlReport", async () => {
  const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
  // 纯空白按缺省处理（stringInput 会 trim）。
  await assert.rejects(
    () => callServiceTool("reviews.save", { ...baseWeeklyInput, htmlReport: "   " }, scheduledWeeklyContext()),
    /REVIEW_HTML_REPORT_REQUIRED/,
  );
  const oversized = `<html><body>${"a".repeat(1024 * 1024)}</body></html>`;
  await assert.rejects(
    () => callServiceTool("reviews.save", { ...baseWeeklyInput, htmlReport: oversized }, scheduledWeeklyContext()),
    /REVIEW_HTML_REPORT_INVALID/,
  );
});

test("scheduled weekly reviews.save publishes markdown + html artifacts idempotently", async () => {
  const { randomUUID } = await import("node:crypto");
  const { registerTestProject } = await import("./helpers/mastra-project.js");
  const { callServiceTool } = await import("../src/mcp/service-tools-core.js");
  const { sqlite } = await import("../src/db/index.js");

  const suffix = randomUUID();
  const userId = `html-publish-user-${suffix}`;
  const instanceId = `html-publish-instance-${suffix}`;
  const reportKey = "2026-08-09_weekly";
  await registerTestProject({ userId, projectId: "invest-agent", instanceId });
  const context = {
    userId,
    instanceId,
    conversationId: `scheduler:weekly-review:${userId}:${instanceId}`,
    expectedReviewKind: "weekly" as const,
    expectedReviewKey: reportKey,
  };
  const htmlReport = "<html><head><style>body{color:#111}</style></head><body><svg viewBox=\"0 0 10 10\"></svg><h1>周复盘</h1></body></html>";

  const first = await callServiceTool("reviews.save", { ...baseWeeklyInput, reportKey, htmlReport }, context) as {
    artifact?: { artifactId: string; versionId?: string | null };
    htmlArtifact?: { artifactId: string; versionId?: string | null; previewMode?: string; mimeType?: string };
  };
  assert.ok(first.artifact?.artifactId, "markdown artifact published");
  assert.ok(first.htmlArtifact?.artifactId, "html artifact published");
  assert.notEqual(first.htmlArtifact!.artifactId, first.artifact!.artifactId);
  assert.equal(first.htmlArtifact!.mimeType, "text/html");
  assert.equal(first.htmlArtifact!.previewMode, "html");

  const row = sqlite.prepare(
    "SELECT relative_path AS relativePath, title FROM conversation_artifacts WHERE artifact_id = ?",
  ).get(first.htmlArtifact!.artifactId) as { relativePath: string; title: string };
  assert.equal(row.relativePath, `reports/weekly/${reportKey}.html`);
  assert.ok(row.title.includes("可视化报告"), "html artifact title carries 可视化报告");

  // 内容变化后重发：两个 artifact 都复用同一 artifactId 并追加新资产版本。
  const second = await callServiceTool("reviews.save", {
    ...baseWeeklyInput,
    reportKey,
    content: "# 周复盘\n\n正文 v2",
    htmlReport: htmlReport.replace("周复盘", "周复盘 v2"),
  }, context) as typeof first;
  assert.equal(second.artifact?.artifactId, first.artifact?.artifactId);
  assert.equal(second.htmlArtifact?.artifactId, first.htmlArtifact?.artifactId);
  assert.notEqual(second.artifact?.versionId, first.artifact?.versionId);
  assert.notEqual(second.htmlArtifact?.versionId, first.htmlArtifact?.versionId);
});
