/**
 * 通用 stdio ACP agent + 多后端注册中心。
 *
 * 当前支持 Hermes / Codex stdio ACP 后端:
 *   - hermes  ~/.local/bin/hermes acp --accept-hooks
 *   - codex   ~/.local/bin/codex-acp
 *
 * 三者都遵循 Agent Client Protocol v1,本类负责统一托管:
 *   - 子进程生命周期
 *   - 会话池(按 conversationId 复用)
 *   - 响应收集
 *   - 超时取消
 *
 * 切换后端时,通过 settings KV 持久化(`acp_backend` 字段)。
 * 切换会 dispose 当前活跃实例,下次调用时懒启动新的。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { settings } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { config } from "../lib/config.js";
import { isAcpDiagnosticText } from "../lib/customer-output.js";
import { type UserContext } from "../lib/user-context.js";
import {
  computeAllowlistFingerprint,
  resolveSessionMcpServers,
  type AcpMcpServer,
  type AcpMcpSessionManifest,
} from "./mcp-session-manifest.js";
import { probeToolConflicts, shouldBlockSessionOnConflict, type ToolConflictReport } from "./mcp-tool-conflict-probe.js";
import {
  AcpBudgetExhaustedError,
  AcpBudgetRun,
  DEFAULT_ACP_BUDGET_CONVERGENCE_MS,
  detectAcpBudgetExhaustion,
  probeAcpCapabilities,
  type AcpBudgetExhaustionType,
  type AcpBudgetRunSnapshot,
  type AcpCapabilityProbe,
} from "./budget-convergence.js";

const ACP_DEBUG_SESSION_UPDATES = process.env.ACP_DEBUG_SESSION_UPDATES === "1";
const ACP_DEBUG_PREVIEW_CHARS = Number(process.env.ACP_DEBUG_PREVIEW_CHARS) || 120;
const ACP_RESPONSE_COLLECTOR_MODE =
  process.env.ACP_RESPONSE_COLLECTOR_MODE === "full" ? "full" : "last_segment";

function awaitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new Error("TASK_CANCELLED"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("TASK_CANCELLED"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// R3: 工具冲突探针缓存——按 server 配置指纹缓存 tools/list + 冲突结果。
// 同配置不重复探针；session 复用时 getOrCreateSession 直接 return 不触发探针。
const toolConflictCache = new Map<string, { report: ToolConflictReport; checkedServers: string[] }>();

/**
 * R3: 在 newSession 前对多 server 配置做工具名冲突检查。
 * - 按 server 名+command+args 指纹缓存探针结果（同配置不重复 spawn）。
 * - 探针失败的外部 server 不阻断 service MCP（从结果 server 列表剔除）。
 * - 冲突时 fail closed：拒绝冲突的外部 server（保留 service-tools）。
 *   如果冲突涉及 service-tools 自身，抛错阻断整个会话。
 */
export async function checkToolConflictsBeforeSession(label: string, servers: AcpMcpServer[]): Promise<typeof servers> {
  const configFingerprint = createHash("sha256")
    .update(JSON.stringify(servers.map((server) => ({
      name: server.name,
      ...(server.type === "http"
        ? { type: "http", configFingerprint: server.configFingerprint }
        : {
            type: "stdio",
            command: server.command,
            args: server.args,
            env: [...server.env].sort((a, b) => a.name.localeCompare(b.name)),
          }),
    })).sort((a, b) => a.name.localeCompare(b.name))))
    .digest("hex");
  const cached = toolConflictCache.get(configFingerprint);
  let report: ToolConflictReport;
  let checkedServers: string[];

  if (cached) {
    report = cached.report;
    checkedServers = cached.checkedServers;
  } else {
    report = await probeToolConflicts(servers);
    checkedServers = servers.map((s) => s.name);
    toolConflictCache.set(configFingerprint, { report, checkedServers });
    // 缓存上限：只保留最近 16 个配置指纹
    if (toolConflictCache.size > 16) {
      const oldest = toolConflictCache.keys().next().value;
      if (oldest) toolConflictCache.delete(oldest);
    }
  }

  if (report.failedServers.has("invest-agent-service-tools")) {
    throw new Error(
      `[${label}] service-tools 工具冲突探针失败，阻断会话创建: ${report.failedServers.get("invest-agent-service-tools")}`,
    );
  }

  // 探针失败的外部 server 剔除（不进入会话）
  const failedSet = new Set(report.failedServers.keys());
  let filtered = servers.filter((s) => !failedSet.has(s.name));
  if (failedSet.size > 0) {
    logger.warn(`[${label}] 工具冲突探针剔除失败的 server: ${[...failedSet].join(", ")}`);
  }

  // 冲突检查
  if (shouldBlockSessionOnConflict(report, "invest-agent-service-tools")) {
    const conflictNames = report.conflicts.map((c) => c.toolName).join(", ");
    // 区分：service-tools 卷入冲突 → 阻断；纯外部冲突 → 剔除冲突外部 server
    const serviceInConflict = report.conflicts.some((c) => c.servers.includes("invest-agent-service-tools"));
    if (serviceInConflict) {
      throw new Error(`[${label}] 工具名冲突涉及 service-tools，阻断会话创建: ${conflictNames}`);
    }
    // 纯外部冲突：剔除涉及冲突的外部 server（保留 service-tools）
    const conflictServers = new Set(report.conflicts.flatMap((c) => c.servers));
    conflictServers.delete("invest-agent-service-tools");
    filtered = filtered.filter((s) => !conflictServers.has(s.name));
    logger.warn(`[${label}] 工具名冲突，剔除外部 server: ${[...conflictServers].join(", ")} (${conflictNames})`);
  }

  return filtered;
}

/** 仅供测试重置冲突探针缓存。 */
export function resetToolConflictCacheForTest(): void {
  toolConflictCache.clear();
}
const DEFAULT_CODEX_ACP_ARGS = [
  "-c",
  'project_trust_level="trusted"',
  "-c",
  'sandbox_mode="workspace-write"',
  "-c",
  "sandbox_workspace_write.network_access=true",
  "-c",
  'approval_policy="never"',
];

// ─── 类型 ───────────────────────────────────────────────────────────

