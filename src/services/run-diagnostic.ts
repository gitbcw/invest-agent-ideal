import { eq, inArray, or, sql, type Column } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  agentTraces,
  automationTaskRuns,
  conversationArtifacts,
  conversationMessages,
  conversationSessions,
  externalMcpToolCalls,
  pushJobs,
  sandboxAuditLogs,
  scheduledTaskRuns,
  weixinDeliveryAttempts,
} from "../db/schema.js";

/**
 * WP3 运行诊断链：从一个入口 ID（traceId/messageId/conversationId/runId/taskId/deliveryId）
 * 出发，用显式 ID 关联收集整条链路节点，并给出缺失关联计数。
 *
 * 契约：docs/run-diagnostic-view-contract.md
 * - 只用显式 ID 关联（列值相等），绝不使用时间邻近猜测。
 * - 不适用节点显式为 n.a.（applicable=false），不计入缺失。
 * - 旧数据（无 trace_id 的 audit、无 runId 的 scheduler trace）计入缺失计数，
 *   不是治理证据。
 */

export type DiagnosticEntryType =
  | "traceId"
  | "messageId"
  | "conversationId"
  | "runId"
  | "taskId"
  | "deliveryId";

export const DIAGNOSTIC_ENTRY_TYPES: readonly DiagnosticEntryType[] = [
  "traceId", "messageId", "conversationId", "runId", "taskId", "deliveryId",
] as const;

function isDiagnosticEntryType(value: string): value is DiagnosticEntryType {
  return (DIAGNOSTIC_ENTRY_TYPES as readonly string[]).includes(value);
}

export function parseDiagnosticEntryType(value: string | undefined): DiagnosticEntryType {
  const trimmed = value?.trim();
  if (!trimmed || !isDiagnosticEntryType(trimmed)) {
    throw new Error(`diagnostic entry type must be one of ${DIAGNOSTIC_ENTRY_TYPES.join("|")}`);
  }
  return trimmed;
}

export interface RunDiagnostic {
  ok: true;
  entry: { by: DiagnosticEntryType; id: string; resolved: boolean };
  scope: { userIds: string[]; conversationIds: string[]; channels: string[] };
  nodes: {
    conversation: { session: typeof conversationSessions.$inferSelect | null; messages: (typeof conversationMessages.$inferSelect)[] };
    traces: (typeof agentTraces.$inferSelect)[];
    mcpToolCalls: (typeof externalMcpToolCalls.$inferSelect)[];
    audits: ((typeof sandboxAuditLogs.$inferSelect) & { correlation: "trace" | "conversation" })[];
    artifacts: (typeof conversationArtifacts.$inferSelect)[];
    automationRuns: (typeof automationTaskRuns.$inferSelect)[];
    scheduledRuns: (typeof scheduledTaskRuns.$inferSelect)[];
    pushJobs: (typeof pushJobs.$inferSelect)[];
    deliveries: (typeof weixinDeliveryAttempts.$inferSelect)[];
  };
  applicable: {
    conversation: boolean;
    scheduler: boolean;
    automation: boolean;
    push: boolean;
    artifacts: boolean;
  };
  missingLinks: {
    tracesWithoutConversationId: number;
    tracesWithoutTraceId: number;
    auditsWithoutTraceId: number;
    scheduledRunsWithoutTraceLink: number;
    pushJobsWithoutOriginRun: number;
    deliveriesWithoutPushJobLink: number;
    artifactsWithoutMessageLink: number;
  };
  notes: string[];
}

