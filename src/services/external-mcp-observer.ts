import { db } from "../db/index.js";
import { sqlite } from "../db/index.js";
import { externalMcpToolCalls } from "../db/schema.js";
import { buildExternalRegistrations, isExternalRegistrationActivated } from "../acp/external-mcp-registrations.js";
import { resolveExternalHttpServer } from "../acp/mcp-registry.js";

export type ExternalMcpObserverScope = {
  userId: string;
  projectId: string;
  instanceId: string;
  conversationId?: string;
  /** Per prompt/run correlation key; for ACP calls this equals codex_acp_traces.message_id. */
  runId?: string;
};

export type ExternalMcpToolCallBudget = {
  /** Maximum external `tools/call` requests for one ACP turn. */
  maxCalls: number;
  /** Maximum consecutive requests for exactly the same external tool. */
  maxConsecutiveCalls: number;
};

export type ExternalMcpToolCallBudgetState = {
  totalCalls: number;
  lastToolKey?: string;
  consecutiveCalls: number;
};

export type ExternalMcpToolCallBudgetDecision =
  | { allowed: true; totalCalls: number; consecutiveCalls: number }
  | {
      allowed: false;
      reason: "total_calls" | "consecutive_calls";
      totalCalls: number;
      consecutiveCalls: number;
    };

const DEFAULT_EXTERNAL_MCP_MAX_CALLS_PER_TURN = 12;
const DEFAULT_EXTERNAL_MCP_MAX_CONSECUTIVE_CALLS = 4;
const MAX_BUDGET_VALUE = 100;

/**
 * Parse the service-owned guardrail. A non-positive value explicitly disables
 * the corresponding cap, which is useful for a controlled compatibility test.
 */
export function resolveExternalMcpToolCallBudget(env: NodeJS.ProcessEnv = process.env): ExternalMcpToolCallBudget {
  return {
    maxCalls: boundedBudget(env.EXTERNAL_MCP_MAX_CALLS_PER_TURN, DEFAULT_EXTERNAL_MCP_MAX_CALLS_PER_TURN),
    maxConsecutiveCalls: boundedBudget(
      env.EXTERNAL_MCP_MAX_CONSECUTIVE_CALLS,
      DEFAULT_EXTERNAL_MCP_MAX_CONSECUTIVE_CALLS,
    ),
  };
}

function boundedBudget(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), MAX_BUDGET_VALUE);
}

/**
 * Decide and reserve a call atomically in the caller's per-turn state. The
 * observer invokes this before forwarding, so concurrent requests cannot
 * overrun the budget merely because their upstream responses overlap.
 */
export function reserveExternalMcpToolCall(input: {
  state: ExternalMcpToolCallBudgetState;
  serverId: string;
  toolName: string;
  budget: ExternalMcpToolCallBudget;
}): ExternalMcpToolCallBudgetDecision {
  const toolKey = `${input.serverId}\u0000${input.toolName}`;
  const nextConsecutive = input.state.lastToolKey === toolKey
    ? input.state.consecutiveCalls + 1
    : 1;
  if (input.budget.maxCalls > 0 && input.state.totalCalls >= input.budget.maxCalls) {
    return {
      allowed: false,
      reason: "total_calls",
      totalCalls: input.state.totalCalls,
      consecutiveCalls: nextConsecutive,
    };
  }
  if (input.budget.maxConsecutiveCalls > 0 && nextConsecutive > input.budget.maxConsecutiveCalls) {
    return {
      allowed: false,
      reason: "consecutive_calls",
      totalCalls: input.state.totalCalls,
      consecutiveCalls: nextConsecutive,
    };
  }
  input.state.totalCalls += 1;
  input.state.lastToolKey = toolKey;
  input.state.consecutiveCalls = nextConsecutive;
  return { allowed: true, totalCalls: input.state.totalCalls, consecutiveCalls: nextConsecutive };
}

export function resolveObservedExternalMcp(serverId: string, env: NodeJS.ProcessEnv = process.env) {
  const registration = buildExternalRegistrations().find((item) => item.id === serverId);
  if (!registration || !isExternalRegistrationActivated(registration, env)) return null;
  const resolved = resolveExternalHttpServer(registration, env);
  return resolved ? { registration, resolved } : null;
}

export function observedToolCallFromBody(body: unknown) {
  if (!body || typeof body !== "object") return null;
  const rpc = body as { method?: unknown; id?: unknown; params?: { name?: unknown } };
  if (rpc.method !== "tools/call" || typeof rpc.params?.name !== "string") return null;
  return {
    toolName: rpc.params.name,
    requestId: typeof rpc.id === "string" || typeof rpc.id === "number" ? String(rpc.id) : undefined,
  };
}

export async function recordObservedExternalToolCall(input: {
  scope: ExternalMcpObserverScope;
  serverId: string;
  toolName: string;
  requestId?: string;
  status: "completed" | "failed";
  elapsedMs: number;
  inputChars?: number;
  outputChars?: number;
  errorClass?: string;
}) {
  await db.insert(externalMcpToolCalls).values({
    userId: input.scope.userId,
    projectId: input.scope.projectId,
    instanceId: input.scope.instanceId,
    conversationId: input.scope.conversationId,
    runId: input.scope.runId,
    serverId: input.serverId,
    toolName: input.toolName,
    requestId: input.requestId,
    status: input.status,
    elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
    inputChars: input.inputChars,
    outputChars: input.outputChars,
    errorClass: input.errorClass,
    createdAt: new Date().toISOString(),
  });
}