type ClientSideConnection = {
  initialize(params: Record<string, unknown>): Promise<unknown>;
  newSession(params: Record<string, unknown>): Promise<{ sessionId: string }>;
  prompt(params: Record<string, unknown>): Promise<unknown>;
  cancel(params: Record<string, unknown>): Promise<unknown>;
};

type SessionNotification = {
  sessionId: string;
  update: SessionUpdate;
};

type SessionUpdate =
  | {
      sessionUpdate: "agent_message_chunk";
      content: { type: "text"; text: string } | { type: string };
    }
  | {
      sessionUpdate: "usage_update";
      used: number;
      size: number;
      cost?: { amount: number; currency: string } | null;
      _meta?: Record<string, unknown> | null;
    }
  | { sessionUpdate: string; [key: string]: unknown };

type RequestPermissionRequest = {
  options: Array<{ optionId: string }>;
};

export type AcpBackendId = "hermes" | "codex";

export interface AcpBackendDef {
  id: AcpBackendId;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  isDefault?: boolean;
}

interface AcpBackendOverride {
  cwd?: string;
  model?: string;
  modelLabel?: string;
}

/**
 * 从 conversationId / scope 推断本次会话的任务类型,用于 MCP 注册表按 sessionKind
 * 过滤注册项。scheduled 会话的 conversationId 以 "scheduler:" 开头;eval 脚本
 * 通过 ACP_EVAL_* env 表达隔离;其余按交互会话处理。
 */
function inferTaskType(userContext?: UserContext, env: NodeJS.ProcessEnv = process.env): string {
  if (env.ACP_EVAL_DISABLE_ALL_MCP === "true" || env.ACP_EVAL_MCP_ALLOWED_TOOLS) {
    return "evaluation";
  }
  if (userContext?.taskType) return userContext.taskType;
  const conversationId = userContext?.conversationId || "";
  if (conversationId.startsWith("scheduler:")) return "scheduled-read";
  return "interactive";
}

export interface AcpBackendStatus {
  id: AcpBackendId;
  label: string;
  ready: boolean;
  command: string;
  cwd: string;
  model?: string;
  pid?: number;
  sessions: number;
  lastError?: string;
  isCurrent: boolean;
  isDefault: boolean;
  capabilityProbe?: AcpCapabilityProbe;
}

export interface AcpTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  totalTokens?: number;
  contextWindowUsed?: number;
  contextWindowSize?: number;
  costAmount?: number;
  costCurrency?: string;
  source: "actual" | "estimated";
  raw?: unknown;
}

export interface AcpChatResult {
  text: string;
  usage: AcpTokenUsage;
  budget: AcpBudgetRunSnapshot;
  backendId: AcpBackendId;
  model?: string;
  modelLabel?: string;
  mcpManifest?: AcpMcpSessionManifest;
  toolCalls?: AcpToolCallSummary[];
}

/** ACP 侧工具事件摘要；不等同于外部 MCP server 的实际执行证明。 */
export interface AcpToolCallSummary {
  source: "acp-event";
  toolCallId: string;
  serverId?: string;
  toolName?: string;
  title?: string;
  kind?: string;
  status?: string;
  startedAt: string;
  completedAt?: string;
  elapsedMs?: number;
  inputChars?: number;
  outputChars?: number;
}

// ─── 后端定义 ───────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 1_800_000;

export const ACP_BACKENDS: AcpBackendDef[] = [
  {
    id: "hermes",
    label: "Hermes",
    command: config.hermes.acpCommand,
    args: config.hermes.acpArgs,
    cwd: config.hermes.acpCwd,
    timeoutMs: config.hermes.acpTimeoutMs || DEFAULT_TIMEOUT_MS,
    isDefault: true,
  },
  {
    id: "codex",
    label: "Codex",
    command: config.codex.acpCommand,
    args: [...DEFAULT_CODEX_ACP_ARGS, ...config.codex.acpArgs],
    cwd: config.codex.acpCwd,
    timeoutMs: config.codex.acpTimeoutMs || DEFAULT_TIMEOUT_MS,
  },
];

const SETTINGS_KEY = "acp_backend";

/**
 * Build the service-owned MCP process configuration for a workspace-scoped
 * Codex session. Codex ACP treats this env list as explicit, so every
 * location that determines service state must travel with the trusted scope.
 *
 * WP1: 该函数现为薄 wrapper,实际装配由配置型 MCP 注册表 + 会话 manifest
 * 解析负责 (mcp-registry.ts / mcp-session-manifest.ts)。签名与输出契约保持
 * 不变,确保零行为回归;WP2 起可通过注册表接入外部只读 MCP。
 */
export function buildInvestAgentMcpServers(
  backendId: AcpBackendId,
  cwd: string,
  userContext?: UserContext,
  env: NodeJS.ProcessEnv = process.env,
): AcpMcpServer[] {
  const taskType = inferTaskType(userContext, env);
  const { servers } = resolveSessionMcpServers({
    backendId,
    cwd,
    userContext,
    env,
    taskType,
    sessionId: userContext?.conversationId || "",
  });
  return servers;
}

// ─── 通用 stdio ACP agent ──────────────────────────────────────────

export class ResponseCollector {
  private readonly chunks: string[] = [];
  private readonly segments: string[] = [];
  private currentSegment: string[] = [];
  private usageUpdate: SessionUpdate | undefined;
  private readonly toolCallRecords = new Map<string, AcpToolCallSummary>();
  private readonly toolCallStartedAt = new Map<string, number>();

  constructor(private readonly hooks: {
    onToolCall?: () => void;
    onBudgetExhausted?: (type: AcpBudgetExhaustionType) => void;
  } = {}) {}

