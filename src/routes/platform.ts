import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { and, count, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { Document, isMap, isSeq, parseDocument } from "yaml";
import { renderPlatformPage } from "../admin/platform-page.js";
import { db } from "../db/index.js";
import { aiInstances, alertEvents, alertRules, channelIdentities, channelIdentityInstances, codexAcpTraces, pushJobs, scheduledTaskRuns, users } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { createInvestAgentInstance, deleteInvestAgentInstance, getProjectRuntimeContext, listProjectRuntimeContexts, type AiProjectRuntimeContext } from "../platform/project-registry.js";
import { WeixinMobileManager } from "../channels/weixin-mobile.js";
import { config } from "../lib/config.js";
import { ensureWorkspace, resolveWorkspacePath } from "../lib/workspace.js";
import { planBackend, portfolioBackend, watchlistBackend } from "../lib/data-backend.js";
import { disposeAcpForWorkspace, ensureHermesRuntimeForWorkspace } from "../acp/stdio-agent.js";
import { loadCodexWorkspaceUsageSummary, type CodexUsageGroupBy } from "../services/codex-usage.js";
import { DEFAULT_INSTANCE_ID } from "../lib/user-context.js";
import { marketHealth } from "../services/market-data.js";
import { getAlertInterval } from "../scheduler/index.js";

const projectWeixinManagers = new Map<string, WeixinMobileManager>();
const goldenCasesPath = path.resolve(process.cwd(), "tests/golden/conversation/cases.yaml");
const evalReportsDir = path.resolve(process.cwd(), "eval-reports");
const reviewQueueJsonPath = path.join(evalReportsDir, "_review-queue.json");
const reviewQueueMarkdownPath = path.join(evalReportsDir, "_review-queue.md");
const reviewDecisionsPath = path.join(evalReportsDir, "_review-decisions.json");
const candidateCasesPath = path.join(evalReportsDir, "_candidate-cases.json");

function readGoldenDocument() {
  const source = readFileSync(goldenCasesPath, "utf-8");
  const doc = parseDocument(source);
  if (doc.errors.length) {
    throw new Error(`黄金数据集 YAML 解析失败: ${doc.errors[0]?.message}`);
  }
  return doc;
}

function caseNodeToYaml(node: unknown) {
  const value = isMap(node) ? node.toJSON() : node;
  return String(new Document(value));
}

function goldenCaseSummary(node: unknown) {
  if (!isMap(node)) return null;
  const expected = node.get("expected", true);
  const turns = node.get("turns", true);
  const turnCount = isSeq(turns) ? turns.items.length : 1;
  const expectedMap = isMap(expected) ? expected : null;
  const mustContain = expectedMap?.get("must_contain", true);
  const mustNotContain = expectedMap?.get("must_not_contain", true);
  return {
    id: String(node.get("id") || ""),
    category: String(node.get("category") || ""),
    reviewTier: String(node.get("review_tier") || ""),
    priority: String(node.get("priority") || ""),
    scenario: String(node.get("scenario") || ""),
    tags: node.get("tags") || [],
    principles: node.get("principles") || [],
    userInput: String(node.get("user_input") || ""),
    turnCount,
    mustContainCount: isSeq(mustContain) ? mustContain.items.length : 0,
    mustNotContainCount: isSeq(mustNotContain) ? mustNotContain.items.length : 0,
    styleNotes: expectedMap ? String(expectedMap.get("style_notes") || "") : "",
    rawYaml: caseNodeToYaml(node),
  };
}

function loadGoldenCases() {
  const doc = readGoldenDocument();
  const casesNode = doc.getIn(["cases"], true);
  if (!isSeq(casesNode)) throw new Error("黄金数据集缺少 cases 数组");
  const cases = casesNode.items.map(goldenCaseSummary).filter(Boolean);
  const categories = new Map<string, number>();
  const priorities = new Map<string, number>();
  const reviewTiers = new Map<string, number>();
  const scenarios = new Map<string, number>();
  for (const item of cases) {
    if (!item) continue;
    categories.set(item.category, (categories.get(item.category) || 0) + 1);
    priorities.set(item.priority, (priorities.get(item.priority) || 0) + 1);
    reviewTiers.set(item.reviewTier, (reviewTiers.get(item.reviewTier) || 0) + 1);
    scenarios.set(item.scenario, (scenarios.get(item.scenario) || 0) + 1);
  }
  return {
    suite: doc.get("suite") || {},
    qualityGates: doc.get("quality_gates") || {},
    sourcePath: goldenCasesPath,
    cases,
    stats: {
      total: cases.length,
      categories: Object.fromEntries([...categories.entries()].sort()),
      priorities: Object.fromEntries([...priorities.entries()].sort()),
      reviewTiers: Object.fromEntries([...reviewTiers.entries()].sort()),
      scenarioCount: scenarios.size,
    },
  };
}

function loadEvaluationReviewQueue() {
  const decisions = loadEvaluationReviewDecisions();
  const candidates = loadEvaluationCandidateCases();
  if (!existsSync(reviewQueueJsonPath)) {
    return {
      exists: false,
      sourcePath: reviewQueueJsonPath,
      markdownPath: reviewQueueMarkdownPath,
      markdown: existsSync(reviewQueueMarkdownPath) ? readFileSync(reviewQueueMarkdownPath, "utf-8") : "",
      updatedAt: null,
      ranAt: null,
      runId: null,
      suite: null,
      testUser: null,
      judge: {
        enabled: false,
        mode: "none",
        verdict_counts: { pass: 0, warn: 0, fail: 0, unknown: 0, none: 0 },
        review_count: 0,
      },
      reviewQueue: [],
      reports: [],
      decisions,
      candidates,
    };
  }
  const parsed = JSON.parse(readFileSync(reviewQueueJsonPath, "utf-8"));
  return {
    exists: true,
    sourcePath: reviewQueueJsonPath,
    markdownPath: reviewQueueMarkdownPath,
    markdown: existsSync(reviewQueueMarkdownPath) ? readFileSync(reviewQueueMarkdownPath, "utf-8") : "",
    updatedAt: new Date(statSync(reviewQueueJsonPath).mtimeMs).toISOString(),
    ranAt: parsed.ran_at || null,
    runId: parsed.run_id || null,
    suite: parsed.suite || null,
    testUser: parsed.test_user || null,
    judge: parsed.judge || {
      enabled: false,
      mode: "none",
      verdict_counts: { pass: 0, warn: 0, fail: 0, unknown: 0, none: 0 },
      review_count: 0,
    },
    reviewQueue: Array.isArray(parsed.review_queue) ? parsed.review_queue : [],
    reports: Array.isArray(parsed.reports) ? parsed.reports : [],
    decisions,
    candidates,
  };
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch (error) {
    logger.warn(`Platform eval json read failed file=${filePath}: ${(error as Error).message}`);
    return fallback;
  }
}

function writeJsonFile(filePath: string, data: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function loadEvaluationReviewDecisions() {
  const data = readJsonFile<{ decisions?: unknown[] }>(reviewDecisionsPath, { decisions: [] });
  return Array.isArray(data.decisions) ? data.decisions : [];
}

function saveEvaluationReviewDecision(input: {
  caseId?: string;
  action?: string;
  finalVerdict?: string;
  note?: string;
  sourceRunId?: string;
}) {
  const caseId = String(input.caseId || "").trim();
  if (!caseId) throw new Error("caseId 必填");
  const allowedActions = new Set(["accept_judge", "override_pass", "override_fail", "needs_fix", "move_to_l1", "update_case"]);
  const action = allowedActions.has(String(input.action)) ? String(input.action) : "";
  if (!action) throw new Error("action 无效");
  const now = new Date().toISOString();
  const current = loadEvaluationReviewDecisions();
  const next = [
    {
      id: `${caseId}:${now}`,
      caseId,
      action,
      finalVerdict: input.finalVerdict ? String(input.finalVerdict) : null,
      note: input.note ? String(input.note).slice(0, 2000) : "",
      sourceRunId: input.sourceRunId ? String(input.sourceRunId) : null,
      decidedAt: now,
    },
    ...current,
  ].slice(0, 500);
  writeJsonFile(reviewDecisionsPath, { updatedAt: now, decisions: next });
  return next[0];
}

function loadEvaluationCandidateCases() {
  const data = readJsonFile<{ candidates?: unknown[] }>(candidateCasesPath, { candidates: [] });
  return Array.isArray(data.candidates) ? data.candidates : [];
}

function saveEvaluationCandidateCase(input: {
  source?: string;
  sourceId?: string;
  userInput?: string;
  actualOutput?: string;
  scenario?: string;
  priority?: string;
  note?: string;
}) {
  const userInput = String(input.userInput || "").trim();
  if (!userInput) throw new Error("userInput 必填");
  const now = new Date().toISOString();
  const idSeed = `${input.source || "manual"}:${input.sourceId || ""}:${userInput}:${now}`;
  const candidate = {
    id: `candidate-${createHash("sha256").update(idSeed).digest("hex").slice(0, 10)}`,
    source: input.source || "manual",
    sourceId: input.sourceId || null,
    scenario: input.scenario || "candidate_from_audit",
    priority: input.priority || "P1",
    reviewTier: "archived_candidate",
    userInput,
    actualOutput: input.actualOutput ? String(input.actualOutput).slice(0, 4000) : "",
    note: input.note ? String(input.note).slice(0, 2000) : "",
    createdAt: now,
  };
  const current = loadEvaluationCandidateCases();
  const next = [candidate, ...current].slice(0, 500);
  writeJsonFile(candidateCasesPath, { updatedAt: now, candidates: next });
  return candidate;
}

function updateGoldenCase(input: { id: string; rawYaml: string }) {
  const nextCaseDoc = parseDocument(input.rawYaml);
  if (nextCaseDoc.errors.length || !isMap(nextCaseDoc.contents)) {
    throw new Error(nextCaseDoc.errors[0]?.message || "case YAML 必须是对象");
  }
  const nextId = String(nextCaseDoc.contents.get("id") || "").trim();
  if (!nextId) throw new Error("case YAML 缺少 id");
  if (nextId !== input.id) throw new Error("暂不支持通过编辑重命名 case id");

  const doc = readGoldenDocument();
  const casesNode = doc.getIn(["cases"], true);
  if (!isSeq(casesNode)) throw new Error("黄金数据集缺少 cases 数组");
  const index = casesNode.items.findIndex((item) => isMap(item) && String(item.get("id") || "") === input.id);
  if (index < 0) throw new Error("未找到 case");
  casesNode.items[index] = nextCaseDoc.contents;
  writeFileSync(goldenCasesPath, String(doc), "utf-8");
  return loadGoldenCases();
}

function getGoldenCaseById(id: string) {
  const doc = readGoldenDocument();
  const casesNode = doc.getIn(["cases"], true);
  if (!isSeq(casesNode)) throw new Error("黄金数据集缺少 cases 数组");
  const node = casesNode.items.find((item) => isMap(item) && String(item.get("id") || "") === id);
  if (!node || !isMap(node)) throw new Error("未找到 case");
  return node;
}

function goldenCaseUserInput(id: string) {
  const node = getGoldenCaseById(id);
  const userInput = String(node.get("user_input") || "").trim();
  if (!userInput) throw new Error("该 case 缺少 user_input，暂不支持多轮 turns 直接运行");
  return userInput;
}

function readSourceQualityReports(limit = 14) {
  const dir = config.runtimeData.sourceQualityDir;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort()
    .reverse()
    .slice(0, Math.max(1, Math.min(limit, 60)))
    .map((name) => {
      try {
        return JSON.parse(readFileSync(path.join(dir, name), "utf-8"));
      } catch (error) {
        logger.warn(`source-quality report read failed file=${name}: ${(error as Error).message}`);
        return null;
      }
    })
    .filter(Boolean);
}

function readSourceQualityAlerts(limit = 40) {
  const dir = config.runtimeData.sourceQualityDir;
  if (!existsSync(dir)) return [];
  const rows: unknown[] = [];
  const files = readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .reverse();
  for (const name of files) {
    try {
      const lines = readFileSync(path.join(dir, name), "utf-8")
        .split("\n")
        .filter((line) => line.trim());
      for (const line of lines.reverse()) {
        rows.push(JSON.parse(line));
        if (rows.length >= limit) return rows;
      }
    } catch (error) {
      logger.warn(`source-quality alerts read failed file=${name}: ${(error as Error).message}`);
    }
  }
  return rows;
}

function projectWeixinManager(project: AiProjectRuntimeContext) {
  const existing = projectWeixinManagers.get(project.instanceId);
  if (existing) {
    const state = existing.getState();
    if (state.backend === project.backend) return existing;
    try {
      existing.stop();
    } catch (error) {
      logger.warn(`Platform 项目微信监听重建失败: ${project.instanceId} ${(error as Error).message}`);
    }
    projectWeixinManagers.delete(project.instanceId);
  }
  const manager = new WeixinMobileManager({
    backend: project.backend,
    stateDir: path.join(config.weixin.stateDir, "project-weixin", project.instanceId.replace(/[^a-zA-Z0-9_-]/g, "-")),
    label: `${project.name}微信`,
    projectBinding: {
      projectId: project.legacyProjectId,
      instanceId: project.instanceId,
      ownerUserId: project.ownerUserId,
      ownerDisplayName: project.name,
      sharedUsers: project.projectType !== "invest-agent",
    },
  });
  projectWeixinManagers.set(project.instanceId, manager);
  return manager;
}

export async function projectWeixinManagerForInstance(instanceId: string) {
  const project = await getProjectRuntimeContext(instanceId);
  return projectWeixinManager(project);
}

async function auditUsers() {
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, status: users.status, updatedAt: users.updatedAt })
    .from(users)
    .innerJoin(aiInstances, eq(aiInstances.ownerUserId, users.id))
    .where(eq(aiInstances.status, "active"))
    .orderBy(desc(users.updatedAt))
    .limit(200);
  return rows;
}

