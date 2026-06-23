// WP5.3 烟测:验证 buildMonthlyReviewContext 返回的 methodChangeProposals 字段透出正确。
// 月复盘归因不写新解析器,所以这烟测只验证"字段透出 + 数据 shape"。
//
// 方法候选的 propose/decide 流程在 WP4.9 已完整烟测,这里不重复。

import { db } from "../dist/db/index.js";
import { methodChangeCandidates } from "../dist/db/schema.js";
import { eq } from "drizzle-orm";
import { buildMonthlyReviewContext } from "../dist/handlers/review.js";
import { methodChangeBackend } from "../dist/lib/method-change-backend.js";

const USER = "smoke-wp53";
const INSTANCE = "smoke-wp53";

// 清理 sqlite 测试数据
await db.delete(methodChangeCandidates).where(eq(methodChangeCandidates.userId, USER));

// 模拟本月已有 2 条 proposed 候选 + 1 条 confirmed
await methodChangeBackend.propose({
  userId: USER, instanceId: INSTANCE,
  sourceType: "monthly_review",
  sourceReviewId: "2026-05_monthly",
  proposedChange: "test 改动 1",
  reason: "test 理由 1",
  affectedResource: "knowledge/methods/fundamental.md",
});
await methodChangeBackend.propose({
  userId: USER, instanceId: INSTANCE,
  sourceType: "monthly_review",
  sourceReviewId: "2026-05_monthly",
  proposedChange: "test 改动 2",
  reason: "test 理由 2",
  affectedResource: "knowledge/methods/technical.md",
});

// 调用 buildMonthlyReviewContext(不传 date,默认本月)
const ctx = await buildMonthlyReviewContext({ userId: USER, instanceId: INSTANCE });

console.log("ctx keys:", Object.keys(ctx).join(", "));
console.log("methodChangeProposals count:", ctx.methodChangeProposals.length);

if (!Array.isArray(ctx.methodChangeProposals)) {
  throw new Error("methodChangeProposals should be an array");
}
if (ctx.methodChangeProposals.length < 2) {
  throw new Error(`expected >= 2 proposals, got ${ctx.methodChangeProposals.length}`);
}

// 验证字段 shape
const sample = ctx.methodChangeProposals[0];
const requiredKeys = ["id", "sourceType", "proposedChange", "reason", "affectedResource", "status", "createdAt"];
for (const key of requiredKeys) {
  if (!(key in sample)) {
    throw new Error(`methodChangeProposal missing field: ${key}`);
  }
}

// 验证 viewpointSummary 也透出了 WP5.2 字段(WP5.3 复用同 summary)
if (!ctx.viewpointSummary) {
  throw new Error("viewpointSummary missing");
}

console.log("\nsample methodChangeProposal:", JSON.stringify(sample, null, 2));
console.log("\n✓ WP5.3 monthly context 字段透出烟测通过");

// 清理
await db.delete(methodChangeCandidates).where(eq(methodChangeCandidates.userId, USER));
