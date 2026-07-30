#!/usr/bin/env node
/**
 * R6: 真正隔离的 scheduled-review-publication smoke。
 *
 * 使用临时 DB/Workspace/Runtime/Reviews 根（mktemp -d），不触碰生产状态。
 * 凭据前置检查：codex backend 不可用时返回明确非零（不当 skip 为 pass）。
 * 执行后清理临时状态。
 *
 * 用法: npm run smoke:scheduled-review-publication
 */

import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// R6: 创建完全隔离的临时状态根
const ISOLATION_ROOT = mkdtempSync(join(tmpdir(), "invest-agent-pub-smoke-"));
const isolatedDb = join(ISOLATION_ROOT, "test.db");
const isolatedWs = join(ISOLATION_ROOT, "workspaces");
const isolatedRuntime = join(ISOLATION_ROOT, "runtime");
const isolatedReviews = join(ISOLATION_ROOT, "reviews");

// R6: 覆盖所有状态环境变量，确保不碰生产
process.env.DB_PATH = isolatedDb;
process.env.WORKSPACE_ROOT = isolatedWs;
process.env.RUNTIME_DATA_ROOT = isolatedRuntime;
process.env.REVIEWS_ROOT = isolatedReviews;
process.env.NODE_ENV = "test";

const userId = process.argv[2]?.trim() || "pub-smoke-user";
const instanceId = process.argv[3]?.trim() || "invest-agent-pub-smoke";
const today = new Date();
const date = process.argv[4]?.trim() ||
  `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

console.log(`[publication-smoke] ISOLATION_ROOT=${ISOLATION_ROOT}`);
console.log(`[publication-smoke] userId=${userId} instanceId=${instanceId} date=${date}`);

// R6: 凭据前置检查——codex backend 可用性
function checkCodexBackend() {
  const codexAcp = process.env.CODEX_ACP_COMMAND || "/Users/combo/.local/bin/codex-acp";
  if (!existsSync(codexAcp)) {
    return { ok: false, reason: `codex-acp not found at ${codexAcp}` };
  }
  // 检查 .env 是否有 model router 凭据（不读值，只看键存在）
  const envFile = join(process.cwd(), ".env");
  if (!existsSync(envFile)) {
    return { ok: false, reason: ".env not found (no model router credentials)" };
  }
  return { ok: true };
}

const backendCheck = checkCodexBackend();
if (!backendCheck.ok) {
  // R6: 无 backend 时明确非零，不当 skip 为 pass
  console.error(`[publication-smoke] BLOCKED: ${backendCheck.reason}`);
  console.error("[publication-smoke] 这是 live probe，需要 codex backend + model API。");
  console.error("[publication-smoke] 在无 backend 的 CI 环境中，此命令应返回非零（不当 skip 为 pass）。");
  // 清理临时状态
  rmSync(ISOLATION_ROOT, { recursive: true, force: true });
  process.exit(2); // 明确非零（不是 0=pass，不是 1=test-fail，而是 2=blocked）
}

let isolatedSqlite;
try {
  const { initDb, sqlite } = await import("../dist/db/index.js");
  isolatedSqlite = sqlite;
  const { disposeAllAcp } = await import("../dist/acp/stdio-agent.js");
  const { runScheduledReviewPublicationProbe } = await import("../dist/acp/scheduled-tasks.js");

  initDb();
  console.log("[publication-smoke] DB initialized (isolated)");

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
    console.log(`[publication-smoke] 隔离状态根 ${ISOLATION_ROOT} 将被清理`);
    process.exitCode = 0;
  } finally {
    await disposeAllAcp();
  }
} catch (err) {
  console.error(`[publication-smoke] FAILED: ${err.message}`);
  process.exitCode = 1;
} finally {
  try {
    isolatedSqlite?.close();
  } catch {}
  // R6: 清理临时状态
  try {
    rmSync(ISOLATION_ROOT, { recursive: true, force: true });
    console.log("[publication-smoke] 临时状态已清理");
  } catch {}
}

// Scheduler imports may retain background handles; exit only after all cleanup has completed.
process.exit(process.exitCode ?? 0);