type AuditScope = "all" | "conversation" | "push";

async function loadAuditTimeline(input: { userId?: string; instanceId?: string; limit?: number; scope?: AuditScope }) {
  const limit = Math.max(1, Math.min(Number(input.limit || 40), 120));
  const scope = input.scope || "all";
  const conditions = [];
  if (input.userId) conditions.push(eq(codexAcpTraces.userId, input.userId));
  if (input.instanceId) conditions.push(eq(codexAcpTraces.instanceId, input.instanceId));
  if (scope === "conversation") conditions.push(eq(codexAcpTraces.channel, "weixin-mobile"));
  if (scope === "push") conditions.push(eq(codexAcpTraces.channel, "scheduler"));
  const pushConditions = [];
  if (input.userId) pushConditions.push(eq(pushJobs.userId, input.userId));
  if (input.instanceId) pushConditions.push(eq(pushJobs.instanceId, input.instanceId));
  const taskConditions = [];
  if (input.userId) taskConditions.push(eq(scheduledTaskRuns.userId, input.userId));
  if (input.instanceId) taskConditions.push(eq(scheduledTaskRuns.instanceId, input.instanceId));

  const traceRows = await db
    .select({
      kind: sql<string>`'trace'`.as("kind"),
      id: codexAcpTraces.id,
      userId: codexAcpTraces.userId,
      instanceId: codexAcpTraces.instanceId,
      channel: codexAcpTraces.channel,
      mode: codexAcpTraces.mode,
      status: codexAcpTraces.status,
      conversationId: codexAcpTraces.conversationId,
      messageId: codexAcpTraces.messageId,
      userText: codexAcpTraces.userText,
      promptText: codexAcpTraces.promptText,
      replyTextRaw: codexAcpTraces.replyTextRaw,
      replyTextSanitized: codexAcpTraces.replyTextSanitized,
      errorMessage: codexAcpTraces.errorMessage,
      elapsedMs: codexAcpTraces.elapsedMs,
      inputTokens: codexAcpTraces.inputTokens,
      outputTokens: codexAcpTraces.outputTokens,
      thoughtTokens: codexAcpTraces.thoughtTokens,
      cachedReadTokens: codexAcpTraces.cachedReadTokens,
      cachedWriteTokens: codexAcpTraces.cachedWriteTokens,
      totalTokens: codexAcpTraces.totalTokens,
      contextWindowUsed: codexAcpTraces.contextWindowUsed,
      contextWindowSize: codexAcpTraces.contextWindowSize,
      costAmount: codexAcpTraces.costAmount,
      costCurrency: codexAcpTraces.costCurrency,
      usageSource: codexAcpTraces.usageSource,
      reviewContextSummary: codexAcpTraces.reviewContextSummary,
      sandboxTokenId: codexAcpTraces.sandboxTokenId,
      createdAt: codexAcpTraces.createdAt,
    })
    .from(codexAcpTraces)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(codexAcpTraces.createdAt))
    .limit(limit);

  const pushRows = scope === "conversation" ? [] : await db
    .select({
      kind: sql<string>`'push'`.as("kind"),
      id: pushJobs.id,
      userId: pushJobs.userId,
      instanceId: pushJobs.instanceId,
      channel: pushJobs.channel,
      mode: pushJobs.source,
      status: pushJobs.status,
      conversationId: sql<string | null>`NULL`.as("conversationId"),
      messageId: sql<string | null>`NULL`.as("messageId"),
      userText: pushJobs.message,
      promptText: sql<string | null>`NULL`.as("promptText"),
      replyTextRaw: pushJobs.message,
      replyTextSanitized: pushJobs.message,
      errorMessage: pushJobs.lastError,
      elapsedMs: sql<number | null>`NULL`.as("elapsedMs"),
      inputTokens: sql<number | null>`NULL`.as("inputTokens"),
      outputTokens: sql<number | null>`NULL`.as("outputTokens"),
      thoughtTokens: sql<number | null>`NULL`.as("thoughtTokens"),
      cachedReadTokens: sql<number | null>`NULL`.as("cachedReadTokens"),
      cachedWriteTokens: sql<number | null>`NULL`.as("cachedWriteTokens"),
      totalTokens: sql<number | null>`NULL`.as("totalTokens"),
      contextWindowUsed: sql<number | null>`NULL`.as("contextWindowUsed"),
      contextWindowSize: sql<number | null>`NULL`.as("contextWindowSize"),
      costAmount: sql<number | null>`NULL`.as("costAmount"),
      costCurrency: sql<string | null>`NULL`.as("costCurrency"),
      usageSource: sql<string | null>`NULL`.as("usageSource"),
      reviewContextSummary: sql<string | null>`NULL`.as("reviewContextSummary"),
      sandboxTokenId: sql<string | null>`NULL`.as("sandboxTokenId"),
      createdAt: pushJobs.createdAt,
      updatedAt: pushJobs.updatedAt,
      sentAt: pushJobs.sentAt,
    })
    .from(pushJobs)
    .where(pushConditions.length > 0 ? and(...pushConditions) : undefined)
    .orderBy(desc(pushJobs.createdAt))
    .limit(limit);

  const taskRows = scope === "conversation" ? [] : await db
    .select({
      kind: sql<string>`'task'`.as("kind"),
      id: scheduledTaskRuns.taskKey,
      userId: scheduledTaskRuns.userId,
      instanceId: scheduledTaskRuns.instanceId,
      channel: sql<string | null>`NULL`.as("channel"),
      mode: scheduledTaskRuns.taskType,
      status: scheduledTaskRuns.status,
      conversationId: sql<string | null>`NULL`.as("conversationId"),
      messageId: sql<string | null>`NULL`.as("messageId"),
      userText: scheduledTaskRuns.taskKey,
      promptText: sql<string | null>`NULL`.as("promptText"),
      replyTextRaw: sql<string | null>`NULL`.as("replyTextRaw"),
      replyTextSanitized: sql<string | null>`NULL`.as("replyTextSanitized"),
      errorMessage: scheduledTaskRuns.errorMessage,
      elapsedMs: sql<number | null>`NULL`.as("elapsedMs"),
      inputTokens: sql<number | null>`NULL`.as("inputTokens"),
      outputTokens: sql<number | null>`NULL`.as("outputTokens"),
      thoughtTokens: sql<number | null>`NULL`.as("thoughtTokens"),
      cachedReadTokens: sql<number | null>`NULL`.as("cachedReadTokens"),
      cachedWriteTokens: sql<number | null>`NULL`.as("cachedWriteTokens"),
      totalTokens: sql<number | null>`NULL`.as("totalTokens"),
      contextWindowUsed: sql<number | null>`NULL`.as("contextWindowUsed"),
      contextWindowSize: sql<number | null>`NULL`.as("contextWindowSize"),
      costAmount: sql<number | null>`NULL`.as("costAmount"),
      costCurrency: sql<string | null>`NULL`.as("costCurrency"),
      usageSource: sql<string | null>`NULL`.as("usageSource"),
      reviewContextSummary: sql<string | null>`NULL`.as("reviewContextSummary"),
      sandboxTokenId: sql<string | null>`NULL`.as("sandboxTokenId"),
      createdAt: scheduledTaskRuns.createdAt,
      finishedAt: scheduledTaskRuns.finishedAt,
      pushJobId: scheduledTaskRuns.pushJobId,
    })
    .from(scheduledTaskRuns)
    .where(taskConditions.length > 0 ? and(...taskConditions) : undefined)
    .orderBy(desc(scheduledTaskRuns.createdAt))
    .limit(limit);

  const combined = [
    ...(scope === "push" ? [] : traceRows),
    ...pushRows,
    ...(scope === "push" ? traceRows : []),
    ...taskRows,
  ]
    .sort((a, b) => String((b as any).createdAt).localeCompare(String((a as any).createdAt)))
    .slice(0, limit);

  if (scope === "push") {
    return { items: aggregatePushRuns({ traceRows, pushRows, taskRows, limit }), limit, scope };
  }

  return { items: combined, limit, scope };
}