function unique(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

export async function buildRunDiagnostic(by: DiagnosticEntryType, rawId: string): Promise<RunDiagnostic> {
  const id = rawId.trim();
  if (!id) throw new Error("diagnostic entry id is required");

  // 1. 解析锚点：入口 ID → trace 集合（deliveryId 先落到 push，再经 origin 反查）。
  const pushSeed = by === "deliveryId"
    ? (await db.select().from(pushJobs).where(eq(pushJobs.id, id)).limit(1))
    : [];
  const anchorRunIds = unique([by === "runId" ? id : undefined]);
  let traces: (typeof agentTraces.$inferSelect)[] = [];
  if (by === "deliveryId") {
    const originKeys = unique([pushSeed[0]?.originRunId, pushSeed[0]?.originTaskKey, ...anchorRunIds]);
    traces = originKeys.length > 0
      ? await db.select().from(agentTraces).where(inArray(agentTraces.runId, originKeys))
      : [];
  } else if (by === "traceId" || by === "messageId") {
    traces = await db.select().from(agentTraces).where(inArray(agentTraces.traceId, [id]));
  } else if (by === "conversationId") {
    traces = await db.select().from(agentTraces).where(inArray(agentTraces.conversationId, [id]));
  } else if (by === "runId") {
    traces = await db.select().from(agentTraces).where(inArray(agentTraces.runId, [id]));
  } else {
    traces = await db.select().from(agentTraces).where(inArray(agentTraces.taskId, [id]));
  }

  const traceIds = unique(traces.map((trace) => trace.traceId));
  const runIds = unique([
    ...traces.map((trace) => trace.runId),
    ...anchorRunIds,
    pushSeed[0]?.originRunId,
    pushSeed[0]?.originTaskKey,
  ]);
  const taskIds = unique([...traces.map((trace) => trace.taskId), by === "taskId" ? id : undefined]);
  const conversationIds = unique(traces.map((trace) => trace.conversationId));
  const userIds = unique(traces.map((trace) => trace.userId));

  // 2. 逐节点收集（全部显式 ID 匹配，无时间邻近）。`.where(undefined)` 在
  // drizzle 是"无条件全表"，因此空关联集必须整段跳过，不得发出查询。
  const [sessionRow] = conversationIds.length === 1
    ? await db.select().from(conversationSessions).where(eq(conversationSessions.conversationId, conversationIds[0])).limit(1)
    : [];
  const messages = conversationIds.length > 0
    ? await db.select().from(conversationMessages)
      .where(inArray(conversationMessages.conversationId, conversationIds))
      .orderBy(conversationMessages.createdAt)
      .limit(200)
    : [];

  const observerKeys = unique([...traceIds, ...runIds]);
  const mcpToolCalls = observerKeys.length > 0
    ? await db.select().from(externalMcpToolCalls)
      .where(inArray(externalMcpToolCalls.runId, observerKeys))
      .limit(500)
    : [];

  const auditByTrace = traceIds.length > 0
    ? await db.select().from(sandboxAuditLogs)
      .where(inArray(sandboxAuditLogs.traceId, traceIds))
      .limit(500)
    : [];
  const auditByConversation = conversationIds.length > 0
    ? await db.select().from(sandboxAuditLogs)
      .where(inArray(sandboxAuditLogs.conversationId, conversationIds))
      .limit(500)
    : [];
  const seenAuditIds = new Set(auditByTrace.map((row) => row.id));
  const audits = [
    ...auditByTrace.map((row) => ({ ...row, correlation: "trace" as const })),
    ...auditByConversation
      .filter((row) => !seenAuditIds.has(row.id))
      .map((row) => ({ ...row, correlation: "conversation" as const })),
  ];

  const artifacts = conversationIds.length > 0
    ? await db.select().from(conversationArtifacts)
      .where(inArray(conversationArtifacts.conversationId, conversationIds))
      .limit(200)
    : [];

  const automationConditions = [
    traceIds.length > 0 ? inArray(automationTaskRuns.traceId, traceIds) : undefined,
    runIds.length > 0 ? inArray(automationTaskRuns.runId, runIds) : undefined,
    taskIds.length > 0 ? inArray(automationTaskRuns.taskId, taskIds) : undefined,
  ].filter((condition) => condition !== undefined);
  const automationRuns = automationConditions.length > 0
    ? await db.select().from(automationTaskRuns)
      .where(automationConditions.length === 1 ? automationConditions[0] : or(...automationConditions))
      .limit(100)
    : [];

  const scheduledRuns = runIds.length > 0
    ? await db.select().from(scheduledTaskRuns)
      .where(inArray(scheduledTaskRuns.taskKey, runIds))
      .limit(50)
    : [];

  const pushJobIds = unique([
    by === "deliveryId" ? id : undefined,
    ...automationRuns.map((row) => row.pushJobId),
    ...scheduledRuns.map((row) => row.pushJobId),
  ]);
  const pushConditions = [
    pushJobIds.length > 0 ? inArray(pushJobs.id, pushJobIds) : undefined,
    runIds.length > 0 ? inArray(pushJobs.originRunId, runIds) : undefined,
  ].filter((condition) => condition !== undefined);
  const pushJobsRows = pushConditions.length > 0
    ? await db.select().from(pushJobs)
      .where(pushConditions.length === 1 ? pushConditions[0] : or(...pushConditions))
      .limit(100)
    : [];

  const deliveryIds = unique(pushJobsRows.map((row) => row.id));
  const deliveries = deliveryIds.length > 0
    ? await db.select().from(weixinDeliveryAttempts)
      .where(inArray(weixinDeliveryAttempts.pushJobId, deliveryIds))
      .orderBy(weixinDeliveryAttempts.createdAt)
      .limit(200)
    : [];

  // 3. 适用性（n.a. 语义）与缺失计数。
  const applicable = {
    conversation: conversationIds.length > 0,
    scheduler: scheduledRuns.length > 0,
    automation: automationRuns.length > 0 || taskIds.length > 0,
    push: pushJobsRows.length > 0,
    artifacts: artifacts.length > 0,
  };
  const missingLinks = {
    tracesWithoutConversationId: traces.filter((trace) => !trace.conversationId || trace.conversationId === "unknown").length,
    tracesWithoutTraceId: traces.filter((trace) => !trace.traceId).length,
    auditsWithoutTraceId: audits.filter((row) => !row.traceId).length,
    scheduledRunsWithoutTraceLink: scheduledRuns.filter((row) => !runIds.includes(row.taskKey)).length,
    pushJobsWithoutOriginRun: pushJobsRows.filter((row) => !row.originRunId && !row.originTaskKey).length,
    deliveriesWithoutPushJobLink: deliveries.filter((row) => !row.pushJobId).length,
    artifactsWithoutMessageLink: artifacts.filter((row) => !row.messageId).length,
  };
  const notes = [
    "关联只使用显式 ID 相等；不使用时间邻近推断。",
    "correlation=conversation 的 audit 是会话级显式关联（同 conversationId），非 trace 级；无 trace_id 的 audit 计入 auditsWithoutTraceId。",
    "applicable=false 的节点类型对该入口是 n.a.，不计缺失。",
  ];

  return {
    ok: true,
    entry: {
      by,
      id,
      resolved: traces.length > 0 || messages.length > 0 || automationRuns.length > 0
        || scheduledRuns.length > 0 || pushJobsRows.length > 0,
    },
    scope: { userIds, conversationIds, channels: unique(traces.map((trace) => trace.channel)) },
    nodes: {
      conversation: { session: sessionRow ?? null, messages },
      traces,
      mcpToolCalls,
      audits,
      artifacts,
      automationRuns,
      scheduledRuns,
      pushJobs: pushJobsRows,
      deliveries,
    },
    applicable,
    missingLinks,
    notes,
  };
}

/** 覆盖率口径：audit 带 trace_id 的比例、scheduler run 有 trace 反链的比例。 */
export async function loadDiagnosticCoverage(days = 30): Promise<{
  windowDays: number;
  auditsTotal: number;
  auditsWithTraceId: number;
  auditsWithoutTraceId: number;
  scheduledRunsTotal: number;
  scheduledRunsWithTraceLink: number;
}> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const [auditStats] = await db.select({
    total: sql<number>`count(*)`,
    withTrace: sql<number>`sum(case when ${sandboxAuditLogs.traceId} is not null then 1 else 0 end)`,
  }).from(sandboxAuditLogs)
    .where(sql`${sandboxAuditLogs.createdAt} >= ${since}`);
  const [runStats] = await db.select({
    total: sql<number>`count(*)`,
    withTrace: sql<number>`sum(case when exists (select 1 from ${agentTraces} where ${agentTraces.runId} = ${scheduledTaskRuns.taskKey}) then 1 else 0 end)`,
  }).from(scheduledTaskRuns)
    .where(sql`${scheduledTaskRuns.createdAt} >= ${since}`);
  return {
    windowDays: days,
    auditsTotal: Number(auditStats?.total ?? 0),
    auditsWithTraceId: Number(auditStats?.withTrace ?? 0),
    auditsWithoutTraceId: Number(auditStats?.total ?? 0) - Number(auditStats?.withTrace ?? 0),
    scheduledRunsTotal: Number(runStats?.total ?? 0),
    scheduledRunsWithTraceLink: Number(runStats?.withTrace ?? 0),
  };
}