  handleUpdate(notification: SessionNotification) {
    const update = notification.update;
    if (update.sessionUpdate === "tool_call") {
      this.hooks.onToolCall?.();
      const budgetType = detectAcpBudgetExhaustion(update);
      if (budgetType) this.hooks.onBudgetExhausted?.(budgetType);
      this.recordToolCall(update as Record<string, unknown>);
      this.flushSegment();
      return;
    }
    if (update.sessionUpdate === "tool_call_update") {
      const toolCallId = typeof (update as { toolCallId?: unknown }).toolCallId === "string"
        ? (update as unknown as { toolCallId: string }).toolCallId
        : "";
      if (toolCallId && !this.toolCallRecords.has(toolCallId)) this.hooks.onToolCall?.();
      const budgetType = detectAcpBudgetExhaustion(update);
      if (budgetType) this.hooks.onBudgetExhausted?.(budgetType);
      this.recordToolCall(update as Record<string, unknown>);
      this.flushSegment();
      return;
    }
    if (update.sessionUpdate === "usage_update") {
      this.usageUpdate = update;
      this.flushSegment();
      return;
    }
    if (update.sessionUpdate !== "agent_message_chunk") {
      this.flushSegment();
      return;
    }
    const content = (update as { content?: { type: string; text?: string } }).content;
    if (content?.type === "text") {
      const text = content.text ?? "";
      this.chunks.push(text);
      this.currentSegment.push(text);
    }
  }

  toText() {
    this.flushSegment();
    if (ACP_RESPONSE_COLLECTOR_MODE === "full") {
      return this.fullText();
    }
    return this.lastSegmentText() || this.fullText();
  }

  stats() {
    let adjacentDuplicateChunks = 0;
    for (let i = 1; i < this.chunks.length; i += 1) {
      if (this.chunks[i] && this.chunks[i] === this.chunks[i - 1]) {
        adjacentDuplicateChunks += 1;
      }
    }
    const text = this.toText();
    return {
      mode: ACP_RESPONSE_COLLECTOR_MODE,
      chunks: this.chunks.length,
      segments: this.segments.length,
      chars: text.length,
      fullChars: this.fullText().length,
      adjacentDuplicateChunks,
      repeatedSuffixChars: estimateRepeatedSuffixChars(text),
    };
  }

  usageFromUpdate() {
    return this.usageUpdate;
  }

  toolCallsSnapshot(): AcpToolCallSummary[] {
    return [...this.toolCallRecords.values()].map((record) => ({ ...record }));
  }

  private recordToolCall(update: Record<string, unknown>) {
    const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
    if (!toolCallId) return;
    const now = Date.now();
    const existing = this.toolCallRecords.get(toolCallId);
    const startedAtMs = this.toolCallStartedAt.get(toolCallId) ?? now;
    if (!existing) this.toolCallStartedAt.set(toolCallId, startedAtMs);
    const status = stringValue(update.status) ?? existing?.status;
    const completed = status === "completed" || status === "failed";
    const input = update.rawInput;
    const output = update.rawOutput;
    this.toolCallRecords.set(toolCallId, {
      source: "acp-event",
      toolCallId,
      serverId: stringValue(update.serverId) ?? existing?.serverId,
      toolName: stringValue(update.toolName) ?? stringValue(update.name) ?? existing?.toolName,
      title: stringValue(update.title) ?? existing?.title,
      kind: stringValue(update.kind) ?? existing?.kind,
      status,
      startedAt: existing?.startedAt ?? new Date(startedAtMs).toISOString(),
      completedAt: completed ? new Date(now).toISOString() : existing?.completedAt,
      elapsedMs: completed ? Math.max(0, now - startedAtMs) : existing?.elapsedMs,
      inputChars: input === undefined ? existing?.inputChars : safeSerializedSize(input),
      outputChars:
        output !== undefined
          ? safeSerializedSize(output)
          : Array.isArray(update.content)
            ? safeSerializedSize(update.content)
            : existing?.outputChars,
    });
    if (completed) this.toolCallStartedAt.delete(toolCallId);
  }

  private flushSegment() {
    if (this.currentSegment.length === 0) return;
    const text = this.currentSegment.join("").trim();
    if (text && !isAcpDiagnosticText(text)) this.segments.push(text);
    this.currentSegment = [];
  }

  private fullText() {
    this.flushSegment();
    return this.segments.join("\n").trim();
  }

  private lastSegmentText() {
    return this.segments[this.segments.length - 1]?.trim() ?? "";
  }
}

function debugSessionUpdate(label: string, notification: SessionNotification) {
  if (!ACP_DEBUG_SESSION_UPDATES) return;
  const update = notification.update;
  const updateRecord: Record<string, unknown> = isRecord(update) ? update : {};
  const record = sanitizeDebugValue(update) as Record<string, unknown>;
  const availableCommands = Array.isArray(updateRecord.availableCommands)
    ? updateRecord.availableCommands
        .slice(0, 80)
        .map((command) => isRecord(command) ? {
          name: typeof command.name === "string" ? command.name : undefined,
          description: typeof command.description === "string"
            ? command.description.slice(0, ACP_DEBUG_PREVIEW_CHARS)
            : undefined,
        } : command)
    : undefined;
  const content = updateRecord.content;
  const text =
    isRecord(content) && typeof content.text === "string"
      ? content.text.slice(0, ACP_DEBUG_PREVIEW_CHARS)
      : undefined;
  logger.info(
    `[ACP_DEBUG] ${label} session=${notification.sessionId} update=${String(update.sessionUpdate)} keys=${Object.keys(record).join(",")} summary=${JSON.stringify({
      ...record,
      availableCommands,
      contentTextPreview: text,
    })}`
  );
}

function debugPromptResult(label: string, sessionId: string, result: unknown) {
  if (!ACP_DEBUG_SESSION_UPDATES) return;
  const summary = sanitizeDebugValue(result);
  logger.info(
    `[ACP_DEBUG] ${label} session=${sessionId} promptResult keys=${isRecord(result) ? Object.keys(result).join(",") : "-"} summary=${JSON.stringify(summary)}`
  );
}

function sanitizeDebugValue(value: unknown, depth = 0): unknown {
  if (depth > 2) return "[MaxDepth]";
  if (typeof value === "string") {
    return value.length > ACP_DEBUG_PREVIEW_CHARS
      ? `${value.slice(0, ACP_DEBUG_PREVIEW_CHARS)}…`
      : value;
  }
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 5).map((item) => sanitizeDebugValue(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    out[key] = sanitizeDebugValue(child, depth + 1);
  }
  return out;
}