async function loadRuleAlertAudit(input: { userId?: string; instanceId?: string; limit?: number }) {
  const limit = Math.max(1, Math.min(Number(input.limit || 40), 120));
  const taskConditions = [eq(scheduledTaskRuns.taskType, "rule-alert-check")];
  const eventConditions = [];
  const ruleConditions = [];
  if (input.userId) {
    taskConditions.push(eq(scheduledTaskRuns.userId, input.userId));
    eventConditions.push(eq(alertEvents.userId, input.userId));
    ruleConditions.push(eq(alertRules.userId, input.userId));
  }
  if (input.instanceId) {
    taskConditions.push(eq(scheduledTaskRuns.instanceId, input.instanceId));
    eventConditions.push(eq(alertEvents.instanceId, input.instanceId));
    ruleConditions.push(eq(alertRules.instanceId, input.instanceId));
  }

  const [taskRows, eventRows, ruleRows, intervalMinutes] = await Promise.all([
    db
      .select()
      .from(scheduledTaskRuns)
      .where(and(...taskConditions))
      .orderBy(desc(scheduledTaskRuns.createdAt))
      .limit(limit),
    db
      .select()
      .from(alertEvents)
      .where(eventConditions.length > 0 ? and(...eventConditions) : undefined)
      .orderBy(desc(alertEvents.createdAt))
      .limit(limit),
    db
      .select()
      .from(alertRules)
      .where(ruleConditions.length > 0 ? and(...ruleConditions) : undefined)
      .orderBy(desc(alertRules.updatedAt))
      .limit(200),
    getAlertInterval(),
  ]);

  const latestTask = taskRows[0] || null;
  const latestEvent = eventRows[0] || null;
  const today = new Date().toISOString().slice(0, 10);
  const todayTasks = taskRows.filter((item) => String(item.scheduledFor || item.createdAt).startsWith(today));
  const todayEvents = eventRows.filter((item) => item.eventDate === today);

  return {
    intervalMinutes,
    summary: {
      enabledRules: ruleRows.filter((item) => item.enabled).length,
      rules: ruleRows.length,
      latestRunAt: latestTask?.createdAt || null,
      latestRunStatus: latestTask?.status || null,
      latestEventAt: latestEvent?.createdAt || null,
      todayRuns: todayTasks.length,
      todayHits: todayEvents.length,
      todayErrors: todayTasks.filter((item) => item.status === "error").length,
    },
    tasks: taskRows,
    events: eventRows,
    rules: ruleRows,
    limit,
  };
}

