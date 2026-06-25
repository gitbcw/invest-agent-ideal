/**
 * 通用 stdio ACP agent + 多后端注册中心。
 *
 * 现在支持三个 ACP 后端:
 *   - kimi    (默认) ~/.kimi-code/bin/kimi acp
 *   - claude  ~/.nvm/.../claude-agent-acp
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
import { existsSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { settings } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { config } from "../lib/config.js";
import { MOBILE_SYSTEM_PROMPT } from "./mobile-prompt.js";

// ─── 类型 ───────────────────────────────────────────────────────────

type ClientSideConnection = {
  initialize(params: Record<string, unknown>): Promise<unknown>;
  newSession(params: Record<string, unknown>): Promise<{ sessionId: string }>;
  prompt(params: Record<string, unknown>): Promise<unknown>;
  cancel(params: Record<string, unknown>): Promise<unknown>;
};

type SessionNotification = {
  sessionId: string;
  update:
    | {
        sessionUpdate: "agent_message_chunk";
        content: { type: "text"; text: string } | { type: string };
      }
    | { sessionUpdate: string };
};

type RequestPermissionRequest = {
  options: Array<{ optionId: string }>;
};

export type AcpBackendId = "kimi" | "claude" | "codex";

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

// ─── 后端定义 ───────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 1_800_000;

const DEFAULT_CODEX_ACP_ARGS = [
  "-c", "sandbox_mode=\"workspace-write\"",
  "-c", "approval_policy=\"never\"",
  "-c", "project_trust_level=\"untrusted\"",
  "-c", "disable_response_storage=true",
  "-c", "mcp_servers={}",
  "-c", "plugins={}",
];

export const ACP_BACKENDS: AcpBackendDef[] = [
  {
    id: "kimi",
    label: "Kimi Code",
    command: process.env.KIMI_ACP_COMMAND || "/Users/combo/.kimi-code/bin/kimi",
    args: process.env.KIMI_ACP_ARGS?.trim()
      ? process.env.KIMI_ACP_ARGS.trim().split(/\s+/)
      : ["acp"],
    cwd: process.env.KIMI_ACP_CWD || process.cwd(),
    timeoutMs: Number(process.env.KIMI_ACP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  },
  {
    id: "claude",
    label: "Claude Code",
    command: process.env.CLAUDE_ACP_COMMAND || "claude-agent-acp",
    args: process.env.CLAUDE_ACP_ARGS?.trim()
      ? process.env.CLAUDE_ACP_ARGS.trim().split(/\s+/)
      : [],
    cwd: process.env.CLAUDE_ACP_CWD || process.cwd(),
    timeoutMs: Number(process.env.CLAUDE_ACP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  },
  {
    id: "codex",
    label: "Codex",
    command: config.codex.acpCommand,
    args: config.codex.acpArgs.length > 0 ? config.codex.acpArgs : DEFAULT_CODEX_ACP_ARGS,
    cwd: config.codex.acpCwd,
    timeoutMs: config.codex.acpTimeoutMs || DEFAULT_TIMEOUT_MS,
    isDefault: true,
  },
];

const SETTINGS_KEY = "acp_backend";

// ─── 通用 stdio ACP agent ──────────────────────────────────────────

class ResponseCollector {
  private readonly chunks: string[] = [];

  handleUpdate(notification: SessionNotification) {
    const update = notification.update;
    if (update.sessionUpdate !== "agent_message_chunk") return;
    const content = (update as { content?: { type: string; text?: string } }).content;
    if (content?.type === "text") {
      this.chunks.push(content.text ?? "");
    }
  }

  toText() {
    return this.chunks.join("").trim();
  }
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

    try {
      const result = await Promise.race([
        conn.prompt({
          sessionId,
          messageId: params.messageId,
          prompt,
        }),
        this.timeoutAfter(params.timeoutMs ?? this.def.timeoutMs),
      ]);
      logger.info(
        `${this.def.label} ACP 完成 session=${sessionId} elapsedMs=${Date.now() - startedAt} result=${JSON.stringify(result)}`
      );
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

    return collector.toText() || "处理完成,但没有生成文本回复。";
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
    const env = this.def.id === "codex" ? buildCodexRuntimeEnv() : process.env;
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
      _meta: {
        systemPrompt: { append: MOBILE_SYSTEM_PROMPT },
      },
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

function buildCodexRuntimeEnv(): NodeJS.ProcessEnv {
  const runtimeHome = config.codex.runtimeHome;
  mkdirSync(runtimeHome, { recursive: true });
  writeCodexRuntimeConfig(runtimeHome);
  copyCodexRuntimeFile("auth.json", runtimeHome);
  copyCodexRuntimeFile("models_cache.json", runtimeHome);
  copyCodexRuntimeFile("version.json", runtimeHome);
  return {
    ...process.env,
    CODEX_HOME: runtimeHome,
    HOME: runtimeHome,
  };
}

function writeCodexRuntimeConfig(runtimeHome: string) {
  const configPath = path.join(runtimeHome, "config.toml");
  const model = process.env.CODEX_RUNTIME_MODEL || "gpt-5.5";
  const provider = process.env.CODEX_RUNTIME_MODEL_PROVIDER || "codex-ai";
  const baseUrl = process.env.CODEX_RUNTIME_BASE_URL || "http://47.107.151.70:3000/v1";
  const wireApi = process.env.CODEX_RUNTIME_WIRE_API || "responses";
  const reasoningEffort = process.env.CODEX_RUNTIME_REASONING_EFFORT || "medium";
  const requiresOpenAiAuth = process.env.CODEX_RUNTIME_REQUIRES_OPENAI_AUTH !== "false";

  const content = [
    "disable_response_storage = true",
    `model = ${JSON.stringify(model)}`,
    `model_reasoning_effort = ${JSON.stringify(reasoningEffort)}`,
    `model_provider = ${JSON.stringify(provider)}`,
    "",
    `[model_providers.${provider}]`,
    `name = ${JSON.stringify(provider)}`,
    `base_url = ${JSON.stringify(baseUrl)}`,
    `wire_api = ${JSON.stringify(wireApi)}`,
    `requires_openai_auth = ${requiresOpenAiAuth ? "true" : "false"}`,
    "",
  ].join("\n");

  writeFileSync(configPath, content, "utf-8");
}

function copyCodexRuntimeFile(fileName: string, runtimeHome: string) {
  const source = path.join(process.env.CODEX_HOME || path.join(process.env.HOME || "", ".codex"), fileName);
  const target = path.join(runtimeHome, fileName);
  if (!existsSync(source) || existsSync(target)) return;
  try {
    copyFileSync(source, target);
  } catch (error) {
    logger.warn(`Codex runtime file copy failed file=${fileName}: ${(error as Error).message}`);
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
    return currentBackendId ?? ACP_BACKENDS.find((b) => b.isDefault)?.id ?? "kimi";
  }
  const row = await db
    .select()
    .from(settings)
    .where(eq(settings.key, SETTINGS_KEY))
    .limit(1);
  const fromSettings = row[0]?.value as AcpBackendId | undefined;
  const valid = ACP_BACKENDS.find((b) => b.id === fromSettings);
  currentBackendId = valid ? valid.id : (ACP_BACKENDS.find((b) => b.isDefault)?.id ?? "kimi");
  settingsLoaded = true;
  return currentBackendId;
}

export async function getCurrentAcpAgent(): Promise<StdioAcpAgent> {
  const id = await loadCurrentBackendId();
  return getOrCreateInstance(id);
}

export function getCodexAcpAgent(workspacePath?: string): StdioAcpAgent {
  return getOrCreateInstance("codex", workspacePath ? { cwd: workspacePath } : {});
}

export function clearCodexAcpSessions(conversationId: string) {
  instances.get("codex")?.clearSession(conversationId);
  for (const [key, inst] of scopedInstances) {
    if (key.startsWith("codex:")) {
      inst.clearSession(conversationId);
    }
  }
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
}