function estimateRepeatedSuffixChars(text: string) {
  for (let len = Math.floor(text.length / 2); len >= 40; len -= 1) {
    const tail = text.slice(-len);
    if (text.slice(0, -len).endsWith(tail)) return len;
  }
  return 0;
}

function extractAcpUsage(
  promptResult: unknown,
  usageUpdate: unknown,
  promptText: string,
  replyText: string
): AcpTokenUsage {
  const resultUsage = isRecord(promptResult) ? normalizeUsage(promptResult.usage) : undefined;
  const updateUsage = normalizeUsageUpdate(usageUpdate);
  if (resultUsage) {
    return {
      ...resultUsage,
      ...updateUsage,
      source: "actual",
      raw: {
        promptUsage: isRecord(promptResult) ? promptResult.usage : undefined,
        usageUpdate,
      },
    };
  }

  const inputTokens = estimateTokens(promptText);
  const outputTokens = estimateTokens(replyText);
  return {
    inputTokens,
    outputTokens,
    ...updateUsage,
    totalTokens: inputTokens + outputTokens,
    source: "estimated",
    raw: updateUsage ? { usageUpdate } : undefined,
  };
}

function normalizeUsage(value: unknown): Omit<AcpTokenUsage, "source" | "raw"> | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = optionalInt(value.inputTokens);
  const outputTokens = optionalInt(value.outputTokens);
  const totalTokens = optionalInt(value.totalTokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    thoughtTokens: optionalInt(value.thoughtTokens),
    cachedReadTokens: optionalInt(value.cachedReadTokens),
    cachedWriteTokens: optionalInt(value.cachedWriteTokens),
    totalTokens,
  };
}

function normalizeUsageUpdate(value: unknown): Omit<AcpTokenUsage, "source" | "raw"> | undefined {
  if (!isRecord(value) || value.sessionUpdate !== "usage_update") return undefined;
  const cost = isRecord(value.cost) ? value.cost : undefined;
  return {
    contextWindowUsed: optionalInt(value.used),
    contextWindowSize: optionalInt(value.size),
    costAmount: optionalNumber(cost?.amount),
    costCurrency: typeof cost?.currency === "string" ? cost.currency : undefined,
  };
}

function optionalInt(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function optionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeSerializedSize(value: unknown): number | undefined {
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    return typeof serialized === "string" ? serialized.length : undefined;
  } catch {
    return undefined;
  }
}

function estimateTokens(text: string) {
  if (!text) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii / 1.7));
}

function resolveAcpBudgetConvergenceMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.ACP_BUDGET_CONVERGENCE_MS);
  if (Number.isFinite(configured) && configured > 0) return Math.round(configured);
  const fromConfig = config.acp.budgetConvergenceMs;
  return Number.isFinite(fromConfig) && fromConfig > 0
    ? Math.round(fromConfig)
    : DEFAULT_ACP_BUDGET_CONVERGENCE_MS;
}

export class StdioAcpAgent {
  private connection: ClientSideConnection | null = null;
  private process: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private starting: Promise<ClientSideConnection> | null = null;
  private lastError: string | undefined;
  private readonly sessions = new Map<string, string>();
  private readonly sessionManifests = new Map<string, AcpMcpSessionManifest>();
  private readonly collectors = new Map<string, ResponseCollector>();
  private readonly activeConversations = new Set<string>();
  private readonly activeConversationSessions = new Map<string, string>();
  private readonly userCancelledSessions = new Set<string>();
  private readonly inFlightPromptRejectors = new Map<string, (error: Error) => void>();
  private httpMcpSupported = false;
  private capabilityProbe: AcpCapabilityProbe = probeAcpCapabilities(undefined);

  constructor(private readonly def: AcpBackendDef, private readonly override: AcpBackendOverride = {}) {}

  get id(): AcpBackendId {
    return this.def.id;
  }

  get label(): string {
    if (this.def.id !== "codex" || !this.override.model) return this.def.label;
    return `${this.def.label}/model:${this.override.model}`;
  }

  status(isCurrent: boolean): AcpBackendStatus {
    return {
      id: this.def.id,
      label: this.label,
      ready: this.ready,
      command: this.def.command,
      cwd: this.cwd,
      model: this.override.model,
      pid: this.process?.pid,
      sessions: this.sessions.size,
      lastError: this.lastError,
      isCurrent,
      isDefault: Boolean(this.def.isDefault),
      capabilityProbe: this.capabilityProbe,
    };
  }

  private get cwd() {
    return this.override.cwd || this.def.cwd;
  }

  private get args() {
    // codex-acp accepts its own small CLI surface and does not forward `-c`
    // flags to the Codex app-server.  Codex session settings are injected via
    // CODEX_CONFIG in buildCodexRuntimeEnv instead.
    return this.def.args;
  }