function aggregatePushRuns(input: { traceRows: any[]; pushRows: any[]; taskRows: any[]; limit: number }) {
  const traces = [...input.traceRows];
  const pushes = [...input.pushRows];
  const pushById = new Map(pushes.map((item) => [item.id, item]));
  const usedTraceIds = new Set<string>();
  const usedPushIds = new Set<string>();

  const runs = input.taskRows.map((task) => {
    const trace = nearestTrace(task.finishedAt || task.createdAt, traces, usedTraceIds);
    if (trace) usedTraceIds.add(String(trace.id));
    const push = task.pushJobId ? pushById.get(task.pushJobId) : null;
    if (push) usedPushIds.add(String(push.id));
    return buildPushRun({ task, trace, push });
  });

  for (const trace of traces) {
    if (usedTraceIds.has(String(trace.id))) continue;
    const push = nearestPush(trace.createdAt, pushes, usedPushIds);
    if (push) usedPushIds.add(String(push.id));
    runs.push(buildPushRun({ trace, push }));
  }

  for (const push of pushes) {
    if (usedPushIds.has(String(push.id))) continue;
    runs.push(buildPushRun({ push }));
  }

  return runs
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, input.limit);
}

function buildPushRun(input: { task?: any; trace?: any; push?: any }) {
  const { task, trace, push } = input;
  const status = push?.status || task?.status || trace?.status || "unknown";
  return {
    kind: "push_run",
    id: task?.id || trace?.id || push?.id,
    userId: task?.userId || trace?.userId || push?.userId,
    instanceId: task?.instanceId || trace?.instanceId || push?.instanceId,
    channel: push?.channel || trace?.channel || null,
    mode: task?.mode || trace?.mode || push?.mode || null,
    status,
    conversationId: trace?.conversationId || null,
    messageId: trace?.messageId || null,
    userText: trace?.userText || task?.userText || push?.userText || null,
    promptText: trace?.promptText || null,
    replyTextRaw: trace?.replyTextRaw || null,
    replyTextSanitized: trace?.replyTextSanitized || null,
    errorMessage: task?.errorMessage || trace?.errorMessage || push?.errorMessage || null,
    elapsedMs: trace?.elapsedMs || null,
    inputTokens: trace?.inputTokens || null,
    outputTokens: trace?.outputTokens || null,
    thoughtTokens: trace?.thoughtTokens || null,
    cachedReadTokens: trace?.cachedReadTokens || null,
    cachedWriteTokens: trace?.cachedWriteTokens || null,
    totalTokens: trace?.totalTokens || null,
    contextWindowUsed: trace?.contextWindowUsed || null,
    contextWindowSize: trace?.contextWindowSize || null,
    costAmount: trace?.costAmount || null,
    costCurrency: trace?.costCurrency || null,
    usageSource: trace?.usageSource || null,
    reviewContextSummary: trace?.reviewContextSummary || null,
    sandboxTokenId: trace?.sandboxTokenId || null,
    createdAt: task?.createdAt || trace?.createdAt || push?.createdAt,
    finishedAt: task?.finishedAt || null,
    pushJobId: task?.pushJobId || push?.id || null,
    task,
    trace,
    push,
  };
}

