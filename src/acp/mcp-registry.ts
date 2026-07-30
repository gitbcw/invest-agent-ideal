/**
 * 配置型 MCP 注册表 (WP1)
 *
 * 把 ACP 会话能接入的 MCP server 从 `buildInvestAgentMcpServers` 的硬编码
 * 单服务器改为受控注册表。首版只配置、不建表、不图形管理后台。
 *
 * 设计要点:
 *   - 注册项只存 secret 引用名 (envRefs / headerRefs),解析后的明文只进入
 *     对应子进程或传输请求,绝不进入 manifest 摘要、trace 或用户可见输出。
 *   - service-scoped 注册项必须由 invest-agent 拥有;external-readonly 注册项
 *     永不获得 service scope 环境引用 (DB_PATH / Workspace / sandbox secret 等)。
 *   - http transport 类型已就绪,但实际启用需 WP2 探针确认 Agent capability;
 *     WP1 阶段 ACP capability 未声明 mcp_capabilities.http,故 http 注册项虽能
 *     注册,但 resolve 时会 fail closed。
 */

import path from "node:path";
import { logger } from "../lib/logger.js";
import { buildExternalRegistrations } from "./external-mcp-registrations.js";

// ─── 注册模型 ──────────────────────────────────────────────────────

/** Transport 对齐 ACP SDK 0.16.1 实际类型 (http/sse/stdio)。SDK 无 streamable-http 概念。 */
export type McpTransport =
  | { kind: "stdio"; command: string; args: string[]; envRefs?: string[] }
  | { kind: "http"; url: string; headerRefs?: string[] };

export type McpTrustClass = "service-scoped" | "external-readonly";
export type McpOwner = "invest-agent" | "external";
export type McpSessionKind = "interactive" | "scheduled-read" | "evaluation";

export interface McpServerRegistration {
  id: string;
  owner: McpOwner;
  enabled: boolean;
  trustClass: McpTrustClass;
  transport: McpTransport;
  versionPolicy?: { expected?: string; allowedRange?: string };
  sessionKinds: McpSessionKind[];
}

// ─── service-scoped 环境引用名 ────────────────────────────────────
//
// 这些引用名描述 service-scoped server 需要的 env 变量类别。
// external-readonly server 永远拿不到这一组引用 —— 它是 service 与外部 MCP
// 之间的安全边界。引用名由 manifest resolver 解析成实际值。
//
// 区分两类:
//   - scope refs: 从 UserContext 派生,随用户/实例/任务变化
//   - passthrough refs: 从 process.env 读取,全局不变 (含凭据)
export const SERVICE_SCOPE_ENV_REFS = [
  // scope refs (从 UserContext 派生)
  "INVEST_AGENT_MCP_USER_ID",
  "INVEST_AGENT_MCP_INSTANCE_ID",
  "INVEST_AGENT_MCP_WORKSPACE_PATH",
  "INVEST_AGENT_MCP_CONVERSATION_ID",
  "INVEST_AGENT_MCP_ALLOWED_TOOLS",
  "INVEST_AGENT_MCP_EXPECTED_REVIEW_KIND",
  "INVEST_AGENT_MCP_EXPECTED_REVIEW_KEY",
  // passthrough refs (从 env 读 + projectRoot resolve)
  "INVEST_AGENT_PROJECT_ROOT",
  "DB_PATH",
  "WORKSPACE_ROOT",
  "WORKSPACE_TEMPLATE_PATH",
  "WORKSPACE_BACKEND",
  "RUNTIME_DATA_ROOT",
  "REVIEWS_ROOT",
  // 可选凭据透传 (passthrough, 仅 service-scoped)
  "INVEST_AGENT_SANDBOX_SECRET",
  "INVEST_AGENT_SANDBOX_SECRET_FILE",
  "TUSHARE_TOKEN",
  "TDX_MCP_API_KEY",
  "TDX_MCP_URL",
  "TDX_MCP_FUNDAMENTALS_TOOL",
  "EXTERNAL_WEB_SEARCH_SEARXNG_URL",
] as const;

/** external-readonly server 被禁止引用的 scope 名 (安全边界护栏)。 */
const FORBIDDEN_EXTERNAL_REFS = new Set<string>(SERVICE_SCOPE_ENV_REFS);

// ─── 校验 ──────────────────────────────────────────────────────────

export class McpRegistryError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "McpRegistryError";
  }
}

