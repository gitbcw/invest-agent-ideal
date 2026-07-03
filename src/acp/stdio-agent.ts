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
import { copyFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { settings } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { config } from "../lib/config.js";

const ACP_DEBUG_SESSION_UPDATES = process.env.ACP_DEBUG_SESSION_UPDATES === "1";
const ACP_DEBUG_PREVIEW_CHARS = Number(process.env.ACP_DEBUG_PREVIEW_CHARS) || 120;
const ACP_RESPONSE_COLLECTOR_MODE =
  process.env.ACP_RESPONSE_COLLECTOR_MODE === "full" ? "full" : "last_segment";
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
}

export interface AcpBackendStatus {
  id: AcpBackendId;
  label: string;
  ready: boolean;
  command: string;
  cwd: string;
  pid?: number;
  sessions: number;
  lastError?: string;
  isCurrent: boolean;
  isDefault: boolean;
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

// ─── 通用 stdio ACP agent ──────────────────────────────────────────

class ResponseCollector {
  private readonly chunks: string[] = [];
  private readonly segments: string[] = [];
  private currentSegment: string[] = [];
  private usageUpdate: SessionUpdate | undefined;

  handleUpdate(notification: SessionNotification) {
    const update = notification.update;
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

  private flushSegment() {
    if (this.currentSegment.length === 0) return;
    const text = this.currentSegment.join("").trim();
    if (text) this.segments.push(text);
    this.currentSegment = [];
  }

  private fullText() {
    return this.chunks.join("").trim();
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
  const content = updateRecord.content;
  const text =
    isRecord(content) && typeof content.text === "string"
      ? content.text.slice(0, ACP_DEBUG_PREVIEW_CHARS)
      : undefined;
  logger.info(
    `[ACP_DEBUG] ${label} session=${notification.sessionId} update=${String(update.sessionUpdate)} keys=${Object.keys(record).join(",")} summary=${JSON.stringify({
      ...record,
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

export class StdioAcpAgent {
  private connection: ClientSideConnection | null = null;
  private process: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private starting: Promise<ClientSideConnection> | null = null;
  private lastError: string | undefined;
  private readonly sessions = new Map<string, string>();
  private readonly collectors = new Map<string, ResponseCollector>();
  private readonly activeConversations = new Set<string>();

  constructor(private readonly def: AcpBackendDef, private readonly override: AcpBackendOverride = {}) {}

  get id(): AcpBackendId {
    return this.def.id;
  }

  get label(): string {
    return this.def.label;
  }

  status(isCurrent: boolean): AcpBackendStatus {
    return {
      id: this.def.id,
      label: this.def.label,
      ready: this.ready,
      command: this.def.command,
      cwd: this.cwd,
      pid: this.process?.pid,
      sessions: this.sessions.size,
      lastError: this.lastError,
      isCurrent,
      isDefault: Boolean(this.def.isDefault),
    };
  }

  private get cwd() {
    return this.override.cwd || this.def.cwd;
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
  }): Promise<AcpChatResult> {
    if (this.activeConversations.has(params.conversationId)) {
      throw new Error("ACP_TURN_BUSY:上一条消息仍在处理中");
    }
    this.activeConversations.add(params.conversationId);
    const conn = await this.ensureReady();
    const sessionKey = params.cwd ? `${params.conversationId}::${params.cwd}` : params.conversationId;
    const sessionId = await this.getOrCreateSession(sessionKey, conn, params.cwd);
    const prompt = [{ type: "text" as const, text: params.text }];
    const collector = new ResponseCollector();
    this.collectors.set(sessionId, collector);
    const startedAt = Date.now();
    logger.info(
      `${this.def.label} ACP 开始处理 session=${sessionId} message=${params.messageId ?? "-"}`
    );

    let promptResult: unknown;
    try {
      promptResult = await Promise.race([
        conn.prompt({
          sessionId,
          messageId: params.messageId,
          prompt,
        }),
        this.timeoutAfter(params.timeoutMs ?? this.def.timeoutMs),
      ]);
      logger.info(
        `${this.def.label} ACP 完成 session=${sessionId} elapsedMs=${Date.now() - startedAt} result=${JSON.stringify(promptResult)} responseStats=${JSON.stringify(collector.stats())}`
      );
      debugPromptResult(this.def.label, sessionId, promptResult);
    } catch (error) {
      if (error instanceof Error && error.message.includes("请求超时")) {
        logger.warn(`${this.def.label} ACP 超时,取消当前轮次 session=${sessionId}`);
        await conn.cancel({ sessionId }).catch((cancelError: unknown) => {
          logger.warn(`${this.def.label} ACP 取消失败:`, cancelError);
        });
      }
      throw error;
    } finally {
      this.collectors.delete(sessionId);
      this.activeConversations.delete(params.conversationId);
    }

    const text = collector.toText() || "处理完成,但没有生成文本回复。";
    return {
      text,
      usage: extractAcpUsage(promptResult, collector.usageFromUpdate(), params.text, text),
    };
  }

  clearSession(conversationId: string) {
    for (const [key, sessionId] of this.sessions) {
      if (key !== conversationId && !key.startsWith(`${conversationId}::`)) continue;
      this.collectors.delete(sessionId);
      this.sessions.delete(key);
    }
  }

  dispose() {
    this.ready = false;
    this.starting = null;
    this.connection = null;
    this.sessions.clear();
    this.collectors.clear();
    this.activeConversations.clear();

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
    logger.info(`${this.def.label} ACP 子进程已停止`);
  }

  private async start(): Promise<ClientSideConnection> {
    const { command, args, label } = this.def;
    const cwd = this.cwd;
    const env = await buildRuntimeEnvForBackend(this.def.id, cwd);
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
      this.ready = false;
      this.connection = null;
      this.process = null;
      this.sessions.clear();
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

    await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "invest-agent", version: "1.0.0" },
      clientCapabilities: {},
    });

    this.connection = conn;
    this.ready = true;
    this.lastError = undefined;
    logger.info(`${label} ACP 已就绪 pid=${child.pid ?? "-"}`);
    return conn;
  }

  private async getOrCreateSession(sessionKey: string, conn: ClientSideConnection, cwd = this.cwd) {
    const existing = this.sessions.get(sessionKey);
    if (existing) return existing;

    const res = await conn.newSession({
      cwd,
      mcpServers: [],
    });
    this.sessions.set(sessionKey, res.sessionId);
    logger.info(
      `${this.def.label} ACP 新会话 key=${sessionKey} cwd=${cwd} session=${res.sessionId}`
    );
    return res.sessionId;
  }

  private timeoutAfter(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`${this.def.label} ACP 请求超时 ${ms}ms`)),
        ms
      );
    });
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

async function buildCodexRuntimeEnv(workspacePath: string): Promise<NodeJS.ProcessEnv> {
  const codexHome = path.join(workspacePath, ".codex");
  await ensureCodexHome(codexHome);
  return {
    ...process.env,
    CODEX_HOME: codexHome,
  };
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
        if (existsSync(target)) rmSync(target, { force: true });
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

function buildRuntimeEnvForBackend(id: AcpBackendId, workspacePath: string): Promise<NodeJS.ProcessEnv> {
  return id === "codex" ? buildCodexRuntimeEnv(workspacePath) : buildHermesRuntimeEnv(workspacePath);
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
  for (const file of ["config.toml", "mcp.json"]) {
    const source = path.join(config.codex.sourceHome, file);
    const target = path.join(codexHome, file);
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
        // target missing
      }
      if (needReplace) {
        if (existsSync(target)) rmSync(target, { force: true });
        symlinkSync(source, target);
      }
    } catch (error) {
      logger.warn(`Codex config symlink failed file=${file}: ${(error as Error).message}`);
    }
  }
  const authSource = path.join(config.codex.sourceHome, "auth.json");
  const authTarget = path.join(codexHome, "auth.json");
  if (existsSync(authSource) && !existsSync(authTarget)) {
    try {
      copyFileSync(authSource, authTarget);
    } catch (error) {
      logger.warn(`Codex auth copy failed: ${(error as Error).message}`);
    }
  }
}

// ─── 注册中心 ───────────────────────────────────────────────────────

const instances = new Map<AcpBackendId, StdioAcpAgent>();
const scopedInstances = new Map<string, StdioAcpAgent>();
let currentBackendId: AcpBackendId | null = null;
let settingsLoaded = false;

function getOrCreateInstance(id: AcpBackendId, override: AcpBackendOverride = {}): StdioAcpAgent {
  const scopedKey = override.cwd ? `${id}:${path.resolve(override.cwd)}` : undefined;
  if (scopedKey) {
    const existing = scopedInstances.get(scopedKey);
    if (existing) return existing;
  }
  const existing = override.cwd ? undefined : instances.get(id);
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

export async function getCurrentAcpAgent(workspacePath?: string): Promise<StdioAcpAgent> {
  const id = await loadCurrentBackendId();
  return getOrCreateInstance(id, workspacePath ? { cwd: workspacePath } : {});
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
    const [, ...cwdParts] = key.split(":");
    const cwd = cwdParts.join(":");
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
