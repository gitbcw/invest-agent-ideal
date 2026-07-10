import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { and, count, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { renderPlatformPage } from "../admin/platform-page.js";
import { db, sqlite } from "../db/index.js";
import { aiInstances, alertEvents, alertRules, channelIdentities, channelIdentityInstances, codexAcpTraces, pushJobs, scheduledTaskRuns, users } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { createInvestAgentInstance, deleteInvestAgentInstance, getProjectRuntimeContext, listProjectRuntimeContexts, type AiProjectRuntimeContext } from "../platform/project-registry.js";
import { WeixinMobileManager } from "../channels/weixin-mobile.js";
import { config } from "../lib/config.js";
import { ensureWorkspace, resolveWorkspacePath } from "../lib/workspace.js";
import { planBackend, portfolioBackend, watchlistBackend } from "../lib/data-backend.js";
import { disposeAcpForWorkspace, ensureCodexRuntimeForWorkspace, ensureHermesRuntimeForWorkspace } from "../acp/stdio-agent.js";
import { loadCodexWorkspaceUsageSummary, type CodexUsageGroupBy } from "../services/codex-usage.js";
import { DEFAULT_INSTANCE_ID } from "../lib/user-context.js";
import { marketHealth } from "../services/market-data.js";
import { getAlertInterval } from "../scheduler/index.js";
import { createPlatformSession, hasPlatformSession, isLoopbackAddress, platformSessionCookie } from "../lib/platform-session.js";

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
    "alerts",
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

  app.get("/platform", async (request, reply) => {
    if (!isLoopbackAddress(request.ip)) {
      return reply.status(403).send({ ok: false, error: "Platform 仅允许本机访问" });
    }
    if (!hasPlatformSession(request.headers.cookie)) {
      const session = createPlatformSession();
      reply.header("set-cookie", platformSessionCookie(session.id, session.maxAgeSeconds));
    }
    return reply.type("text/html; charset=utf-8").send(renderPlatformPage({
      portalPublicUrl: config.portal.publicUrl,
    }));
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