  async ensureReady(): Promise<ClientSideConnection> {
    if (this.ready && this.connection) return this.connection;
    if (this.starting) return this.starting;

    this.starting = this.start();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async chat(params: {
    conversationId: string;
    text: string;
    messageId?: string;
    timeoutMs?: number;
    cwd?: string;
    userContext?: UserContext;
    signal?: AbortSignal;
  }): Promise<string> {
    const result = await this.chatWithUsage(params);
    return result.text;
  }

  async chatWithUsage(params: {
    conversationId: string;
    text: string;
    messageId?: string;
    timeoutMs?: number;
    cwd?: string;
    userContext?: UserContext;
    signal?: AbortSignal;
  }): Promise<AcpChatResult> {
    if (params.signal?.aborted) throw new Error("TASK_CANCELLED");
    if (this.activeConversations.has(params.conversationId)) {
      throw new Error("ACP_TURN_BUSY:上一条消息仍在处理中");
    }
    this.activeConversations.add(params.conversationId);
    let conn: ClientSideConnection;
    try {
      conn = await awaitWithAbort(this.ensureReady(), params.signal);
    } catch (error) {
      this.activeConversations.delete(params.conversationId);
      throw error;
    }
    if (params.signal?.aborted) {
      this.activeConversations.delete(params.conversationId);
      throw new Error("TASK_CANCELLED");
    }
    // WP3: sessionKey 必须纳入 allowlist 指纹,否则同一 conversation 不同 allowlist 会复用
    // session,导致权限泄漏 (全量 session 被只读阶段复用)。无 allowlist (全量) 时指纹为空串。
    const allowlistFp = computeAllowlistFingerprint(params.userContext, process.env);
    const resolvedMcp = this.buildMcpSession(params.cwd ?? this.cwd, params.userContext, params.messageId);
    const sessionKey = [
      params.conversationId,
      params.cwd,
      allowlistFp,
      // Observer headers are immutable for an ACP session. Include the turn id so
      // external evidence can be joined to exactly one ACP trace.
      resolvedMcp.requiresTurnScopedSession ? params.messageId : undefined,
    ]
      .filter((part) => part !== undefined && part !== "")
      .join("::");
    let sessionId: string;
    try {
      sessionId = await awaitWithAbort(
        this.getOrCreateSession(sessionKey, conn, params.cwd, resolvedMcp),
        params.signal,
      );
    } catch (error) {
      this.activeConversations.delete(params.conversationId);
      throw error;
    }
    this.activeConversationSessions.set(params.conversationId, sessionId);
    const prompt = [{ type: "text" as const, text: params.text }];
    const budgetRun = new AcpBudgetRun({ convergenceMs: resolveAcpBudgetConvergenceMs() });
    let budgetCancelRequested = false;
    let budgetTimer: NodeJS.Timeout | undefined;
    let rejectBudgetConvergence: ((error: AcpBudgetExhaustedError) => void) | undefined;
    const budgetConvergence = new Promise<never>((_, reject) => {
      rejectBudgetConvergence = reject;
    });
    const collector = new ResponseCollector({
      onToolCall: () => budgetRun.recordToolCall(),
      onBudgetExhausted: (type) => {
        if (!budgetRun.markBudgetExhausted(type)) return;
        // ACP 0.16.1 does not advertise a safe same-turn MCP revocation
        // operation, so cancel the active turn and converge to a terminal
        // result instead of allowing another upstream request.
        budgetRun.enterSynthesisOnly();
        if (!budgetCancelRequested) {
          budgetCancelRequested = true;
          void conn.cancel({ sessionId }).catch((error: unknown) => {
            logger.warn(`${this.label} ACP 预算耗尽后的取消失败:`, error);
          });
        }
        const deadline = budgetRun.snapshot().convergenceDeadlineAt ?? Date.now();
        budgetTimer = setTimeout(() => {
          budgetRun.terminalFail();
          rejectBudgetConvergence?.(new AcpBudgetExhaustedError(budgetRun.snapshot()));
        }, Math.max(0, deadline - Date.now()));
        budgetTimer.unref?.();
      },
    });
    this.collectors.set(sessionId, collector);
    const startedAt = Date.now();
    logger.info(
      `${this.label} ACP 开始处理 session=${sessionId} message=${params.messageId ?? "-"}`
    );

    let promptResult: unknown;
    const processExit = new Promise<never>((_, reject) => {
      this.inFlightPromptRejectors.set(sessionId, reject);
    });
    // Cancellation can arrive after the session exists but before Promise.race
    // begins. Attach a rejection handler immediately so that narrow window
    // cannot become an unhandled rejection and terminate the Runtime.
    void processExit.catch(() => undefined);
    const abortHandler = () => {
      void this.cancelConversation(params.conversationId);
    };
    params.signal?.addEventListener("abort", abortHandler, { once: true });
    try {
      if (params.signal?.aborted) {
        await this.cancelConversation(params.conversationId);
        throw new Error("TASK_CANCELLED");
      }
      promptResult = await Promise.race([
        conn.prompt({
          sessionId,
          messageId: params.messageId,
          prompt,
        }),
        this.timeoutAfter(params.timeoutMs ?? this.def.timeoutMs),
        processExit,
        budgetConvergence,
      ]);
      logger.info(
        `${this.label} ACP 完成 session=${sessionId} elapsedMs=${Date.now() - startedAt} result=${JSON.stringify(promptResult)} responseStats=${JSON.stringify(collector.stats())}`
      );
      debugPromptResult(this.label, sessionId, promptResult);
    } catch (error) {
      if (budgetRun.isBudgetExhausted()) {
        budgetRun.terminalFail();
        throw error instanceof AcpBudgetExhaustedError
          ? error
          : new AcpBudgetExhaustedError(budgetRun.snapshot());
      }
      if (error instanceof Error && error.message.includes("请求超时")) {
        logger.warn(`${this.label} ACP 超时,取消当前轮次 session=${sessionId}`);
        await conn.cancel({ sessionId }).catch((cancelError: unknown) => {
          logger.warn(`${this.label} ACP 取消失败:`, cancelError);
        });
      }
      throw error;
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer);
      params.signal?.removeEventListener("abort", abortHandler);
      this.inFlightPromptRejectors.delete(sessionId);
      this.collectors.delete(sessionId);
      this.userCancelledSessions.delete(sessionId);
      if (this.activeConversationSessions.get(params.conversationId) === sessionId) {
        this.activeConversationSessions.delete(params.conversationId);
      }
      this.activeConversations.delete(params.conversationId);
    }

    if (budgetRun.isBudgetExhausted()) {
      budgetRun.terminalFail();
      throw new AcpBudgetExhaustedError(budgetRun.snapshot());
    }

    const text = collector.toText();
    if (!text) {
      throw new Error(`${this.label} ACP 未生成可展示的用户回复`);
    }
    budgetRun.complete();
    return {
      text,
      usage: extractAcpUsage(promptResult, collector.usageFromUpdate(), params.text, text),
      budget: budgetRun.snapshot(),
      backendId: this.def.id,
      model: this.override.model,
      modelLabel: this.override.modelLabel,
      mcpManifest: this.sessionManifests.get(sessionKey),
      toolCalls: collector.toolCallsSnapshot(),
    };
  }

  async cancelConversation(conversationId: string): Promise<boolean> {
    const sessionId = this.activeConversationSessions.get(conversationId);
    const conn = this.connection;
    if (!sessionId || !conn) return false;
    if (this.userCancelledSessions.has(sessionId)) return true;
    this.userCancelledSessions.add(sessionId);

    this.inFlightPromptRejectors.get(sessionId)?.(new Error("TASK_CANCELLED"));
    void conn.cancel({ sessionId }).catch((error: unknown) => {
      logger.warn(`${this.label} ACP 用户取消失败 session=${sessionId}:`, error);
    });
    return true;
  }

