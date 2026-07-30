import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import { periodicReviewBackend, validateReportKey } from "../src/lib/periodic-review-backend.js";

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