export function validateRegistration(reg: McpServerRegistration): string | null {
  if (!reg.id || typeof reg.id !== "string") return "registration id is required";
  if (!/^[a-zA-Z0-9_.-]+$/.test(reg.id)) return `invalid registration id: ${reg.id}`;
  if (reg.trustClass === "service-scoped" && reg.owner !== "invest-agent") {
    return `service-scoped server must be owned by invest-agent: ${reg.id}`;
  }
  if (reg.trustClass === "external-readonly" && reg.owner === "invest-agent") {
    return `external-readonly server should not be owned by invest-agent: ${reg.id}`;
  }
  if (!Array.isArray(reg.sessionKinds) || reg.sessionKinds.length === 0) {
    return `sessionKinds must be non-empty: ${reg.id}`;
  }
  // transport 一致性
  if (reg.transport.kind === "stdio") {
    if (!reg.transport.command) return `stdio server missing command: ${reg.id}`;
    if (!Array.isArray(reg.transport.args)) return `stdio server missing args: ${reg.id}`;
  } else if (reg.transport.kind === "http") {
    if (!reg.transport.url) return `http server missing url: ${reg.id}`;
  }
  // external-readonly 安全边界:不得引用 forbidden scope
  if (reg.trustClass === "external-readonly") {
    const refs = reg.transport.kind === "stdio" ? reg.transport.envRefs : reg.transport.headerRefs;
    const leaked = (refs || []).filter((r) => FORBIDDEN_EXTERNAL_REFS.has(r));
    if (leaked.length) {
      return `external-readonly server ${reg.id} must not reference service scope env: ${leaked.join(", ")}`;
    }
  }
  return null;
}

// ─── 注册表 ────────────────────────────────────────────────────────

/**
 * 构建内建 `invest-agent-service-tools` 注册项。
 *
 * command / dist 路径在 resolve 时解析 (传入 projectRoot + execPath),
 * 因为它们依赖运行时进程上下文,注册项本身保持可序列化的引用形态。
 */
export function buildBuiltinServiceToolsRegistration(): McpServerRegistration {
  return {
    id: "invest-agent-service-tools",
    owner: "invest-agent",
    enabled: true,
    trustClass: "service-scoped",
    transport: {
      kind: "stdio",
      // 运行时解析:resolve 时替换为 process.execPath
      command: "<runtime:exec-path>",
      // 运行时解析:resolve 时拼出 dist/mcp/invest-agent-service-tools.js
      args: ["<runtime:dist-mcp-path>"],
      envRefs: [...SERVICE_SCOPE_ENV_REFS],
    },
    sessionKinds: ["interactive", "scheduled-read", "evaluation"],
  };
}

export class McpRegistry {
  private readonly registrations = new Map<string, McpServerRegistration>();

  constructor(builtins: McpServerRegistration[] = [buildBuiltinServiceToolsRegistration()]) {
    for (const reg of builtins) {
      this.register(reg);
    }
  }

  /** 注册一项。重复 id 或校验失败抛 McpRegistryError (fail closed)。 */
  register(reg: McpServerRegistration): void {
    const err = validateRegistration(reg);
    if (err) throw new McpRegistryError(err, "invalid_registration");
    if (this.registrations.has(reg.id)) {
      throw new McpRegistryError(`duplicate server id: ${reg.id}`, "duplicate_id");
    }
    this.registrations.set(reg.id, { ...reg });
  }

