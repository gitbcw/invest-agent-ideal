// WP5.6 烟测:验证 buildWeeklyReviewContext / buildMonthlyReviewContext 在 workspace 模式下
// 透出 behaviorStats(action_confirmed / wechat_conversation_turn / out_of_scope_query 计数 + 最近 30 条详情)。
//
// 方法论:代码层只透字段,"追高/频繁短线"等模式识别全权交 Codex。这烟测只验证字段透出 + 数据 shape。
//
// 运行:WORKSPACE_BACKEND=workspace node scripts/wp56-behavior-stats-smoke.mjs

import { config } from "../dist/lib/config.js";
import { ensureWorkspace } from "../dist/lib/workspace.js";
import { WorkspaceStore } from "../dist/lib/workspace-store.js";
import { buildWeeklyReviewContext, buildMonthlyReviewContext } from "../dist/handlers/review.js";

if (process.env.WORKSPACE_BACKEND !== "workspace") {
  console.error("此烟测必须在 workspace 模式下运行:WORKSPACE_BACKEND=workspace node scripts/wp56-behavior-stats-smoke.mjs");
  process.exit(1);
}

const USER = "smoke-wp56";
const INSTANCE = "smoke-wp56";

// 清理(或初始化)workspace 目录
const workspaceRoot = config.workspace.root;
const targetPath = `${workspaceRoot}/${USER}`;
import { rmSync, existsSync } from "node:fs";
if (existsSync(targetPath)) {
  rmSync(targetPath, { recursive: true, force: true });
}

await ensureWorkspace({ userId: USER });
const store = new WorkspaceStore(USER);

// 准备 behavior_events.jsonl:模拟本周(以今日为周末,周一到今天范围内)有 3 类事件
// - 2 条 action_confirmed(都是 buy,价格递增 → 模拟追高)
// - 3 条 wechat_conversation_turn
// - 1 条 out_of_scope_query
// weekRangeForDate 取周一到今天,所以事件都用今天日期才能落进本周范围
const today = new Date();
const iso = (offsetMs) => new Date(today.getTime() + offsetMs).toISOString();

await store.appendBehaviorEvent({
  event_type: "action_confirmed",
  occurred_at: iso(-3000_000), // 约 50 分钟前
  payload: { instance_id: INSTANCE, code: "600519", action: "buy", price: 1680.5, quantity: 100 },
});
await store.appendBehaviorEvent({
  event_type: "action_confirmed",
  occurred_at: iso(-1000_000), // 约 17 分钟前
  payload: { instance_id: INSTANCE, code: "600519", action: "buy", price: 1710.2, quantity: 100 },
});
await store.appendBehaviorEvent({
  event_type: "wechat_conversation_turn",
  occurred_at: iso(-2000_000),
  payload: { instance_id: INSTANCE, text: "你好" },
});
await store.appendBehaviorEvent({
  event_type: "wechat_conversation_turn",
  occurred_at: iso(-1500_000),
  payload: { instance_id: INSTANCE, text: "看一下持仓" },
});
await store.appendBehaviorEvent({
  event_type: "wechat_conversation_turn",
  occurred_at: iso(-500_000),
  payload: { instance_id: INSTANCE, text: "周复盘" },
});
await store.appendBehaviorEvent({
  event_type: "out_of_scope_query",
  occurred_at: iso(-1000_000),
  payload: { instance_id: INSTANCE, text: "今天天气怎么样" },
});

// 其他 instance 的事件(应被过滤掉)
await store.appendBehaviorEvent({
  event_type: "action_confirmed",
  occurred_at: iso(-1000_000),
  payload: { instance_id: "OTHER_INSTANCE", code: "000001", action: "buy", price: 12.5, quantity: 1000 },
});

// 周复盘 context
const weekCtx = await buildWeeklyReviewContext({ userId: USER, instanceId: INSTANCE });
console.log("[week] behaviorStats keys:", Object.keys(weekCtx.behaviorStats).join(", "));
console.log("[week] available:", weekCtx.behaviorStats.available);
console.log("[week] actionConfirmedCount:", weekCtx.behaviorStats.actionConfirmedCount);
console.log("[week] conversationTurnCount:", weekCtx.behaviorStats.conversationTurnCount);
console.log("[week] outOfScopeCount:", weekCtx.behaviorStats.outOfScopeCount);
console.log("[week] recentActions.length:", weekCtx.behaviorStats.recentActions.length);

if (!weekCtx.behaviorStats.available) {
  throw new Error("workspace 模式下 behaviorStats.available 应为 true");
}
if (weekCtx.behaviorStats.actionConfirmedCount !== 2) {
  throw new Error(`expected actionConfirmedCount=2, got ${weekCtx.behaviorStats.actionConfirmedCount}`);
}
if (weekCtx.behaviorStats.conversationTurnCount !== 3) {
  throw new Error(`expected conversationTurnCount=3, got ${weekCtx.behaviorStats.conversationTurnCount}`);
}
if (weekCtx.behaviorStats.outOfScopeCount !== 1) {
  throw new Error(`expected outOfScopeCount=1, got ${weekCtx.behaviorStats.outOfScopeCount}`);
}
if (weekCtx.behaviorStats.recentActions.length !== 2) {
  throw new Error(`expected recentActions.length=2, got ${weekCtx.behaviorStats.recentActions.length}`);
}

// 验证 recentActions 字段 shape
const sample = weekCtx.behaviorStats.recentActions[0];
const requiredKeys = ["occurred_at", "code", "action", "price", "quantity"];
for (const key of requiredKeys) {
  if (!(key in sample)) {
    throw new Error(`recentAction missing field: ${key}`);
  }
}

// 验证范围(rangeStart/rangeEnd 应是 YYYY-MM-DD)
if (!/^\d{4}-\d{2}-\d{2}$/.test(weekCtx.behaviorStats.rangeStart)) {
  throw new Error(`rangeStart format wrong: ${weekCtx.behaviorStats.rangeStart}`);
}

console.log("\nsample recentAction:", JSON.stringify(sample, null, 2));

// 月复盘 context 也应透出 behaviorStats(月范围 ≥ 周范围,数据应能覆盖)
const monthCtx = await buildMonthlyReviewContext({ userId: USER, instanceId: INSTANCE });
if (!monthCtx.behaviorStats.available) {
  throw new Error("monthly behaviorStats.available 应为 true");
}
if (monthCtx.behaviorStats.actionConfirmedCount < 2) {
  throw new Error(`monthly actionConfirmedCount 应 >= 2, got ${monthCtx.behaviorStats.actionConfirmedCount}`);
}
console.log("\n[month] actionConfirmedCount:", monthCtx.behaviorStats.actionConfirmedCount);
console.log("[month] conversationTurnCount:", monthCtx.behaviorStats.conversationTurnCount);

console.log("\n✓ WP5.6 behaviorStats 字段透出烟测通过");

// 清理
rmSync(targetPath, { recursive: true, force: true });
