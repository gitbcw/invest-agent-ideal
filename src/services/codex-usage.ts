import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveWorkspacePath } from "../lib/workspace.js";
import type { AiProjectRuntimeContext } from "../platform/project-registry.js";

export type CodexUsageGroupBy = "day" | "instance" | "user" | "model";

export interface CodexUsageSummaryRow {
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

export interface CodexUsageSummary {
  filters: {
    userId: string;
    instanceId: string;
    days: number;
    groupBy: CodexUsageGroupBy;
    since: string;
    scopeUnsupported: boolean;
  };
  totals: CodexUsageSummaryRow;
  groups: CodexUsageSummaryRow[];
}

interface CodexUsageEntry {
  userId: string;
  instanceId: string;
  model: string;
  timestamp: Date;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  thoughtTokens: number;
}

type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  cache_read_input_tokens?: number;
  reasoning_output_tokens?: number;
};

function findJsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonlFiles(fullPath));
    } else if (entry.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }
  return results;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageFromTokenInfo(info: Record<string, unknown>, prevTotal: Map<string, TokenUsage>, model: string): TokenUsage | null {
  const last = info.last_token_usage;
  if (last && typeof last === "object") return last as TokenUsage;

  const total = info.total_token_usage;
  if (!total || typeof total !== "object") return null;

  const curr = total as TokenUsage;
  const prev = prevTotal.get(model);
  prevTotal.set(model, { ...curr });
  if (!prev) return curr;
  return {
    input_tokens: optionalNumber(curr.input_tokens) - optionalNumber(prev.input_tokens),
    output_tokens: optionalNumber(curr.output_tokens) - optionalNumber(prev.output_tokens),
    cached_input_tokens: optionalNumber(curr.cached_input_tokens) - optionalNumber(prev.cached_input_tokens),
    cache_read_input_tokens: optionalNumber(curr.cache_read_input_tokens) - optionalNumber(prev.cache_read_input_tokens),
    reasoning_output_tokens: optionalNumber(curr.reasoning_output_tokens) - optionalNumber(prev.reasoning_output_tokens),
  };
}

function parseCodexSessionFile(input: {
  filePath: string;
  userId: string;
  instanceId: string;
  sinceMs: number;
}): CodexUsageEntry[] {
  let content = "";
  try {
    content = readFileSync(input.filePath, "utf-8");
  } catch {
    return [];
  }

  const entries: CodexUsageEntry[] = [];
  const prevTotal = new Map<string, TokenUsage>();
  let turnContextModel = "unknown";
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, any>;
      if (obj.type === "turn_context" && obj.payload?.model) {
        turnContextModel = String(obj.payload.model);
        continue;
      }
      if (obj.type !== "event_msg" || obj.payload?.type !== "token_count") continue;

      const timestamp = obj.timestamp ? new Date(obj.timestamp) : null;
      if (!timestamp || !Number.isFinite(timestamp.getTime()) || timestamp.getTime() < input.sinceMs) continue;

      const info = obj.payload.info;
      if (!info || typeof info !== "object") continue;
      const model = String(info.model || obj.payload.model || turnContextModel || "unknown");
      const usage = usageFromTokenInfo(info, prevTotal, model);
      if (!usage) continue;

      const cachedReadTokens = Math.max(0, optionalNumber(usage.cached_input_tokens) || optionalNumber(usage.cache_read_input_tokens));
      const thoughtTokens = Math.max(0, optionalNumber(usage.reasoning_output_tokens));
      const rawInput = Math.max(0, optionalNumber(usage.input_tokens));
      const rawOutput = Math.max(0, optionalNumber(usage.output_tokens));

      entries.push({
        userId: input.userId,
        instanceId: input.instanceId,
        model,
        timestamp,
        inputTokens: Math.max(0, rawInput - cachedReadTokens),
        outputTokens: Math.max(0, rawOutput - thoughtTokens),
        cachedReadTokens,
        thoughtTokens,
      });
    } catch {
      continue;
    }
  }
  return entries;
}

function emptyRow(bucket = "total"): CodexUsageSummaryRow {
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

function addEntry(row: CodexUsageSummaryRow, entry: CodexUsageEntry) {
  row.calls += 1;
  row.inputTokens += entry.inputTokens;
  row.outputTokens += entry.outputTokens;
  row.thoughtTokens += entry.thoughtTokens;
  row.cachedReadTokens += entry.cachedReadTokens;
  row.totalTokens += entry.inputTokens + entry.outputTokens + entry.thoughtTokens;
  row.actualCalls += 1;
}

function bucketFor(entry: CodexUsageEntry, groupBy: CodexUsageGroupBy) {
  if (groupBy === "instance") return entry.instanceId;
  if (groupBy === "user") return entry.userId;
  if (groupBy === "model") return entry.model;
  return entry.timestamp.toISOString().slice(0, 10);
}

function sessionFingerprint(instance: AiProjectRuntimeContext) {
  return createHash("sha256").update(`${instance.ownerUserId}:${instance.instanceId}`).digest("hex").slice(0, 12);
}

export function loadCodexWorkspaceUsageSummary(input: {
  instances: AiProjectRuntimeContext[];
  userId?: string;
  instanceId?: string;
  days?: number;
  groupBy?: CodexUsageGroupBy;
}): CodexUsageSummary {
  const days = Math.max(1, Math.min(Number(input.days || 30), 365));
  const groupBy = input.groupBy || "day";
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const sinceMs = Date.parse(since);
  const entries: CodexUsageEntry[] = [];

  for (const instance of input.instances) {
    if (input.userId && instance.ownerUserId !== input.userId) continue;
    if (input.instanceId && instance.instanceId !== input.instanceId) continue;
    const sessionsDir = path.join(resolveWorkspacePath(instance.ownerUserId), ".codex", "sessions");
    const files = findJsonlFiles(sessionsDir);
    for (const filePath of files) {
      entries.push(...parseCodexSessionFile({
        filePath,
        userId: instance.ownerUserId,
        instanceId: instance.instanceId,
        sinceMs,
      }));
    }
  }

  const totals = emptyRow("total");
  const groups = new Map<string, CodexUsageSummaryRow>();
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
      scopeUnsupported: true,
    },
    totals,
    groups: sortedGroups,
  };
}

export function codexUsageDebugKey(instance: AiProjectRuntimeContext) {
  return sessionFingerprint(instance);
}
