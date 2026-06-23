/**
 * @deprecated 主链路已统一由 Codex ACP 兜底,本文件不再被产品主链路使用。
 *
 * 2026-06-21 工作包 2 决策:Hermes 退出主链路,CodeX 一律兜底。
 * 详见 docs/ideal-refactor-plan.md 第一节"核心决定"。
 *
 * 本文件保留作考古与 /api/hermes/* 实验路由使用,不要在主链路 agent.ts /
 * weixin-mobile.ts / handlers 中重新引入对它的依赖。
 * 后续工作包 0 完成数据归属划分后,可考虑彻底移除。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { config } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import { MOBILE_SYSTEM_PROMPT } from "./mobile-prompt.js";

type ClientSideConnection = {
  initialize(params: Record<string, unknown>): Promise<unknown>;
  newSession(params: Record<string, unknown>): Promise<{ sessionId: string }>;
  prompt(params: Record<string, unknown>): Promise<unknown>;
  cancel(params: Record<string, unknown>): Promise<unknown>;
};

type ContentBlock = { type: "text"; text: string };

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

export type HermesAcpStatus = {
  enabled: boolean;
  ready: boolean;
  profile: string;
  command: string;
  args: string[];
  cwd: string;
  pid?: number;
  sessions: number;
  lastError?: string;
  profiles?: HermesAcpStatus[];
};

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

function argsForProfile(profile: string) {
  if (!process.env.HERMES_ACP_ARGS?.trim()) {
    return ["-p", profile, "acp", "--accept-hooks"];
  }
  const args = [...config.hermes.acpArgs];
  const profileFlagIndex = args.findIndex((arg) => arg === "-p" || arg === "--profile");
  if (profileFlagIndex >= 0 && args[profileFlagIndex + 1]) {
    args[profileFlagIndex + 1] = profile;
    return args;
  }
  return ["-p", profile, ...args];
}

class HermesProfileAcpAgent {
  private connection: ClientSideConnection | null = null;
  private process: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private starting: Promise<ClientSideConnection> | null = null;
  private lastError: string | undefined;
  private readonly sessions = new Map<string, string>();
  private readonly collectors = new Map<string, ResponseCollector>();

  constructor(private readonly profile: string) {}

  status(): HermesAcpStatus {
    const args = argsForProfile(this.profile);
    return {
      enabled: config.hermes.enabled,
      ready: this.ready,
      profile: this.profile,
      command: config.hermes.acpCommand,
      args,
      cwd: config.hermes.acpCwd,
      pid: this.process?.pid,
      sessions: this.sessions.size,
      lastError: this.lastError,
    };
  }

  async ensureReady(): Promise<ClientSideConnection> {
    if (!config.hermes.enabled) {
      throw new Error("Hermes 实验后端未启用，请设置 HERMES_EXPERIMENT_ENABLED=true");
    }
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
  }): Promise<string> {
    const conn = await this.ensureReady();
    const sessionId = await this.getOrCreateSession(params.conversationId, conn);
    const prompt: ContentBlock[] = [{ type: "text", text: params.text }];
    const collector = new ResponseCollector();
    this.collectors.set(sessionId, collector);
    const startedAt = Date.now();
    logger.info(`Hermes ACP 开始处理 profile=${this.profile} session=${sessionId} message=${params.messageId ?? "-"}`);

    try {
      const result = await Promise.race([
        conn.prompt({
          sessionId,
          messageId: params.messageId,
          prompt,
        }),
        this.timeoutAfter(config.hermes.acpTimeoutMs),
      ]);
      logger.info(
        `Hermes ACP 完成 session=${sessionId} elapsedMs=${Date.now() - startedAt} result=${JSON.stringify(result)}`
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("请求超时")) {
        logger.warn(`Hermes ACP 超时，取消当前轮次 session=${sessionId}`);
        await conn.cancel({ sessionId }).catch((cancelError: unknown) => {
          logger.warn("Hermes ACP 取消失败:", cancelError);
        });
      }
      throw error;
    } finally {
      this.collectors.delete(sessionId);
    }

    return collector.toText() || "处理完成，但没有生成文本回复。";
  }

  clearSession(conversationId: string) {
    const sessionId = this.sessions.get(conversationId);
    if (!sessionId) return;
    this.collectors.delete(sessionId);
    this.sessions.delete(conversationId);
  }

  dispose() {
    this.ready = false;
    this.starting = null;
    this.connection = null;
    this.sessions.clear();
    this.collectors.clear();

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
    logger.info(`Hermes ACP 子进程已停止 profile=${this.profile}`);
  }

  private async start(): Promise<ClientSideConnection> {
    const command = config.hermes.acpCommand;
    const args = argsForProfile(this.profile);
    logger.info(`启动 Hermes ACP profile=${this.profile}: ${command}${args.length ? ` ${args.join(" ")}` : ""}`);

    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: config.hermes.acpCwd,
      env: process.env,
      detached: true,
    });
    this.process = child;

    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString("utf-8").trim();
      if (text) logger.warn(`[hermes-acp:${this.profile}] ${text}`);
    });

    child.on("exit", (code, signal) => {
      logger.warn(`Hermes ACP 子进程退出 profile=${this.profile} code=${code ?? "-"} signal=${signal ?? "-"}`);
      this.ready = false;
      this.connection = null;
      this.process = null;
      this.sessions.clear();
      this.collectors.clear();
    });

    child.on("error", (error) => {
      this.lastError = error.message;
      logger.error(`Hermes ACP 子进程启动失败 profile=${this.profile}:`, error);
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
      clientInfo: { name: `invest-agent-hermes-${this.profile}`, version: "1.0.0" },
      clientCapabilities: {},
    });

    this.connection = conn;
    this.ready = true;
    this.lastError = undefined;
    logger.info(`Hermes ACP 已就绪 profile=${this.profile} pid=${child.pid ?? "-"}`);
    return conn;
  }

  private async getOrCreateSession(conversationId: string, conn: ClientSideConnection) {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;

    const res = await conn.newSession({
      cwd: config.hermes.acpCwd,
      mcpServers: [],
      _meta: {
        systemPrompt: { append: MOBILE_SYSTEM_PROMPT },
      },
    });
    this.sessions.set(conversationId, res.sessionId);
    logger.info(`Hermes ACP 新会话 profile=${this.profile} conversation=${conversationId} session=${res.sessionId}`);
    return res.sessionId;
  }

  private timeoutAfter(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Hermes ACP 请求超时 ${ms}ms`)), ms);
    });
  }
}

class HermesStdioAcpManager {
  private readonly agents = new Map<string, HermesProfileAcpAgent>();

  private normalizeProfile(profile?: string) {
    return (profile || config.hermes.profile || "invest-agent").trim() || "invest-agent";
  }

  private agentFor(profile?: string) {
    const normalized = this.normalizeProfile(profile);
    const existing = this.agents.get(normalized);
    if (existing) return existing;
    const agent = new HermesProfileAcpAgent(normalized);
    this.agents.set(normalized, agent);
    return agent;
  }

  status(profile?: string): HermesAcpStatus {
    if (profile) return this.agentFor(profile).status();
    const defaultAgent = this.agentFor(config.hermes.profile);
    return {
      ...defaultAgent.status(),
      profiles: Array.from(this.agents.values()).map((agent) => agent.status()),
    };
  }

  ensureReady(profile?: string) {
    return this.agentFor(profile).ensureReady();
  }

  chat(params: {
    conversationId: string;
    text: string;
    messageId?: string;
    profile?: string;
  }) {
    return this.agentFor(params.profile).chat(params);
  }

  clearSession(conversationId: string, profile?: string) {
    if (profile) {
      this.agentFor(profile).clearSession(conversationId);
      return;
    }
    for (const agent of this.agents.values()) {
      agent.clearSession(conversationId);
    }
  }

  dispose() {
    for (const agent of this.agents.values()) {
      agent.dispose();
    }
    this.agents.clear();
  }
}

export const hermesStdioAcpAgent = new HermesStdioAcpManager();

export async function startHermesAcpIfEnabled() {
  if (!config.hermes.enabled) return;
  await hermesStdioAcpAgent.ensureReady(config.hermes.profile);
}

export function disposeHermesAcp() {
  hermesStdioAcpAgent.dispose();
}

export function getHermesAcpStatus() {
  return hermesStdioAcpAgent.status();
}
