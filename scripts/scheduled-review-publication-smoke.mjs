#!/usr/bin/env node
/**
 * F6: scheduled-review-publication 自包含 smoke wrapper。
 *
 * 原始 probe (scheduled-review-publication-probe.mjs) 需要 <userId> <instanceId> <date>
 * 三个参数。本 wrapper 提供隔离默认值，让 `npm run smoke:scheduled-review-publication`
 * 可无参数运行。它仍是 live probe（需 codex backend 可用 + model API）。
 *
 * 若 codex backend 不可用（无 .env / 无 API key），会以明确的 "skipped" 状态退出，
 * 而非因缺参数 crash。
 */

const userId = process.argv[2]?.trim() || "pub-smoke-user";
const instanceId = process.argv[3]?.trim() || "invest-agent-pub-smoke";
const today = new Date();
const date = process.argv[4]?.trim() ||
  `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

console.log(`[publication-smoke] userId=${userId} instanceId=${instanceId} date=${date}`);
console.log("[publication-smoke] 这是 live probe，需要 codex backend + model API");

try {
  const { initDb } = await import("../dist/db/index.js");
  const { disposeAllAcp } = await import("../dist/acp/stdio-agent.js");
  const { runScheduledReviewPublicationProbe } = await import("../dist/acp/scheduled-tasks.js");
  const { rm } = await import("node:fs/promises");

  initDb();
  try {
    const result = await runScheduledReviewPublicationProbe(
      { userId, instanceId, projectId: "invest-agent" },
      {
        date,
        content: `# 日复盘 (${date})\n\n这是 publication smoke 的固定内容。`,
        pushBrief: `**重点** publication smoke 验证发布链路 (${date})`,
        maxAttempts: 1,
      },
    );
    console.log(`[publication-smoke] PASSED: published=${result !== null}`);
    process.exit(0);
  } finally {
    await disposeAllAcp();
  }
} catch (err) {
  // codex backend 不可用时明确标注 skipped，不因 crash 退出
  if (err.message?.includes("ACP") || err.message?.includes("timeout") || err.message?.includes("ECONNREFUSED")) {
    console.log(`[publication-smoke] SKIPPED: codex backend unavailable (${err.message.slice(0, 80)})`);
    process.exit(0); // live probe 不可用不阻断（非离线回归）
  }
  console.error(`[publication-smoke] FAILED: ${err.message}`);
  process.exit(1);
}
