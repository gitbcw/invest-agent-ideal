/**
 * 会话 Manifest 解析 (WP1)
 *
 * 把已注册的 MCP server 按 backend / scope / taskType 解析成本次会话实际装配的
 * ACP mcpServers,并生成一份脱敏 manifest 摘要。manifest 不是第二份工具目录 ——
 * 工具清单以 server 握手返回的 tools/list 为准;这里只记录"装配了哪些 server"
 * 的最小运维信息,绝不记录 secret 或工具结果。
 *
 * 默认行为与重构前的 buildInvestAgentMcpServers 完全一致:仅 codex backend
 * 装配唯一的 service-scoped stdio server。WP2 接入外部 MCP 时只需新增注册项。
 */

import path from "node:path";
import { createHash } from "node:crypto";
import type { UserContext } from "../lib/user-context.js";
import { defaultInstanceIdForUser } from "../lib/user-context.js";
import { config } from "../lib/config.js";
import { logger } from "../lib/logger.js";
import type { AcpBackendId } from "./stdio-agent.js";
import {
  getMcpRegistry,
  resolveRuntimePlaceholders,
  isExternalStdioHealthy,
  resolveExternalServer,
  type McpRegistry,
  type McpServerRegistration,
  type McpSessionKind,
} from "./mcp-registry.js";

// ─── 类型 ──────────────────────────────────────────────────────────

/** ACP mcpServers 数组元素。对齐 SDK 的 McpServer stdio 形态 (WP1 仅产出 stdio)。 */
export type AcpMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
};

/** 脱敏 manifest 摘要 —— 可安全记录到 trace/日志,不含 secret。 */
export interface AcpMcpSessionManifest {
  sessionId: string;
  runId?: string;
  userId: string;
  instanceId: string;
  taskType: string;
  servers: Array<{
    id: string;
    transportKind: "stdio" | "http";
    version?: string;
    /** 去除 secret 后的配置指纹 (sha256 前 12 位),用于审计一致性。 */
    configFingerprint: string;
  }>;
}

export interface ResolveSessionInput {
  backendId: AcpBackendId;
  cwd: string;
  userContext?: UserContext;
  env?: NodeJS.ProcessEnv;
  taskType: string;
  sessionId: string;
  runId?: string;
  /** 测试注入;生产用全局单例。 */
  registry?: McpRegistry;
}

export interface ResolveSessionResult {
  manifest: AcpMcpSessionManifest;
  servers: AcpMcpServer[];
}

// ─── scope 解析 (1:1 搬迁自原 buildInvestAgentMcpServers) ─────────

interface ResolvedIdentity {
  userId: string;
  instanceId: string;
  workspacePath: string;
  conversationId: string;
  allowedTools: string[];
}

function inferSessionKind(taskType: string): McpSessionKind | null {
  // WP1 阶段:交互会话与 eval 隔离都按 taskType 归类。
  // scheduled 前缀来自 scheduled-tasks.ts 的 conversationId 约定。
  if (taskType.startsWith("scheduled")) return "scheduled-read";
  if (taskType === "evaluation") return "evaluation";
  if (taskType === "interactive" || taskType === "") return "interactive";
  return null;
}

function resolveUserIdentity(
  userContext: UserContext | undefined,
  env: NodeJS.ProcessEnv,
): { userId: string; instanceId: string } {
  const userId = userContext?.userId || env.INVEST_AGENT_MCP_USER_ID || "primary";
  const instanceId =
    userContext?.instanceId || env.INVEST_AGENT_MCP_INSTANCE_ID || defaultInstanceIdForUser(userId);
  return { userId, instanceId };
}

function resolveAllowedTools(
  userContext: UserContext | undefined,
  env: NodeJS.ProcessEnv,
): string[] {
  const evaluationAllowedTools = (env.ACP_EVAL_MCP_ALLOWED_TOOLS || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return userContext?.mcpAllowedTools?.length ? userContext.mcpAllowedTools : evaluationAllowedTools;
}

/**
 * 计算会话 allowlist 的稳定指纹 (WP3)。
 *
 * sessionKey 必须纳入 allowlist,否则同一 conversation 不同 allowlist 会复用 session,
 * 导致权限泄漏 (全量 session 被只读阶段复用)。指纹 = 排序去重后的 allowlist 短 hash;
 * 无 allowlist (全量) 返回空串,使无 allowlist 的会话仍可互相复用。
 *
 * 用 sha256 前 8 位,与 configFingerprint 风格一致。
 */
export function computeAllowlistFingerprint(
  userContext: UserContext | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const tools = resolveAllowedTools(userContext, env);
  if (tools.length === 0) return "";
  const normalized = [...new Set(tools)].sort().join(",");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 8);
}