  getRegistration(id: string): McpServerRegistration | undefined {
    return this.registrations.get(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    const reg = this.registrations.get(id);
    if (!reg) throw new McpRegistryError(`unknown server id: ${id}`, "unknown_id");
    reg.enabled = enabled;
  }

  /** 列出全部注册项 (含禁用)。 */
  listRegistrations(): McpServerRegistration[] {
    return Array.from(this.registrations.values());
  }

  /** 列出已启用的注册项,可选按 sessionKind 过滤。 */
  listEnabledRegistrations(sessionKind?: McpSessionKind): McpServerRegistration[] {
    return this.listRegistrations().filter(
      (reg) => reg.enabled && (!sessionKind || reg.sessionKinds.includes(sessionKind)),
    );
  }
}

// ─── 全局单例 ──────────────────────────────────────────────────────
//
// 首版使用进程内单例;不引入数据库后台。测试可通过 createMcpRegistry() 构造独立实例。

let globalRegistry: McpRegistry | undefined;

export function getMcpRegistry(): McpRegistry {
  if (!globalRegistry) {
    globalRegistry = new McpRegistry();
    // WP2: 受 env 开关控制接入外部只读 MCP。默认关闭,保证零行为回归。
    if (process.env.INVEST_AGENT_MCP_EXTERNAL_ENABLED === "true") {
      registerExternalMcpServers(globalRegistry);
    }
  }
  return globalRegistry;
}

/**
 * 把外部只读 MCP 注册项接入注册表并启用。
 * 幂等:已注册的 id 跳过。受 env 开关 INVEST_AGENT_MCP_EXTERNAL_ENABLED 控制。
 */
export function registerExternalMcpServers(registry: McpRegistry): void {
  // 延迟导入避免循环依赖
  for (const reg of buildExternalRegistrations()) {
    if (registry.getRegistration(reg.id)) continue;
    registry.register(reg);
    registry.setEnabled(reg.id, true);
  }
}

export function createMcpRegistry(builtins?: McpServerRegistration[]): McpRegistry {
  return new McpRegistry(builtins);
}

/** 仅供测试重置全局单例。 */
export function resetMcpRegistryForTest(): void {
  globalRegistry = undefined;
}

/**
 * 运行时把注册项中的 `<runtime:*>` 占位符解析成实际路径/命令。
 * service-scoped 用 exec-path/dist-mcp-path;external 用 mdt-uv-bin/mdt-run-args。
 */
export function resolveRuntimePlaceholders(
  reg: McpServerRegistration,
  ctx: { projectRoot: string; execPath: string; env?: NodeJS.ProcessEnv },
): McpServerRegistration {
  if (reg.transport.kind !== "stdio") return reg;
  const env = ctx.env || process.env;
  return {
    ...reg,
    transport: {
      ...reg.transport,
      command: reg.transport.command
        .replace("<runtime:exec-path>", ctx.execPath)
        .replace("<runtime:mdt-uv-bin>", env.MDT_UV_BIN || ""),
      args: reg.transport.args.map((arg) =>
        arg
          .replace(
            "<runtime:dist-mcp-path>",
            path.join(ctx.projectRoot, "dist/mcp/invest-agent-service-tools.js"),
          )
          .replace(
            "<runtime:mdt-run-args>",
            JSON.stringify(["run", "--project", env.MDT_PROJECT_DIR || "", "mdt-mcp"]),
          ),
      ),
    },
  };
}

/**
 * external-readonly server 缺少必需 env 引用时,会话应明确缺少该服务器 (fail closed)。
 * 返回 null 表示健康检查未通过;返回 string[] 表示占位符是否需要展开。
 */
export function isExternalStdioHealthy(reg: McpServerRegistration, env: NodeJS.ProcessEnv): boolean {
  if (reg.trustClass !== "external-readonly" || reg.transport.kind !== "stdio") return true;
  // 如果 transport 用的是直接 command（非占位符），只需 command 非空即可
  if (reg.transport.command && !reg.transport.command.startsWith("<runtime:")) {
    return Boolean(reg.transport.command);
  }
  // 占位符 command（如 market-data-tool 的 <runtime:mdt-uv-bin>）需要对应 env
  return Boolean(env.MDT_UV_BIN && env.MDT_PROJECT_DIR);
}

/**
 * 解析 external-readonly server 的 env:只含它声明的、且在 env 中存在的引用。
 * 绝不注入 service scope env (WP1 校验已禁止声明,这里双保险过滤)。
 * mdt-run-args 占位符展开成多个 args (而非单个 JSON 字符串)。
 */
export function resolveExternalServer(
  reg: McpServerRegistration,
  env: NodeJS.ProcessEnv,
): { command: string; args: string[]; env: Array<{ name: string; value: string }> } | null {
  if (reg.transport.kind !== "stdio") return null;
  if (!isExternalStdioHealthy(reg, env)) return null;

  // mdt-run-args 展开为实际子进程参数
  let args: string[];
  if (reg.transport.args.length === 1 && reg.transport.args[0] === "<runtime:mdt-run-args>") {
    args = ["run", "--project", env.MDT_PROJECT_DIR || "", "mdt-mcp"];
  } else {
    args = [...reg.transport.args];
  }

  const serverEnv: Array<{ name: string; value: string }> = [];
  for (const ref of reg.transport.envRefs || []) {
    if (FORBIDDEN_EXTERNAL_REFS.has(ref)) continue; // 双保险:安全边界
    const value = env[ref];
    if (value !== undefined && value !== "") {
      serverEnv.push({ name: ref, value });
    }
  }

  return {
    command: reg.transport.command === "<runtime:mdt-uv-bin>" ? env.MDT_UV_BIN || "" : reg.transport.command,
    args,
    env: serverEnv,
  };
}

/** 调试用:导出安全边界引用集。 */
export function isForbiddenExternalRef(ref: string): boolean {
  return FORBIDDEN_EXTERNAL_REFS.has(ref);
}

export { logger as _registryLogger };