  clearSession(conversationId: string) {
    for (const [key, sessionId] of this.sessions) {
      if (key !== conversationId && !key.startsWith(`${conversationId}::`)) continue;
      this.collectors.delete(sessionId);
      this.sessions.delete(key);
      this.sessionManifests.delete(key);
    }
  }

  dispose() {
    this.rejectInFlightPrompts(new Error(`${this.label} ACP 已停止`));
    this.ready = false;
    this.starting = null;
    this.connection = null;
    this.sessions.clear();
    this.sessionManifests.clear();
    this.collectors.clear();
    this.activeConversations.clear();
    this.activeConversationSessions.clear();
    this.userCancelledSessions.clear();

    if (this.process && !this.process.killed) {
      if (this.process.pid) {
        try {
          process.kill(-this.process.pid, "SIGTERM");
        } catch {
          this.process.kill("SIGTERM");
        }
      } else {
        this.process.kill("SIGTERM");
      }
    }
    this.process = null;
    logger.info(`${this.label} ACP 子进程已停止`);
  }

  private async start(): Promise<ClientSideConnection> {
    const { command } = this.def;
    const args = this.args;
    const label = this.label;
    const cwd = this.cwd;
    const env = await buildRuntimeEnvForBackend(this.def.id, cwd, this.override.model);
    logger.info(`启动 ${label} ACP: ${command}${args.length ? ` ${args.join(" ")}` : ""}`);

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env,
      detached: true,
    });
    this.process = child;

    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString("utf-8").trim();
      if (text) logger.warn(`[${label.toLowerCase()}-acp] ${text}`);
    });

    child.on("exit", (code, signal) => {
      logger.warn(`${label} ACP 子进程退出 code=${code ?? "-"} signal=${signal ?? "-"}`);
      if (this.process !== child) return;
      this.rejectInFlightPrompts(
        new Error(`${label} ACP 子进程退出 code=${code ?? "-"} signal=${signal ?? "-"}`)
      );
      this.ready = false;
      this.connection = null;
      this.process = null;
      this.sessions.clear();
      this.sessionManifests.clear();
      this.collectors.clear();
    });

    child.on("error", (error) => {
      this.lastError = error.message;
      logger.error(`${label} ACP 子进程启动失败:`, error);
    });

    const acp = await import("@agentclientprotocol/sdk");
    const conn = new acp.ClientSideConnection(
      () => ({
        sessionUpdate: async (params: SessionNotification) => {
          debugSessionUpdate(label, params);
          const collector = this.collectors.get(params.sessionId);
          collector?.handleUpdate(params);
        },
        requestPermission: async (params: RequestPermissionRequest) => ({
          outcome: {
            outcome: "selected",
            optionId: params.options[0]?.optionId ?? "allow",
          },
        }),
      }),
      acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
      )
    );

    const initResult = await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "invest-agent", version: "1.0.0" },
      clientCapabilities: {},
    });

    this.capabilityProbe = probeAcpCapabilities(initResult, conn);

    const agentCapabilities = initResult as {
      agentCapabilities?: { mcpCapabilities?: { http?: boolean } };
    };
    this.httpMcpSupported = agentCapabilities.agentCapabilities?.mcpCapabilities?.http === true;

    this.connection = conn;
    this.ready = true;
    this.lastError = undefined;
    logger.info(`${label} ACP 已就绪 pid=${child.pid ?? "-"}`);
    return conn;
  }

  private async getOrCreateSession(
    sessionKey: string,
    conn: ClientSideConnection,
    cwd = this.cwd,
    resolvedMcp: ReturnType<StdioAcpAgent["buildMcpSession"]>,
  ) {
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;

    let mcpServers = resolvedMcp.servers;

    // R3: 多 server 时在 newSession 前做工具名冲突检查（按配置指纹缓存，session 复用不重复）
    if (mcpServers.length > 1) {
      mcpServers = await checkToolConflictsBeforeSession(this.label, mcpServers);
    }

    const res = await conn.newSession({
      cwd,
      mcpServers,
    });
    this.sessions.set(sessionKey, res.sessionId);
    this.sessionManifests.set(sessionKey, {
      ...resolvedMcp.manifest,
      sessionId: res.sessionId,
      servers: resolvedMcp.manifest.servers.filter((server) =>
        mcpServers.some((active) => active.name === server.id),
      ),
    });
    logger.info(
      `${this.label} ACP 新会话 key=${sessionKey} cwd=${cwd} session=${res.sessionId}`
    );
    return res.sessionId;
  }

  private buildMcpSession(cwd: string, userContext?: UserContext, runId?: string) {
    const taskType = inferTaskType(userContext, process.env);
    return resolveSessionMcpServers({
      backendId: this.def.id,
      cwd,
      userContext,
      env: process.env,
      taskType,
      sessionId: userContext?.conversationId || "",
      runId,
      mcpCapabilities: { http: this.httpMcpSupported },
    });
  }

  private timeoutAfter(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${this.label} ACP 请求超时 ${ms}ms`)),
        ms
      );
      timer.unref?.();
    });
  }

  private rejectInFlightPrompts(error: Error) {
    for (const reject of this.inFlightPromptRejectors.values()) reject(error);
    this.inFlightPromptRejectors.clear();
  }
}

async function buildHermesRuntimeEnv(workspacePath: string): Promise<NodeJS.ProcessEnv> {
  const hermesHome = path.join(workspacePath, ".hermes");
  await ensureHermesHome(hermesHome);
  return {
    ...process.env,
    HERMES_HOME: hermesHome,
  };
}

async function buildCodexRuntimeEnv(workspacePath: string, model?: string): Promise<NodeJS.ProcessEnv> {
  const codexHome = path.join(workspacePath, ".codex");
  await ensureCodexHome(codexHome);

  // `@agentclientprotocol/codex-acp` does not forward its CLI `-c` arguments
  // to the Codex app-server.  It uses these two environment variables instead
  // when creating an ACP session.  Without them, an isolated DeepSeek config
  // can still be routed as the app-server's default OpenAI model.
  const codexConfig = parseCodexAcpConfig(model);
  const modelProvider = readConfiguredCodexModelProvider(path.join(codexHome, "config.toml"));
  return {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_CONFIG: JSON.stringify(codexConfig),
    ...(modelProvider ? { MODEL_PROVIDER: modelProvider } : {}),
  };
}

function parseCodexAcpConfig(model?: string): Record<string, unknown> {
  return {
    project_trust_level: "trusted",
    sandbox_mode: "workspace-write",
    sandbox_workspace_write: { network_access: true },
    approval_policy: "never",
    ...(model ? { model } : {}),
  };
}

function readConfiguredCodexModelProvider(configPath: string): string | undefined {
  try {
    const source = readFileSync(configPath, "utf8");
    const match = /^\s*model_provider\s*=\s*[\"']([^\"']+)[\"']\s*$/m.exec(source);
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function ensureHermesHome(hermesHome: string): Promise<void> {
  mkdirSync(hermesHome, { recursive: true });
  // config.yaml / .env 改用符号链接,这样 ~/.hermes/ 的全局改动立即对所有 workspace 生效。
  // hermes 子进程只读这两个文件,不存在并发写,符号链接安全。
  for (const file of ["config.yaml", ".env"]) {
    const source = path.join(config.hermes.sourceHome, file);
    const target = path.join(hermesHome, file);
    if (!existsSync(source)) continue;
    try {
      let needReplace = true;
      try {
        const stat = lstatSync(target);
        if (stat.isSymbolicLink()) {
          const linkTarget = readlinkSync(target).toString();
          if (linkTarget === source) needReplace = false;
        }
      } catch {
        // lstatSync 抛错说明 target 不存在,继续走创建分支
      }
      if (needReplace) {
        try {
          lstatSync(target);
          rmSync(target, { force: true });
        } catch {
          // target missing
        }
        symlinkSync(source, target);
      }
    } catch (error) {
      logger.warn(`Hermes config symlink failed file=${file}: ${(error as Error).message}`);
    }
  }
  // auth.json 仍用 copy 方式 — hermes 运行时可能刷新 token,多 workspace 共享会并发写冲突。
  const authSource = path.join(config.hermes.sourceHome, "auth.json");
  const authTarget = path.join(hermesHome, "auth.json");
  if (existsSync(authSource) && !existsSync(authTarget)) {
    try {
      copyFileSync(authSource, authTarget);
    } catch (error) {
      logger.warn(`Hermes auth copy failed: ${(error as Error).message}`);
    }
  }
}

function buildRuntimeEnvForBackend(id: AcpBackendId, workspacePath: string, model?: string): Promise<NodeJS.ProcessEnv> {
  return id === "codex" ? buildCodexRuntimeEnv(workspacePath, model) : buildHermesRuntimeEnv(workspacePath);
}

export async function ensureHermesRuntimeForWorkspace(workspacePath: string): Promise<string> {
  const hermesHome = path.join(workspacePath, ".hermes");
  await ensureHermesHome(hermesHome);
  return hermesHome;
}

export async function ensureCodexRuntimeForWorkspace(workspacePath: string): Promise<string> {
  const codexHome = path.join(workspacePath, ".codex");
  await ensureCodexHome(codexHome);
  return codexHome;
}

async function ensureCodexHome(codexHome: string): Promise<void> {
  mkdirSync(codexHome, { recursive: true });
  const sourceHome = resolveCodexRuntimeSourceHome(config.codex.sourceHome);
  const evaluationIsolation = process.env.ACP_EVAL_DISABLE_ALL_MCP === "true" || process.env.ACP_EVAL_DISABLE_INHERITED_MCP === "true";
  // config.toml can define both model providers and MCP servers. Evaluation
  // needs the former, but must remove the latter rather than fall back to a
  // different default provider.
  const inheritedConfigFiles = evaluationIsolation
    ? ["config.toml"]
    : ["config.toml", "mcp.json"];
  for (const file of inheritedConfigFiles) {
    const source = path.join(sourceHome, file);
    const target = path.join(codexHome, file);
    if (!existsSync(source)) continue;
    try {
      if (evaluationIsolation && file === "config.toml") {
        const filtered = stripCodexMcpConfigForEvaluation(readFileSync(source, "utf8"));
        const current = existsSync(target) ? readFileSync(target, "utf8") : undefined;
        if (current !== filtered) {
          try { rmSync(target, { force: true }); } catch { /* target missing */ }
          writeFileSync(target, filtered, "utf8");
        }
        continue;
      }
      let needReplace = true;
      try {
        const stat = lstatSync(target);
        if (stat.isSymbolicLink()) {
          const linkTarget = readlinkSync(target).toString();
          if (linkTarget === source) needReplace = false;
        }
      } catch {
        // target missing
      }
      if (needReplace) {
        try {
          lstatSync(target);
          rmSync(target, { force: true });
        } catch {
          // target missing
        }
        symlinkSync(source, target);
      }
    } catch (error) {
      logger.warn(`Codex config symlink failed file=${file}: ${(error as Error).message}`);
    }
  }
  const authSource = path.join(sourceHome, "auth.json");
  const authTarget = path.join(codexHome, "auth.json");
  try {
    syncRuntimeAuthFile(authSource, authTarget);
  } catch (error) {
    logger.warn(`Codex auth sync failed: ${(error as Error).message}`);
  }
}

export function resolveCodexRuntimeSourceHome(configuredSourceHome: string, homeDirectory = process.env.HOME || ""): string {
  if (existsSync(configuredSourceHome)) return configuredSourceHome;
  const fallback = path.join(homeDirectory, ".codex");
  if (existsSync(fallback)) {
    logger.warn(`Configured Codex source home is unavailable; using current runtime home instead`);
    return fallback;
  }
  return configuredSourceHome;
}

/**
 * Workspace ACP homes isolate mutable session state, but authentication must
 * follow the currently authenticated runtime. The previous copy-once behavior
 * left a workspace permanently on an expired credential after re-authentication.
 */
export function syncRuntimeAuthFile(source: string, target: string): boolean {
  if (!existsSync(source)) return false;
  const sourceContents = readFileSync(source);
  if (existsSync(target) && readFileSync(target).equals(sourceContents)) return false;

  const temporaryTarget = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporaryTarget, sourceContents, { mode: 0o600 });
    renameSync(temporaryTarget, target);
  } finally {
    if (existsSync(temporaryTarget)) rmSync(temporaryTarget, { force: true });
  }
  return true;
}

export function stripCodexMcpConfigForEvaluation(source: string): string {
  let inMcpSection = false;
  const retained: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const section = /^\s*\[{1,2}([^\]\r\n]+)\]{1,2}\s*$/.exec(line)?.[1]?.trim();
    if (section) inMcpSection = section === "mcp_servers" || section.startsWith("mcp_servers.");
    if (!inMcpSection) retained.push(line);
  }
  return retained.join("\n");
}

// ─── 注册中心 ───────────────────────────────────────────────────────

const instances = new Map<AcpBackendId, StdioAcpAgent>();
const scopedInstances = new Map<string, StdioAcpAgent>();
let currentBackendId: AcpBackendId | null = null;
let settingsLoaded = false;

export function resolveDefaultCodexModel(): string {
  return config.codex.model;
}

function scopedInstanceKey(id: AcpBackendId, override: AcpBackendOverride): string | undefined {
  if (!override.cwd && !override.model) return undefined;
  return [id, path.resolve(override.cwd || ACP_BACKENDS.find((b) => b.id === id)?.cwd || process.cwd()), override.model || ""].join("\0");
}

function scopedInstanceCwd(key: string): string {
  return key.split("\0")[1] || "";
}

function getOrCreateInstance(id: AcpBackendId, override: AcpBackendOverride = {}): StdioAcpAgent {
  const scopedKey = scopedInstanceKey(id, override);
  if (scopedKey) {
    const existing = scopedInstances.get(scopedKey);
    if (existing) return existing;
  }
  const existing = scopedKey ? undefined : instances.get(id);
  if (existing) return existing;
  const def = ACP_BACKENDS.find((b) => b.id === id);
  if (!def) throw new Error(`未知 ACP backend: ${id}`);
  const inst = new StdioAcpAgent(def, override);
  if (scopedKey) {
    scopedInstances.set(scopedKey, inst);
  } else {
    instances.set(id, inst);
  }
  return inst;
}

export async function loadCurrentBackendId(): Promise<AcpBackendId> {
  if (settingsLoaded) {
    return currentBackendId ?? "codex";
  }
  const row = await db
    .select()
    .from(settings)
    .where(eq(settings.key, SETTINGS_KEY))
    .limit(1);
  const fromSettings = row[0]?.value as string | undefined;
  const valid = ACP_BACKENDS.find((b) => b.id === fromSettings);
  currentBackendId = valid ? valid.id : "codex";
  settingsLoaded = true;
  return currentBackendId;
}

export async function getCurrentAcpAgent(
  workspacePath?: string,
  options: { model?: string; modelLabel?: string } = {},
): Promise<StdioAcpAgent> {
  const id = await loadCurrentBackendId();
  const model = id === "codex"
    ? options.model || resolveDefaultCodexModel()
    : undefined;
  return getOrCreateInstance(id, {
    ...(workspacePath ? { cwd: workspacePath } : {}),
    ...(options.modelLabel ? { modelLabel: options.modelLabel } : {}),
    ...(model ? { model } : {}),
  });
}

export function clearAcpSessions(conversationId: string) {
  for (const inst of instances.values()) {
    inst.clearSession(conversationId);
  }
  for (const inst of scopedInstances.values()) {
    inst.clearSession(conversationId);
  }
}

export function disposeAcpForWorkspace(workspacePath: string): number {
  const resolved = path.resolve(workspacePath);
  let disposed = 0;
  for (const [key, inst] of [...scopedInstances.entries()]) {
    const cwd = scopedInstanceCwd(key);
    if (path.resolve(cwd) !== resolved) continue;
    inst.dispose();
    scopedInstances.delete(key);
    disposed += 1;
  }
  return disposed;
}

export async function switchAcpBackend(id: AcpBackendId): Promise<AcpBackendStatus> {
  const def = ACP_BACKENDS.find((b) => b.id === id);
  if (!def) throw new Error(`未知 ACP backend: ${id}`);

  const previousId = currentBackendId;
  if (previousId && previousId !== id) {
    const previous = instances.get(previousId);
    if (previous) {
      logger.info(`切换 ACP backend: ${previousId} → ${id},停止旧实例`);
      previous.dispose();
      instances.delete(previousId);
    }
  }

  currentBackendId = id;
  settingsLoaded = true;

  const existing = await db
    .select()
    .from(settings)
    .where(eq(settings.key, SETTINGS_KEY))
    .limit(1);
  if (existing.length > 0) {
    await db.update(settings).set({ value: id }).where(eq(settings.key, SETTINGS_KEY));
  } else {
    await db.insert(settings).values({ key: SETTINGS_KEY, value: id });
  }

  const inst = getOrCreateInstance(id);
  return inst.status(true);
}

export async function listAcpBackends(): Promise<{
  current: AcpBackendId;
  backends: AcpBackendStatus[];
}> {
  const current = await loadCurrentBackendId();
  const backends = ACP_BACKENDS.map((def) => {
    const inst = instances.get(def.id);
    if (!inst) {
      return {
        id: def.id,
        label: def.label,
        ready: false,
        command: def.command,
        cwd: def.cwd,
        sessions: 0,
        isCurrent: def.id === current,
        isDefault: Boolean(def.isDefault),
        capabilityProbe: probeAcpCapabilities(undefined),
      } satisfies AcpBackendStatus;
    }
    return inst.status(def.id === current);
  });
  return { current, backends };
}

export async function startDefaultAcp(): Promise<void> {
  const agent = await getCurrentAcpAgent();
  await agent.ensureReady();
}

export function disposeAllAcp(): void {
  for (const inst of instances.values()) {
    inst.dispose();
  }
  instances.clear();
  for (const inst of scopedInstances.values()) {
    inst.dispose();
  }
  scopedInstances.clear();
}