/**
 * 解析 service-scoped server 的完整 env 数组。
 * 逻辑与原 buildInvestAgentMcpServers :191-231 完全一致,保证零行为回归。
 */
function resolveServiceScopeEnv(
  identity: ResolvedIdentity,
  env: NodeJS.ProcessEnv,
  projectRoot: string,
): Array<{ name: string; value: string }> {
  const resolveFromProject = (value: string) => path.resolve(projectRoot, value);
  const runtimeEnv: Array<{ name: string; value: string }> = [
    { name: "INVEST_AGENT_MCP_USER_ID", value: identity.userId },
    { name: "INVEST_AGENT_MCP_INSTANCE_ID", value: identity.instanceId },
    { name: "INVEST_AGENT_MCP_WORKSPACE_PATH", value: identity.workspacePath },
    { name: "INVEST_AGENT_MCP_CONVERSATION_ID", value: identity.conversationId },
    ...(identity.allowedTools.length
      ? [{ name: "INVEST_AGENT_MCP_ALLOWED_TOOLS", value: identity.allowedTools.join(",") }]
      : []),
    { name: "INVEST_AGENT_PROJECT_ROOT", value: projectRoot },
    { name: "DB_PATH", value: resolveFromProject(env.DB_PATH || config.db.path) },
    { name: "WORKSPACE_ROOT", value: resolveFromProject(env.WORKSPACE_ROOT || config.workspace.root) },
    {
      name: "WORKSPACE_TEMPLATE_PATH",
      value: resolveFromProject(env.WORKSPACE_TEMPLATE_PATH || config.workspace.templatePath),
    },
    { name: "WORKSPACE_BACKEND", value: env.WORKSPACE_BACKEND || "workspace" },
    { name: "RUNTIME_DATA_ROOT", value: resolveFromProject(env.RUNTIME_DATA_ROOT || config.runtimeData.root) },
    { name: "REVIEWS_ROOT", value: resolveFromProject(env.REVIEWS_ROOT || path.join(projectRoot, "reviews")) },
  ];

  // Credentials are deliberately passed only to the child process. This
  // configuration is never logged or included in customer-visible output.
  if (env.INVEST_AGENT_SANDBOX_SECRET) {
    runtimeEnv.push({ name: "INVEST_AGENT_SANDBOX_SECRET", value: env.INVEST_AGENT_SANDBOX_SECRET });
  }
  if (env.INVEST_AGENT_SANDBOX_SECRET_FILE) {
    runtimeEnv.push({
      name: "INVEST_AGENT_SANDBOX_SECRET_FILE",
      value: resolveFromProject(env.INVEST_AGENT_SANDBOX_SECRET_FILE),
    });
  }
  for (const name of [
    "TUSHARE_TOKEN",
    "TDX_MCP_API_KEY",
    "TDX_MCP_URL",
    "TDX_MCP_FUNDAMENTALS_TOOL",
    "EXTERNAL_WEB_SEARCH_SEARXNG_URL",
  ]) {
    const value = env[name]?.trim();
    if (value) runtimeEnv.push({ name, value });
  }

  return runtimeEnv;
}

// ─── configFingerprint (脱敏) ─────────────────────────────────────
//
// 只对"决定 server 身份和配置形态"的字段做指纹,绝不包含 secret/凭据值。
// service-scoped server 的指纹基于 id + transport + 非 secret 的 scope 变量名集合。

function computeConfigFingerprint(
  reg: McpServerRegistration,
  identity: ResolvedIdentity,
): string {
  const fingerprintInput = JSON.stringify({
    id: reg.id,
    transport: reg.transport.kind,
    // 只含 scope 变量名,不含值;http 的 headerRefs 也是引用名
    scopeRefs:
      reg.transport.kind === "stdio"
        ? (reg.transport.envRefs || [])
        : (reg.transport.headerRefs || []),
    // scope 身份参与指纹 (userId/instanceId 区分不同用户的会话)
    scopeIdentity: { userId: identity.userId, instanceId: identity.instanceId },
  });
  return createHash("sha256").update(fingerprintInput).digest("hex").slice(0, 12);
}

