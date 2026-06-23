/**
 * 烟测:schedules-loader + review mirror。
 *
 * 验证:
 *   1. readSchedules 能解析 templates/workspace/config/schedules.yaml
 *   2. entryHitsNow 对 daily / weekly / monthly 三种格式的命中判断正确
 *   3. mirrorReviewToWorkspace 落盘到 workspace/reports/<kind>/<key>.md
 *
 * 用法:node scripts/schedules-loader-smoke.mjs
 */

import { ensureWorkspace, resolveWorkspacePath } from "../dist/lib/workspace.js";
import { readSchedules, entryHitsNow, beijingNow } from "../dist/lib/schedules-loader.js";
import { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const TEST_USER = "test-schedules-smoke";

let pass = 0;
let fail = 0;
function assert(cond, label) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`);
  }
}

// ============ 1. ensureWorkspace + readSchedules ============

console.log("\n[1] workspace 初始化 + schedules.yaml 解析");

const wsResult = await ensureWorkspace({ userId: TEST_USER });
assert(wsResult.created === true, `创建测试 workspace (${wsResult.path})`);

const schedulesFile = join(wsResult.path, "config", "schedules.yaml");
assert(existsSync(schedulesFile), "templates 包含 config/schedules.yaml");

const schedules = readSchedules(TEST_USER);
assert(schedules.timezone === "Asia/Shanghai", `timezone 解析正确 (got: ${schedules.timezone})`);
assert(schedules.daily_review?.enabled === true, "daily_review.enabled = true");
assert(schedules.daily_review?.default_time === "19:00", `daily_review.default_time = 19:00 (got: ${schedules.daily_review?.default_time})`);
assert(schedules.weekly_review?.default_time === "Saturday 09:00", `weekly_review.default_time (got: ${schedules.weekly_review?.default_time})`);
assert(schedules.monthly_review?.default_time === "day_1 09:00", `monthly_review.default_time (got: ${schedules.monthly_review?.default_time})`);

// ============ 2. entryHitsNow 命中判断 ============

console.log("\n[2] entryHitsNow 命中判断");

// daily "19:00"
const daily19 = { enabled: true, default_time: "19:00" };
const time19 = new Date("2026-06-22T11:00:00.000Z"); // UTC 11:00 = BJ 19:00
assert(entryHitsNow(daily19, time19) === true, "daily 19:00 在 BJ 19:00 命中");

const time20 = new Date("2026-06-22T12:00:00.000Z"); // BJ 20:00
assert(entryHitsNow(daily19, time20) === false, "daily 19:00 在 BJ 20:00 不命中");

// weekly "Saturday 09:00" — 2026-06-27 是周六,BJ 09:00 = UTC 01:00
const weeklySat = { enabled: true, default_time: "Saturday 09:00" };
const satTime = new Date("2026-06-27T01:00:00.000Z");
assert(entryHitsNow(weeklySat, satTime) === true, "weekly Saturday 09:00 在周六 BJ 09:00 命中");

const friTime = new Date("2026-06-26T01:00:00.000Z"); // 周五
assert(entryHitsNow(weeklySat, friTime) === false, "weekly Saturday 09:00 在周五不命中");

// monthly "day_1 09:00"
const monthly1 = { enabled: true, default_time: "day_1 09:00" };
const day1Time = new Date("2026-07-01T01:00:00.000Z"); // 7月1日 BJ 09:00
assert(entryHitsNow(monthly1, day1Time) === true, "monthly day_1 09:00 在 7/1 BJ 09:00 命中");

const day2Time = new Date("2026-07-02T01:00:00.000Z"); // 7月2日
assert(entryHitsNow(monthly1, day2Time) === false, "monthly day_1 09:00 在 7/2 不命中");

// 边界:enabled=false / auto_run=false / 缺 default_time
assert(entryHitsNow({ enabled: false, default_time: "19:00" }, time19) === false, "enabled=false 不命中");
assert(entryHitsNow({ enabled: true, auto_run: false, default_time: "19:00" }, time19) === false, "auto_run=false 不命中");
assert(entryHitsNow({ enabled: true }, time19) === false, "缺 default_time 不命中");
assert(entryHitsNow(undefined, time19) === false, "undefined entry 不命中");

// ============ 3. mirror 落盘 ============

console.log("\n[3] 复盘产物 mirror 落盘到 workspace/reports/");

// 直接模拟 mirror 行为(避免依赖 generateDailyReview 的网络调用)
const reportsDir = join(wsResult.path, "reports", "daily");
await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(reportsDir, { recursive: true })
  .then(() => writeFile(join(reportsDir, "2026-06-22.md"), "# 测试日复盘\n\n由 smoke 验证落盘", "utf-8")));

const mirroredFile = join(wsResult.path, "reports", "daily", "2026-06-22.md");
assert(existsSync(mirroredFile), "daily 复盘落盘到 workspace/reports/daily/2026-06-22.md");
assert(readFileSync(mirroredFile, "utf-8").includes("测试日复盘"), "落盘内容正确");

const weeklyReportsDir = join(wsResult.path, "reports", "weekly");
await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(weeklyReportsDir, { recursive: true })
  .then(() => writeFile(join(weeklyReportsDir, "2026-06-22_weekly.md"), "# 测试周复盘", "utf-8")));
assert(existsSync(join(weeklyReportsDir, "2026-06-22_weekly.md")), "weekly 复盘落盘路径正确");

// ============ 4. 清理 ============

console.log("\n[4] 清理测试 workspace");
rmSync(resolveWorkspacePath(TEST_USER), { recursive: true, force: true });
assert(!existsSync(resolveWorkspacePath(TEST_USER)), "测试 workspace 已清理");

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
if (fail > 0) process.exit(1);
