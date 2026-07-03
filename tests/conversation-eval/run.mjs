/**
 * 对话评估集执行器
 *
 * 用法:
 *   npm run eval:conversation           # 跑全部 case
 *   npm run eval:conversation -- --only=portfolio-001    # 只跑某条
 *   npm run eval:conversation -- --only=alert-001,alert-002
 *   npm run eval:conversation -- --only=portfolio-001:invalid_stock
 *   npm run eval:conversation -- --tag=review            # 跑某类标签
 *   npm run eval:conversation -- --scenario=daily_review_request
 *   npm run eval:conversation -- --priority=P0
 *   npm run eval:conversation -- --only=monitor-001 --conversation-id=eval-monitor-001
 *   npm run eval:conversation -- --only=review-002 --run-id=review-002-solo
 *   npm run eval:conversation -- --shared-conversation       # 整个批次复用同一会话(默认每 case 隔离)
 *   npm run eval:conversation -- --no-wait-async             # 不等待后台推送 trace
 *   npm run eval:conversation -- --judge=static              # 生成结构化 rubric verdict(默认)
 *   npm run eval:conversation -- --judge=model               # 使用外部 judge 模型(需要 EVAL_JUDGE_MODEL)
 *   npm run eval:conversation -- --judge=none                # 只产出原始输出,不判分
 *   npm run eval:conversation -- --dry-run                # 只解析+列出 case,不真跑
 *
 * 输出:
 *   eval-reports/<中文场景名>.md   — 该场景最新人工审计报告
 *   eval-reports/<中文场景名>.json — 同内容机器可读版
 *
 * 通道:
 *   走本地微信模拟入口(WeixinMobileManager.simulateIncomingText),覆盖真实 workspace-scoped Codex ACP。
 *   测试用户独立工作空间(userId=eval),与 primary 用户数据隔离。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import {
  buildJudgeInput,
  buildJudgeSystemPrompt,
  modelJudgeConfigFromEnv,
  normalizeJudgeOutput,
  parseJudgeJson,
  unconfiguredModelJudgeResult,
} from "./judge-contract.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function loadEnvFileIfPresent(filePath, { override = false } = {}) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!override && process.env[key] !== undefined) continue;
    process.env[key] = rawValue
      .trim()
      .replace(/^(['"])([\s\S]*)\1$/, "$2");
  }
}

function applyGenericJudgeApiKey(config) {
  if (!process.env.EVAL_JUDGE_API_KEY) return;
  const keyByProvider = {
    deepseek: "DEEPSEEK_API_KEY",
    stepfun: "STEPFUN_API_KEY",
    doubao: "DOUBAO_API_KEY",
    openai: "OPENAI_API_KEY",
  };
  const keyName = keyByProvider[config.provider];
  if (keyName && !process.env[keyName]) {
    process.env[keyName] = process.env.EVAL_JUDGE_API_KEY;
  }
}

function exportedFunction(moduleValue, name) {
  return moduleValue?.[name] || moduleValue?.default?.[name];
}

const casesPath = resolve(__dirname, "..", "golden", "conversation", "cases.yaml");
const repoRoot = resolve(__dirname, "..", "..");
loadEnvFileIfPresent(resolve(repoRoot, ".env"));
loadEnvFileIfPresent(resolve(repoRoot, ".hermes", ".env"));

// 解析 CLI 参数
const args = process.argv.slice(2);
const onlyIds = new Set((args.find((a) => a.startsWith("--only="))?.slice("--only=".length) ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean));
const tagFilters = new Set((args.find((a) => a.startsWith("--tag="))?.slice("--tag=".length) ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean));
const scenarioFilters = new Set((args.find((a) => a.startsWith("--scenario="))?.slice("--scenario=".length) ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean));
const priorityFilters = new Set((args.find((a) => a.startsWith("--priority="))?.slice("--priority=".length) ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean));
const conversationIdOverride = args.find((a) => a.startsWith("--conversation-id="))?.slice("--conversation-id=".length).trim();
const runIdOverride = args.find((a) => a.startsWith("--run-id="))?.slice("--run-id=".length).trim();
const dryRun = args.includes("--dry-run");
const sharedConversation = args.includes("--shared-conversation") || Boolean(conversationIdOverride);
const waitAsync = !args.includes("--no-wait-async");
const asyncWaitTimeoutMs = Number(args.find((a) => a.startsWith("--async-timeout-ms="))?.slice("--async-timeout-ms=".length) ?? 180_000);
const judgeMode = args.find((a) => a.startsWith("--judge="))?.slice("--judge=".length).trim() || "static";
const judgeEnabled = judgeMode !== "none";

const SCENARIO_NAMES = {
  workspace_greeting: "问候引导",
  onboarding_market_watch_custom_times: "Onboarding 自定义盯盘时间",
  onboarding_notification_custom_times: "Onboarding 自定义通知时间",
  investment_model_guided_setup: "默认投资模型引导配置",
  investment_model_query_empty: "查询投资模型空状态",
  investment_model_freeform_draft: "投资模型自由描述草案",
  investment_model_plan_drafting_confirm: "投资模型制定预案确认",
  out_of_scope_boundary: "非投资问题边界",
  portfolio_add_no_plan_hint: "添加持仓并提示预案",
  watchlist_add: "添加自选",
  contextual_watchlist_add: "上下文加入自选",
  contextual_expand_latest: "上下文展开最近内容",
  contextual_write_policy_guard: "上下文写入意图保护",
  alert_set_simple_price: "设置价格提醒草案",
  alert_set_confirm_two_turn: "价格提醒两轮确认",
  alert_set_breakout_price_cancel: "突破价提醒取消",
  pending_confirmation_can_be_ambiguous: "短确认消费待确认草案",
  alert_rules_query: "查询提醒规则",
  strategy_list_query: "查询交易策略",
  strategy_plan_drafting_gate_one: "策略预案第一道闸门",
  investment_style_set_confirm: "投资风格设置确认",
  methodology_set_confirm: "投资方法论设置确认",
  screening_methodology_overlay_draft: "选股方法论承接",
  trading_strategy_set_confirm: "交易策略设置确认",
  trading_strategy_indicator_draft: "交易策略指标化草案",
  daily_review_request: "日复盘请求",
  daily_review_summary_then_expand: "日复盘摘要后展开",
  weekly_review_request: "周复盘请求",
  monthly_review_request: "月复盘请求",
  stock_screening_qa: "选股问答",
  stock_screening_ambiguous: "模糊选股问答",
};

function slug(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function quoteMarkdown(value) {
  const text = String(value ?? "");
  if (!text) return "> ";
  return text.split("\n").map((line) => `> ${line}`).join("\n");
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

function scenarioDisplayName(scenario) {
  return SCENARIO_NAMES[scenario] ?? scenario;
}

const raw = parse(readFileSync(casesPath, "utf-8"));
const testUser = {
  ...raw.test_user,
  conversationId: conversationIdOverride || raw.test_user?.conversationId,
};

function conversationIdForCase(c) {
  if (sharedConversation) return testUser.conversationId;
  return `${testUser.conversationId}-${slug(c.id)}`;
}
function expandCases(cases) {
  const expanded = [];
  for (const c of cases) {
    const { edge_cases: _edgeCases, ...base } = c;
    expanded.push({ ...base, base_id: c.id, variant_id: null, variant_type: "main" });
    for (const edge of c.edge_cases ?? []) {
      expanded.push({
        ...edge,
        id: `${c.id}:${edge.id}`,
        base_id: c.id,
        variant_id: edge.id,
        variant_type: "edge",
        scenario: edge.scenario ?? c.scenario,
        priority: edge.priority ?? c.priority,
        tags: [...new Set([...(c.tags ?? []), ...(edge.tags ?? []), "edge"])],
      });
    }
  }
  return expanded;
}

const allCases = expandCases(raw.cases ?? []);

if (!testUser || !Array.isArray(allCases)) {
  console.error("cases.yaml 格式错误:缺少 test_user 或 cases");
  process.exit(1);
}

const cases = allCases.filter((c) => {
  if (onlyIds.size > 0 && !onlyIds.has(c.id)) return false;
  if (scenarioFilters.size > 0 && !scenarioFilters.has(c.scenario)) return false;
  if (priorityFilters.size > 0 && !priorityFilters.has(c.priority)) return false;
  if (tagFilters.size > 0) {
    const tags = new Set(c.tags ?? []);
    for (const tag of tagFilters) {
      if (!tags.has(tag)) return false;
    }
  }
  return true;
});

if (cases.length === 0) {
  console.error(`未找到匹配的 case: ${args.join(" ")}`);
  process.exit(1);
}

console.log(`=== 对话评估集 ===`);
console.log(`测试用户: ${testUser.userId} / ${testUser.instanceId}`);
console.log(`待跑 case: ${cases.length} / ${allCases.length}`);
if (onlyIds.size > 0) console.log(`only: ${[...onlyIds].join(",")}`);
if (tagFilters.size > 0) console.log(`tag: ${[...tagFilters].join(",")}`);
if (scenarioFilters.size > 0) console.log(`scenario: ${[...scenarioFilters].join(",")}`);
if (priorityFilters.size > 0) console.log(`priority: ${[...priorityFilters].join(",")}`);
if (conversationIdOverride) console.log(`conversationId: ${conversationIdOverride}`);
console.log(`conversation 模式: ${sharedConversation ? "shared" : "per-case"}`);
console.log(`等待后台任务: ${waitAsync ? `yes (${asyncWaitTimeoutMs}ms)` : "no"}`);
console.log(`judge: ${judgeEnabled ? judgeMode : "none"}`);
if (dryRun) console.log(`[dry-run] 只解析,不真跑通道`);
console.log("");

if (dryRun) {
  for (const c of cases) {
    const variant = c.variant_type === "edge" ? " edge" : "";
    console.log(`- ${c.id} [${c.scenario}]${variant}`);
    if (c.category) console.log(`  category: ${c.category}`);
    if (c.principles?.length) console.log(`  principles: ${c.principles.join(" / ")}`);
    if (c.description) console.log(`  说明: ${c.description}`);
    if (Array.isArray(c.turns)) {
      console.log(`  输入: ${c.turns.map((turn) => turn.user_input).join(" -> ")}`);
    } else {
      console.log(`  输入: ${c.user_input}`);
    }
    console.log(`  must_contain: ${(c.expected?.must_contain ?? []).join(" / ")}`);
    console.log(`  must_not_contain: ${(c.expected?.must_not_contain ?? []).join(" / ")}`);
    console.log("");
  }
  process.exit(0);
}

// 动态加载(避免顶层 import 失败时无法 --dry-run)
const { ensureDefaultProjectForUser } = await import("../../src/platform/project-registry.ts");
const { projectWeixinManagerForInstance } = await import("../../src/routes/platform.ts");
const { ensureWorkspace } = await import("../../src/lib/workspace.ts");
const { WorkspaceStore } = await import("../../src/lib/workspace-store.ts");
const { sqlite } = await import("../../src/db/index.ts");

function resetEvalCaseState(instanceId) {
  const userId = testUser.userId;
  const conversationIds = new Set([testUser.conversationId, ...cases.map((c) => conversationIdForCase(c))].filter(Boolean));
  const legacyUserIds = [...conversationIds].map((conversationId) => `weixin-mobile-${createHash("sha256").update(conversationId).digest("hex").slice(0, 10)}`);
  const userIds = [userId, ...legacyUserIds];
  const deleteByUser = [
    "portfolio",
    "watchlist",
    "alerts",
    "alert_rules",
    "alert_events",
    "stock_plans",
    "trade_actions",
    "chat_history",
    "codex_acp_traces",
    "sandbox_audit_logs",
    "pending_sandbox_confirmations",
    "conversation_tasks",
  ];
  const tx = sqlite.transaction(() => {
    for (const table of deleteByUser) {
      const stmt = sqlite.prepare(`DELETE FROM ${table} WHERE user_id = ?`);
      for (const id of userIds) stmt.run(id);
    }
    sqlite.prepare(`
      DELETE FROM channel_identity_instances
      WHERE channel_identity_id IN (
        SELECT id FROM channel_identities
        WHERE user_id IN (${userIds.map(() => "?").join(",")})
          OR external_user_id IN (${[...conversationIds].map(() => "?").join(",")})
      )
    `).run(...userIds, ...conversationIds);
    sqlite.prepare(`
      DELETE FROM channel_identities
      WHERE user_id IN (${userIds.map(() => "?").join(",")})
        OR external_user_id IN (${[...conversationIds].map(() => "?").join(",")})
    `).run(...userIds, ...conversationIds);
    sqlite.prepare(`DELETE FROM ai_instances WHERE id = ? OR owner_user_id IN (${userIds.map(() => "?").join(",")})`).run(instanceId, ...userIds);
    sqlite.prepare(`DELETE FROM users WHERE id IN (${userIds.map(() => "?").join(",")})`).run(...userIds);
  });
  tx();
}

async function seedEvalFixtures(runtimeContext) {
  await ensureWorkspace({
    userId: testUser.userId,
    tenantId: testUser.userId,
    projectId: runtimeContext.projectId,
  });
  const store = new WorkspaceStore(testUser.userId);
  await store.writeTradingStrategy({
    key: "trend-continuation",
    name: "趋势中继",
    applicability: "适用于中期趋势未破、缩量回踩关键均线后重新放量确认的个股。",
    body: [
      "第一道闸门只判断策略是否适配标的,不得直接起草个股预案。",
      "适配条件: 中期趋势未破,回踩关键均线附近,量能缩小后重新放量确认。",
      "不适配条件: 趋势已破、基本面恶化、单日题材脉冲或追高。",
    ].join("\n"),
    enabled: true,
  });
}

function latestAsyncTrace(conversationId, afterIso) {
  return sqlite.prepare(`
    SELECT mode, status, reply_text_sanitized AS replyTextSanitized, error_message AS errorMessage, elapsed_ms AS elapsedMs, created_at AS createdAt
    FROM codex_acp_traces
    WHERE user_id = ?
      AND conversation_id = ?
      AND created_at >= ?
      AND mode IN ('daily-review-push', 'complex-push')
    ORDER BY id DESC
    LIMIT 1
  `).get(testUser.userId, conversationId, afterIso);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function todayLocalDate() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function readDailyReviewArtifactIfExists(afterIso) {
  const afterMs = new Date(afterIso).getTime();
  const date = todayLocalDate();
  const candidates = [
    resolve(__dirname, "..", "..", "reviews", testUser.userId, `${date}.md`),
    resolve(__dirname, "..", "..", "reviews", testUser.userId, `${date}.txt`),
  ];
  for (const filePath of candidates) {
    if (existsSync(filePath)) {
      const stat = statSync(filePath);
      if (Number.isFinite(afterMs) && stat.mtimeMs + 1000 < afterMs) continue;
      return {
        filePath,
        content: readFileSync(filePath, "utf-8"),
      };
    }
  }
  return null;
}

function includesLoose(text, needle) {
  const source = String(text || "").toLowerCase();
  const target = String(needle || "").toLowerCase().trim();
  if (!target) return true;
  return source.includes(target);
}

function expectedChecksForResult(result) {
  const checks = [];
  if (result.turns?.length) {
    for (const turn of result.turns) {
      checks.push({
        scope: `turn-${turn.index}`,
        expected: turn.expected || {},
        actual: turn.actual_output || "",
      });
    }
  }
  checks.push({
    scope: "final",
    expected: result.expected || {},
    actual: result.actual_output || "",
  });
  return checks;
}

function staticRubricJudge(result) {
  if (result.error) {
    return normalizeJudgeOutput({
      judge_type: "static_rubric",
      verdict: "fail",
      confidence: "high",
      reason: `运行错误: ${result.error}`,
      missing_must: [],
      forbidden_hits: [],
      global_forbidden_hits: [],
      needs_human_review: true,
    });
  }

  const missingMust = [];
  const forbiddenHits = [];
  const globalForbiddenHits = [];

  for (const check of expectedChecksForResult(result)) {
    for (const item of check.expected.must_contain || []) {
      if (!includesLoose(check.actual, item)) {
        missingMust.push({ scope: check.scope, text: item });
      }
    }
    for (const item of check.expected.must_not_contain || []) {
      if (includesLoose(check.actual, item)) {
        forbiddenHits.push({ scope: check.scope, text: item });
      }
    }
  }

  for (const item of raw.quality_gates?.global_must_not_contain || []) {
    if (includesLoose(result.actual_output, item)) {
      globalForbiddenHits.push(item);
    }
  }

  const hasForbidden = forbiddenHits.length > 0 || globalForbiddenHits.length > 0;
  const hasMissing = missingMust.length > 0;
  const verdict = hasForbidden ? "fail" : hasMissing ? "warn" : "pass";
  const reason = hasForbidden
    ? "命中禁止项或全局禁词"
    : hasMissing
      ? "缺少部分 must_contain 要点"
      : "静态 rubric 未发现缺失或越界";

  return normalizeJudgeOutput({
    judge_type: "static_rubric",
    verdict,
    confidence: hasForbidden ? "high" : hasMissing ? "medium" : "medium",
    reason,
    missing_must: missingMust,
    forbidden_hits: forbiddenHits,
    global_forbidden_hits: globalForbiddenHits,
    needs_human_review: verdict !== "pass",
  });
}

async function modelJudge(result) {
  const config = modelJudgeConfigFromEnv();
  if (!config.model || !config.apiKeyPresent) {
    return unconfiguredModelJudgeResult(config);
  }
  applyGenericJudgeApiKey(config);
  const judgeInput = buildJudgeInput({
    result,
    suite: raw.suite,
    qualityGates: raw.quality_gates,
  });

  try {
    if (config.provider === "openai") {
      throw new Error("openai provider is not implemented in this project judge runner");
    }
    const deepseekModule = await import("../../src/services/deepseek.js");
    const callDeepSeek = exportedFunction(deepseekModule, "callDeepSeek");
    if (typeof callDeepSeek !== "function") {
      throw new Error("callDeepSeek export was not found");
    }
    const reply = await callDeepSeek(
      JSON.stringify(judgeInput, null, 2),
      buildJudgeSystemPrompt(),
      [],
      {
        provider: config.provider,
        profile: "light",
        model: config.model,
        thinking: false,
        temperature: 0,
        maxTokens: 1200,
      },
    );
    const parsed = parseJudgeJson(reply);
    return normalizeJudgeOutput(parsed, {
      judge_type: "model",
      judge_model: `${config.provider}/${config.model}`,
    });
  } catch (error) {
    return normalizeJudgeOutput({
      judge_type: "model_error",
      judge_model: `${config.provider}/${config.model}`,
      verdict: "unknown",
      confidence: "low",
      reason: `model judge failed: ${error instanceof Error ? error.message : String(error)}`,
      needs_human_review: true,
    });
  }
}

async function judgeResult(result) {
  if (!judgeEnabled) return null;
  if (judgeMode === "static") return staticRubricJudge(result);
  if (judgeMode === "model") return modelJudge(result);
  return normalizeJudgeOutput({
    judge_type: judgeMode,
    verdict: "unknown",
    confidence: "low",
    reason: `未知 judge 模式: ${judgeMode}`,
    missing_must: [],
    forbidden_hits: [],
    global_forbidden_hits: [],
    needs_human_review: true,
  });
}

async function waitForAsyncTraceIfNeeded(conversationId, afterIso) {
  if (!waitAsync) return null;
  const deadline = Date.now() + asyncWaitTimeoutMs;
  while (Date.now() < deadline) {
    const trace = latestAsyncTrace(conversationId, afterIso);
    if (trace) {
      const artifact = readDailyReviewArtifactIfExists(afterIso);
      if (artifact && !trace.replyTextSanitized) {
        return {
          ...trace,
          artifactPath: artifact.filePath,
          artifactContent: artifact.content,
        };
      }
      return trace;
    }
    await sleep(1000);
  }
  return {
    mode: "async-wait-timeout",
    status: "timeout",
    errorMessage: `等待后台推送 trace 超时(${asyncWaitTimeoutMs}ms)`,
    elapsedMs: asyncWaitTimeoutMs,
    createdAt: new Date().toISOString(),
  };
}

// 1. 确保测试用户绑定到 invest-agent project(拿到正确的 projectType / skillBundleId / 等),
//    否则 prompt-context-builder 不会加载 invest-agent 相关 SKILL,行为跟真实微信不一致。
const initialContext = await ensureDefaultProjectForUser(testUser.userId, "codex", "评估测试用户");
resetEvalCaseState(initialContext.instanceId);
const runtimeContext = await ensureDefaultProjectForUser(testUser.userId, "codex", "评估测试用户");
await seedEvalFixtures(runtimeContext);
const weixinManager = await projectWeixinManagerForInstance(runtimeContext.instanceId);

// 2. 跑批:走当前主微信通道(WeixinMobileManager → InvestAgentMobileBridge.chat)。
//    该通道覆盖 WeChat bridge、AcpAgent 直通入口、workspace-scoped Codex ACP 和 sandbox/API 边界。
const accountId = `eval-account-${testUser.userId}`;
const results = [];

for (const c of cases) {
  process.stdout.write(`▶ ${c.id} [${c.scenario}] ... `);
  const caseConversationId = conversationIdForCase(c);
  const startedAt = Date.now();
  let actual = "";
  let error = null;
  const turnResults = [];
  const asyncResults = [];
  try {
    const turns = Array.isArray(c.turns) ? c.turns : [{ user_input: c.user_input, expected: c.expected }];
    for (const [turnIndex, turn] of turns.entries()) {
      const turnStartedAt = Date.now();
      const asyncTraceSince = new Date().toISOString();
      const response = await weixinManager.simulateIncomingText({
        text: turn.user_input,
        conversationId: caseConversationId,
        accountId,
      });
      const turnText = response.text ?? "";
      let asyncTrace = null;
      if (/复盘已经开始生成|预计几分钟后发给你|我处理完会直接发给你/.test(turnText)) {
        asyncTrace = await waitForAsyncTraceIfNeeded(caseConversationId, asyncTraceSince);
        if (asyncTrace?.replyTextSanitized) {
          actual = asyncTrace.replyTextSanitized;
        } else if (asyncTrace?.artifactContent) {
          actual = asyncTrace.artifactContent;
        }
        if (asyncTrace) {
          asyncResults.push({ turn: turnIndex + 1, ...asyncTrace });
        }
      }
      turnResults.push({
        index: turnIndex + 1,
        user_input: turn.user_input,
        expected: turn.expected ?? {},
        actual_output: turnText,
        async_trace: asyncTrace,
        elapsed_ms: Date.now() - turnStartedAt,
      });
      if (!asyncTrace?.replyTextSanitized && !asyncTrace?.artifactContent) actual = turnText;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const elapsedMs = Date.now() - startedAt;
  const result = {
    id: c.id,
    scenario: c.scenario,
    conversation_id: caseConversationId,
    user_input: c.user_input,
    turns: turnResults,
    async_results: asyncResults,
    expected: c.expected ?? {},
    category: c.category,
    principles: c.principles ?? [],
    actual_output: actual,
    error,
    elapsed_ms: elapsedMs,
    ran_at: new Date().toISOString(),
  };
  result.judge = await judgeResult(result);
  results.push(result);
  if (error) {
    console.log(`ERROR (${elapsedMs}ms): ${error}`);
  } else {
    const preview = actual.slice(0, 60).replace(/\n/g, " ");
    const verdict = result.judge?.verdict ? ` ${result.judge.verdict.toUpperCase()}` : "";
    console.log(`OK${verdict} (${elapsedMs}ms): ${preview}...`);
  }
}

// 3. 落结果:按场景覆盖最新人工审计报告
const finishedAt = new Date();
const today = todayLocalDate(finishedAt);
const outDir = resolve(__dirname, "..", "..", "eval-reports");
mkdirSync(outDir, { recursive: true });
const autoRunIdParts = [
  finishedAt.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14),
  onlyIds.size > 0 ? [...onlyIds].map(slug).join("_") : "all",
  tagFilters.size > 0 ? `tag-${[...tagFilters].map(slug).join("_")}` : "",
  scenarioFilters.size > 0 ? `scenario-${[...scenarioFilters].map(slug).join("_")}` : "",
  priorityFilters.size > 0 ? `priority-${[...priorityFilters].map(slug).join("_")}` : "",
].filter(Boolean);
const runId = slug(runIdOverride) || autoRunIdParts.join("__");

function verdictCounts(rows) {
  const counts = { pass: 0, warn: 0, fail: 0, unknown: 0, none: 0 };
  for (const row of rows) {
    const verdict = row.judge?.verdict || "none";
    counts[verdict] = (counts[verdict] ?? 0) + 1;
  }
  return counts;
}

function needsHumanReview(row) {
  return Boolean(row.judge?.needs_human_review || ["warn", "fail", "unknown"].includes(row.judge?.verdict));
}

function formatJudgeIssueList(items) {
  if (!items?.length) return ["- 无"];
  return items.map((item) => {
    if (typeof item === "string") return `- ${item}`;
    return `- ${item.scope ? `[${item.scope}] ` : ""}${item.text ?? JSON.stringify(item)}`;
  });
}

function buildMarkdownReport(group) {
  const scenarioName = scenarioDisplayName(group.scenario);
  const counts = verdictCounts(group.results);
  const mdLines = [];
  mdLines.push(`# ${scenarioName}`);
  mdLines.push("");
  mdLines.push(`- 场景: \`${group.scenario}\``);
  mdLines.push(`- golden suite: \`${raw.suite?.id ?? "unknown"}\` v${raw.suite?.version ?? "-"}`);
  mdLines.push(`- 测试用户: \`${testUser.userId}\` / \`${testUser.instanceId}\``);
  mdLines.push(`- conversation 模式: ${sharedConversation ? `shared \`${testUser.conversationId}\`` : `per-case(base \`${testUser.conversationId}\`)`}`);
  mdLines.push(`- 通道: weixin-simulate (current main bridge)`);
  mdLines.push(`- 跑批时间: ${finishedAt.toISOString()}`);
  mdLines.push(`- run id: \`${runId}\``);
  mdLines.push(`- 等待后台任务: ${waitAsync ? `yes (${asyncWaitTimeoutMs}ms)` : "no"}`);
  mdLines.push(`- judge: ${judgeEnabled ? judgeMode : "none"}`);
  mdLines.push(`- case 总数: ${group.results.length}`);
  mdLines.push(`- 出错数: ${group.results.filter((r) => r.error).length}`);
  mdLines.push(`- verdict: pass ${counts.pass} / warn ${counts.warn} / fail ${counts.fail} / unknown ${counts.unknown}`);
  mdLines.push("");
  mdLines.push(`> 评估说明: 本报告保留该场景最新一次实际输出和结构化 judge 结果。`);
  mdLines.push(`> 人工优先看 warn / fail / unknown; pass 不代表收益或投资结论正确,只代表当前 rubric 未发现明显违背。`);
  mdLines.push("");
  mdLines.push("---");
  mdLines.push("");

  for (const r of group.results) {
  mdLines.push(`## ${r.id} [${r.scenario}]`);
  mdLines.push("");
  if (r.category) mdLines.push(`**分类**: ${r.category}`);
  if (r.judge) {
    mdLines.push(`**Judge**: ${r.judge.verdict.toUpperCase()} (${r.judge.judge_type}, ${r.judge.confidence}) — ${r.judge.reason}`);
  }
  mdLines.push(`**conversationId**: \`${r.conversation_id}\``);
  if (r.principles?.length) {
    mdLines.push("");
    mdLines.push(`**守护原则**:`);
    for (const principle of r.principles) mdLines.push(`- ${principle}`);
  }
  mdLines.push("");
  mdLines.push(`**输入**:`);
  mdLines.push(quoteMarkdown(r.user_input));
  mdLines.push("");
  mdLines.push(`**预期**:`);
  if (r.expected.must_contain?.length) {
    mdLines.push(`- 必须包含:`);
    for (const m of r.expected.must_contain) mdLines.push(`  - ${m}`);
  }
  if (r.expected.must_not_contain?.length) {
    mdLines.push(`- 不能包含:`);
    for (const m of r.expected.must_not_contain) mdLines.push(`  - ${m}`);
  }
  if (r.turns?.length > 1) {
    mdLines.push(`- 轮次: ${r.turns.length}`);
  }
  if (r.expected.style_notes) {
    mdLines.push(`- 风格: ${r.expected.style_notes}`);
  }
  if (r.judge && r.judge.verdict !== "pass") {
    mdLines.push("");
    mdLines.push(`**Judge 问题**:`);
    mdLines.push(`- 缺失 must_contain:`);
    mdLines.push(...formatJudgeIssueList(r.judge.missing_must).map((line) => `  ${line}`));
    mdLines.push(`- 命中 must_not_contain:`);
    mdLines.push(...formatJudgeIssueList(r.judge.forbidden_hits).map((line) => `  ${line}`));
    mdLines.push(`- 命中全局禁词:`);
    mdLines.push(...formatJudgeIssueList(r.judge.global_forbidden_hits).map((line) => `  ${line}`));
  }
  mdLines.push("");
  mdLines.push(`**实际输出** (${r.elapsed_ms}ms${r.error ? " / ERROR" : ""}):`);
  mdLines.push("");
  if (r.error) {
    mdLines.push(`\`\`\``);
    mdLines.push(`[ERROR] ${r.error}`);
    mdLines.push(`\`\`\``);
  } else {
    mdLines.push(quoteMarkdown(r.actual_output));
  }
  if (r.turns?.length > 1) {
    mdLines.push("");
    mdLines.push(`**逐轮输出**:`);
    for (const turn of r.turns) {
      mdLines.push("");
      mdLines.push(`Turn ${turn.index} 输入:`);
      mdLines.push(quoteMarkdown(turn.user_input));
      mdLines.push("");
      mdLines.push(quoteMarkdown(turn.actual_output));
      if (turn.async_trace?.replyTextSanitized) {
        mdLines.push("");
        mdLines.push(`Turn ${turn.index} 后台推送 (${turn.async_trace.mode}/${turn.async_trace.status}):`);
        mdLines.push("");
        mdLines.push(quoteMarkdown(turn.async_trace.replyTextSanitized));
      } else if (turn.async_trace?.artifactContent) {
        mdLines.push("");
        mdLines.push(`Turn ${turn.index} 后台产物 (${turn.async_trace.mode}/${turn.async_trace.status}) ${turn.async_trace.artifactPath}:`);
        mdLines.push("");
        mdLines.push(quoteMarkdown(turn.async_trace.artifactContent));
      }
    }
  }
  if (r.async_results?.length && r.turns?.length <= 1) {
    mdLines.push("");
    mdLines.push(`**后台输出**:`);
    for (const trace of r.async_results) {
      mdLines.push("");
      mdLines.push(`Turn ${trace.turn} 后台推送 (${trace.mode}/${trace.status}):`);
      mdLines.push("");
      if (trace.replyTextSanitized) {
        mdLines.push(quoteMarkdown(trace.replyTextSanitized));
      } else if (trace.artifactContent) {
        mdLines.push(`产物文件: \`${trace.artifactPath}\``);
        mdLines.push("");
        mdLines.push(quoteMarkdown(trace.artifactContent));
      } else if (trace.errorMessage) {
        mdLines.push(quoteMarkdown(`[${trace.status}] ${trace.errorMessage}`));
      }
    }
  }
  mdLines.push("");
  mdLines.push("---");
  mdLines.push("");
  }

  return mdLines.join("\n");
}

function buildReviewQueueMarkdown(rows) {
  const counts = verdictCounts(rows);
  const reviewRows = rows.filter(needsHumanReview);
  const mdLines = [];
  mdLines.push(`# 对话语义评估人工待审`);
  mdLines.push("");
  mdLines.push(`- run id: \`${runId}\``);
  mdLines.push(`- 跑批时间: ${finishedAt.toISOString()}`);
  mdLines.push(`- judge: ${judgeEnabled ? judgeMode : "none"}`);
  mdLines.push(`- case 总数: ${rows.length}`);
  mdLines.push(`- verdict: pass ${counts.pass} / warn ${counts.warn} / fail ${counts.fail} / unknown ${counts.unknown}`);
  mdLines.push(`- 人工待审: ${reviewRows.length}`);
  mdLines.push("");
  mdLines.push(`> 人工只需要优先处理本文件中的 warn / fail / unknown。`);
  mdLines.push(`> 如果某个失败可以程序化判断,应下沉到 L1 测试,不要长期留在人工审查队列。`);
  mdLines.push("");

  if (!reviewRows.length) {
    mdLines.push("暂无人工待审项。");
    mdLines.push("");
    return mdLines.join("\n");
  }

  for (const r of reviewRows) {
    mdLines.push(`## ${r.judge?.verdict?.toUpperCase() || "UNKNOWN"} · ${r.id}`);
    mdLines.push("");
    mdLines.push(`- 场景: \`${r.scenario}\` (${scenarioDisplayName(r.scenario)})`);
    mdLines.push(`- 分类: ${r.category || "-"}`);
    mdLines.push(`- reason: ${r.judge?.reason || "-"}`);
    mdLines.push(`- report: \`${scenarioDisplayName(r.scenario)}\``);
    mdLines.push("");
    mdLines.push(`**输入**:`);
    mdLines.push(quoteMarkdown(r.user_input || r.turns?.[0]?.user_input || ""));
    mdLines.push("");
    mdLines.push(`**问题摘要**:`);
    mdLines.push(`- 缺失 must_contain: ${r.judge?.missing_must?.length || 0}`);
    mdLines.push(`- 命中 must_not_contain: ${r.judge?.forbidden_hits?.length || 0}`);
    mdLines.push(`- 命中全局禁词: ${r.judge?.global_forbidden_hits?.length || 0}`);
    mdLines.push("");
    mdLines.push(`**实际输出预览**:`);
    mdLines.push(quoteMarkdown(String(r.actual_output || r.error || "").slice(0, 800)));
    mdLines.push("");
    mdLines.push("---");
    mdLines.push("");
  }
  return mdLines.join("\n");
}

const groups = new Map();
for (const result of results) {
  const existing = groups.get(result.scenario) ?? { scenario: result.scenario, results: [] };
  existing.results.push(result);
  groups.set(result.scenario, existing);
}

const writtenReports = [];
for (const group of groups.values()) {
  const scenarioName = scenarioDisplayName(group.scenario);
  const counts = verdictCounts(group.results);
  const basename = filenameSafeChinese(scenarioName) || filenameSafeChinese(group.scenario) || "未命名场景";
  const mdFilename = `${basename}.md`;
  const jsonFilename = `${basename}.json`;
  const reportMarkdown = buildMarkdownReport(group);
  const reportJson = JSON.stringify({
    ran_at: finishedAt.toISOString(),
    run_id: runId,
    scenario: group.scenario,
    scenario_name: scenarioName,
    suite: raw.suite,
    test_user: testUser,
    quality_gates: raw.quality_gates,
    judge: {
      enabled: judgeEnabled,
      mode: judgeEnabled ? judgeMode : "none",
      verdict_counts: counts,
      review_count: group.results.filter(needsHumanReview).length,
    },
    results: group.results,
  }, null, 2);
  writeFileSync(resolve(outDir, mdFilename), reportMarkdown);
  writeFileSync(resolve(outDir, jsonFilename), reportJson);
  writtenReports.push({ scenario: group.scenario, mdFilename, jsonFilename });
}

const totalVerdictCounts = verdictCounts(results);
const reviewQueue = results.filter(needsHumanReview);
const reviewQueueJson = {
  ran_at: finishedAt.toISOString(),
  run_id: runId,
  suite: raw.suite,
  test_user: testUser,
  judge: {
    enabled: judgeEnabled,
    mode: judgeEnabled ? judgeMode : "none",
    verdict_counts: totalVerdictCounts,
    review_count: reviewQueue.length,
  },
  review_queue: reviewQueue.map((row) => ({
    id: row.id,
    scenario: row.scenario,
    scenario_name: scenarioDisplayName(row.scenario),
    category: row.category,
    conversation_id: row.conversation_id,
    user_input: row.user_input || row.turns?.[0]?.user_input || "",
    actual_output_preview: String(row.actual_output || row.error || "").slice(0, 1200),
    judge: row.judge,
    elapsed_ms: row.elapsed_ms,
    ran_at: row.ran_at,
  })),
  reports: writtenReports,
};
writeFileSync(resolve(outDir, "_review-queue.md"), buildReviewQueueMarkdown(results));
writeFileSync(resolve(outDir, "_review-queue.json"), JSON.stringify(reviewQueueJson, null, 2));

console.log("");
console.log(`=== 完成 ===`);
console.log(`verdict: pass ${totalVerdictCounts.pass} / warn ${totalVerdictCounts.warn} / fail ${totalVerdictCounts.fail} / unknown ${totalVerdictCounts.unknown}`);
console.log(`人工待审: ${reviewQueue.length} -> eval-reports/_review-queue.md`);
for (const report of writtenReports) {
  console.log(`${scenarioDisplayName(report.scenario)}: eval-reports/${report.mdFilename}`);
}