function nearestTrace(anchor: string | null | undefined, traces: any[], used: Set<string>) {
  return nearestByTime(anchor, traces.filter((item) => !used.has(String(item.id))), 5 * 60 * 1000);
}

function nearestPush(anchor: string | null | undefined, pushes: any[], used: Set<string>) {
  return nearestByTime(anchor, pushes.filter((item) => !used.has(String(item.id))), 5 * 1000);
}

function nearestByTime(anchor: string | null | undefined, items: any[], maxDeltaMs: number) {
  const time = Date.parse(String(anchor || ""));
  if (!Number.isFinite(time)) return null;
  let best: any = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const itemTime = Date.parse(String(item.createdAt || ""));
    if (!Number.isFinite(itemTime)) continue;
    const delta = Math.abs(itemTime - time);
    if (delta < bestDelta && delta <= maxDeltaMs) {
      best = item;
      bestDelta = delta;
    }
  }
  return best;
}

export async function autoStartPlatformWeixinListeners() {
  if (process.env.PLATFORM_WEIXIN_AUTO_START === "false") {
    logger.info("Platform 项目微信监听自动恢复已关闭");
    return;
  }

  const projects = await listProjectRuntimeContexts();
  let startedProjects = 0;
  for (const project of projects) {
    const manager = projectWeixinManager(project);
    const state = manager.getState();
    if (!state.accounts?.length) {
      continue;
    }
    try {
      await manager.ensureListenerStarted();
      startedProjects += 1;
      logger.info(`Platform 项目微信监听已恢复: ${project.instanceId} accounts=${state.accounts.length}`);
    } catch (error) {
      logger.warn(`Platform 项目微信监听恢复失败: ${project.instanceId} ${(error as Error).message}`);
    }
  }
  logger.info(`Platform 项目微信监听自动恢复完成: projects=${startedProjects}`);
}