export function serializedSize(value: unknown): number | undefined {
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : undefined;
  } catch {
    return undefined;
  }
}

// ─── T-243 聚合读取 ────────────────────────────────────────────────
//
// observer 一直在写 external_mcp_tool_calls,但此前 src 内零读取 (只写不读)。
// 下面是面向 Platform UI 的聚合 read API,把采集到的数据接通成可见。
// 按 server_id + tool_name 分组,给出调用量 / 成功率 / p95 延迟 / 最近错误。

export type ExternalMcpToolStat = {
  serverId: string;
  toolName: string;
  totalCalls: number;
  completed: number;
  failed: number;
  failureRate: number;
  /** 最近成功时间 (ISO)。 */
  lastCompletedAt: string | null;
  /** 最近一次失败时间 (ISO)。 */
  lastFailedAt: string | null;
  /** 最近一次失败错误类 (如 HTTP_500 / UPSTREAM_ERROR)。 */
  lastErrorClass: string | null;
  /** 样本 p95 延迟 (毫秒),窗口内最近 max(1, totalCalls) 条采样。 */
  latencyP95Ms: number | null;
};

export type ExternalMcpToolStatSummary = {
  updatedAt: string;
  /** 窗口天数 (默认 7)。 */
  days: number;
  /** server+tool 维度统计行。 */
  stats: ExternalMcpToolStat[];
  /** 已声明的外部注册项 (无论是否激活),供 UI 展示"已接入工具集"。 */
  registrations: Array<{
    id: string;
    activated: boolean;
    trustClass: string;
    sessionKinds: string[];
  }>;
};

/**
 * 聚合 external_mcp_tool_calls 的统计。仅 GROUP BY server/tool + COUNT/时间戳,
 * 不读取任何 body/参数/结果 (observer 写入时本就不存这些)。
 *
 * latencyP95 用 SQLite 取窗口内该组 elapsed_ms 的第 95 百分位近似
 * (better-sqlite3 无原生 percentile,这里用排序后行号取近似,样本量小够用)。
 */
export function readExternalMcpToolCallStats(
  options: { days?: number } = {},
): ExternalMcpToolStatSummary {
  const days = Math.max(1, Math.min(90, Number(options.days) || 7));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // 聚合行:窗口内每 server+tool 的调用量/成功失败/最近时间戳/最近错误类。
  const rows = sqlite
    .prepare(
      `SELECT server_id AS serverId,
              tool_name AS toolName,
              COUNT(*) AS totalCalls,
              SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
              MAX(CASE WHEN status='completed' THEN created_at END) AS lastCompletedAt,
              MAX(CASE WHEN status='failed' THEN created_at END) AS lastFailedAt,
              (SELECT error_class FROM external_mcp_tool_calls AS inner_t
                 WHERE inner_t.server_id = outer_t.server_id
                   AND inner_t.tool_name = outer_t.tool_name
                   AND inner_t.status = 'failed'
                 ORDER BY inner_t.created_at DESC LIMIT 1) AS lastErrorClass
       FROM external_mcp_tool_calls AS outer_t
       WHERE created_at >= ?
       GROUP BY server_id, tool_name
       ORDER BY totalCalls DESC`,
    )
    .all(since) as Array<{
      serverId: string;
      toolName: string;
      totalCalls: number;
      completed: number;
      failed: number;
      lastCompletedAt: string | null;
      lastFailedAt: string | null;
      lastErrorClass: string | null;
    }>;

  // p95 延迟:对每个 server+tool 取窗口内 elapsed_ms 排序后近似第 95 百分位。
  const stats: ExternalMcpToolStat[] = rows.map((row) => {
    const latencySamples = sqlite
      .prepare(
        `SELECT elapsed_ms AS elapsedMs FROM external_mcp_tool_calls
         WHERE server_id = ? AND tool_name = ? AND created_at >= ?
         ORDER BY elapsed_ms ASC`,
      )
      .all(row.serverId, row.toolName, since) as Array<{ elapsedMs: number }>;
    const latencyP95Ms = percentileFromSamples(
      latencySamples.map((sample) => sample.elapsedMs),
      0.95,
    );
    const failureRate = row.totalCalls > 0 ? row.failed / row.totalCalls : 0;
    return {
      serverId: row.serverId,
      toolName: row.toolName,
      totalCalls: row.totalCalls,
      completed: row.completed,
      failed: row.failed,
      failureRate: Number(failureRate.toFixed(4)),
      lastCompletedAt: row.lastCompletedAt,
      lastFailedAt: row.lastFailedAt,
      lastErrorClass: row.lastErrorClass,
      latencyP95Ms,
    };
  });

  const registrations = buildExternalRegistrations().map((reg) => ({
    id: reg.id,
    activated: isExternalRegistrationActivated(reg),
    trustClass: reg.trustClass,
    sessionKinds: reg.sessionKinds,
  }));

  return { updatedAt: new Date().toISOString(), days, stats, registrations };
}

function percentileFromSamples(values: number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? null;
}
