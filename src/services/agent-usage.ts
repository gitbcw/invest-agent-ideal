import { sqlite } from "../db/index.js";
import type { AiProjectRuntimeContext } from "../platform/project-registry.js";

export type AgentUsageGroupBy = "day" | "instance" | "user" | "model";

export interface AgentUsageSummaryRow {
  bucket: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  totalTokens: number;
  costAmount: number;
  actualCalls: number;
  estimatedCalls: number;
}

export interface AgentUsageSummary {
  filters: {
    userId: string;
    instanceId: string;
    days: number;
    groupBy: AgentUsageGroupBy;
    since: string;
    scopeUnsupported: boolean;
  };
  source: "agent_traces";
  totals: AgentUsageSummaryRow;
  groups: AgentUsageSummaryRow[];
}

interface AgentUsageEntry {
  userId: string;
  instanceId: string;
  model: string;
  timestamp: Date;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  thoughtTokens: number;
  totalTokens: number;
  costAmount: number;
  estimated: boolean;
}

interface AgentTraceUsageRow {
  userId: string;
  instanceId: string;
  model: string | null;
  createdAt: string;
  inputTokens: number | null;
  outputTokens: number | null;
  thoughtTokens: number | null;
  cachedReadTokens: number | null;
  cachedWriteTokens: number | null;
  totalTokens: number | null;
  costAmount: number | null;
  usageSource: string | null;
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nonNegativeNumber(value: unknown): number {
  return Math.max(0, finiteNumber(value));
}

function emptyRow(bucket = "total"): AgentUsageSummaryRow {
  return {
    bucket,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    totalTokens: 0,
    costAmount: 0,
    actualCalls: 0,
    estimatedCalls: 0,
  };
}

function addEntry(row: AgentUsageSummaryRow, entry: AgentUsageEntry) {
  row.calls += 1;
  row.inputTokens += entry.inputTokens;
  row.outputTokens += entry.outputTokens;
  row.thoughtTokens += entry.thoughtTokens;
  row.cachedReadTokens += entry.cachedReadTokens;
  row.cachedWriteTokens += entry.cachedWriteTokens;
  row.totalTokens += entry.totalTokens;
  row.costAmount += entry.costAmount;
  if (entry.estimated) row.estimatedCalls += 1;
  else row.actualCalls += 1;
}

function bucketFor(entry: AgentUsageEntry, groupBy: AgentUsageGroupBy) {
  if (groupBy === "instance") return entry.instanceId;
  if (groupBy === "user") return entry.userId;
  if (groupBy === "model") return entry.model;
  return entry.timestamp.toISOString().slice(0, 10);
}

function readTraceUsageRows(input: {
  instanceIds: string[];
  userId?: string;
  instanceId?: string;
  since: string;
}): AgentTraceUsageRow[] {
  if (input.instanceIds.length === 0) return [];

  const placeholders = input.instanceIds.map(() => "?").join(", ");
  const filters = ["created_at >= ?", `instance_id IN (${placeholders})`];
  const params: unknown[] = [input.since, ...input.instanceIds];
  if (input.userId) {
    filters.push("user_id = ?");
    params.push(input.userId);
  }
  if (input.instanceId) {
    filters.push("instance_id = ?");
    params.push(input.instanceId);
  }

  return sqlite
    .prepare(
      `SELECT
         user_id AS userId,
         instance_id AS instanceId,
         agent_model AS model,
         created_at AS createdAt,
         input_tokens AS inputTokens,
         output_tokens AS outputTokens,
         thought_tokens AS thoughtTokens,
         cached_read_tokens AS cachedReadTokens,
         cached_write_tokens AS cachedWriteTokens,
         total_tokens AS totalTokens,
         cost_amount AS costAmount,
         usage_source AS usageSource
       FROM agent_traces
       WHERE ${filters.join(" AND ")}
       ORDER BY created_at DESC`,
    )
    .all(...params) as AgentTraceUsageRow[];
}

function normalizeEntry(row: AgentTraceUsageRow): AgentUsageEntry | null {
  const timestamp = new Date(row.createdAt);
  if (!Number.isFinite(timestamp.getTime())) return null;

  const inputTokens = nonNegativeNumber(row.inputTokens);
  const outputTokens = nonNegativeNumber(row.outputTokens);
  const thoughtTokens = nonNegativeNumber(row.thoughtTokens);
  const cachedReadTokens = nonNegativeNumber(row.cachedReadTokens);
  const cachedWriteTokens = nonNegativeNumber(row.cachedWriteTokens);
  const reportedTotal = finiteNumber(row.totalTokens);
  const totalTokens = reportedTotal > 0
    ? reportedTotal
    : inputTokens + outputTokens + thoughtTokens;

  return {
    userId: String(row.userId || "unknown"),
    instanceId: String(row.instanceId || "unknown"),
    model: String(row.model || "unknown"),
    timestamp,
    inputTokens,
    outputTokens,
    thoughtTokens,
    cachedReadTokens,
    cachedWriteTokens,
    totalTokens: Math.max(0, totalTokens),
    costAmount: nonNegativeNumber(row.costAmount),
    estimated: row.usageSource !== "actual",
  };
}

/** Aggregate neutral agent usage from persisted execution traces. */
export function loadAgentUsageSummary(input: {
  instances: AiProjectRuntimeContext[];
  userId?: string;
  instanceId?: string;
  days?: number;
  groupBy?: AgentUsageGroupBy;
}): AgentUsageSummary {
  const days = Math.max(1, Math.min(Number(input.days || 30), 365));
  const groupBy = input.groupBy || "day";
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const instanceIds = input.instances
    .map((instance) => instance.instanceId)
    .filter((instanceId): instanceId is string => Boolean(instanceId));
  const entries = readTraceUsageRows({
    instanceIds,
    userId: input.userId,
    instanceId: input.instanceId,
    since,
  })
    .map(normalizeEntry)
    .filter((entry): entry is AgentUsageEntry => entry !== null);

  const totals = emptyRow("total");
  const groups = new Map<string, AgentUsageSummaryRow>();
  for (const entry of entries) {
    addEntry(totals, entry);
    const bucket = bucketFor(entry, groupBy);
    const existing = groups.get(bucket) || emptyRow(bucket);
    addEntry(existing, entry);
    groups.set(bucket, existing);
  }

  const sortedGroups = [...groups.values()].sort((a, b) => {
    if (groupBy === "day") return String(b.bucket).localeCompare(String(a.bucket));
    return b.totalTokens - a.totalTokens || String(a.bucket).localeCompare(String(b.bucket));
  });

  return {
    filters: {
      userId: input.userId || "",
      instanceId: input.instanceId || "",
      days,
      groupBy,
      since,
      scopeUnsupported: false,
    },
    source: "agent_traces",
    totals,
    groups: sortedGroups,
  };
}
