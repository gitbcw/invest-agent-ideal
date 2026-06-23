// WP4.8 烟测:验证 sqlite 和 workspace 两种 backend 在 replaceByDate / resolve / list 上行为等价。
import { sqliteReviewViewpointBackend, workspaceReviewViewpointBackend, __resetReviewViewpointBackendWorkspaceInitCache } from "../dist/lib/review-viewpoint-backend.js";
import { ensureWorkspace } from "../dist/lib/workspace.js";
import { rm } from "node:fs/promises";
import path from "node:path";
import { config } from "../dist/lib/config.js";

const USER = "smoke-rv";
const INSTANCE = "smoke-rv";

async function runCase(backend, label, { preserveWp51Fields }) {
  console.log(`\n=== ${label} ===`);

  // day1: 写入 2 条观点(含 WP5.1 扩展字段)
  await backend.replaceByDate({
    userId: USER, instanceId: INSTANCE, sourceDate: "2026-06-20",
    viewpoints: [
      {
        viewpointId: "v1", view: "看多茅台", reason: "资金回流", action: "持有", validation: "突破前高", expectedReviewDate: "2026-06-27",
        invalidationSignals: ["跌破 1700", "MACD 死叉"], confidence: "high",
      },
      {
        viewpointId: "v2", view: "看空白酒板块", reason: "库存高位", action: "减仓", validation: "跌破支撑", expectedReviewDate: "2026-06-27",
        confidence: "medium",
      },
    ],
  });
  let all = await backend.list(USER, INSTANCE, {});
  console.log("after day1 list count:", all.length);
  if (all.length !== 2) throw new Error("day1 should have 2 viewpoints");
  if (all[0].status !== "open") throw new Error("initial status should be open");

  // WP5.1 字段持久化:
  //   - workspace 路径:真实落 yaml,list 读回时完全保留
  //   - sqlite 路径:扩展列未建,list 返回默认值(设计上仅 replaceByDate 返回时透传)
  const v1Day1 = all.find((r) => r.sourceDate === "2026-06-20" && r.viewpointId === "v1");
  if (!v1Day1) throw new Error("v1 day1 missing");
  if (preserveWp51Fields) {
    if (JSON.stringify(v1Day1.invalidationSignals) !== JSON.stringify(["跌破 1700", "MACD 死叉"])) {
      throw new Error(`invalidationSignals not preserved: ${JSON.stringify(v1Day1.invalidationSignals)}`);
    }
    if (v1Day1.confidence !== "high") throw new Error(`confidence not preserved: ${v1Day1.confidence}`);
  } else {
    if (v1Day1.invalidationSignals.length !== 0) throw new Error("sqlite list should return empty invalidationSignals");
    if (v1Day1.confidence !== "unknown") throw new Error(`sqlite list should return unknown confidence: ${v1Day1.confidence}`);
  }
  // 不传扩展字段时:workspace 写默认值;sqlite 也写默认值
  const v2Day1 = all.find((r) => r.sourceDate === "2026-06-20" && r.viewpointId === "v2");
  if (!v2Day1) throw new Error("v2 day1 missing");
  if (preserveWp51Fields) {
    if (v2Day1.confidence !== "medium") throw new Error(`v2 confidence should be medium: ${v2Day1.confidence}`);
  }

  // day2: 写入 2 条观点(其中 v1 与 day1 同 id,跨日期重复场景)
  await backend.replaceByDate({
    userId: USER, instanceId: INSTANCE, sourceDate: "2026-06-21",
    viewpoints: [
      { viewpointId: "v1", view: "看多茅台(加强)", reason: "外资加仓", action: "加仓", validation: "新高", expectedReviewDate: "2026-06-28" },
      { viewpointId: "v3", view: "关注新能源", reason: "政策利好", action: "观察", validation: "放量突破", expectedReviewDate: "2026-06-28" },
    ],
  });
  all = await backend.list(USER, INSTANCE, {});
  console.log("after day2 list count:", all.length);
  if (all.length !== 4) throw new Error("total should be 4 viewpoints (2+2)");

  // 按 sourceDate 过滤
  const day1Only = await backend.list(USER, INSTANCE, { sourceDateFrom: "2026-06-20", sourceDateTo: "2026-06-20" });
  console.log("day1 only count:", day1Only.length);
  if (day1Only.length !== 2) throw new Error("day1 should have 2");

  // 重跑 day1(观点数量减少,验证 replaceByDate 替换语义)
  await backend.replaceByDate({
    userId: USER, instanceId: INSTANCE, sourceDate: "2026-06-20",
    viewpoints: [
      { viewpointId: "v1", view: "看多茅台", reason: "资金回流", action: "持有", validation: "突破前高", expectedReviewDate: "2026-06-27" },
    ],
  });
  all = await backend.list(USER, INSTANCE, {});
  console.log("after day1 rerun count:", all.length);
  if (all.length !== 3) throw new Error("total should be 3 after day1 rerun (v2 被替换掉)");

  // resolve:把 day1.v1 改成 validated(原 SQLite 宽容语义,跨日都改)
  const resolved = await backend.resolve({
    userId: USER, instanceId: INSTANCE,
    viewpointId: "v1",
    status: "validated",
    resolution: "已突破前高,符合预期",
  });
  console.log("resolve v1:", resolved?.status, resolved?.resolution);
  if (!resolved || resolved.status !== "validated") throw new Error("resolve failed");
  if (!resolved.resolvedAt) throw new Error("validated should have resolvedAt");

  // resolve 不传 sourceDate,应找最新一条(day2 的 v1)
  if (resolved.sourceDate !== "2026-06-21") throw new Error("resolve should pick latest sourceDate");

  // resolve pending(resolvedAt 应清空)
  const pending = await backend.resolve({
    userId: USER, instanceId: INSTANCE,
    viewpointId: "v3",
    sourceDate: "2026-06-21",
    status: "pending",
    resolution: "等待观察放量",
  });
  if (pending?.status !== "pending" || pending.resolvedAt) throw new Error("pending should clear resolvedAt");

  // list by status
  const validated = await backend.list(USER, INSTANCE, { status: "validated" });
  console.log("validated count:", validated.length);
  if (validated.length !== 1) throw new Error("should have 1 validated");

  // list by expectedReviewDate
  const dueBefore27 = await backend.list(USER, INSTANCE, { expectedReviewDateTo: "2026-06-27" });
  console.log("due before 06-27 count:", dueBefore27.length);
  // 06-27 是 v1(day1) 和 v2(day1, 但已被替换);只 v1(day1) expectedReviewDate=06-27,但 v1(day1) 还在吗?
  // day1 rerun 只保留了 v1(day1),所以 expectedReviewDate=06-27 应有 1 条
  // day2 的 v1(06-28) 和 v3(06-28) 都不满足
  if (dueBefore27.length !== 1) throw new Error("should have 1 due before 06-27");

  // 复合查询:status=open + expectedReviewDateTo
  const openDue = await backend.list(USER, INSTANCE, { status: "open", expectedReviewDateTo: "2026-06-28" });
  console.log("openDue 06-28 count:", openDue.length);
  if (openDue.length !== 1) throw new Error("should have 1 open due before 06-28 (day1.v1 was validated)");

  console.log(`✓ ${label} passed`);
}

// 清理 sqlite 测试数据
import { db } from "../dist/db/index.js";
import { reviewViewpoints } from "../dist/db/schema.js";
import { eq } from "drizzle-orm";
await db.delete(reviewViewpoints).where(eq(reviewViewpoints.userId, USER));

await runCase(sqliteReviewViewpointBackend, "sqlite", { preserveWp51Fields: false });

__resetReviewViewpointBackendWorkspaceInitCache();
await ensureWorkspace({ userId: USER });
// 清空 workspace jsonl,避免历史数据污染本次烟测
const viewpointsJsonl = path.join(config.workspace.root, USER, "memory/review_viewpoints.jsonl");
await rm(viewpointsJsonl, { force: true });
await runCase(workspaceReviewViewpointBackend, "workspace", { preserveWp51Fields: true });

// 清理
await db.delete(reviewViewpoints).where(eq(reviewViewpoints.userId, USER));

console.log("\n=== 全部通过 ===");