export function stopPlatformWeixinListeners() {
  for (const [instanceId, manager] of projectWeixinManagers.entries()) {
    try {
      manager.stop();
    } catch (error) {
      logger.warn(`Platform 项目微信监听停止失败: ${instanceId} ${(error as Error).message}`);
    }
  }
}

function deletePlatformWeixinManager(instanceId: string) {
  const manager = projectWeixinManagers.get(instanceId);
  if (!manager) return;
  try {
    manager.stop();
  } catch (error) {
    logger.warn(`Platform 项目微信监听停止失败: ${instanceId} ${(error as Error).message}`);
  }
  projectWeixinManagers.delete(instanceId);
}

function stableSuffix(value?: string | null) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 10);
}

async function safePrivateAssetCount(label: string, project: AiProjectRuntimeContext, loader: () => Promise<unknown[]>): Promise<number> {
  try {
    return (await loader()).length;
  } catch (error) {
    logger.warn(`Platform private asset count skipped label=${label} user=${project.ownerUserId} instance=${project.instanceId}: ${(error as Error).message}`);
    return 0;
  }
}

async function channelBindingsForProject(project: AiProjectRuntimeContext) {
  const bindings = await db
    .select({
      id: channelIdentityInstances.id,
      channelIdentityId: channelIdentityInstances.channelIdentityId,
      userId: channelIdentities.userId,
      userDisplayName: users.displayName,
      channel: channelIdentities.channel,
      backend: channelIdentities.backend,
      externalAccountId: channelIdentities.externalAccountId,
      externalUserId: channelIdentities.externalUserId,
      isDefault: channelIdentityInstances.isDefault,
      updatedAt: channelIdentities.updatedAt,
    })
    .from(channelIdentityInstances)
    .innerJoin(channelIdentities, eq(channelIdentityInstances.channelIdentityId, channelIdentities.id))
    .leftJoin(users, eq(channelIdentities.userId, users.id))
    .where(eq(channelIdentityInstances.instanceId, project.instanceId))
    .orderBy(desc(channelIdentities.updatedAt));

  return bindings.map((binding) => ({
    id: binding.id,
    channelIdentityId: binding.channelIdentityId,
    userId: binding.userId,
    userDisplayName: binding.userDisplayName,
    channel: binding.channel,
    backend: binding.backend,
    externalAccountId: binding.externalAccountId,
    externalUserIdSuffix: stableSuffix(binding.externalUserId),
    isDefault: binding.isDefault,
    updatedAt: binding.updatedAt,
  }));
}

async function summarizeInstance(project: AiProjectRuntimeContext) {
  const [
    ownerRows,
    channelBindings,
    traceRows,
    recentTraceRows,
    holdingRows,
    watchlistRows,
    planRows,
    alertRuleRows,
  ] = await Promise.all([
    db.select({ id: users.id, displayName: users.displayName, status: users.status }).from(users).where(eq(users.id, project.ownerUserId)).limit(1),
    channelBindingsForProject(project),
    db.select({ count: count() }).from(codexAcpTraces).where(eq(codexAcpTraces.instanceId, project.instanceId)),
    db
      .select({
        id: codexAcpTraces.id,
        channel: codexAcpTraces.channel,
        mode: codexAcpTraces.mode,
        status: codexAcpTraces.status,
        userText: codexAcpTraces.userText,
        elapsedMs: codexAcpTraces.elapsedMs,
        createdAt: codexAcpTraces.createdAt,
      })
      .from(codexAcpTraces)
      .where(eq(codexAcpTraces.instanceId, project.instanceId))
      .orderBy(desc(codexAcpTraces.createdAt))
      .limit(5),
    safePrivateAssetCount("portfolio", project, () => portfolioBackend.listActive(project.ownerUserId, project.instanceId)),
    safePrivateAssetCount("watchlist", project, () => watchlistBackend.list(project.ownerUserId, project.instanceId)),
    safePrivateAssetCount("plan", project, () => planBackend.list(project.ownerUserId, project.instanceId)),
    db.select({ count: count() }).from(alertRules).where(and(eq(alertRules.userId, project.ownerUserId), eq(alertRules.instanceId, project.instanceId))),
  ]);

  const owner = ownerRows[0] || {
    id: project.ownerUserId,
    displayName: project.ownerUserId,
    status: "unknown",
  };
  const workspacePath = resolveWorkspacePath(project.ownerUserId);
  return {
    projectId: project.legacyProjectId,
    aiProjectId: project.projectId,
    instanceId: project.instanceId,
    name: project.name,
    projectType: project.projectType,
    owner,
    backend: project.backend,
    skillBundleId: project.skillBundleId,
    status: project.status,
    dashboardType: project.dashboardType,
    permissions: project.permissions,
    resourceTypes: project.resourceTypes,
    allowedTools: project.allowedTools,
    config: project.config,
    workspace: {
      path: workspacePath,
      exists: existsSync(workspacePath),
      identity: {
        userId: project.ownerUserId,
        tenantId: project.ownerUserId,
        projectId: project.projectId,
        instanceId: project.instanceId,
      },
    },
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    channelBindingCount: channelBindings.length,
    channelBindings,
    traceCount: traceRows[0]?.count ?? 0,
    recentTraces: recentTraceRows,
    holdingCount: holdingRows,
    watchlistCount: watchlistRows,
    planCount: planRows,
    alertRuleCount: alertRuleRows[0]?.count ?? 0,
  };
}

