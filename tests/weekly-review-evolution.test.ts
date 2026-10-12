import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * 周复盘「策略进化建议」+ htmlReport 可视化报告的 prompt/context 断言。
 * prompt 断言走源码比对（与 tests/scheduled-orchestration-flag.test.ts 同一约定）。
 * 报告格式自 2026-10-12 owner 裁决起是用户偏好：htmlReport 行由
 * describeReviewReportFormat 动态生成（services/user-preferences.ts 单一事实），
 * runtime prompt 与 generic automation runner 共用；类型默认指令为偏好感知静态文案。
 */

test("weekly review prompt requires 策略进化建议 block and preference-driven htmlReport line", () => {
  const source = readFileSync(new URL("../src/runtime/scheduled-tasks.ts", import.meta.url), "utf8");
  const fnIdx = source.indexOf("async function runStructuredReviewPrompt");
  const fnEnd = source.indexOf("interface ScheduledAgentTaskInput", fnIdx);
  assert.ok(fnIdx > 0 && fnEnd > fnIdx);
  const body = source.slice(fnIdx, fnEnd);
  assert.ok(body.includes("策略进化建议"), "weekly prompt requires 策略进化建议 block");
  assert.ok(body.includes("失效信号"), "进化建议须含失效信号");
  assert.ok(body.includes('kind === "weekly"'), "策略进化建议只对 weekly 强制");
  assert.ok(body.includes("describeReviewReportFormat"), "htmlReport 要求按用户报告格式偏好动态注入");
  assert.ok(!body.includes("必须同时传 htmlReport"), "不再硬编码无条件 htmlReport 强制行");
});

test("scheduled task type instructions stay in sync with the structured prompt", () => {
  const source = readFileSync(new URL("../src/services/scheduled-task-types.ts", import.meta.url), "utf8");
  assert.ok(source.includes("htmlReport"), "periodic instructions reference htmlReport");

  const weeklyIdx = source.indexOf("WEEKLY_REVIEW_INSTRUCTION");
  const monthlyIdx = source.indexOf("MONTHLY_REVIEW_INSTRUCTION");
  assert.ok(weeklyIdx > 0 && monthlyIdx > weeklyIdx, "weekly/monthly instructions defined");
  const weeklyBlock = source.slice(weeklyIdx, monthlyIdx);
  const monthlyBlock = source.slice(monthlyIdx);
  assert.ok(weeklyBlock.includes("策略进化建议"), "weekly instruction requires 策略进化建议 block");
  assert.ok(!monthlyBlock.includes("策略进化建议"), "monthly instruction does not force 策略进化建议");

  // 报告格式偏好感知（owner 2026-10-12）：默认 html 必传，markdown/brief/table 不要求；
  // 动态行与静态指令都指向 describeReviewReportFormat 这一共享事实。
  assert.ok(source.includes("报告格式遵循用户偏好"), "静态指令为偏好感知文案");
  assert.ok(source.includes("默认 html"), "静态指令声明默认 html");
  const runtimeSource = readFileSync(new URL("../src/runtime/scheduled-tasks.ts", import.meta.url), "utf8");
  const runnerSource = readFileSync(new URL("../src/services/generic-automation-runner.ts", import.meta.url), "utf8");
  assert.ok(runtimeSource.includes("describeReviewReportFormat"), "runtime prompt 注入偏好行");
  assert.ok(runnerSource.includes("describeReviewReportFormat"), "generic runner 注入偏好行（存量迁移任务感知）");

  // 周复盘任务类型绑定 weekly 指令，月复盘绑定 monthly 指令。
  const weeklyTypeIdx = source.indexOf('"scheduled-weekly-review"');
  const monthlyTypeIdx = source.indexOf('"scheduled-monthly-review"');
  assert.ok(source.slice(weeklyTypeIdx, monthlyTypeIdx).includes("defaultInstruction: WEEKLY_REVIEW_INSTRUCTION"));
  assert.ok(source.slice(monthlyTypeIdx).includes("defaultInstruction: MONTHLY_REVIEW_INSTRUCTION"));
});

test("describeReviewReportFormat: html 行明确要求 htmlReport，其余格式不要求", async () => {
  const { describeReviewReportFormat } = await import("../src/services/user-preferences.js");
  const htmlLine = describeReviewReportFormat("html");
  assert.ok(htmlLine.includes("必须同时传 htmlReport"), "html 偏好行向模型明确要求 htmlReport（prompt 层指令）");
  assert.ok(htmlLine.includes("<iframe>"), "html 偏好行保留安全约束");
  for (const format of ["markdown", "brief", "table"] as const) {
    const line = describeReviewReportFormat(format);
    assert.ok(line.includes("不需要 htmlReport"), `${format} 偏好不要求 htmlReport`);
    assert.ok(!line.includes("必须同时传 htmlReport"), `${format} 偏好不得保留强制措辞`);
  }
});

test("report_format 解析：别名归一化、缺省 html、按 kind 分段读取", async () => {
  const { normalizeReviewReportFormat, resolveReviewReportFormat } = await import("../src/services/user-preferences.js");
  assert.equal(normalizeReviewReportFormat("可视化"), "html");
  assert.equal(normalizeReviewReportFormat("Visual"), "html");
  assert.equal(normalizeReviewReportFormat("MD"), "markdown");
  assert.equal(normalizeReviewReportFormat("简短"), "brief");
  assert.equal(normalizeReviewReportFormat("表格"), "table");
  assert.equal(normalizeReviewReportFormat("ppt"), null);
  assert.equal(normalizeReviewReportFormat(42), null);

  assert.equal(resolveReviewReportFormat(null, "weekly"), "html", "无偏好记录时缺省 html");
  assert.equal(resolveReviewReportFormat({}, "monthly"), "html", "空 schedules 缺省 html");
  assert.equal(resolveReviewReportFormat({ weekly_review: { report_format: "brief" } }, "weekly"), "brief");
  assert.equal(resolveReviewReportFormat({ weekly_review: { report_format: "brief" } }, "monthly"), "html", "偏好按复盘类型分段");
  assert.equal(resolveReviewReportFormat({ weekly_review: { report_format: "非法值" } }, "weekly"), "html", "历史非法值按 html 兜底");
});

test("buildWeeklyReviewContext injects methodChangeProposals like the monthly context", async () => {
  const { methodChangeBackend } = await import("../src/lib/method-change-backend.js");
  const { buildWeeklyReviewContext } = await import("../src/handlers/review.js");

  const suffix = randomUUID();
  const userId = `weekly-evolution-user-${suffix}`;
  const instanceId = `weekly-evolution-instance-${suffix}`;
  await methodChangeBackend.propose({
    userId,
    instanceId,
    proposedChange: "止损线从 -8% 收紧到 -6%",
    reason: "本周两次触及止损后反弹，信号过钝",
    affectedResource: "主策略",
  });

  const context = await buildWeeklyReviewContext({ userId, instanceId, date: "2026-08-13" });
  assert.ok(Array.isArray(context.methodChangeProposals), "weekly context carries methodChangeProposals");
  const proposal = context.methodChangeProposals.find((item) => item.proposedChange.includes("止损线"));
  assert.ok(proposal, "已有候选注入 weekly context，避免重复提议");
  assert.equal(proposal!.status, "proposed");
  assert.ok(proposal!.reason.includes("信号过钝"));
});
