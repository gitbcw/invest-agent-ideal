import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { and, count, desc, eq, gte, not, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { parse as parseYaml } from "yaml";
import { renderPlatformPage } from "../admin/platform-page.js";
import { renderPartnerPlatformPage } from "../admin/partner-platform-page.js";
import { db, sqlite } from "../db/index.js";
import {
  aiInstances,
  alertEvents,
  alertRules,
  channelIdentities,
  channelIdentityInstances,
  codexAcpTraces,
  conversationMessages,
  dailyPlans,
  onboardingDrafts,
  platformUsers,
  pushJobs,
  scheduledTaskRuns,
  users,
} from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { createInvestAgentInstance, deleteInvestAgentInstance, getProjectRuntimeContext, listProjectRuntimeContexts, type AiProjectRuntimeContext } from "../platform/project-registry.js";
import { WeixinMobileManager } from "../channels/weixin-mobile.js";
import { config } from "../lib/config.js";
import { ensureWorkspace, resolveWorkspacePath, workspaceExists } from "../lib/workspace.js";
import { planBackend, portfolioBackend, watchlistBackend } from "../lib/data-backend.js";
import { dailyPlanBackend } from "../lib/daily-plan-backend.js";
import { reviewViewpointBackend } from "../lib/review-viewpoint-backend.js";
import { listWatchRules } from "../services/watch-rules.js";
import { disposeAcpForWorkspace, ensureCodexRuntimeForWorkspace, ensureHermesRuntimeForWorkspace } from "../acp/stdio-agent.js";
import { loadCodexWorkspaceUsageSummary, type CodexUsageGroupBy } from "../services/codex-usage.js";
import { DEFAULT_INSTANCE_ID } from "../lib/user-context.js";
import { marketHealth } from "../services/market-data.js";
import { getAlertInterval } from "../scheduler/index.js";
import { createPlatformSession, hasPlatformSession, isLoopbackAddress, platformSessionCookie } from "../lib/platform-session.js";
import { getWeixinDeliveryHealth, recordWeixinDeliveryAttempt } from "../services/weixin-delivery.js";
import { consumeRequestRateLimit } from "../lib/request-rate-limit.js";
import {
  authenticatePlatformUser,
  clearPlatformSessionCookie,
  getPlatformAuthContext,
  hasPlatformPermission,
  platformSessionCookie as persistentPlatformSessionCookie,
  recordPlatformAudit,
  revokePlatformSession,
  type PlatformAuthContext,
  type PlatformPermission,
} from "../lib/platform-auth.js";
import { hashPlatformPassword, verifyPlatformPassword } from "../lib/platform-password.js";

const projectWeixinManagers = new Map<string, WeixinMobileManager>();
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
  if (scope === "conversation") conditions.push(sql`${codexAcpTraces.channel} IN ('weixin-mobile', 'web')`);
  if (scope === "push") conditions.push(eq(codexAcpTraces.channel, "scheduler"));
  const pushConditions = [];
  if (input.userId) pushConditions.push(eq(pushJobs.userId, input.userId));
  if (input.instanceId) pushConditions.push(eq(pushJobs.instanceId, input.instanceId));
  const taskConditions = [];
  if (input.userId) taskConditions.push(eq(scheduledTaskRuns.userId, input.userId));
  if (input.instanceId) taskConditions.push(eq(scheduledTaskRuns.instanceId, input.instanceId));
  // The rule-alert page owns the full sampling history. Keep general audit focused on
  // actionable scheduler activity while preserving rule hits, errors, and suppression.
  taskConditions.push(not(and(
    eq(scheduledTaskRuns.taskType, "rule-alert-check"),
    eq(scheduledTaskRuns.status, "skipped"),
  )!));

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

async function resetDefaultTestInstance(project: AiProjectRuntimeContext) {
  if (project.instanceId !== DEFAULT_INSTANCE_ID) {
    throw new Error("ONLY_DEFAULT_TEST_INSTANCE_CAN_RESET");
  }
  const now = new Date().toISOString();
  const userId = project.ownerUserId;
  const instanceId = project.instanceId;
  const workspacePath = resolveWorkspacePath(userId);
  deletePlatformWeixinManager(instanceId);
  const disposedAcpCount = disposeAcpForWorkspace(workspacePath);

  const userInstanceTables = [
    "portfolio",
    "watchlist",
    "stock_plans",
    "chat_history",
    "daily_plans",
    "investment_profiles",
    "methodology_profiles",
    "method_change_candidates",
    "review_viewpoints",
    "alert_events",
    "alert_signal_states",
    "trade_actions",
    "codex_acp_traces",
    "indicator_results",
    "alert_rules",
    "sandbox_audit_logs",
    "pending_sandbox_confirmations",
    "onboarding_drafts",
    "conversation_tasks",
    "push_jobs",
    "scheduled_task_runs",
  ];
  const changes: Record<string, number> = {};
  const resetDb = sqlite.transaction(() => {
    const channelInstanceResult = sqlite.prepare(`
      DELETE FROM channel_identity_instances
      WHERE instance_id = ?
         OR channel_identity_id IN (SELECT id FROM channel_identities WHERE user_id = ?)
    `).run(instanceId, userId);
    changes.channel_identity_instances = channelInstanceResult.changes;

    const channelIdentityResult = sqlite.prepare("DELETE FROM channel_identities WHERE user_id = ?").run(userId);
    changes.channel_identities = channelIdentityResult.changes;

    for (const table of userInstanceTables) {
      const result = sqlite.prepare(`DELETE FROM ${table} WHERE user_id = ? OR instance_id = ?`).run(userId, instanceId);
      changes[table] = result.changes;
    }

    const agentTraceResult = sqlite.prepare("DELETE FROM agent_traces WHERE owner_user_id = ? OR user_id = ?").run(userId, userId);
    changes.agent_traces = agentTraceResult.changes;

    sqlite.prepare("UPDATE users SET display_name = ?, status = 'active', updated_at = ? WHERE id = ?")
      .run("默认测试用户", now, userId);
    sqlite.prepare("UPDATE ai_instances SET name = ?, status = 'active', config = ?, updated_at = ? WHERE id = ?")
      .run("默认测试投资助手", JSON.stringify({ autoCreated: true, role: "default_test_instance", resetAt: now }), now, instanceId);
  });
  resetDb();

  await rm(workspacePath, { recursive: true, force: true });
  const workspace = await ensureWorkspace({ userId, tenantId: userId, projectId: instanceId });
  if (project.backend === "codex") {
    await ensureCodexRuntimeForWorkspace(workspace.path);
  } else {
    await ensureHermesRuntimeForWorkspace(workspace.path);
  }
  logger.info(`Platform 默认测试实例已重置 userId=${userId} instanceId=${instanceId}`);
  return {
    userId,
    instanceId,
    workspace,
    disposedAcpCount,
    changes,
    resetAt: now,
  };
}

function stableSuffix(value?: string | null) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 10);
}