export function registerPlatformRoutes(app: FastifyInstance) {
  const safe = (handler: (request: any, reply: any) => Promise<any>) =>
    async (request: any, reply: any) => {
      try {
        return await handler(request, reply);
      } catch (error) {
        logger.error("Platform API 操作失败:", error);
        return reply.status(500).send({
          ok: false,
          error: error instanceof Error ? error.message : "平台接口操作失败",
        });
      }
    };

  app.get("/platform", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(renderPlatformPage());
  });

  app.get("/api/platform/instances", safe(async () => {
    const projects = await listProjectRuntimeContexts();
    const instances = await Promise.all(projects.map(summarizeInstance));
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      count: instances.length,
      instances,
    };
  }));

  app.get("/api/platform/golden-cases", safe(async () => {
    const data = loadGoldenCases();
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      ...data,
    };
  }));

  app.get("/api/platform/evaluation/review-queue", safe(async () => {
    const data = loadEvaluationReviewQueue();
    return {
      ok: true,
      ...data,
      loadedAt: new Date().toISOString(),
    };
  }));

  app.post<{ Body: { caseId?: string; action?: string; finalVerdict?: string; note?: string; sourceRunId?: string } }>(
    "/api/platform/evaluation/review-decisions",
    safe(async (request) => {
      const decision = saveEvaluationReviewDecision(request.body || {});
      return {
        ok: true,
        decision,
        decisions: loadEvaluationReviewDecisions(),
        updatedAt: new Date().toISOString(),
      };
    }),
  );

  app.post<{ Body: { source?: string; sourceId?: string; userInput?: string; actualOutput?: string; scenario?: string; priority?: string; note?: string } }>(
    "/api/platform/evaluation/candidates",
    safe(async (request) => {
      const candidate = saveEvaluationCandidateCase(request.body || {});
      return {
        ok: true,
        candidate,
        candidates: loadEvaluationCandidateCases(),
        updatedAt: new Date().toISOString(),
      };
    }),
  );

  app.put<{ Body: { id?: string; rawYaml?: string } }>("/api/platform/golden-cases", safe(async (request, reply) => {
    const id = request.body?.id?.trim();
    const rawYaml = request.body?.rawYaml;
    if (!id) return reply.status(400).send({ ok: false, error: "id 必填" });
    if (!rawYaml || typeof rawYaml !== "string") return reply.status(400).send({ ok: false, error: "rawYaml 必填" });
    try {
      const data = updateGoldenCase({ id, rawYaml });
      return {
        ok: true,
        updatedAt: new Date().toISOString(),
        ...data,
      };
    } catch (error) {
      return reply.status(400).send({ ok: false, error: (error as Error).message });
    }
  }));

  app.post<{ Body: { id?: string; instanceId?: string } }>("/api/platform/golden-cases/run", safe(async (request, reply) => {
    const id = request.body?.id?.trim();
    const instanceId = request.body?.instanceId?.trim() || DEFAULT_INSTANCE_ID;
    if (!id) return reply.status(400).send({ ok: false, error: "id 必填" });
    const userInput = goldenCaseUserInput(id);
    const project = await getProjectRuntimeContext(instanceId).catch(() => null);
    if (!project) return reply.status(404).send({ ok: false, error: `未找到用户助手 ${instanceId}` });
    const manager = projectWeixinManager(project);
    const conversationId = `golden:${id}:${Date.now()}`;
    const startedAt = Date.now();
    const response = await manager.simulateIncomingText({
      text: userInput,
      conversationId,
      accountId: `${project.backend}-golden-runner`,
    });
    return {
      ok: true,
      id,
      target: {
        userId: project.ownerUserId,
        instanceId: project.instanceId,
        name: project.name,
        backend: project.backend,
      },
      userInput,
      text: response.text || "",
      accountId: response.accountId,
      conversationId,
      elapsedMs: Date.now() - startedAt,
      updatedAt: new Date().toISOString(),
    };
  }));

  app.get<{ Querystring: { userId?: string; instanceId?: string; limit?: string; scope?: string } }>("/api/platform/audit", safe(async (request) => {
    const users = await auditUsers();
    const userId = request.query.userId?.trim();
    const instanceId = request.query.instanceId?.trim();
    const limit = Number(request.query.limit || 40);
    const scope = request.query.scope === "conversation" || request.query.scope === "push" ? request.query.scope : "all";
    const timeline = await loadAuditTimeline({ userId, instanceId, limit, scope });
    const instances = await listProjectRuntimeContexts({ ownerUserId: userId || undefined });
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      filters: { userId: userId || "", instanceId: instanceId || "", limit: timeline.limit, scope: timeline.scope },
      users,
      instances: instances.map((item) => ({
        instanceId: item.instanceId,
        name: item.name,
        ownerUserId: item.ownerUserId,
        backend: item.backend,
        status: item.status,
      })),
      items: timeline.items,
    };
  }));

  app.get<{ Querystring: { userId?: string; instanceId?: string; limit?: string } }>("/api/platform/rule-alerts", safe(async (request) => {
    const users = await auditUsers();
    const userId = request.query.userId?.trim();
    const instanceId = request.query.instanceId?.trim();
    const limit = Number(request.query.limit || 40);
    const instances = await listProjectRuntimeContexts({ ownerUserId: userId || undefined });
    const audit = await loadRuleAlertAudit({ userId, instanceId, limit });
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      filters: { userId: userId || "", instanceId: instanceId || "", limit: audit.limit },
      users,
      instances: instances.map((item) => ({
        instanceId: item.instanceId,
        name: item.name,
        ownerUserId: item.ownerUserId,
        backend: item.backend,
        status: item.status,
      })),
      ...audit,
    };
  }));

  app.get<{ Querystring: { userId?: string; instanceId?: string; days?: string; groupBy?: string } }>("/api/platform/audit/usage", safe(async (request) => {
    const userId = request.query.userId?.trim();
    const instanceId = request.query.instanceId?.trim();
    const days = Math.max(1, Math.min(Number(request.query.days || 30), 365));
    const groupBy =
      request.query.groupBy === "user" ||
      request.query.groupBy === "instance"
        ? request.query.groupBy
        : "day";
    const codexGroupBy: CodexUsageGroupBy = groupBy === "instance" || groupBy === "user" ? groupBy : "day";
    const instances = await listProjectRuntimeContexts({ ownerUserId: userId || undefined });
    const codexUsage = loadCodexWorkspaceUsageSummary({
      instances,
      userId,
      instanceId,
      days,
      groupBy: codexGroupBy,
    });
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      filters: { userId: userId || "", instanceId: instanceId || "", days, groupBy },
      codexUsage,
    };
  }));

  app.get<{ Querystring: { reportLimit?: string; alertLimit?: string } }>("/api/platform/source-quality", safe(async (request) => {
    const reportLimit = Number(request.query.reportLimit || 14);
    const alertLimit = Number(request.query.alertLimit || 40);
    const health = await marketHealth();
    const reports = readSourceQualityReports(reportLimit);
    const alerts = readSourceQualityAlerts(alertLimit);
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      sourceQualityDir: config.runtimeData.sourceQualityDir,
      health,
      reports,
      alerts,
    };
  }));

  app.post<{ Body: { userId?: string; displayName?: string; instanceName?: string } }>("/api/platform/instances", safe(async (request, reply) => {
    const userId = request.body?.userId?.trim();
    if (!userId) {
      return reply.status(400).send({ ok: false, error: "userId 必填" });
    }
    try {
      const project = await createInvestAgentInstance({
        userId,
        displayName: request.body?.displayName,
        instanceName: request.body?.instanceName,
        backend: config.acp.backend,
      });
      return {
        ok: true,
        updatedAt: new Date().toISOString(),
        instance: await summarizeInstance(project),
      };
    } catch (error) {
      if ((error as Error).message === "INVALID_USER_ID") {
        return reply.status(400).send({ ok: false, error: "userId 只能包含字母、数字、下划线和连字符，长度 2-64" });
      }
      throw error;
    }
  }));

  app.delete<{ Params: { instanceId: string } }>("/api/platform/instances/:instanceId", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.instanceId).catch(() => null);
    if (!project) return reply.status(404).send({ ok: false, error: "实例不存在" });
    if (project.instanceId === "invest-agent-primary") {
      return reply.status(400).send({ ok: false, error: "主实例不能删除" });
    }
    deletePlatformWeixinManager(project.instanceId);
    const workspacePath = resolveWorkspacePath(project.ownerUserId);
    const disposedAcpCount = disposeAcpForWorkspace(workspacePath);
    const deleted = await deleteInvestAgentInstance(project.instanceId);
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      disposedAcpCount,
      deleted,
    };
  }));

  app.get<{ Params: { instanceId: string } }>("/api/platform/instances/:instanceId/weixin/status", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.instanceId).catch(() => null);
    if (!project || project.status === "archived") return reply.status(404).send({ ok: false, error: "实例不存在或已归档", status: "removed" });
    return projectWeixinManager(project).getState();
  }));

  app.post<{ Params: { instanceId: string } }>("/api/platform/instances/:instanceId/weixin/connect/start", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.instanceId).catch(() => null);
    if (!project || project.status === "archived") return reply.status(404).send({ ok: false, error: "实例不存在或已归档" });
    return projectWeixinManager(project).startLogin();
  }));

  app.post<{ Params: { instanceId: string } }>("/api/platform/instances/:instanceId/weixin/listener/start", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.instanceId).catch(() => null);
    if (!project || project.status === "archived") return reply.status(404).send({ ok: false, error: "实例不存在或已归档" });
    const manager = projectWeixinManager(project);
    await manager.ensureListenerStarted();
    return manager.getState();
  }));

  app.post<{ Params: { instanceId: string } }>("/api/platform/instances/:instanceId/weixin/connect/stop", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.instanceId).catch(() => null);
    if (!project) return reply.status(404).send({ ok: false, error: "实例不存在" });
    const manager = projectWeixinManager(project);
    manager.stop();
    return manager.getState();
  }));

  app.post<{ Params: { instanceId: string }; Body: { message?: string } }>("/api/platform/instances/:instanceId/weixin/push/test", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.instanceId).catch(() => null);
    if (!project || project.status === "archived") return reply.status(404).send({ ok: false, error: "实例不存在或已归档" });
    const manager = projectWeixinManager(project);
    const text = request.body?.message?.trim() || `测试提醒：${project.name} ${new Date().toLocaleString("zh-CN")}`;
    const pushed = await manager.pushText(text, { userId: project.ownerUserId, instanceId: project.instanceId });
    if (!pushed) {
      return reply.status(409).send({
        ok: false,
        message: "当前没有可用的微信会话，请先让该实例绑定的微信给助手发送一条消息。",
        state: manager.getState(),
      });
    }
    return { ok: true, state: manager.getState() };
  }));

  app.post<{ Params: { instanceId: string } }>("/api/platform/instances/:instanceId/workspace/ensure", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.instanceId).catch(() => null);
    if (!project || project.status === "archived") return reply.status(404).send({ ok: false, error: "实例不存在或已归档" });
    const workspace = await ensureWorkspace({
      userId: project.ownerUserId,
      tenantId: project.ownerUserId,
      projectId: project.instanceId,
    });
    const hermesHome = await ensureHermesRuntimeForWorkspace(workspace.path);
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      workspace,
      hermesHome,
      instance: await summarizeInstance(project),
    };
  }));
}
