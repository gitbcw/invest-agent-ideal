/**
 * 业务流程评测执行器
 *
 * 用法:
 *   npm run eval:workflow -- --workflow=onboarding
 *   npm run eval:workflow -- --workflow=onboarding --run-id=onboarding-baseline
 *   npm run eval:workflow -- --workflow=onboarding --dry-run
 *
 * 语义:
 *   workflow 是连续业务场景,会为每次运行创建新的评测用户和 workspace,
 *   然后在同一个微信模拟会话中连续发送 turns。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..", "..");
const args = process.argv.slice(2);

function argValue(name, fallback = "") {
  return args.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3).trim() || fallback;
}

function slug(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function timestampRunId() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function workflowPathFor(name) {
  const normalized = slug(name || "onboarding") || "onboarding";
  return resolve(repoRoot, "tests", "golden", "workflows", `${normalized}.yaml`);
}

function loadWorkflow(name) {
  const filePath = workflowPathFor(name);
  if (!existsSync(filePath)) throw new Error(`workflow not found: ${filePath}`);
  return { filePath, raw: parse(readFileSync(filePath, "utf-8")) };
}

function expectedChecks(turns, finalExpected) {
  const checks = [];
  for (const turn of turns) {
    checks.push({
      scope: turn.name || `turn-${checks.length + 1}`,
      text: turn.actual_output || "",
      expected: turn.expected || {},
    });
  }
  if (finalExpected) {
    checks.push({
      scope: "final",
      text: turns.at(-1)?.actual_output || "",
      expected: finalExpected,
    });
  }
  return checks;
}

function staticJudge(turns, finalExpected, workspaceChecks) {
  const missingMust = [];
  const forbiddenHits = [];
  for (const check of expectedChecks(turns, finalExpected)) {
    for (const item of check.expected.must_contain || []) {
      if (!check.text.includes(item)) missingMust.push({ scope: check.scope, text: item });
    }
    for (const item of check.expected.must_not_contain || []) {
      if (check.text.includes(item)) forbiddenHits.push({ scope: check.scope, text: item });
    }
  }
  const failedWorkspace = workspaceChecks.filter((item) => !item.ok);
  const verdict = forbiddenHits.length || failedWorkspace.length ? "fail" : missingMust.length ? "warn" : "pass";
  return {
    judge_type: "workflow_static_rubric",
    verdict,
    confidence: verdict === "pass" ? "medium" : "high",
    reason: failedWorkspace.length
      ? "workspace 状态不符合预期"
      : forbiddenHits.length
        ? "命中禁止项"
        : missingMust.length
          ? "缺少部分 must_contain 要点"
          : "workflow 静态检查通过",
    missing_must: missingMust,
    forbidden_hits: forbiddenHits,
    workspace_failures: failedWorkspace,
    needs_human_review: verdict !== "pass",
  };
}

function readYamlIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  return parse(readFileSync(filePath, "utf-8"));
}

function getByPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

function arraysEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => item === b[index]);
}

function checkWorkspace(workspacePath, workspaceExpect = {}) {
  const checks = [];
  const onboardingState = readYamlIfExists(resolve(workspacePath, "config", "onboarding_state.yaml"));
  const schedules = readYamlIfExists(resolve(workspacePath, "config", "schedules.yaml"));
  if (workspaceExpect.onboarding_status) {
    const actual = onboardingState?.status || null;
    checks.push({
      name: "onboarding_state.status",
      ok: actual === workspaceExpect.onboarding_status,
      expected: workspaceExpect.onboarding_status,
      actual,
    });
  }
  if (workspaceExpect.market_watch_default_windows) {
    const actual = getByPath(schedules, "market_watch.default_windows") || [];
    checks.push({
      name: "schedules.market_watch.default_windows",
      ok: arraysEqual(actual, workspaceExpect.market_watch_default_windows),
      expected: workspaceExpect.market_watch_default_windows,
      actual,
    });
  }
  return checks;
}

function quoteMarkdown(value) {
  return String(value ?? "").split("\n").map((line) => `> ${line}`).join("\n");
}

function filenameSafeChinese(value) {
  return String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function buildMarkdownReport(result) {
  const lines = [];
  lines.push(`# ${result.suite.title || result.workflow.id}`);
  lines.push("");
  lines.push(`- workflow: \`${result.workflow.id}\``);
  lines.push(`- domain: ${result.suite.domain || "-"}`);
  lines.push(`- run id: \`${result.run_id}\``);
  lines.push(`- 用户: \`${result.test_user.userId}\``);
  lines.push(`- 实例: \`${result.test_user.instanceId}\``);
  lines.push(`- 会话: \`${result.test_user.conversationId}\``);
  lines.push(`- verdict: ${result.judge.verdict.toUpperCase()} (${result.judge.reason})`);
  lines.push("");
  lines.push("## Workspace 状态");
  lines.push("");
  for (const check of result.workspace_checks) {
    lines.push(`- ${check.ok ? "PASS" : "FAIL"} ${check.name}: expected \`${JSON.stringify(check.expected)}\`, actual \`${JSON.stringify(check.actual)}\``);
  }
  lines.push("");
  lines.push("## 逐轮输出");
  for (const turn of result.turns) {
    lines.push("");
    lines.push(`### ${turn.index}. ${turn.name || "未命名步骤"}`);
    lines.push("");
    lines.push("**输入**");
    lines.push("");
    lines.push(quoteMarkdown(turn.user_input));
    lines.push("");
    lines.push(`**输出** (${turn.elapsed_ms}ms)`);
    lines.push("");
    lines.push(quoteMarkdown(turn.actual_output || turn.error || ""));
  }
  if (result.judge.verdict !== "pass") {
    lines.push("");
    lines.push("## Judge 问题");
    lines.push("");
    lines.push(`- missing_must: ${result.judge.missing_must.length}`);
    for (const item of result.judge.missing_must) lines.push(`  - [${item.scope}] ${item.text}`);
    lines.push(`- forbidden_hits: ${result.judge.forbidden_hits.length}`);
    for (const item of result.judge.forbidden_hits) lines.push(`  - [${item.scope}] ${item.text}`);
    lines.push(`- workspace_failures: ${result.judge.workspace_failures.length}`);
    for (const item of result.judge.workspace_failures) lines.push(`  - ${item.name}`);
  }
  lines.push("");
  return lines.join("\n");
}

function buildReviewQueue(result, reports) {
  const needsReview = result.judge.needs_human_review;
  return {
    ran_at: result.ran_at,
    run_id: result.run_id,
    suite: result.suite,
    test_user: result.test_user,
    judge: {
      enabled: true,
      mode: "workflow-static",
      verdict_counts: {
        pass: result.judge.verdict === "pass" ? 1 : 0,
        warn: result.judge.verdict === "warn" ? 1 : 0,
        fail: result.judge.verdict === "fail" ? 1 : 0,
        unknown: 0,
        none: 0,
      },
      review_count: needsReview ? 1 : 0,
    },
    review_queue: needsReview ? [{
      id: result.workflow.id,
      scenario: result.workflow.id,
      scenario_name: result.suite.title || result.workflow.id,
      category: "business_flow",
      conversation_id: result.test_user.conversationId,
      user_input: result.turns[0]?.user_input || "",
      actual_output_preview: String(result.turns.at(-1)?.actual_output || result.error || "").slice(0, 1200),
      judge: result.judge,
      elapsed_ms: result.elapsed_ms,
      ran_at: result.ran_at,
    }] : [],
    reports,
  };
}

function buildReviewQueueMarkdown(result) {
  const lines = [];
  lines.push("# 业务流程评测人工待审");
  lines.push("");
  lines.push(`- run id: \`${result.run_id}\``);
  lines.push(`- workflow: \`${result.workflow.id}\``);
  lines.push(`- verdict: ${result.judge.verdict.toUpperCase()}`);
  lines.push(`- 人工待审: ${result.judge.needs_human_review ? 1 : 0}`);
  lines.push("");
  if (!result.judge.needs_human_review) {
    lines.push("暂无人工待审项。");
    return lines.join("\n");
  }
  lines.push(`## ${result.judge.verdict.toUpperCase()} · ${result.workflow.id}`);
  lines.push("");
  lines.push(`- reason: ${result.judge.reason}`);
  lines.push(`- conversation: \`${result.test_user.conversationId}\``);
  lines.push(`- test user: \`${result.test_user.userId}\``);
  lines.push("");
  lines.push("**最后输出预览**");
  lines.push("");
  lines.push(quoteMarkdown(String(result.turns.at(-1)?.actual_output || result.error || "").slice(0, 800)));
  lines.push("");
  return lines.join("\n");
}

const workflowName = argValue("workflow", "onboarding");
const runId = slug(argValue("run-id", timestampRunId())) || timestampRunId();
const dryRun = args.includes("--dry-run");
const turnTimeoutMs = Number(argValue("turn-timeout-ms", "120000"));
const { filePath, raw } = loadWorkflow(workflowName);
const workflow = raw.workflow;
if (!workflow?.id || !Array.isArray(workflow.turns)) {
  throw new Error(`${filePath} 缺少 workflow.id 或 workflow.turns`);
}

const userId = slug(argValue("user-id", `${workflow.user_id_prefix || "eval-flow"}-${runId}`)).toLowerCase();
const conversationId = slug(argValue("conversation-id", `${workflow.conversation_id_prefix || workflow.id}-${runId}`));

console.log("=== 业务流程评测 ===");
console.log(`workflow: ${workflow.id}`);
console.log(`domain: ${raw.suite?.domain || "-"}`);
console.log(`turns: ${workflow.turns.length}`);
console.log(`user: ${userId}`);
console.log(`conversation: ${conversationId}`);
console.log(`turn timeout: ${turnTimeoutMs}ms`);
console.log(`file: ${filePath}`);
if (dryRun) {
  console.log("[dry-run] 只解析 workflow,不创建用户、不调用 ACP");
  for (const [index, turn] of workflow.turns.entries()) {
    console.log(`- ${index + 1}. ${turn.name}: ${String(turn.user_input).replace(/\s+/g, " ").slice(0, 120)}`);
  }
  process.exit(0);
}

const startedAt = Date.now();
const { createInvestAgentInstance, deleteInvestAgentInstance } = await import("../../src/platform/project-registry.ts");
const { projectWeixinManagerForInstance } = await import("../../src/routes/platform.ts");
const { resolveWorkspacePath } = await import("../../src/lib/workspace.ts");
const { disposeAcpForWorkspace } = await import("../../src/acp/stdio-agent.ts");

const existingInstanceId = `invest-agent-${userId}`.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
try {
  await deleteInvestAgentInstance(existingInstanceId);
} catch {
  // 新 run 通常没有同名用户；没有就跳过。
}

const runtimeContext = await createInvestAgentInstance({
  userId,
  displayName: `评测 ${raw.suite?.domain || workflow.id}`,
  instanceName: `评测 ${raw.suite?.title || workflow.id} ${runId}`,
  backend: "codex",
});
const workspacePath = resolveWorkspacePath(userId);
const manager = await projectWeixinManagerForInstance(runtimeContext.instanceId);
const accountId = `workflow-${workflow.id}-${runId}`;
const turns = [];
let error = null;

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

try {
  for (const [index, turn] of workflow.turns.entries()) {
    const turnStartedAt = Date.now();
    process.stdout.write(`▶ ${index + 1}/${workflow.turns.length} ${turn.name || "turn"} ... `);
    try {
      const response = await withTimeout(
        manager.simulateIncomingText({
          text: turn.user_input,
          conversationId,
          accountId,
        }),
        turnTimeoutMs,
        `turn ${index + 1} ${turn.name || ""}`.trim(),
      );
      const actual = response.text || "";
      turns.push({
        index: index + 1,
        name: turn.name || "",
        user_input: turn.user_input,
        expected: turn.expected || {},
        actual_output: actual,
        elapsed_ms: Date.now() - turnStartedAt,
      });
      console.log(actual.slice(0, 80).replace(/\n/g, " "));
    } catch (turnError) {
      const message = turnError instanceof Error ? turnError.message : String(turnError);
      turns.push({
        index: index + 1,
        name: turn.name || "",
        user_input: turn.user_input,
        expected: turn.expected || {},
        actual_output: "",
        error: message,
        elapsed_ms: Date.now() - turnStartedAt,
      });
      console.log(`ERROR: ${message}`);
      error = message;
      break;
    }
  }
} finally {
  try {
    await Promise.resolve(disposeAcpForWorkspace(workspacePath));
  } catch {
    // 评测报告比清理错误更重要；ACP 清理失败可由后续服务重启回收。
  }
}

const workspaceChecks = checkWorkspace(workspacePath, workflow.workspace_expect || {});
const judge = staticJudge(turns, workflow.final_expected, workspaceChecks);
if (error && judge.verdict === "pass") {
  judge.verdict = "fail";
  judge.reason = "workflow 执行异常";
  judge.needs_human_review = true;
}

const result = {
  ran_at: new Date().toISOString(),
  run_id: runId,
  suite: raw.suite || {},
  workflow: {
    id: workflow.id,
    review_tier: workflow.review_tier || "business_flow",
    priority: workflow.priority || "P1",
    principles: workflow.principles || [],
  },
  test_user: {
    userId,
    instanceId: runtimeContext.instanceId,
    conversationId,
    workspacePath,
  },
  turns,
  workspace_checks: workspaceChecks,
  judge,
  error,
  elapsed_ms: Date.now() - startedAt,
};

const outDir = resolve(repoRoot, "eval-reports");
mkdirSync(outDir, { recursive: true });
const basename = filenameSafeChinese(raw.suite?.title || workflow.id) || workflow.id;
const mdFilename = `${basename}.md`;
const jsonFilename = `${basename}.json`;
writeFileSync(resolve(outDir, mdFilename), buildMarkdownReport(result), "utf-8");
writeFileSync(resolve(outDir, jsonFilename), JSON.stringify(result, null, 2), "utf-8");
const reports = [{ scenario: workflow.id, scenario_name: raw.suite?.title || workflow.id, mdFilename, jsonFilename }];
writeFileSync(resolve(outDir, "_review-queue.md"), buildReviewQueueMarkdown(result), "utf-8");
writeFileSync(resolve(outDir, "_review-queue.json"), JSON.stringify(buildReviewQueue(result, reports), null, 2), "utf-8");

console.log("");
console.log("=== 完成 ===");
console.log(`verdict: ${judge.verdict.toUpperCase()} (${judge.reason})`);
console.log(`report: eval-reports/${mdFilename}`);
console.log(`review queue: eval-reports/_review-queue.md`);
console.log(`test user: ${userId}`);
process.exit(judge.verdict === "fail" ? 1 : 0);