// ─── 主解析函数 ────────────────────────────────────────────────────

export function resolveSessionMcpServers(input: ResolveSessionInput): ResolveSessionResult {
  const { backendId, cwd, userContext, env = process.env, taskType, sessionId, runId } = input;
  const registry = input.registry || getMcpRegistry();

  // codex 以外的 backend 不装配任何 service MCP (与原行为一致)
  if (backendId !== "codex") {
    return emptyManifest(sessionId, runId, taskType, env);
  }
  // eval 全禁模式 (与原行为一致)
  if (env.ACP_EVAL_DISABLE_ALL_MCP === "true") {
    return emptyManifest(sessionId, runId, taskType, env);
  }

  const sessionKind = inferSessionKind(taskType);
  if (!sessionKind) {
    return emptyManifest(sessionId, runId, taskType, env);
  }

  const { userId, instanceId } = resolveUserIdentity(userContext, env);
  const workspacePath = path.resolve(userContext?.workspacePath || cwd);
  const allowedTools = resolveAllowedTools(userContext, env);
  const identity: ResolvedIdentity = {
    userId,
    instanceId,
    workspacePath,
    conversationId: userContext?.conversationId || "",
    allowedTools,
  };
  const projectRoot = path.resolve(env.INVEST_AGENT_PROJECT_ROOT || process.cwd());

  const manifestServers: AcpMcpSessionManifest["servers"] = [];
  const servers: AcpMcpServer[] = [];

  for (const reg of registry.listEnabledRegistrations(sessionKind)) {
    // WP1: http transport 类型就绪但 ACP capability 未声明,暂 fail closed。
    // WP2 接入外部 MCP 时在此探针 capability 后放行。
    if (reg.transport.kind === "http") {
      logger.warn(
        `MCP server ${reg.id} uses http transport which is not yet enabled (ACP capability unprobed); skipping`,
      );
      continue;
    }

    // service-scoped: 复用 WP1 的 scope 解析
    if (reg.trustClass === "service-scoped") {
      const resolved = resolveRuntimePlaceholders(reg, { projectRoot, execPath: process.execPath, env });
      if (resolved.transport.kind !== "stdio") continue;
      servers.push({
        name: resolved.id,
        command: resolved.transport.command,
        args: resolved.transport.args,
        env: resolveServiceScopeEnv(identity, env, projectRoot),
      });
      manifestServers.push({
        id: resolved.id,
        transportKind: resolved.transport.kind,
        version: resolved.versionPolicy?.expected,
        configFingerprint: computeConfigFingerprint(resolved, identity),
      });
      continue;
    }

    // external-readonly (WP2): 健康检查 + 外部 env 解析
    if (reg.trustClass === "external-readonly") {
      if (!isExternalStdioHealthy(reg, env)) {
        // 外部 MCP 不健康时会话明确缺少该服务器,不阻断 service-scoped MCP 启动
        logger.warn(
          `MCP server ${reg.id} is not healthy (missing required env MDT_PROJECT_DIR/MDT_UV_BIN); skipping`,
        );
        continue;
      }
      const external = resolveExternalServer(reg, env);
      if (!external) continue;
      servers.push({
        name: reg.id,
        command: external.command,
        args: external.args,
        env: external.env,
      });
      manifestServers.push({
        id: reg.id,
        transportKind: "stdio",
        version: reg.versionPolicy?.expected,
        configFingerprint: computeConfigFingerprint(reg, identity),
      });
    }
  }

  const manifest: AcpMcpSessionManifest = {
    sessionId,
    runId,
    userId,
    instanceId,
    taskType,
    servers: manifestServers,
  };

  // 结构化运行日志 (脱敏):WP1 不引入 DB schema 变更
  logger.info(
    `[MCP_SESSION] assembled session=${sessionId} taskType=${taskType} userId=${userId} servers=${manifestServers
      .map((s) => `${s.id}:${s.transportKind}`)
      .join(",")}`,
  );

  return { manifest, servers };
}

function emptyManifest(
  sessionId: string,
  runId: string | undefined,
  taskType: string,
  env: NodeJS.ProcessEnv,
): ResolveSessionResult {
  const userId = env.INVEST_AGENT_MCP_USER_ID || "primary";
  const instanceId = env.INVEST_AGENT_MCP_INSTANCE_ID || defaultInstanceIdForUser(userId);
  return {
    manifest: { sessionId, runId, userId, instanceId, taskType, servers: [] },
    servers: [],
  };
}