async function provisionPortalAccount(project: AiProjectRuntimeContext) {
  const res = await fetch(config.portal.distributionUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.portal.distributionToken}`,
    },
    body: JSON.stringify({
      username: project.ownerUserId,
      displayName: project.name,
      assistantId: project.instanceId,
      instanceId: project.instanceId,
    }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.ok === false) {
    throw new Error(payload.error?.message || payload.error || `PORTAL_DISTRIBUTION_FAILED:${res.status}`);
  }
  return payload.data;
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

type PartnerOnboardingStatus = "not_started" | "drafting" | "committing" | "completed" | "exception" | "unknown";
type PartnerNotificationPreference = "low_disturbance" | "active_watch" | "evening_summary" | "unknown";

function shanghaiDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return String(values.year) + "-" + String(values.month) + "-" + String(values.day);
}

function shanghaiDateOffset(days: number) {
  const [year, month, day] = shanghaiDateKey().split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.getUTCFullYear().toString().padStart(4, "0") +
    "-" + (date.getUTCMonth() + 1).toString().padStart(2, "0") +
    "-" + date.getUTCDate().toString().padStart(2, "0");
}

function shanghaiDayStartIso(dateKey: string) {
  return new Date(dateKey + "T00:00:00+08:00").toISOString();
}

function traceIsSuccessful(row: { status: string; elapsedMs: number | null }) {
  return row.status !== "error" &&
    row.status !== "failed" &&
    row.status !== "timeout" &&
    row.status !== "pending" &&
    row.status !== "claimed" &&
    row.status !== "running" &&
    row.status !== "skipped" &&
    !(typeof row.elapsedMs === "number" && row.elapsedMs >= 30_000);
}

function repeatedConfirmationCount(rows: Array<{ userText?: string | null; createdAt: string }>) {
  const confirmations = rows
    .filter((row) => /^(确认|确认完成|确认默认时间)$/.test(String(row.userText || "").trim()))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let count = 0;
  for (let index = 1; index < confirmations.length; index += 1) {
    const previous = Date.parse(confirmations[index - 1].createdAt);
    const current = Date.parse(confirmations[index].createdAt);
    if (Number.isFinite(previous) && Number.isFinite(current) && current - previous <= 24 * 60 * 60 * 1000) count += 1;
  }
  return count;
}

async function partnerSourceQualitySummary() {
  const todayKey = shanghaiDateKey();
  const alerts = readSourceQualityAlerts(10_000);
  const todayAlerts = alerts.filter((item: any) => {
    const value = item?.createdAt || item?.timestamp || item?.date;
    return value && String(value).slice(0, 10) === todayKey;
  }) as any[];
  const health = await marketHealth().catch(() => ({ status: "unknown" }));
  const endpoints = typeof health === "object" && health !== null && "endpoints" in health
    ? ((health as any).endpoints || []) as Array<{ lastStatus?: string; totalFailures?: number }>
    : [];
  const status = endpoints.length === 0
    ? "unknown"
    : endpoints.some((item) => item.lastStatus === "fail" || item.lastStatus === "degraded" || Number(item.totalFailures || 0) > 0)
      ? "degraded"
      : endpoints.some((item) => item.lastStatus === "unknown")
        ? "partial"
      : "ok";
  return {
    countToday: todayAlerts.length,
    status,
    latestAt: todayAlerts[0]?.createdAt || todayAlerts[0]?.timestamp || shanghaiDayStartIso(todayKey),
  };
}

function decodePartnerCursor(value: unknown) {
  if (!value) return 0;
  try {
    const offset = Number(Buffer.from(String(value), "base64url").toString("utf8"));
    return Number.isInteger(offset) && offset >= 0 ? offset : 0;
  } catch {
    return 0;
  }
}

function encodePartnerCursor(offset: number) {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function partnerCustomerKey(instanceId: string) {
  const secret = config.platform.anonymizationSecret;
  if (!secret) throw new Error("PLATFORM_ANONYMIZATION_SECRET_REQUIRED");
  return "cus_" + createHmac("sha256", secret).update(instanceId).digest("hex").slice(0, 12);
}

function partnerCustomerKeyCandidates(instanceId: string) {
  const secrets = [config.platform.anonymizationSecret, config.platform.anonymizationPreviousSecret].filter(Boolean);
  if (secrets.length === 0) throw new Error("PLATFORM_ANONYMIZATION_SECRET_REQUIRED");
  return secrets.map((secret) => "cus_" + createHmac("sha256", secret).update(instanceId).digest("hex").slice(0, 12));
}

export async function assertPlatformPartnerKeySafety() {
  if (!config.platform.authEnabled) return;
  const projects = await listProjectRuntimeContexts();
  const seen = new Map<string, string>();
  for (const project of projects) {
    for (const customerKey of partnerCustomerKeyCandidates(project.instanceId)) {
      const existing = seen.get(customerKey);
      if (existing && existing !== project.instanceId) {
        throw new Error("PARTNER_CUSTOMER_KEY_COLLISION:" + customerKey);
      }
      seen.set(customerKey, project.instanceId);
    }
  }
}

function partnerCustomerLabel(customerKey: string) {
  return "客户 " + customerKey.slice(-6);
}

function partnerNotificationPreference(workspacePath: string): PartnerNotificationPreference {
  const filePath = path.join(workspacePath, "config", "notification.yaml");
  if (!existsSync(filePath)) return "unknown";
  try {
    const raw = parseYaml(readFileSync(filePath, "utf8")) as any;
    const mode = raw?.preference?.mode;
    if (mode === "active_watch") return "active_watch";
    if (mode === "evening_summary") return "evening_summary";
    if (mode === "low_disturbance") return "low_disturbance";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function partnerOnboardingStatus(input: {
  draftStatus?: string;
  files: Record<string, boolean>;
}): PartnerOnboardingStatus {
  if (input.draftStatus === "failed" || input.draftStatus === "exception") return "exception";
  if (input.draftStatus === "queued" || input.draftStatus === "committing") return "committing";
  if (input.draftStatus === "completed") return "completed";
  if (input.draftStatus === "collecting" || input.draftStatus === "confirmed") return "drafting";
  if (Object.values(input.files).every(Boolean)) return "completed";
  if (Object.values(input.files).some(Boolean)) return "drafting";
  return "not_started";
}

function partnerFailureCategory(status: string | null | undefined, message: string | null | undefined) {
  if (status === "sent") return null;
  const text = String(message || "").toLowerCase();
  if (text.includes("context") || text.includes("session")) return "session_expired";
  if (text.includes("wechat") || text.includes("微信")) return "wechat_delivery_error";
  if (text.includes("timeout") || text.includes("超时")) return "timeout";
  if (status === "awaiting_user") return "awaiting_user";
  return status ? "delivery_failed" : null;
}

async function partnerCustomerSnapshot(project: AiProjectRuntimeContext) {
  const todayStart = shanghaiDayStartIso(shanghaiDateKey());
  const sevenDaysAgo = shanghaiDayStartIso(shanghaiDateOffset(-7));
  const thirtyDaysAgo = shanghaiDayStartIso(shanghaiDateOffset(-30));
  const workspacePath = resolveWorkspacePath(project.ownerUserId);
  const files = {
    portfolio: existsSync(path.join(workspacePath, "config", "portfolio.yaml")),
    strategy: existsSync(path.join(workspacePath, "config", "strategy.yaml")),
    reviewSchedule: existsSync(path.join(workspacePath, "config", "schedules.yaml")),
    notification: existsSync(path.join(workspacePath, "config", "notification.yaml")),
  };

  const [draftRows, traceRows, messageRows, pushRows, reviewRows, ruleRows, bindingRows, delivery, weixinState] = await Promise.all([
    db.select({ status: onboardingDrafts.status, updatedAt: onboardingDrafts.updatedAt })
      .from(onboardingDrafts)
      .where(eq(onboardingDrafts.instanceId, project.instanceId))
      .orderBy(desc(onboardingDrafts.updatedAt))
      .limit(1),
    db.select({ status: codexAcpTraces.status, elapsedMs: codexAcpTraces.elapsedMs, userText: codexAcpTraces.userText, createdAt: codexAcpTraces.createdAt })
      .from(codexAcpTraces)
      .where(and(eq(codexAcpTraces.instanceId, project.instanceId), gte(codexAcpTraces.createdAt, thirtyDaysAgo)))
      .orderBy(desc(codexAcpTraces.createdAt))
      .limit(300),
    db.select({ createdAt: conversationMessages.createdAt })
      .from(conversationMessages)
      .where(and(eq(conversationMessages.instanceId, project.instanceId), gte(conversationMessages.createdAt, thirtyDaysAgo)))
      .orderBy(desc(conversationMessages.createdAt))
      .limit(300),
    db.select({ status: pushJobs.status, sentAt: pushJobs.sentAt, createdAt: pushJobs.createdAt, lastError: pushJobs.lastError })
      .from(pushJobs)
      .where(and(eq(pushJobs.instanceId, project.instanceId), gte(pushJobs.createdAt, thirtyDaysAgo)))
      .orderBy(desc(pushJobs.createdAt))
      .limit(100),
    db.select({ planDate: dailyPlans.planDate, generatedAt: dailyPlans.generatedAt })
      .from(dailyPlans)
      .where(eq(dailyPlans.instanceId, project.instanceId))
      .orderBy(desc(dailyPlans.planDate))
      .limit(30),
    db.select({ count: count() })
      .from(alertRules)
      .where(and(eq(alertRules.instanceId, project.instanceId), eq(alertRules.enabled, true))),
    db.select({ count: count() })
      .from(channelIdentityInstances)
      .where(eq(channelIdentityInstances.instanceId, project.instanceId)),
    getWeixinDeliveryHealth(project.ownerUserId, project.instanceId).catch(() => null),
    Promise.resolve(projectWeixinManager(project).getState()).catch(() => null),
  ]);

  const draftStatus = draftRows[0]?.status;
  const onboardingStatus = partnerOnboardingStatus({ draftStatus, files });
  const traceToday = traceRows.filter((row) => row.createdAt >= todayStart);
  const trace7d = traceRows.filter((row) => row.createdAt >= sevenDaysAgo);
  const message7d = messageRows.filter((row) => row.createdAt >= sevenDaysAgo);
  const push7d = pushRows.filter((row) => row.createdAt >= sevenDaysAgo);
  const latestTraceAt = traceRows[0]?.createdAt || null;
  const latestMessageAt = messageRows[0]?.createdAt || null;
  const lastActiveAt = [latestTraceAt, latestMessageAt, project.updatedAt].filter(Boolean).sort().reverse()[0] || null;
  const latestPush = pushRows[0] || null;
  const wechatBound = Number(bindingRows[0]?.count || 0) > 0;
  const pushReachable = Boolean(wechatBound && delivery?.hasConversation && weixinState?.stage === "connected");
  const missingSetupSteps = [
    !files.portfolio ? "portfolio" : null,
    !files.strategy ? "strategy" : null,
    !files.reviewSchedule ? "review_schedule" : null,
    !files.notification ? "notification_preference" : null,
  ].filter(Boolean) as string[];
  const failureCategory = partnerFailureCategory(latestPush?.status, latestPush?.lastError);
  const health = onboardingStatus === "exception"
    ? "blocked"
    : project.status !== "active" || (wechatBound && !pushReachable)
      ? "attention"
      : "ok";

  return {
    customerKey: partnerCustomerKey(project.instanceId),
    customerLabel: partnerCustomerLabel(partnerCustomerKey(project.instanceId)),
    assistantStatus: project.status,
    onboardingStatus,
    missingSetupSteps,
    wechatBound,
    pushReachable,
    lastInboundAt: delivery?.lastInboundAt || null,
    lastOutboundAt: latestPush?.sentAt || latestPush?.createdAt || null,
    lastActiveAt,
    conversationCountToday: traceToday.length,
    traceCount7d: trace7d.length,
    conversationCount7d: Math.max(trace7d.length, message7d.length),
    conversationCount30d: Math.max(traceRows.length, messageRows.length),
    responseElapsedToday: traceToday.map((row) => row.elapsedMs).filter((value): value is number => typeof value === "number" && value >= 0),
    successfulTraceCountToday: traceToday.filter(traceIsSuccessful).length,
    traceCountToday: traceToday.length,
    reviewCount30d: reviewRows.filter((row) => row.planDate >= shanghaiDateOffset(-30)).length,
    lastReviewAt: reviewRows[0]?.generatedAt || reviewRows[0]?.planDate || null,
    pushCount7d: push7d.length,
    pushSentCountToday: pushRows.filter((row) => row.createdAt >= todayStart && row.status === "sent").length,
    pushAttemptCountToday: pushRows.filter((row) => row.createdAt >= todayStart).length,
    lastPushStatus: latestPush?.status || "none",
    failureCategory,
    notificationPreference: partnerNotificationPreference(workspacePath),
    enabledRuleCount: Number(ruleRows[0]?.count || 0),
    health,
    portfolioConfigured: files.portfolio,
    strategyConfigured: files.strategy,
    reviewScheduleConfigured: files.reviewSchedule,
    notificationConfigured: files.notification,
    timeoutCount7d: trace7d.filter((row) => row.status === "timeout" || (typeof row.elapsedMs === "number" && row.elapsedMs >= 30_000)).length,
    errorCount7d: trace7d.filter((row) => row.status === "error" || row.status === "failed").length,
    repeatConfirmationCount7d: repeatedConfirmationCount(trace7d),
    repeatConfirmationAffected: repeatedConfirmationCount(trace7d) > 0 ? 1 : 0,
  };
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? null;
}

function partnerRoutePermission(pathname: string, method: string): PlatformPermission | null {
  if (pathname.startsWith("/api/platform/auth/")) return null;
  if (pathname === "/api/platform/partner/overview") return "overview.read";
  if (pathname === "/api/platform/partner/customers" || pathname.startsWith("/api/platform/partner/customers/")) return "customers.read";
  if (pathname === "/api/platform/partner/quality") return "quality.read";
  if (pathname === "/api/platform/partner/runtime-health") return "operations.read";
  if (pathname === "/api/platform/audit/usage") return "cost.read";
  if (pathname === "/api/platform/instances/" && method === "GET") return "customers.sensitive.read";
  if (pathname.includes("/investment-state")) return "customers.sensitive.read";
  if (pathname === "/api/platform/audit" || pathname === "/api/platform/rule-alerts") return "admin_audit.read";
  if (pathname === "/api/platform/source-quality") return "admin_audit.read";
  if (method === "GET" && pathname === "/api/platform/instances") return "customers.sensitive.read";
  if (method === "POST" && pathname === "/api/platform/instances") return "instances.create";
  if (pathname.includes("/portal/credential")) return "portal.credential.issue";
  if (method === "DELETE" && pathname.startsWith("/api/platform/instances/")) return "instances.archive";
  if (pathname.includes("/reset-test")) return "instances.reset_test";
  if (pathname.includes("/weixin/connect/start") || pathname.includes("/weixin/listener/start")) return "weixin.connect";
  if (pathname.includes("/weixin/connect/stop")) return "weixin.disconnect";
  if (pathname.includes("/weixin/push/test")) return "weixin.test_push";
  if (pathname.includes("/workspace/ensure")) return "customers.sensitive.read";
  return "admin_audit.read";
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

  app.addHook("preHandler", async (request: any, reply: any) => {
    const pathname = String(request.url || "").split("?")[0];
    if (!pathname.startsWith("/api/platform/")) return;
    if (!config.platform.authEnabled && (
      pathname.startsWith("/api/platform/auth/") ||
      pathname.startsWith("/api/platform/partner/")
    )) {
      return reply.status(404).send({ ok: false, error: "platform auth surface disabled" });
    }
    if (pathname === "/api/platform/auth/login") return;

    const context = await getPlatformAuthContext(request);
    if (pathname.startsWith("/api/platform/auth/")) {
      if (!context) return reply.status(401).send({ ok: false, error: "platform authentication required" });
      request.platformAuth = context;
      return;
    }
    if (!context) return reply.status(401).send({ ok: false, error: "platform authentication required" });
    if (context.authType === "account" && context.mustChangePassword) {
      await recordPlatformAudit({
        request,
        context,
        action: "password_change_required",
        route: pathname,
        status: "denied",
        summary: { method: request.method },
      }).catch((error) => logger.warn("Platform 改密门槛审计写入失败: " + (error as Error).message));
      return reply.status(428).send({ ok: false, error: "password change required" });
    }

    const permission = partnerRoutePermission(pathname, String(request.method || "GET").toUpperCase());
    if (permission && !hasPlatformPermission(context, permission)) {
      try {
        await recordPlatformAudit({
          request,
          context,
          action: "permission_denied",
          route: pathname,
          permission,
          status: "denied",
          summary: { method: request.method },
        });
      } catch (error) {
        logger.error("Platform 拒绝审计写入失败:", error);
      }
      return reply.status(403).send({ ok: false, error: "platform permission denied", permission });
    }
    const customerMatch = pathname.match(/\/customers\/(cus_[a-f0-9]{12})/);
    try {
      await recordPlatformAudit({
        request,
        context,
        action: pathname.startsWith("/api/platform/partner/") ? "partner_read_aggregate" : "platform_route_access",
        route: pathname,
        permission: permission || undefined,
        targetCustomerKey: customerMatch?.[1],
        status: "allowed",
        summary: { method: request.method },
      });
    } catch (error) {
      logger.error("Platform 授权审计写入失败:", error);
      return reply.status(503).send({ ok: false, error: "platform audit unavailable" });
    }
    request.platformAuth = context;
  });

  app.post<{ Body: { username?: string; password?: string } }>("/api/platform/auth/login", safe(async (request, reply) => {
    const rate = consumeRequestRateLimit({
      key: "platform-login:" + String(request.ip || "unknown"),
      max: 10,
      windowMs: 60_000,
    });
    if (!rate.allowed) {
      return reply.header("retry-after", String(rate.retryAfterSeconds)).status(429).send({ ok: false, error: "login rate limit exceeded" });
    }
    const username = String(request.body?.username || "").trim();
    const password = String(request.body?.password || "");
    if (!username || !password || username.length > 128 || password.length > 256) {
      return reply.status(400).send({ ok: false, error: "username and password are required" });
    }
    const result = await authenticatePlatformUser({ username, password, request });
    if (!result.ok) {
      const status = result.error === "ACCOUNT_LOCKED" ? 423 : 401;
      return reply.status(status).send({ ok: false, error: "invalid platform credentials" });
    }
    reply.header("set-cookie", persistentPlatformSessionCookie(result.id));
    return {
      ok: true,
      user: {
        username: result.context.username,
        displayName: result.context.displayName,
        role: result.context.role,
      },
      mustChangePassword: result.mustChangePassword,
    };
  }));

  app.get("/api/platform/auth/me", safe(async (request, reply) => {
    const context = await getPlatformAuthContext(request);
    if (!context || context.authType === "service_token" || context.authType === "legacy_local") {
      return reply.status(401).send({ ok: false, error: "platform account session required" });
    }
    return {
      ok: true,
      user: {
        username: context.username,
        displayName: context.displayName,
        role: context.role,
        permissions: context.permissions.filter((item) => item !== "*"),
      },
    };
  }));

  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>("/api/platform/auth/password", safe(async (request, reply) => {
    const context = await getPlatformAuthContext(request);
    if (!context || context.authType !== "account") {
      return reply.status(401).send({ ok: false, error: "platform account session required" });
    }
    const currentPassword = String(request.body?.currentPassword || "");
    const newPassword = String(request.body?.newPassword || "");
    if (newPassword.length < 12 || newPassword.length > 256) {
      return reply.status(400).send({ ok: false, error: "new password must be 12-256 characters" });
    }
    const rows = await db.select().from(platformUsers).where(eq(platformUsers.id, context.userId)).limit(1);
    const user = rows[0];
    if (!user || !verifyPlatformPassword(currentPassword, user.passwordHash)) {
      await recordPlatformAudit({
        request,
        context,
        action: "password_change",
        route: "/api/platform/auth/password",
        status: "failure",
        summary: { reason: "invalid_current_password" },
      });
      return reply.status(401).send({ ok: false, error: "invalid current password" });
    }
    const now = new Date().toISOString();
    await db.update(platformUsers)
      .set({ passwordHash: hashPlatformPassword(newPassword), mustChangePassword: false, failedLoginCount: 0, lockedUntil: null, updatedAt: now })
      .where(eq(platformUsers.id, user.id));
    await recordPlatformAudit({
      request,
      context,
      action: "password_change",
      route: "/api/platform/auth/password",
      status: "allowed",
    });
    return { ok: true };
  }));

  app.post("/api/platform/auth/logout", safe(async (request, reply) => {
    const context = await getPlatformAuthContext(request);
    const revoked = await revokePlatformSession(request);
    if (context) {
      await recordPlatformAudit({
        request,
        context,
        action: "logout",
        route: "/api/platform/auth/logout",
        status: "allowed",
      });
    }
    reply.header("set-cookie", clearPlatformSessionCookie());
    return { ok: true, revoked };
  }));

  app.get("/api/platform/partner/overview", safe(async (_request) => {
    const projects = await listProjectRuntimeContexts();
    const snapshots = await Promise.all(projects.map(partnerCustomerSnapshot));
    const todayDate = shanghaiDateKey();
    const todayStart = shanghaiDayStartIso(todayDate);
    const sevenDaysAgo = shanghaiDayStartIso(shanghaiDateOffset(-7));
    const sourceQuality = await partnerSourceQualitySummary();
    const customerKeys = new Set<string>();
    for (const item of snapshots) {
      if (customerKeys.has(item.customerKey)) throw new Error("PARTNER_CUSTOMER_KEY_COLLISION");
      customerKeys.add(item.customerKey);
    }
    const active7d = snapshots.filter((item) => item.lastActiveAt && item.lastActiveAt >= sevenDaysAgo).length;
    const onboardingCompleted = snapshots.filter((item) => item.onboardingStatus === "completed").length;
    const onboardingInProgress = snapshots.filter((item) => item.onboardingStatus === "drafting" || item.onboardingStatus === "committing").length;
    const onboardingException = snapshots.filter((item) => item.onboardingStatus === "exception").length;
    const tracesToday = snapshots.reduce((sum, item) => sum + item.traceCountToday, 0);
    const successfulToday = snapshots.reduce((sum, item) => sum + item.successfulTraceCountToday, 0);
    const elapsedToday = snapshots.flatMap((item) => item.responseElapsedToday);
    const pushAttemptsToday = snapshots.reduce((sum, item) => sum + item.pushAttemptCountToday, 0);
    const pushSentToday = snapshots.reduce((sum, item) => sum + item.pushSentCountToday, 0);
    const reviewsToday = snapshots.filter((item) => item.lastReviewAt && String(item.lastReviewAt).slice(0, 10) === todayDate).length;
    const qualityExceptions = snapshots.reduce((sum, item) => sum + item.errorCount7d + item.timeoutCount7d + item.repeatConfirmationCount7d, 0);
    const exceptions = [
      { type: "onboarding_stuck", count: onboardingInProgress, affectedCustomers: onboardingInProgress },
      { type: "onboarding_exception", count: onboardingException, affectedCustomers: onboardingException },
      { type: "push_failed", count: snapshots.filter((item) => item.failureCategory !== null).length, affectedCustomers: snapshots.filter((item) => item.failureCategory !== null).length },
      { type: "inactive_7d", count: snapshots.length - active7d, affectedCustomers: snapshots.length - active7d },
    ].filter((item) => item.count > 0);
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      timeRange: {
        start: todayStart.slice(0, 10),
        end: todayDate,
        timezone: "Asia/Shanghai",
      },
      metrics: {
        customersTotal: snapshots.length,
        customersActivated: snapshots.filter((item) => item.assistantStatus === "active").length,
        activeCustomers7d: active7d,
        activeCustomers30d: snapshots.filter((item) => item.conversationCount30d > 0).length,
        onboardingCompleted,
        onboardingInProgress,
        onboardingException,
        conversationCountToday: tracesToday,
        conversationSuccessRateToday: tracesToday > 0 ? successfulToday / tracesToday : null,
        responseP50MsToday: percentile(elapsedToday, 0.5),
        responseP95MsToday: percentile(elapsedToday, 0.95),
        reviewCoverageToday: snapshots.length > 0 ? reviewsToday / snapshots.length : null,
        pushDeliveryRateToday: pushAttemptsToday > 0 ? pushSentToday / pushAttemptsToday : null,
        qualityExceptionCountToday: qualityExceptions,
        dataSourceExceptionCountToday: sourceQuality.countToday,
      },
      exceptions,
      dataQuality: {
        status: snapshots.length > 0 && sourceQuality.status === "ok" ? "ok" : "degraded",
        missing: snapshots.length > 0 ? [] : ["no active customer snapshots"],
        staleSources: sourceQuality.status === "ok" ? [] : ["market-data"],
      },
    };
  }));

  app.get("/api/platform/partner/customers", safe(async (request) => {
    const query = request.query || {};
    const limit = Math.max(1, Math.min(Number(query.limit || 50), 50));
    const offset = decodePartnerCursor(query.cursor);
    const projects = await listProjectRuntimeContexts();
    const snapshots = await Promise.all(projects.map(partnerCustomerSnapshot));
    const filtered = snapshots.filter((item) => {
      if (query.status && item.assistantStatus !== query.status) return false;
      if (query.onboarding && item.onboardingStatus !== query.onboarding) return false;
      if (query.health && item.health !== query.health) return false;
      return true;
    });
    const ordered = filtered.sort((a, b) => a.customerKey.localeCompare(b.customerKey));
    const pageItems = ordered.slice(offset, offset + limit);
    const nextCursor = offset + limit < ordered.length ? encodePartnerCursor(offset + limit) : null;
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      page: { limit, cursor: query.cursor || null, nextCursor },
      filters: {
        status: query.status || "",
        onboarding: query.onboarding || "",
        health: query.health || "",
      },
      customers: pageItems.map((item) => ({
        customerKey: item.customerKey,
        customerLabel: item.customerLabel,
        assistantStatus: item.assistantStatus,
        onboardingStatus: item.onboardingStatus,
        missingSetupSteps: item.missingSetupSteps,
        wechatBound: item.wechatBound,
        pushReachable: item.pushReachable,
        lastInboundAt: item.lastInboundAt,
        lastOutboundAt: item.lastOutboundAt,
        lastActiveAt: item.lastActiveAt,
        conversationCount7d: item.conversationCount7d,
        lastReviewAt: item.lastReviewAt,
        lastPushStatus: item.lastPushStatus,
        notificationPreference: item.notificationPreference,
        enabledRuleCount: item.enabledRuleCount,
        health: item.health,
      })),
    };
  }));

  app.get("/api/platform/partner/customers/:customerKey/operations", safe(async (request, reply) => {
    const projects = await listProjectRuntimeContexts();
    const project = projects.find((candidate) => partnerCustomerKeyCandidates(candidate.instanceId).includes(request.params.customerKey));
    const item = project ? await partnerCustomerSnapshot(project) : null;
    if (!item) return reply.status(404).send({ ok: false, error: "customer not found" });
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      customer: { customerKey: item.customerKey, customerLabel: item.customerLabel },
      setup: {
        onboardingStatus: item.onboardingStatus,
        portfolioConfigured: item.portfolioConfigured,
        strategyConfigured: item.strategyConfigured,
        reviewScheduleConfigured: item.reviewScheduleConfigured,
        notificationPreference: item.notificationPreference,
        enabledRuleCount: item.enabledRuleCount,
      },
      usage: {
        conversationCount7d: item.conversationCount7d,
        reviewCount30d: item.reviewCount30d,
        pushCount7d: item.pushCount7d,
      },
      delivery: {
        wechatBound: item.wechatBound,
        pushReachable: item.pushReachable,
        lastPushStatus: item.lastPushStatus,
        failureCategory: item.failureCategory,
      },
      quality: {
        timeoutCount7d: item.timeoutCount7d,
        errorCount7d: item.errorCount7d,
        repeatConfirmationCount7d: item.repeatConfirmationCount7d,
      },
    };
  }));

  app.get("/api/platform/partner/quality", safe(async () => {
    const snapshots = await Promise.all((await listProjectRuntimeContexts()).map(partnerCustomerSnapshot));
    const sourceQuality = await partnerSourceQualitySummary();
    const traceCount = snapshots.reduce((sum, item) => sum + item.traceCount7d, 0);
    const errors = snapshots.reduce((sum, item) => sum + item.errorCount7d, 0);
    const timeouts = snapshots.reduce((sum, item) => sum + item.timeoutCount7d, 0);
    const successful = Math.max(0, traceCount - errors - timeouts);
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      items: [
        { type: "conversation_success", status: "observed", count: successful, rate: traceCount > 0 ? successful / traceCount : null, latestAt: new Date().toISOString(), affectedCustomers: snapshots.filter((item) => item.traceCount7d > 0).length },
        { type: "conversation_error", status: errors > 0 ? "attention" : "ok", count: errors, rate: traceCount > 0 ? errors / traceCount : null, latestAt: new Date().toISOString(), affectedCustomers: snapshots.filter((item) => item.errorCount7d > 0).length },
        { type: "conversation_timeout", status: timeouts > 0 ? "attention" : "ok", count: timeouts, rate: traceCount > 0 ? timeouts / traceCount : null, latestAt: new Date().toISOString(), affectedCustomers: snapshots.filter((item) => item.timeoutCount7d > 0).length },
        { type: "repeat_confirmation", status: "observed", count: snapshots.reduce((sum, item) => sum + item.repeatConfirmationCount7d, 0), rate: null, latestAt: new Date().toISOString(), affectedCustomers: snapshots.reduce((sum, item) => sum + item.repeatConfirmationAffected, 0) },
      ],
      dataQuality: {
        status: snapshots.length > 0 && sourceQuality.status === "ok" ? "ok" : "partial",
        missing: [
          ...(snapshots.length > 0 ? [] : ["no customer snapshots"]),
          ...(sourceQuality.status === "ok" ? [] : ["source-quality"]),
          ...(snapshots.some((item) => item.traceCount7d === 0) ? ["trace coverage"] : []),
        ],
      },
    };
  }));

  app.get("/api/platform/partner/runtime-health", safe(async () => {
    const snapshots = await Promise.all((await listProjectRuntimeContexts()).map(partnerCustomerSnapshot));
    const pushFailures = snapshots.filter((item) => item.failureCategory !== null).length;
    const reachable = snapshots.filter((item) => item.pushReachable).length;
    const sourceQuality = await partnerSourceQualitySummary();
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      items: [
        { type: "wechat_reachability", status: reachable === snapshots.length ? "ok" : "attention", count: reachable, affectedCustomers: snapshots.length - reachable, latestAt: new Date().toISOString() },
        { type: "push_delivery", status: pushFailures > 0 ? "attention" : "ok", count: pushFailures, affectedCustomers: pushFailures, latestAt: new Date().toISOString() },
        { type: "market_data", status: sourceQuality.status, count: sourceQuality.countToday, affectedCustomers: 0, latestAt: sourceQuality.latestAt },
      ],
      dataQuality: {
        status: sourceQuality.status,
        missing: sourceQuality.status === "ok" ? [] : ["source-quality"],
      },
    };
  }));

  app.get("/platform", async (request, reply) => {
    // Rollback disables the new account/Partner surface. Keep the old loopback
    // compatibility page available, but never render a persisted account page
    // while the feature is disabled.
    if (!config.platform.authEnabled) {
      if (isLoopbackAddress(request.ip)) {
        if (!hasPlatformSession(request.headers.cookie)) {
          const session = createPlatformSession();
          reply.header("set-cookie", platformSessionCookie(session.id, session.maxAgeSeconds));
        }
        return reply.type("text/html; charset=utf-8").send(renderPlatformPage({
          portalPublicUrl: config.portal.publicUrl,
        }));
      }
      return reply.status(401).type("text/html; charset=utf-8").send(renderPartnerPlatformPage());
    }
    const context = await getPlatformAuthContext(request);
    if (context?.authType === "account" && context.role === "partner") {
      return reply.type("text/html; charset=utf-8").send(renderPartnerPlatformPage({ authenticated: true }));
    }
    if (context?.authType === "account" && context.role === "owner" && context.mustChangePassword) {
      return reply.type("text/html; charset=utf-8").send(renderPartnerPlatformPage());
    }
    if (context?.authType === "account" && context.role === "owner") {
      return reply.type("text/html; charset=utf-8").send(renderPlatformPage({
        portalPublicUrl: config.portal.publicUrl,
      }));
    }
    if (isLoopbackAddress(request.ip)) {
      if (!hasPlatformSession(request.headers.cookie)) {
        const session = createPlatformSession();
        reply.header("set-cookie", platformSessionCookie(session.id, session.maxAgeSeconds));
      }
      return reply.type("text/html; charset=utf-8").send(renderPlatformPage({
        portalPublicUrl: config.portal.publicUrl,
      }));
    }
    return reply.status(401).type("text/html; charset=utf-8").send(renderPartnerPlatformPage());
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
      const portalCredential = await provisionPortalAccount(project);
      return {
        ok: true,
        updatedAt: new Date().toISOString(),
        instance: await summarizeInstance(project),
        portalCredential,
      };
    } catch (error) {
      if ((error as Error).message === "INVALID_USER_ID") {
        return reply.status(400).send({ ok: false, error: "userId 只能包含字母、数字、下划线和连字符，长度 2-64" });
      }
      throw error;
    }
  }));

  app.post<{ Params: { instanceId: string } }>("/api/platform/instances/:instanceId/portal/credential", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.instanceId).catch(() => null);
    if (!project || project.status === "archived") {
      return reply.status(404).send({ ok: false, error: "实例不存在或已归档" });
    }
    const portalCredential = await provisionPortalAccount(project);
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      portalCredential,
    };
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

  app.post<{ Params: { instanceId: string }; Body: { confirm?: string } }>("/api/platform/instances/:instanceId/reset-test", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.instanceId).catch(() => null);
    if (!project) return reply.status(404).send({ ok: false, error: "实例不存在" });
    if (project.instanceId !== DEFAULT_INSTANCE_ID) {
      return reply.status(400).send({ ok: false, error: "目前仅默认测试实例支持重置" });
    }
    if (request.body?.confirm !== "RESET_DEFAULT_TEST_INSTANCE") {
      return reply.status(400).send({ ok: false, error: "缺少重置确认" });
    }
    const reset = await resetDefaultTestInstance(project);
    const nextProject = await getProjectRuntimeContext(project.instanceId);
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      reset,
      instance: await summarizeInstance(nextProject),
    };
  }));

  app.get<{ Params: { instanceId: string } }>("/api/platform/instances/:instanceId/weixin/status", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.instanceId).catch(() => null);
    if (!project || project.status === "archived") return reply.status(404).send({ ok: false, error: "实例不存在或已归档", status: "removed" });
    return {
      ...projectWeixinManager(project).getState(),
      delivery: await getWeixinDeliveryHealth(project.ownerUserId, project.instanceId),
    };
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
    const result = await manager.pushTextDetailed(text, { userId: project.ownerUserId, instanceId: project.instanceId });
    await recordWeixinDeliveryAttempt({
      userId: project.ownerUserId,
      instanceId: project.instanceId,
      source: "platform_manual_probe",
      probe: true,
      result,
    });
    if (!result.ok) {
      return reply.status(409).send({
        ok: false,
        message: "微信探测未提交成功，请查看会话活性和失败原因。",
        delivery: await getWeixinDeliveryHealth(project.ownerUserId, project.instanceId),
        state: manager.getState(),
      });
    }
    return { ok: true, probe: true, delivery: await getWeixinDeliveryHealth(project.ownerUserId, project.instanceId), state: manager.getState() };
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

  app.get<{ Params: { instanceId: string } }>("/api/platform/instances/:instanceId/investment-state", safe(async (request, reply) => {
    const project = await getProjectRuntimeContext(request.params.instanceId).catch(() => null);
    if (!project || project.status === "archived") return reply.status(404).send({ ok: false, error: "实例不存在或已归档" });
    const userId = project.ownerUserId;
    const instanceId = project.instanceId;
    if (!workspaceExists(userId)) {
      return {
        ok: true,
        updatedAt: new Date().toISOString(),
        workspaceReady: false,
        instance: {
          instanceId,
          name: project.name,
          ownerUserId: userId,
        },
        summary: {
          holdingCount: 0,
          watchlistCount: 0,
          planCount: 0,
          activeWatchRuleCount: 0,
          totalWatchRuleCount: 0,
          latestReviewDate: null,
          openViewpointCount: 0,
        },
        holdings: [],
        watchlist: [],
        plans: [],
        recentReviews: [],
        viewpoints: [],
      };
    }
    const today = new Date().toISOString().slice(0, 10);
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [holdings, watchlist, plans, watchRules, recentDailyPlans, recentViewpoints] = await Promise.all([
      portfolioBackend.listActive(userId, instanceId).catch(() => []),
      watchlistBackend.list(userId, instanceId).catch(() => []),
      planBackend.list(userId, instanceId).catch(() => []),
      listWatchRules(userId, instanceId).catch(() => []),
      dailyPlanBackend.listInRange(userId, instanceId, startDate, today).catch(() => []),
      reviewViewpointBackend.list(userId, instanceId, { limit: 5 }).catch(() => []),
    ]);
    const activeWatchRules = watchRules.filter((rule) => rule.enabled !== false);
    const openViewpoints = recentViewpoints.filter((viewpoint) => viewpoint.status === "open");
    const latestReview = recentDailyPlans.length > 0 ? recentDailyPlans[0] : null;
    return {
      ok: true,
      updatedAt: new Date().toISOString(),
      workspaceReady: true,
      instance: {
        instanceId,
        name: project.name,
        ownerUserId: userId,
      },
      summary: {
        holdingCount: holdings.length,
        watchlistCount: watchlist.length,
        planCount: plans.length,
        activeWatchRuleCount: activeWatchRules.length,
        totalWatchRuleCount: watchRules.length,
        latestReviewDate: latestReview?.planDate ?? null,
        openViewpointCount: openViewpoints.length,
      },
      holdings: holdings.slice(0, 12).map((row) => ({
        code: row.code,
        name: row.name,
        buyDate: row.buyDate,
        costPrice: row.costPrice ?? null,
      })),
      watchlist: watchlist.slice(0, 12).map((row) => ({
        code: row.code,
        name: row.name,
        reason: row.reason ?? null,
        addedAt: row.addedAt ?? null,
      })),
      plans: plans.slice(0, 12).map((row) => ({
        code: row.code,
        name: row.name,
        support: row.support ?? null,
        resistance: row.resistance ?? null,
        targetPrice: row.targetPrice ?? null,
        stopLoss: row.stopLoss ?? null,
        strategyKey: row.strategyKey ?? null,
      })),
      recentReviews: recentDailyPlans.slice(0, 5).map((row) => ({
        date: row.planDate,
        generatedAt: row.generatedAt,
        summary: row.summary ?? null,
      })),
      viewpoints: recentViewpoints.slice(0, 5).map((row) => ({
        id: row.id,
        sourceDate: row.sourceDate,
        view: row.view,
        status: row.status,
        expectedReviewDate: row.expectedReviewDate,
      })),
    };
  }));
}
